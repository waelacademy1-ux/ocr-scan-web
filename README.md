# 📷 ScanText — Camera OCR in your browser

A tiny, install-free website that extracts text from what your camera sees.
Everything runs **client-side** ([Tesseract.js](https://tesseract.projectnaptha.com/)) — images never leave your device.

## How it works

When you open the site you pick how you're using it:

- **📱 Mobile** — opens the rear camera. Point at any document/sign, tap **Capture & scan**, and the text is extracted on the spot. Copy it with one tap.
- **🖥️ Desktop** — shows a QR code so you can open the site on your phone (where the camera lives), plus an **upload an image** fallback that runs the same OCR on any picture or screenshot.

Languages supported: **English, French, Arabic** (and combinations).

## Run locally

It's a static site — no build step. Serve the folder over HTTP(S):

```bash
# any static server works, e.g.
npx serve .
# then open the printed URL
```

> The camera only works over **https://** or **http://localhost** (a browser security rule). The published GitHub Pages URL is https, so it works there.

## Deploy

Push to GitHub and enable **Pages** (Settings → Pages → Deploy from branch → `main` / root).
The live URL will be `https://<user>.github.io/<repo>/`.

## Tech

- Plain HTML/CSS/JS, no framework, no bundler
- [Tesseract.js](https://github.com/naptha/tesseract.js) for OCR (WASM, in-browser)
- [qrcode](https://github.com/soldair/node-qrcode) for the desktop QR
- Responsive + automatic light/dark theme

## Privacy

No server, no upload, no tracking. The image you scan is processed entirely in your browser.
