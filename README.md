# QR Code Tool

A small static website that does four things, entirely in the browser:

| Tab | What it does |
|---|---|
| **Generate QR** | Text, URL, email or phone number → QR code → **Download PNG** / **Copy Text** / **Clear** |
| **Scan QR** (laptop webcam) | Pick a camera, live preview, auto-detect, **Copy Result** / **Scan Again** / **Clear Result** |
| **Scan QR** (mobile) | Same screen; prefers the rear camera (`facingMode: environment`) |
| **Upload Image** | Choose or drag & drop a PNG / JPG / JPEG / WebP, preview it, decode it, copy the result |

No backend, no database, no login, no analytics, no CDN. Camera frames and images never leave the device, and nothing is stored.

---

## Project structure

```text
qr-tool/
├── index.html            Page markup (three tabs)
├── css/
│   └── style.css         Mobile-first styles
├── js/
│   ├── app.js            All application logic (generator, camera scanner, image scanner, tabs)
│   └── vendor/           Bundled third-party libraries (served locally, no CDN)
│       ├── jsQR.js            QR decoder  (jsQR 1.4.0, Apache-2.0)
│       ├── qrcode.min.js      QR generator (qrcode 1.5.4, MIT)
│       └── *.LICENSE
├── assets/
│   └── logo.svg          Logo / favicon
├── scripts/
│   └── vendor.mjs        Optional: rebuilds js/vendor from npm (only for upgrading libraries)
├── _headers              Security headers for Netlify / Cloudflare Pages
├── package.json          Dev helpers only (`npm start`, `npm run vendor`)
└── README.md
```

**Libraries:** [`qrcode`](https://github.com/soldair/node-qrcode) generates codes. [`jsQR`](https://github.com/cozmo/jsQR) decodes them. One decoder serves all three scan paths: live video frames and uploaded images are both converted to pixel data and passed to jsQR, so camera and image results behave the same.

---

## Run locally

Requires nothing but a static file server. There is **no build step**.

```bash
cd qr-tool

# Option A – Node
npm start                 # serves http://localhost:8080

# Option B – Python
python3 -m http.server 8080
```

Open **http://localhost:8080**. Browsers treat `localhost` as a secure context, so the camera works.

> Open the site through a server, not by double-clicking `index.html`. Some browsers restrict camera access on `file://` pages.

### Testing the camera on a phone during development

A phone reaching your laptop at `http://192.168.x.x:8080` is **not** a secure context, so the browser will block the camera. Use any one of these:

1. **HTTPS tunnel (easiest):** run a tunnel such as `ngrok http 8080` or `cloudflared tunnel --url http://localhost:8080` and open the printed `https://…` link on the phone.
2. **Local HTTPS certificate:**
   ```bash
   mkcert -install && mkcert localhost 192.168.x.x
   npx --yes serve . -l 8443 --ssl-cert localhost+1.pem --ssl-key localhost+1-key.pem
   ```
   Install the mkcert root CA on the phone, then open `https://192.168.x.x:8443`.
3. **Android + USB debugging:** in desktop Chrome open `chrome://inspect/#devices`, add port forwarding `8080 → localhost:8080`, then open `http://localhost:8080` on the phone. It counts as localhost.
4. **Chrome on Android flag:** `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://192.168.x.x:8080`, relaunch. Development only.

---

## Deploy to production

The site is just static files. Publish the project folder as-is (no build command, publish directory = `.`). **It must be served over HTTPS**, otherwise camera scanning is blocked by browsers. Generating codes and uploading images still work without HTTPS.

You only need to deploy `index.html`, `css/`, `js/` and `assets/` (plus `_headers` where supported). `scripts/` and `package.json` are optional.

| Host | Steps |
|---|---|
| **Netlify** | Drag the folder into *Add new site → Deploy manually*, or connect the repo with an empty build command and publish dir `.`. `_headers` is applied automatically. HTTPS is automatic. |
| **Cloudflare Pages** | Create a project from the repo, framework "None", build command empty, output dir `/`. `_headers` is applied automatically. |
| **GitHub Pages** | Push to a repo → *Settings → Pages → Deploy from branch*. HTTPS is automatic (tick *Enforce HTTPS*). Custom headers aren't supported there, which is fine; they're hardening, not a requirement. |
| **Vercel** | Import the repo, framework "Other", no build command, output dir `.`. Add headers with a `vercel.json` (see below). |
| **Nginx / Apache / any server** | Copy the files to your web root and serve over HTTPS (e.g. Let's Encrypt via `certbot`). See the Nginx example below. |

### Recommended security headers

These are already in `_headers`. For other hosts, add the equivalent:

```text
Permissions-Policy: camera=(self), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

`connect-src 'none'` makes the privacy promise enforceable: the page is not allowed to make network requests at all.

**Nginx example**

```nginx
server {
    listen 80;
    server_name qr.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name qr.example.com;

    ssl_certificate     /etc/letsencrypt/live/qr.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/qr.example.com/privkey.pem;

    root /var/www/qr-tool;
    index index.html;

    add_header Permissions-Policy "camera=(self), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;

    location / { try_files $uri $uri/ =404; }
}
```

**Vercel `vercel.json`**

```json
{
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "Permissions-Policy", "value": "camera=(self), microphone=(), geolocation=()" },
      { "key": "Content-Security-Policy", "value": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "Referrer-Policy", "value": "no-referrer" }
    ]
  }]
}
```

### Embedding in another page

If you embed the tool in an `<iframe>`, the parent must grant camera access and `frame-ancestors 'none'` must be relaxed:

```html
<iframe src="https://qr.example.com/#scan" allow="camera"></iframe>
```

---

## HTTPS and camera permissions

- Camera APIs (`navigator.mediaDevices.getUserMedia`) only exist in a **secure context**: `https://…` or `http://localhost`. On plain HTTP the app says *"Camera access requires HTTPS or localhost."*
- The camera is requested **only after you press Start Camera**, never on page load.
- The camera is stopped when you: press Stop Camera, get a result, switch tab, switch camera, hide the page or close it. The green camera light should go off each time.

**If permission was denied**, the browser will not ask again until you reset it:

| Browser | Reset |
|---|---|
| Chrome / Edge (desktop) | Click the lock/tune icon left of the address bar → *Site settings* → Camera → *Allow* → reload |
| Chrome (Android) | ⋮ → *Settings → Site settings → Camera* (or tap the lock icon in the address bar) |
| Firefox | Click the camera icon in the address bar → remove the blocked entry → reload |
| Safari (macOS) | *Safari → Settings → Websites → Camera* → set the site to *Allow* |
| Safari (iOS) | *Settings → Safari → Camera* → *Ask* or *Allow* (also check *Settings → Privacy & Security → Camera*) |

---

## Browser compatibility

| Browser | Generate | Upload image | Live camera |
|---|---|---|---|
| Chrome / Edge 90+ (desktop & Android) | ✅ | ✅ | ✅ |
| Firefox 90+ (desktop & Android) | ✅ | ✅ | ✅ |
| Safari 15+ (macOS) | ✅ | ✅ | ✅ |
| iOS Safari 15+ (iOS 14.5 works but is untested) | ✅ | ✅ | ✅ (`playsinline` is set, required on iOS) |

Notes:

- **Feature detection, not user-agent sniffing.** The app checks for `isSecureContext`, `mediaDevices.getUserMedia`, `enumerateDevices`, the Clipboard API and others, and degrades with a clear message when something is missing.
- **Copy** uses `navigator.clipboard.writeText`, with an `execCommand('copy')` fallback.
- **Camera selection:** laptops show a camera dropdown whenever more than one camera exists (labels only appear after permission is granted, which is a browser rule). Phones start on the rear camera and the dropdown lets you switch to the front one.
- **In-app browsers** (Instagram, Facebook, some email/chat apps) often block camera access. Ask the user to open the link in Safari/Chrome. *Upload Image* still works there.
- **iOS "Download PNG":** Safari saves to Files or opens a preview, depending on the iOS version. Use *Share → Save Image* from the preview if needed.
- **iOS home-screen web apps** support the camera on iOS 13.4+.
- **Photo uploads:** iPhones convert HEIC to JPEG automatically when a picker only accepts PNG/JPG/WebP, as this one does.

---

## How the scanner works

1. `getUserMedia` is called with `facingMode: { ideal: "environment" }` and a 1280×720 ideal size. If the browser rejects those constraints it retries with plain `video: true`.
2. After permission is granted, `enumerateDevices()` fills the camera dropdown.
3. About 8 times a second, a frame is drawn onto an off-screen canvas, downscaled to at most 800 px, and passed to jsQR. Every 4th pass also tries inverted (light-on-dark) codes.
4. On a hit the camera stops immediately and the result is shown. Scan Again restarts it, using the camera you selected.

Uploaded images are decoded at several sizes (native, then smaller, then enlarged for tiny images), on a white background so transparent PNGs work, trying both normal and inverted codes.

Scanned text is always inserted with `textContent` (never as HTML). A scanned value is only turned into an **Open link** if it is a single `http(s)` URL, and it opens with `rel="noopener noreferrer"`. Other schemes such as `javascript:` are never linked.

---

## Privacy

- Your camera and uploaded images are processed locally in your browser.
- No camera frames, images, scan results or generated content are sent anywhere. The app makes no network requests after loading its own files.
- Nothing is written to `localStorage`, cookies or a database. Results exist only in memory until you clear them or close the tab.

---

## Upgrading the bundled libraries (optional)

```bash
npm install            # installs qrcode, jsqr, esbuild as dev dependencies
npm run vendor         # re-creates js/vendor/qrcode.min.js and js/vendor/jsQR.js
```

`qrcode` ships no browser bundle, so `scripts/vendor.mjs` bundles its browser entry into a single global `QRCode`. Bump the versions in `package.json` first if you want newer releases.

---

## Manual test checklist

Run through this on real devices before launch:

**Generate:** type text → QR appears; try URL / Email / Phone; *Download PNG* saves `qr-code.png`; *Copy Text* shows "Copied!"; *Clear* resets. Scan the result with your phone's camera app.

**Laptop webcam:** *Start Camera* → permission prompt → live preview → hold up a QR code → result appears and the camera light goes off; *Copy Result*, *Scan Again*, *Clear Result*. With two cameras, check the dropdown switches. Deny permission → friendly error. Switch tabs while scanning → camera light goes off.

**Phone (Android Chrome, iOS Safari):** over HTTPS, *Start Camera* opens the **rear** camera; scan; copy; scan again.

**Upload:** pick a PNG/JPG/WebP; drag & drop (desktop); preview + result + *Copy Result*; a photo without a QR → "No QR code found in this image."; a `.txt` or `.pdf` → "Please upload a valid PNG, JPG, JPEG or WebP image."

---

## License

The application code in this folder is yours to use as you like. Bundled libraries keep their own licenses (see `js/vendor/*.LICENSE`): jsQR is Apache-2.0 and qrcode is MIT.
#   q r - c o d e  
 