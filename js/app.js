/* WaelPrint (V2) — focused in-browser code scanner
 * A fixed rectangle (ROI) in the camera reads ONLY the code lined up inside it
 * (single-line OCR, Tesseract.js) — far more accurate & repeatable than whole-frame.
 * Optional live link: the phone sends each read code to a paired PC via an
 * MQTT-over-WebSocket relay (room = the QR pairing code).
 */
(function () {
  "use strict";
  var VERSION = "V3.6";

  /* ---------- helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const show = (el) => { if (el) el.hidden = false; };
  const hide = (el) => { if (el) el.hidden = true; };
  const now = () => (Date.now ? Date.now() : new Date().getTime());
  const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");

  const BROKER_URL = "wss://broker.emqx.io:8084/mqtt"; // URL-string form required by mqtt.js
  const TOPIC_ROOT = "scantext/v3";

  // Cloud AI reader (accurate) with automatic on-device Tesseract fallback.
  // User consented to cloud OCR for accuracy. Images are sent to OCR.space to be read.
  const OCR_SPACE_URL = "https://api.ocr.space/parse/image";
  const OCR_SPACE_KEY = "helloworld"; // free demo key — replace with your own from https://ocr.space/ocrapi for higher limits
  let cloudEnabled = true;

  const views = { landing: $("view-landing"), mobile: $("view-mobile"), desktop: $("view-desktop") };
  const backBtn = $("backBtn");
  const liveStatus = $("ocrStatus");
  let currentView = "landing";
  let pendingPairId = null;

  /* ================= view routing ================= */
  function focusView(name) {
    let t = null;
    if (name === "landing") t = views.landing.querySelector("h1");
    else if (name === "desktop") t = views.desktop.querySelector("h1");
    else if (name === "mobile") t = backBtn;
    if (t) { try { t.focus({ preventScroll: true }); } catch (_) {} }
  }
  function applyView(name) {
    if (!views[name]) name = "landing";
    Object.values(views).forEach((v) => v.classList.remove("active"));
    views[name].classList.add("active");
    currentView = name;
    backBtn.hidden = name === "landing";
    window.scrollTo(0, 0);
    if (name === "mobile") {
      startCamera();
      if (pendingPairId) { startClient(pendingPairId); pendingPairId = null; }
      else if (link.role !== "client") hide($("mobilePair"));
      updateCaptureLabel();
    } else {
      stopCamera();
    }
    if (name === "desktop") startHost();
    focusView(name);
  }
  function goTo(name) {
    if (name === "landing" || name === "mobile") {
      pendingPairId = null;
      if (link.role === "client") { cleanupLink(); hide($("mobilePair")); }
    }
    const hash = name === "landing" ? "" : "#" + name;
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname + location.search);
    applyView(name);
  }
  backBtn.addEventListener("click", () => goTo("landing"));
  document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => goTo(b.getAttribute("data-go"))));
  window.addEventListener("hashchange", () => {
    const p = parseHash();
    if (p.pair) pendingPairId = p.pair;
    applyView(p.view);
  });
  function parseHash() {
    const raw = (location.hash || "").replace(/^#/, "");
    if (raw.indexOf("pair=") === 0) return { view: "mobile", pair: decodeURIComponent(raw.slice(5)) };
    if (raw === "mobile" || raw === "desktop") return { view: raw, pair: null };
    return { view: "landing", pair: null };
  }

  /* ---------- device hint ---------- */
  function isMobileDevice() {
    const u = navigator.userAgentData;
    if (u && typeof u.mobile === "boolean") return u.mobile;
    const ua = navigator.userAgent || "";
    const touch = (navigator.maxTouchPoints || 0) > 1;
    return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua) || (touch && window.innerWidth < 900);
  }
  if (isMobileDevice()) show($("badge-mobile")); else show($("badge-desktop"));

  /* ================= camera ================= */
  const video = $("video");
  const camMsg = $("camMsg");
  let stream = null, acquiring = false;

  function camError(title, body) { camMsg.innerHTML = "<strong>" + title + "</strong>" + body; show(camMsg); }
  function stopCamera() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (video) video.srcObject = null;
  }
  async function startCamera() {
    hide(camMsg);
    if (acquiring) return;
    stopCamera();
    if (!window.isSecureContext) { camError("Camera needs a secure connection", "Open this page over <b>https://</b> (the published site) to use the camera."); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camError("Camera not supported", "This browser can't access the camera. Try Chrome or Safari."); return; }
    acquiring = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      if (currentView !== "mobile") { s.getTracks().forEach((t) => t.stop()); return; }
      stopCamera();
      stream = s; video.srcObject = stream;
      await video.play().catch(() => {});
    } catch (err) {
      if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) camError("Camera permission denied", "Allow camera access in your browser settings, then reopen this page.");
      else if (err && err.name === "NotFoundError") camError("No camera found", "This device doesn't seem to have a camera.");
      else camError("Couldn't start the camera", (err && err.message) || "Unknown error.");
    } finally { acquiring = false; }
  }
  window.addEventListener("pagehide", () => { stopCamera(); cleanupLink(); });
  document.addEventListener("visibilitychange", () => {
    if (currentView !== "mobile") return;
    if (document.hidden) stopCamera(); else startCamera();
  });

  /* ================= image preprocessing (accuracy) ================= */
  function preprocess(source) {
    const sw = source.naturalWidth || source.videoWidth || source.width;
    const sh = source.naturalHeight || source.videoHeight || source.height;
    if (!sw || !sh) return source;
    const maxSide = Math.max(sw, sh);
    let scale = 1;
    if (maxSide < 1600) scale = Math.min(3, 1600 / maxSide);
    else if (maxSide > 2600) scale = 2600 / maxSide;
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    let img;
    try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return c; }
    const d = img.data;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      gray[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    }
    // Bradley–Roth adaptive threshold (integral image) — robust to uneven lighting.
    const integ = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) {
      let rowsum = 0;
      for (let x = 0; x < w; x++) {
        rowsum += gray[y * w + x];
        integ[y * w + x] = (y > 0 ? integ[(y - 1) * w + x] : 0) + rowsum;
      }
    }
    const half = Math.max(4, (w >> 4) >> 1);
    const T = 0.15;
    for (let y = 0; y < h; y++) {
      const y1 = y - half < 0 ? 0 : y - half;
      const y2 = y + half >= h ? h - 1 : y + half;
      for (let x = 0; x < w; x++) {
        const x1 = x - half < 0 ? 0 : x - half;
        const x2 = x + half >= w ? w - 1 : x + half;
        const count = (x2 - x1 + 1) * (y2 - y1 + 1);
        const A = (x1 > 0 && y1 > 0) ? integ[(y1 - 1) * w + (x1 - 1)] : 0;
        const B = (y1 > 0) ? integ[(y1 - 1) * w + x2] : 0;
        const C = (x1 > 0) ? integ[y2 * w + (x1 - 1)] : 0;
        const sum = integ[y2 * w + x2] - B - C + A;
        const p = y * w + x;
        const o = (gray[p] * count) <= (sum * (1 - T)) ? 0 : 255;
        const idx = p << 2;
        d[idx] = d[idx + 1] = d[idx + 2] = o;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function canvasToJpeg(canvas, maxSide, quality) {
    maxSide = maxSide || 1600; quality = quality || 0.8;
    const w = canvas.width, h = canvas.height, m = Math.max(w, h);
    if (m <= maxSide) return canvas.toDataURL("image/jpeg", quality);
    const s = maxSide / m;
    const c2 = document.createElement("canvas");
    c2.width = Math.round(w * s); c2.height = Math.round(h * s);
    c2.getContext("2d").drawImage(canvas, 0, 0, c2.width, c2.height);
    return c2.toDataURL("image/jpeg", quality);
  }
  function loadImage(src) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("image load failed")); im.src = src; });
  }
  function isDataImage(s) {
    return typeof s === "string" && /^data:image\/(png|jpe?g|webp);base64,/.test(s) && s.length < 400000;
  }

  /* ================= OCR (cached worker per language+mode, serialized) ================= */
  const STATUS_LABELS = {
    "loading tesseract core": "Loading engine…",
    "initializing tesseract": "Starting engine…",
    "loading language traineddata": "Loading language…",
    "initializing api": "Initializing…",
    "recognizing text": "Reading…",
  };
  const workerCache = {};
  let activeProgress = null;
  let ocrChain = Promise.resolve();

  function getWorker(lang, psm) {
    const key = lang + "@" + psm;
    if (!workerCache[key]) {
      workerCache[key] = (async () => {
        const w = await Tesseract.createWorker(lang, 1, { logger: (m) => { if (activeProgress) activeProgress(m); } });
        try { await w.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: "1", user_defined_dpi: "300" }); } catch (_) {}
        return w;
      })();
    }
    return workerCache[key];
  }

  // psm "7" = single text line (code scanner), "3" = auto page (whole-image upload).
  function ocr(image, lang, progressCb, psm) {
    psm = psm || "3";
    const run = async () => {
      if (typeof Tesseract === "undefined") throw new Error("OCR engine not loaded");
      activeProgress = progressCb || null;
      try {
        const w = await getWorker(lang, psm);
        const { data } = await w.recognize(image);
        return (data && data.text ? data.text : "").replace(/\n{3,}/g, "\n\n").trim();
      } finally { activeProgress = null; }
    };
    const p = ocrChain.then(run, run);
    ocrChain = p.catch(() => {});
    return p;
  }

  /* ---- cloud AI reader (OCR.space) — sent as a JPEG blob ---- */
  function sourceToCanvas(source, maxSide) {
    const sw = source.naturalWidth || source.videoWidth || source.width;
    const sh = source.naturalHeight || source.videoHeight || source.height;
    const m = Math.max(sw, sh) || 1;
    const s = m > maxSide ? maxSide / m : 1;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * s));
    c.height = Math.max(1, Math.round(sh * s));
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    return c;
  }
  function dataUrlToBlob(d) {
    const parts = d.split(","), mime = (parts[0].match(/:(.*?);/) || [])[1] || "image/jpeg";
    const bin = atob(parts[1]), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function sourceToBlob(source, maxSide, q) {
    const c = sourceToCanvas(source, maxSide);
    return new Promise((res) => {
      if (c.toBlob) c.toBlob((b) => res(b || dataUrlToBlob(c.toDataURL("image/jpeg", q))), "image/jpeg", q);
      else res(dataUrlToBlob(c.toDataURL("image/jpeg", q)));
    });
  }
  function ocrSpaceParams(sel) {
    if (sel.indexOf("ara") >= 0) return { OCREngine: "1", language: "ara" };
    if (sel === "fra") return { OCREngine: "1", language: "fre" };
    return { OCREngine: "2", language: "eng" }; // engine 2 is best for Latin letters+digits
  }
  async function ocrCloud(blob, sel) {
    const pr = ocrSpaceParams(sel);
    const form = new FormData();
    form.append("apikey", OCR_SPACE_KEY);
    form.append("file", blob, "scan.jpg");
    form.append("language", pr.language);
    form.append("OCREngine", pr.OCREngine);
    form.append("scale", "true");
    form.append("detectOrientation", "true");
    form.append("isOverlayRequired", "false");
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try { res = await fetch(OCR_SPACE_URL, { method: "POST", body: form, signal: ctrl.signal }); }
    finally { clearTimeout(to); }
    if (!res.ok) throw new Error("cloud OCR http " + res.status);
    const data = await res.json();
    if (data.IsErroredOnProcessing) { const m = data.ErrorMessage; throw new Error((Array.isArray(m) ? m[0] : m) || "cloud OCR error"); }
    const r = data.ParsedResults && data.ParsedResults[0];
    return r ? (r.ParsedText || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim() : "";
  }

  // Smart OCR: cloud AI first (accurate), automatic on-device fallback.
  async function ocrSmart(source, sel, psm, progressCb) {
    if (cloudEnabled && typeof fetch !== "undefined") {
      try {
        if (progressCb) progressCb({ status: "recognizing text", progress: 0.4 });
        const blob = await sourceToBlob(source, 1600, 0.72);
        const text = await ocrCloud(blob, sel);
        if (text) { if (progressCb) progressCb({ status: "recognizing text", progress: 1 }); return text; }
      } catch (e) { if (liveStatus) liveStatus.textContent = "Online reader busy — reading on-device…"; }
    }
    return ocr(preprocess(source), sel, progressCb, psm);
  }

  function makeProgress(barEl, labelEl) {
    return (m) => {
      const label = STATUS_LABELS[m.status] || (m.status ? m.status[0].toUpperCase() + m.status.slice(1) : "Working…");
      if (typeof m.progress === "number") {
        const pct = Math.round(m.progress * 100);
        if (barEl) barEl.style.width = pct + "%";
        if (barEl && barEl.parentElement) barEl.parentElement.setAttribute("aria-valuenow", String(pct));
      }
      if (labelEl) labelEl.textContent = label;
      if (liveStatus) liveStatus.textContent = label;
    };
  }

  // Whole-image OCR into a panel UI (desktop upload). Returns recognized text.
  async function runOCRPanel(imageSource, lang, els) {
    if (typeof Tesseract === "undefined") { alert("OCR engine failed to load. Check your internet connection and refresh."); return ""; }
    show(els.panel); show(els.progressWrap); hide(els.resultWrap);
    if (els.bar) { els.bar.style.width = "0%"; if (els.bar.parentElement) els.bar.parentElement.setAttribute("aria-valuenow", "0"); }
    els.label.textContent = "Preparing…";
    if (liveStatus) liveStatus.textContent = "Preparing…";
    els.panel.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      const text = await ocrSmart(imageSource, lang, "3", makeProgress(els.bar, els.label));
      els.textarea.value = text;
      hide(els.progressWrap); show(els.resultWrap);
      if (liveStatus) liveStatus.textContent = text ? "Done. Text extracted." : "No text detected.";
      if (!text) els.textarea.placeholder = "No text detected. Try again with better lighting and a steady, filled frame.";
      return text;
    } catch (err) {
      hide(els.progressWrap); show(els.resultWrap);
      els.textarea.value = "";
      els.textarea.placeholder = "Something went wrong reading the image: " + ((err && err.message) || err);
      return "";
    }
  }

  /* ================= phone ↔ PC relay (MQTT over WebSocket) ================= */
  const link = { client: null, role: null, room: null, base: null, peerPresent: false };
  const relayAvailable = (typeof mqtt !== "undefined");

  function genRoom() {
    const a = new Uint8Array(6);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    let s = ""; for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, "0");
    return s;
  }
  function mqttOpts(me) {
    return {
      clientId: "waelprint_" + me + "_" + genRoom(),
      clean: true, connectTimeout: 8000, reconnectPeriod: 3000, keepalive: 30,
      will: { topic: link.base + "/presence/" + me, payload: "0", qos: 0, retain: true },
    };
  }
  function cleanupLink() {
    try {
      if (link.client) {
        if (link.base && link.role) {
          const me = link.role === "host" ? "pc" : "phone";
          try { link.client.publish(link.base + "/presence/" + me, "0", { retain: true, qos: 0 }); } catch (_) {}
        }
        link.client.end(false);
      }
    } catch (_) {}
    link.client = null; link.role = null; link.peerPresent = false;
  }

  /* ---- desktop (PC) = host / subscriber ---- */
  function setPairStatus(state, text) {
    const el = $("pairStatus"); if (el) el.setAttribute("data-state", state);
    const t = $("pairStatusText"); if (t) t.textContent = text;
  }
  function startHost() {
    if (!relayAvailable) { setPairStatus("error", "Live link unavailable (blocked). You can still upload images below."); return; }
    if (link.role === "host" && link.client) { showPairQR(); return; }
    cleanupLink();
    link.role = "host";
    link.room = link.room || genRoom();
    link.base = TOPIC_ROOT + "/" + link.room;
    setPairStatus("starting", "Starting secure link…");
    showPairQR();
    let c;
    try { c = mqtt.connect(BROKER_URL, mqttOpts("pc")); } catch (e) { setPairStatus("error", "Couldn't start the link. Upload an image below instead."); return; }
    link.client = c;
    c.on("connect", () => {
      c.subscribe([link.base + "/scan", link.base + "/presence/phone"], { qos: 0 }, () => {});
      c.publish(link.base + "/presence/pc", "1", { retain: true, qos: 0 });
      setPairStatus(link.peerPresent ? "linked" : "waiting", link.peerPresent ? "Phone linked — scan away" : "Ready — scan the code with your phone");
    });
    c.on("message", (topic, payload) => onHostMessage(topic, payload));
    c.on("reconnect", () => setPairStatus("starting", "Reconnecting…"));
    c.on("error", () => setPairStatus("error", "Link problem — check your internet. Upload still works below."));
    c.on("close", () => {});
  }
  function onHostMessage(topic, payload) {
    const s = payload && payload.toString ? payload.toString() : "";
    if (topic === link.base + "/presence/phone") {
      link.peerPresent = (s === "1");
      setPairStatus(link.peerPresent ? "linked" : "waiting", link.peerPresent ? "Phone linked — scan away" : "Waiting for your phone…");
      return;
    }
    if (topic === link.base + "/scan") {
      let msg; try { msg = JSON.parse(s); } catch (_) { return; }
      if (!msg || typeof msg.text !== "string") return;
      link.peerPresent = true;
      const id = (typeof msg.ts === "number" ? msg.ts : now());
      addLiveItem(id, isDataImage(msg.thumb) ? msg.thumb : null);
      const text = msg.text.slice(0, 20000).trim();
      updateLiveItem(id, text || "(no code detected)", !text);
      if (text) appendCodeToInput(text); // add scanned code to the "open files" box
      setPairStatus("linked", "Phone linked — scan away");
    }
  }

  /* ---- desktop live list ---- */
  const liveList = $("liveList");
  const liveEmpty = $("liveEmpty");
  const LIVE_MAX = 60;
  function addLiveItem(id, imageUrl) {
    if (liveEmpty) hide(liveEmpty);
    const item = document.createElement("div");
    item.className = "live-item";
    item.setAttribute("data-ts", String(id));
    if (isDataImage(imageUrl)) {
      const img = document.createElement("img");
      img.className = "live-thumb"; img.alt = "scanned code"; img.src = imageUrl;
      item.appendChild(img);
    }
    const body = document.createElement("div"); body.className = "live-body";
    const txt = document.createElement("div"); txt.className = "live-text"; txt.textContent = "Reading…";
    body.appendChild(txt); item.appendChild(body);
    const copy = document.createElement("button"); copy.className = "btn btn-ghost live-copy"; copy.type = "button"; copy.hidden = true; copy.textContent = "Copy";
    item.appendChild(copy);
    liveList.insertBefore(item, liveList.firstChild);
    let items = liveList.querySelectorAll(".live-item");
    while (items.length > LIVE_MAX) { items[items.length - 1].remove(); items = liveList.querySelectorAll(".live-item"); }
  }
  function updateLiveItem(id, text, isPlaceholder) {
    const item = liveList.querySelector('.live-item[data-ts="' + cssEsc(String(id)) + '"]');
    if (!item) return;
    item.querySelector(".live-text").textContent = text;
    if (isPlaceholder) item.setAttribute("data-placeholder", "true"); else item.removeAttribute("data-placeholder");
    const copy = item.querySelector(".live-copy");
    if (text && !isPlaceholder) { copy.hidden = false; copy.onclick = () => copyText(text, copy); }
    if (liveStatus) liveStatus.textContent = "New code received on this computer.";
  }
  $("clearLiveBtn").addEventListener("click", () => {
    liveList.querySelectorAll(".live-item").forEach((n) => n.remove());
    if (liveEmpty) show(liveEmpty);
  });
  $("copyAllBtn").addEventListener("click", (e) => {
    const texts = [];
    liveList.querySelectorAll(".live-item").forEach((item) => {
      if (item.getAttribute("data-placeholder") === "true") return;
      const t = (item.querySelector(".live-text").textContent || "").trim();
      if (t && t !== "Reading…") texts.push(t);
    });
    copyText(texts.join("\n"), e.currentTarget);
  });

  /* ---- mobile (phone) = client / publisher ---- */
  function setMobilePair(state, text) {
    const b = $("mobilePair"); if (!b) return;
    show(b); b.setAttribute("data-state", state);
    $("mobilePairText").textContent = text;
  }
  function startClient(room) {
    if (!relayAvailable) { setMobilePair("error", "Live link unavailable — scanning on the phone instead."); return; }
    if (link.role === "client" && link.client && link.room === room) { updateCaptureLabel(); return; }
    cleanupLink();
    link.role = "client"; link.room = room; link.base = TOPIC_ROOT + "/" + room;
    setMobilePair("starting", "Connecting to your PC…");
    let c;
    try { c = mqtt.connect(BROKER_URL, mqttOpts("phone")); } catch (e) { setMobilePair("error", "Couldn't connect — scanning on the phone instead."); return; }
    link.client = c;
    c.on("connect", () => {
      c.subscribe(link.base + "/presence/pc", { qos: 0 }, () => {});
      c.publish(link.base + "/presence/phone", "1", { retain: true, qos: 0 });
      setMobilePair(link.peerPresent ? "linked" : "waiting", link.peerPresent ? "Linked to your PC — codes appear there" : "Linked — waiting for your PC…");
      updateCaptureLabel();
    });
    c.on("message", (topic, payload) => {
      if (topic === link.base + "/presence/pc") {
        link.peerPresent = (payload.toString() === "1");
        setMobilePair(link.peerPresent ? "linked" : "waiting", link.peerPresent ? "Linked to your PC — codes appear there" : "Waiting for your PC…");
      }
    });
    c.on("reconnect", () => setMobilePair("starting", "Reconnecting…"));
    c.on("error", () => setMobilePair("error", "Link problem — scanning on the phone instead"));
  }
  function publishScan(text, thumb) {
    if (link.role !== "client" || !link.client) return false;
    try {
      link.client.publish(link.base + "/scan", JSON.stringify({ text: text || "", thumb: thumb || "", ts: now() }), { qos: 0 });
      return true;
    } catch (_) { return false; }
  }
  function isClient() { return link.role === "client" && link.client; }
  function updateCaptureLabel() {
    const lbl = $("captureLabel");
    if (lbl) lbl.textContent = isClient() ? "Scan code → PC" : "Scan code";
  }

  /* ================= MOBILE: focused ROI code scanner ================= */
  const captureBtn = $("captureBtn");
  const codesList = $("codesList");
  const codesEmpty = $("codesEmpty");

  function setScanMsg(text, kind) {
    const m = $("scanMsg");
    if (!m) return;
    if (!text) { hide(m); return; }
    m.textContent = text; m.setAttribute("data-kind", kind || ""); show(m);
  }
  function updateCodeCount() {
    const el = $("codeCount");
    if (el) el.textContent = String(codesList.querySelectorAll(".code-item").length);
  }
  function addCode(text) {
    if (codesEmpty) hide(codesEmpty);
    const item = document.createElement("div");
    item.className = "code-item";
    const inp = document.createElement("input");
    inp.className = "code-input"; inp.type = "text"; inp.value = text; inp.spellcheck = false;
    inp.setAttribute("aria-label", "Scanned code (editable)");
    const copy = document.createElement("button");
    copy.className = "btn btn-ghost code-copy"; copy.type = "button"; copy.textContent = "Copy";
    copy.addEventListener("click", () => copyText(inp.value, copy));
    const del = document.createElement("button");
    del.className = "btn btn-ghost code-del"; del.type = "button"; del.textContent = "✕"; del.setAttribute("aria-label", "Remove code");
    del.addEventListener("click", () => { item.remove(); updateCodeCount(); if (!codesList.querySelector(".code-item") && codesEmpty) show(codesEmpty); });
    item.appendChild(inp); item.appendChild(copy); item.appendChild(del);
    codesList.insertBefore(item, codesList.firstChild);
    updateCodeCount();
    try { if (navigator.vibrate) navigator.vibrate(55); } catch (_) {}
  }
  function cleanCode(text) {
    return (text || "").replace(/\r/g, "").replace(/\n+/g, " ").replace(/[ \t]{2,}/g, " ").trim();
  }

  // Map the on-screen ROI rectangle to raw video pixels (video is object-fit: cover),
  // crop just that region, and upscale it for the OCR engine.
  function cropROI() {
    const stage = $("cameraStage");
    const frame = stage ? stage.querySelector(".scan-frame") : null;
    if (!stage || !frame) return null;
    const VW = video.videoWidth, VH = video.videoHeight;
    if (!VW || !VH) return null;
    const sRect = stage.getBoundingClientRect();
    const fRect = frame.getBoundingClientRect();
    const CW = sRect.width, CH = sRect.height;
    if (!CW || !CH) return null;
    const scale = Math.max(CW / VW, CH / VH);
    const offX = (VW * scale - CW) / 2, offY = (VH * scale - CH) / 2;
    let sx = ((fRect.left - sRect.left) + offX) / scale;
    let sy = ((fRect.top - sRect.top) + offY) / scale;
    let sw = fRect.width / scale, sh = fRect.height / scale;
    sx = Math.max(0, Math.min(VW - 1, sx)); sy = Math.max(0, Math.min(VH - 1, sy));
    sw = Math.max(1, Math.min(VW - sx, sw)); sh = Math.max(1, Math.min(VH - sy, sh));
    const k = Math.min(3, Math.max(1, 1400 / sw)); // upscale a narrow strip toward ~1400px wide
    const c = document.createElement("canvas");
    c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  captureBtn.addEventListener("click", async () => {
    if (!stream || !video.videoWidth) { startCamera(); return; }
    const roi = cropROI();
    if (!roi) { setScanMsg("Camera not ready — hold on a second and try again.", "err"); return; }
    captureBtn.disabled = true;
    setScanMsg("Reading…", "");
    try {
      const raw = await ocrSmart(roi, $("langSelect").value, "7", null); // cloud AI, on-device fallback
      const code = cleanCode(raw);
      if (code) {
        addCode(code);
        setScanMsg("Read: " + code, "ok");
        if (isClient()) {
          const sent = publishScan(code, canvasToJpeg(roi, 240, 0.6));
          if (link.client && link.client.connected) {
            setMobilePair(link.peerPresent ? "linked" : "waiting", sent ? (link.peerPresent ? "Sent to your PC ✓" : "Sent — open the page on your PC") : "Couldn't send — check your connection");
          }
        }
      } else {
        setScanMsg("No code found — line it up inside the box, fill it, and hold steady.", "err");
      }
    } catch (e) {
      setScanMsg("Couldn't read: " + ((e && e.message) || e), "err");
    } finally {
      captureBtn.disabled = false;
    }
  });

  $("copyCodesBtn").addEventListener("click", (e) => {
    const vals = [];
    codesList.querySelectorAll(".code-input").forEach((inp) => { const v = inp.value.trim(); if (v) vals.push(v); });
    copyText(vals.join("\n"), e.currentTarget);
  });
  $("clearCodesBtn").addEventListener("click", () => {
    codesList.querySelectorAll(".code-item").forEach((n) => n.remove());
    updateCodeCount();
    if (codesEmpty) show(codesEmpty);
  });

  /* ================= DESKTOP upload ================= */
  const deskEls = { panel: $("ocrPanelDesk"), progressWrap: $("progressWrapDesk"), bar: $("progressBarDesk"), label: $("progressLabelDesk"), resultWrap: $("resultWrapDesk"), textarea: $("resultTextDesk") };
  const fileInput = $("fileInput");
  const dropZone = $("dropZone");
  const pickBtn = $("pickBtn");
  let deskBusy = false;

  pickBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { if (fileInput.files && fileInput.files[0]) handleImageFile(fileInput.files[0]); fileInput.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("dragover"); }));
  dropZone.addEventListener("drop", (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleImageFile(f); });

  async function handleImageFile(file) {
    if (deskBusy) return;
    if (!/^image\//.test(file.type)) { alert("Please choose an image file."); return; }
    deskBusy = true; pickBtn.disabled = true;
    const url = URL.createObjectURL(file);
    try { const im = await loadImage(url); await runOCRPanel(im, $("langSelectDesk").value, deskEls); }
    catch (e) { /* ignore */ }
    finally { try { URL.revokeObjectURL(url); } catch (_) {} deskBusy = false; pickBtn.disabled = false; }
  }

  /* ================= DESKTOP: open print files by code (File System Access) ================= */
  let printDir = null;   // FileSystemDirectoryHandle for e.g. D:\wael\Wael print
  const fileMap = {};    // NORMALIZED name/basename -> FileSystemFileHandle (the "database")
  const fsaSupported = (typeof window.showDirectoryPicker === "function");
  const codesInput = $("codesInput");

  // remember the chosen folder between visits (IndexedDB can store the handle)
  function idb(op, val) {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open("waelprint", 1); } catch (_) { return resolve(null); }
      req.onupgradeneeded = () => { try { req.result.createObjectStore("kv"); } catch (_) {} };
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        let tx; try { tx = db.transaction("kv", op === "set" ? "readwrite" : "readonly"); } catch (_) { return resolve(null); }
        const store = tx.objectStore("kv");
        const r = op === "set" ? store.put(val, "printDir") : store.get("printDir");
        r.onsuccess = () => resolve(op === "set" ? true : (r.result || null));
        r.onerror = () => resolve(null);
      };
    });
  }
  function setFolderStatus(state, text) { const el = $("folderStatus"); if (el) { el.textContent = text; el.setAttribute("data-state", state); } }
  function normName(s) { return String(s).trim().toUpperCase(); }
  function baseName(name) { const i = name.lastIndexOf("."); return i > 0 ? name.slice(0, i) : name; }

  // Recursively index files under the connected folder, so you can authorise a
  // parent (e.g. D:\ or D:\wael) and it still finds HG1.pdf deep inside a subfolder.
  async function refreshFileMap() {
    for (const k in fileMap) delete fileMap[k];
    if (!printDir) return 0;
    const MAX_FILES = 20000, MAX_DEPTH = 10;
    let n = 0;
    async function walk(dir, depth) {
      if (depth > MAX_DEPTH || n >= MAX_FILES) return;
      let entries;
      try { entries = dir.values(); } catch (_) { return; }
      try {
        for await (const entry of entries) {
          if (n >= MAX_FILES) return;
          if (entry.kind === "file") {
            const full = normName(entry.name), base = normName(baseName(entry.name));
            if (!fileMap[full]) fileMap[full] = entry;   // first match wins
            if (!fileMap[base]) fileMap[base] = entry;   // so HG1 -> HG1.pdf
            n++;
          } else if (entry.kind === "directory") {
            await walk(entry, depth + 1);
          }
        }
      } catch (_) {}
    }
    await walk(printDir, 0);
    return n;
  }
  async function useDir(handle, remember) {
    printDir = handle;
    setFolderStatus("scanning", "Scanning " + (handle.name || "folder") + " (incl. subfolders)…");
    const n = await refreshFileMap();
    setFolderStatus("ok", (handle.name || "Folder") + " · " + n + " file" + (n === 1 ? "" : "s") + " found");
    if (remember) { try { await idb("set", handle); } catch (_) {} }
  }
  async function connectFolder() {
    if (!fsaSupported) { setFolderStatus("err", "Open this page in Microsoft Edge or Chrome to use local files."); return; }
    try {
      const saved = await idb("get");
      if (saved && saved.requestPermission) {
        const perm = await saved.requestPermission({ mode: "read" });
        if (perm === "granted") { await useDir(saved, false); return; }
      }
      const handle = await window.showDirectoryPicker({ id: "waelprint", mode: "read" });
      await useDir(handle, true);
    } catch (e) {
      if (e && e.name === "AbortError") return;
      setFolderStatus("err", "Couldn't open the folder.");
    }
  }
  function parseCodes(text) {
    const seen = {};
    // split on ANY symbol or space (dash, comma, period, semicolon, slash, …) — keep alphanumeric codes
    return String(text || "").split(/[^a-zA-Z0-9]+/).map(normName).filter((c) => c && !seen[c] && (seen[c] = 1));
  }
  function setPrintMsg(text, kind) {
    const m = $("printMsg"); if (!m) return;
    if (!text) { hide(m); return; }
    m.textContent = text; m.setAttribute("data-kind", kind || ""); show(m);
  }
  function appendCodeToInput(code) {
    if (!codesInput) return;
    const cur = codesInput.value.trim();
    codesInput.value = (cur ? cur + " " : "") + normName(code);
  }
  // ALL files open TOGETHER in ONE new window, separate from this page. It's a
  // single pop-up (always allowed) so 2+ files reliably open at the same time.
  function groupFeatures() {
    const sw = screen.availWidth || 1280, sh = screen.availHeight || 800;
    const w = Math.floor(sw * 0.96), h = Math.floor(sh * 0.94);
    return "width=" + w + ",height=" + h + ",left=" + Math.floor((sw - w) / 2) + ",top=" + Math.floor((sh - h) / 2);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function buildViewerHtml(parts) {
    const title = escapeHtml(parts.map((p) => p.code).join(", "));
    const rows = parts.map((p) =>
      '<div class="doc"><div class="lbl">' + escapeHtml(p.code) + '</div><iframe src="' + p.url + '" title="' + escapeHtml(p.code) + '"></iframe></div>'
    ).join("");
    // side-by-side: 2 files fill the window left/right; more wrap to rows of two
    return '<!doctype html><html><head><meta charset="utf-8"><title>WaelPrint — ' + title + '</title>' +
      '<style>*{box-sizing:border-box}html,body{margin:0;padding:0;background:#2a2d34}' +
      'body{display:flex;flex-wrap:wrap;min-height:100vh}' +
      '.doc{position:relative;flex:1 1 46%;min-width:340px;height:100vh;border:1px solid #111}' +
      '.lbl{position:absolute;top:10px;left:10px;z-index:2;background:rgba(17,17,17,.85);color:#fff;font:600 13px system-ui,Arial,sans-serif;padding:4px 11px;border-radius:8px}' +
      'iframe{border:0;width:100%;height:100%;display:block;background:#fff}</style></head><body>' + rows + '</body></html>';
  }
  function writeViewer(win, parts) {
    try {
      if (parts.length === 1) { win.location.href = parts[0].url; return true; } // single -> native PDF view
      win.document.open(); win.document.write(buildViewerHtml(parts)); win.document.close(); return true;
    } catch (e) { return false; }
  }
  function groupFallback(parts) {
    const box = $("openFallback"); if (!box) return;
    box.innerHTML = "";
    const note = document.createElement("p");
    note.className = "fallback-note";
    note.textContent = "Your browser blocked the window. Click to open the file(s):";
    box.appendChild(note);
    const btn = document.createElement("button");
    btn.className = "btn btn-primary fallback-btn"; btn.type = "button";
    btn.textContent = "Open " + parts.map((p) => p.code).join(", ");
    btn.addEventListener("click", () => {
      let w = null; try { w = window.open("", "wp_group_" + now(), groupFeatures()); } catch (_) {}
      if (w) writeViewer(w, parts);
      btn.disabled = true; btn.textContent = "Opened";
    });
    box.appendChild(btn);
    show(box);
  }
  async function openFiles() {
    if (!fsaSupported) { setPrintMsg("Open this page in Edge or Chrome to open local files.", "err"); return; }
    if (!printDir) { setPrintMsg("Connect the print folder first.", "err"); return; }
    const codes = parseCodes(codesInput ? codesInput.value : "");
    if (!codes.length) { setPrintMsg("No codes to open — scan or type some (e.g. HG1-CN7).", "err"); return; }
    if (codesInput) codesInput.value = codes.join(" "); // collapse duplicates -> each file opens once
    const found = [], notFound = [];
    codes.forEach((c) => (fileMap[c] ? found : notFound).push(c));
    const fb = $("openFallback"); if (fb) { fb.innerHTML = ""; hide(fb); }
    // Pre-open the ONE separate window inside the click (single pop-up is allowed), fill after.
    let win = null;
    if (found.length) {
      try { win = window.open("", "wp_group_" + now(), groupFeatures()); } catch (_) { win = null; }
      if (win) { try { win.document.write('<!doctype html><meta charset="utf-8"><title>WaelPrint</title><body style="font:16px system-ui,Arial,sans-serif;padding:26px;color:#444;background:#f4f5fb">Loading file(s)…</body>'); win.document.close(); } catch (_) {} }
    }
    let msg = "";
    if (notFound.length) msg = (notFound.length === 1 ? "Code " : "Codes ") + notFound.join(", ") + " — out of the database";
    if (found.length) msg += (msg ? " · " : "") + "opening " + found.join(", ") + " in a new window";
    setPrintMsg(msg, notFound.length ? (found.length ? "warn" : "err") : "ok");
    const delay = (notFound.length && found.length) ? 3000 : 0; // show the "out" note first, then open
    setTimeout(async () => {
      if (!found.length) return;
      const parts = [];
      for (let i = 0; i < found.length; i++) {
        try {
          const file = await fileMap[found[i]].getFile();
          const url = URL.createObjectURL(file);
          parts.push({ code: found[i], url: url });
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 600000);
        } catch (e) { /* skip unreadable file */ }
      }
      if (!parts.length) { if (win && !win.closed) { try { win.close(); } catch (_) {} } return; }
      if (win && !win.closed && writeViewer(win, parts)) { /* opened */ }
      else groupFallback(parts);
    }, delay);
  }

  if ($("connectFolderBtn")) $("connectFolderBtn").addEventListener("click", connectFolder);
  if ($("openFilesBtn")) $("openFilesBtn").addEventListener("click", openFiles);
  if ($("clearCodesInputBtn")) $("clearCodesInputBtn").addEventListener("click", () => { if (codesInput) codesInput.value = ""; setPrintMsg("", ""); });
  if ($("refreshFolderBtn")) $("refreshFolderBtn").addEventListener("click", async () => { if (printDir) await useDir(printDir, false); });

  /* ================= copy ================= */
  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(t);
    }
    if (btn) { const old = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => (btn.textContent = old), 1400); }
  }
  function wireCopy(btn, getText) { if (btn) btn.addEventListener("click", () => copyText(getText(), btn)); }
  wireCopy($("copyBtnDesk"), () => $("resultTextDesk").value);
  wireCopy($("copyUrlBtn"), () => $("siteUrl").value);

  /* ================= QR ================= */
  function showPairQR() {
    const url = location.origin + location.pathname + "#pair=" + encodeURIComponent(link.room);
    $("siteUrl").value = url;
    renderQR(url);
  }
  function renderQR(url) {
    const holder = $("qrcode");
    holder.innerHTML = "";
    try {
      if (typeof QRCode !== "undefined") {
        new QRCode(holder, { text: url, width: 190, height: 190, colorDark: "#111111", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel ? QRCode.CorrectLevel.M : undefined });
      } else holder.innerHTML = '<span class="qr-fallback">' + url + "</span>";
    } catch (e) { holder.innerHTML = '<span class="qr-fallback">' + url + "</span>"; }
  }

  /* ================= init ================= */
  const verEl = $("version"); if (verEl) verEl.textContent = VERSION;
  // try to silently restore a previously-connected print folder
  (async () => {
    if (!fsaSupported) { setFolderStatus("err", "Open in Edge or Chrome to open local files."); return; }
    try {
      const saved = await idb("get");
      if (saved && saved.queryPermission) {
        const perm = await saved.queryPermission({ mode: "read" });
        if (perm === "granted") await useDir(saved, false);
        else setFolderStatus("idle", "Folder remembered — click Connect to allow access");
      }
    } catch (_) {}
  })();
  const first = parseHash();
  if (first.pair) pendingPairId = first.pair;
  if (first.view !== "landing") applyView(first.view);
})();
