/* ScanText — in-browser camera OCR
 * All processing is client-side (Tesseract.js). Images never leave the device.
 */
(function () {
  "use strict";

  /* ---------- tiny helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const show = (el) => { if (el) el.hidden = false; };
  const hide = (el) => { if (el) el.hidden = true; };

  const views = {
    landing: $("view-landing"),
    mobile: $("view-mobile"),
    desktop: $("view-desktop"),
  };
  const backBtn = $("backBtn");
  const liveStatus = $("ocrStatus");
  let currentView = "landing";

  /* ---------- view routing ---------- */
  function focusView(name) {
    let target = null;
    if (name === "landing") target = views.landing.querySelector("h1");
    else if (name === "desktop") target = views.desktop.querySelector("h1");
    else if (name === "mobile") target = backBtn;
    if (target) { try { target.focus({ preventScroll: true }); } catch (_) {} }
  }

  // Apply a view (idempotent) — no history side effects.
  function applyView(name) {
    if (!views[name]) name = "landing";
    Object.values(views).forEach((v) => v.classList.remove("active"));
    views[name].classList.add("active");
    currentView = name;
    backBtn.hidden = name === "landing";
    window.scrollTo(0, 0);

    if (name === "mobile") startCamera();
    else stopCamera();
    if (name === "desktop") renderQR();

    focusView(name);
  }

  // Navigate (updates the URL hash, then applies the view).
  function goTo(name) {
    const hash = name === "landing" ? "" : "#" + name;
    if (location.hash !== hash) {
      history.replaceState(null, "", hash || location.pathname + location.search);
    }
    applyView(name);
  }

  backBtn.addEventListener("click", () => goTo("landing"));
  document.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => goTo(btn.getAttribute("data-go")));
  });
  // Keep the view in sync if the hash is changed externally (manual edit / browser nav).
  window.addEventListener("hashchange", () => {
    const n = (location.hash || "").replace("#", "");
    applyView(n === "mobile" || n === "desktop" ? n : "landing");
  });

  /* ---------- device hint (which card to recommend) ---------- */
  function isMobileDevice() {
    const uaData = navigator.userAgentData;
    if (uaData && typeof uaData.mobile === "boolean") return uaData.mobile;
    const ua = navigator.userAgent || "";
    const touch = (navigator.maxTouchPoints || 0) > 1;
    return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua) || (touch && window.innerWidth < 900);
  }
  if (isMobileDevice()) show($("badge-mobile"));
  else show($("badge-desktop"));

  /* ---------- camera ---------- */
  const video = $("video");
  const camMsg = $("camMsg");
  let stream = null;
  let acquiring = false; // guards against overlapping getUserMedia calls

  function camError(title, body) {
    camMsg.innerHTML = "<strong>" + title + "</strong>" + body;
    show(camMsg);
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) video.srcObject = null;
  }

  async function startCamera() {
    hide(camMsg);
    if (acquiring) return;          // an acquisition is already in flight
    stopCamera();                   // never leak a previously-held stream
    if (!window.isSecureContext) {
      camError("Camera needs a secure connection",
        "Open this page over <b>https://</b> (the published site) to use the camera.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camError("Camera not supported", "This browser can't access the camera. Try Chrome or Safari.");
      return;
    }
    acquiring = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      // If the user left the mobile view while we were acquiring, discard the stream.
      if (currentView !== "mobile") { s.getTracks().forEach((t) => t.stop()); return; }
      stopCamera();
      stream = s;
      video.srcObject = stream;
      await video.play().catch(() => {});
    } catch (err) {
      if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
        camError("Camera permission denied",
          "Allow camera access in your browser settings, then reopen this page.");
      } else if (err && err.name === "NotFoundError") {
        camError("No camera found", "This device doesn't seem to have a camera.");
      } else {
        camError("Couldn't start the camera", (err && err.message) || "Unknown error.");
      }
    } finally {
      acquiring = false;
    }
  }

  window.addEventListener("pagehide", stopCamera);
  // Release the camera when the tab is backgrounded; re-open it on return.
  document.addEventListener("visibilitychange", () => {
    if (currentView !== "mobile") return;
    if (document.hidden) stopCamera();
    else startCamera();
  });

  /* ---------- OCR engine (shared) ---------- */
  const STATUS_LABELS = {
    "loading tesseract core": "Loading engine…",
    "initializing tesseract": "Starting engine…",
    "loading language traineddata": "Loading language…",
    "initializing api": "Initializing…",
    "recognizing text": "Reading text…",
  };

  function makeProgress(barEl, labelEl) {
    return (m) => {
      const label = STATUS_LABELS[m.status] || (m.status ? m.status[0].toUpperCase() + m.status.slice(1) : "Working…");
      if (typeof m.progress === "number") {
        const pct = Math.round(m.progress * 100);
        barEl.style.width = pct + "%";
        const track = barEl.parentElement;
        if (track) track.setAttribute("aria-valuenow", String(pct));
      }
      labelEl.textContent = label;
      if (liveStatus) liveStatus.textContent = label;
    };
  }

  async function runOCR(imageSource, lang, els) {
    if (typeof Tesseract === "undefined") {
      alert("OCR engine failed to load. Check your internet connection and refresh.");
      return;
    }
    show(els.panel);
    show(els.progressWrap);
    hide(els.resultWrap);
    els.bar.style.width = "0%";
    if (els.bar.parentElement) els.bar.parentElement.setAttribute("aria-valuenow", "0");
    els.label.textContent = "Preparing…";
    if (liveStatus) liveStatus.textContent = "Preparing…";
    els.panel.scrollIntoView({ behavior: "smooth", block: "start" });

    try {
      const { data } = await Tesseract.recognize(imageSource, lang, {
        logger: makeProgress(els.bar, els.label),
      });
      const text = (data && data.text ? data.text : "").trim();
      els.textarea.value = text;
      hide(els.progressWrap);
      show(els.resultWrap);
      if (liveStatus) liveStatus.textContent = text ? "Done. Text extracted." : "No text detected.";
      if (!text) els.textarea.placeholder = "No text detected. Try again with better lighting and a steady shot.";
    } catch (err) {
      hide(els.progressWrap);
      show(els.resultWrap);
      els.textarea.value = "";
      els.textarea.placeholder = "Something went wrong reading the image: " + ((err && err.message) || err);
      if (liveStatus) liveStatus.textContent = "Something went wrong reading the image.";
    }
  }

  /* ---------- MOBILE: capture & scan ---------- */
  const canvas = $("canvas");
  const captureBtn = $("captureBtn");
  const mobileEls = {
    panel: $("ocrPanel"),
    progressWrap: $("progressWrap"),
    bar: $("progressBar"),
    label: $("progressLabel"),
    resultWrap: $("resultWrap"),
    textarea: $("resultText"),
  };

  captureBtn.addEventListener("click", async () => {
    if (!stream || !video.videoWidth) {
      startCamera();
      return;
    }
    const w = video.videoWidth, h = video.videoHeight;
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
    captureBtn.disabled = true;
    await runOCR(canvas, $("langSelect").value, mobileEls);
    captureBtn.disabled = false;
  });

  $("rescanBtn").addEventListener("click", () => {
    hide(mobileEls.panel);
    if (!stream) startCamera();
    document.querySelector("#view-mobile .camera-stage").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  /* ---------- DESKTOP: upload & scan ---------- */
  const deskEls = {
    panel: $("ocrPanelDesk"),
    progressWrap: $("progressWrapDesk"),
    bar: $("progressBarDesk"),
    label: $("progressLabelDesk"),
    resultWrap: $("resultWrapDesk"),
    textarea: $("resultTextDesk"),
  };
  const fileInput = $("fileInput");
  const dropZone = $("dropZone");
  const pickBtn = $("pickBtn");
  let deskBusy = false; // guards against overlapping upload OCR runs

  pickBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) handleImageFile(fileInput.files[0]);
    fileInput.value = ""; // allow re-picking the same file
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("dragover"); }));
  dropZone.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleImageFile(f);
  });

  function handleImageFile(file) {
    if (deskBusy) return; // ignore picks AND drops while a scan is running
    if (!/^image\//.test(file.type)) { alert("Please choose an image file."); return; }
    deskBusy = true;
    pickBtn.disabled = true;
    runOCR(file, $("langSelectDesk").value, deskEls).finally(() => {
      deskBusy = false;
      pickBtn.disabled = false;
    });
  }

  /* ---------- copy buttons ---------- */
  function wireCopy(btn, getText) {
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const text = getText();
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        const t = document.createElement("textarea");
        t.value = text; document.body.appendChild(t); t.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(t);
      }
      const old = btn.textContent; btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = old), 1400);
    });
  }
  wireCopy($("copyBtn"), () => $("resultText").value);
  wireCopy($("copyBtnDesk"), () => $("resultTextDesk").value);
  wireCopy($("copyUrlBtn"), () => $("siteUrl").value);

  /* ---------- QR code (desktop) — uses qrcodejs (global QRCode) ---------- */
  let qrRendered = false;
  function renderQR() {
    const url = location.origin + location.pathname; // clean link, no hash
    $("siteUrl").value = url;
    if (qrRendered) return;
    const holder = $("qrcode");
    holder.innerHTML = "";
    try {
      if (typeof QRCode !== "undefined") {
        new QRCode(holder, {
          text: url,
          width: 190,
          height: 190,
          colorDark: "#111111",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel ? QRCode.CorrectLevel.M : undefined,
        });
        qrRendered = true;
      } else {
        holder.innerHTML = '<span class="qr-fallback">' + url + "</span>";
      }
    } catch (e) {
      holder.innerHTML = '<span class="qr-fallback">' + url + "</span>";
    }
  }

  /* ---------- deep-link support (#mobile / #desktop) ---------- */
  const initial = (location.hash || "").replace("#", "");
  if (initial === "mobile" || initial === "desktop") applyView(initial);
})();
