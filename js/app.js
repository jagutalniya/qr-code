/* ==========================================================================
   QR Code Tool — client-side QR generation and scanning.
   - Generation: qrcode (bundled in js/vendor/qrcode.min.js)
   - Decoding:   jsQR   (bundled in js/vendor/jsQR.js)
   No network requests are made. Nothing is stored.
   ========================================================================== */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 16));

  /* ======================================================================
     Shared helpers
     ====================================================================== */

  const toastEl = $('#toast');
  let toastTimer = 0;

  function toast(message, kind = 'success') {
    toastEl.textContent = message;
    toastEl.dataset.kind = kind;
    toastEl.dataset.visible = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.dataset.visible = 'false'; }, 2000);
  }

  function legacyCopy(text) {
    const buffer = document.createElement('textarea');
    buffer.className = 'copy-buffer';
    buffer.value = text;
    buffer.setAttribute('readonly', '');
    document.body.appendChild(buffer);
    buffer.select();
    buffer.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    buffer.remove();
    return ok;
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) { /* fall through to legacy method */ }
    }
    return legacyCopy(text);
  }

  async function copyWithFeedback(text) {
    if (!text) return;
    const ok = await copyToClipboard(text);
    if (ok) toast('Copied!');
    else toast('Copy failed. Select the text and copy it manually.', 'error');
  }

  /** Render a status line: kind is "info" | "loading" | "error" | "success". Empty text hides it. */
  function renderStatus(el, kind, text, title) {
    el.textContent = '';
    el.dataset.kind = kind;
    if (!text && !title) { el.hidden = true; return; }
    el.hidden = false;
    if (kind === 'loading') {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      el.appendChild(spinner);
    }
    const body = document.createElement('span');
    body.className = 'status-body';
    if (title) {
      const strong = document.createElement('strong');
      strong.textContent = title;
      body.appendChild(strong);
    }
    if (text) {
      const span = document.createElement('span');
      span.textContent = text;
      body.appendChild(span);
    }
    el.appendChild(body);
  }

  /** Returns a normalised http(s) URL string if the text is a single web link, otherwise null. */
  function safeHttpUrl(text) {
    const value = String(text).trim();
    if (!value || /\s/.test(value)) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  /** Fill a result card's text (as plain text, never HTML) and optional "open link" anchor. */
  function fillResult(textEl, linkEl, text) {
    textEl.textContent = text;
    const href = safeHttpUrl(text);
    if (href) {
      linkEl.href = href;
      linkEl.hidden = false;
    } else {
      linkEl.removeAttribute('href');
      linkEl.hidden = true;
    }
  }

  function revealAndFocus(container, headingEl) {
    try { container.scrollIntoView({ block: 'nearest' }); } catch (_) { /* ignore */ }
    headingEl.focus({ preventScroll: true });
  }

  /* ======================================================================
     1. Generate
     ====================================================================== */

  const generator = (() => {
    const typeEl = $('#gen-type');
    const inputEl = $('#gen-input');
    const labelEl = $('#gen-label');
    const errorEl = $('#gen-error');
    const outputEl = $('#gen-output');
    const canvas = $('#gen-canvas');
    const encodedEl = $('#gen-encoded');

    const QR_OPTIONS = {
      width: 1024,
      margin: 4,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' },
    };

    const TYPES = {
      text:  { label: 'Text or data',   placeholder: 'Enter any text or data',     inputMode: 'text' },
      url:   { label: 'URL',            placeholder: 'https://example.com',        inputMode: 'url' },
      email: { label: 'Email address',  placeholder: 'name@example.com',           inputMode: 'email' },
      phone: { label: 'Phone number',   placeholder: '+1 555 123 4567',            inputMode: 'tel' },
    };

    let encoded = '';
    let renderId = 0;
    let liveTimer = 0;

    /** Turns the user's input into the exact string stored in the QR code. */
    function buildPayload(type, raw) {
      const value = type === 'text' ? raw : raw.trim();
      if (!value.trim()) return { empty: true };

      switch (type) {
        case 'url': {
          if (/\s/.test(value)) return { error: 'A URL cannot contain spaces.' };
          const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
          try {
            const url = new URL(withScheme);
            if (!url.hostname) throw new Error('no host');
            return { value: withScheme };
          } catch (_) {
            return { error: 'Enter a valid URL, for example https://example.com.' };
          }
        }
        case 'email': {
          const address = value.replace(/^mailto:/i, '');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address)) {
            return { error: 'Enter a valid email address, for example name@example.com.' };
          }
          return { value: `mailto:${address}` };
        }
        case 'phone': {
          const number = value.replace(/^tel:/i, '').replace(/[\s().-]/g, '');
          if (!/^\+?\d{3,15}$/.test(number)) {
            return { error: 'Enter a valid phone number, for example +1 555 123 4567.' };
          }
          return { value: `tel:${number}` };
        }
        default:
          return { value };
      }
    }

    function showError(message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      inputEl.setAttribute('aria-invalid', 'true');
      inputEl.setAttribute('aria-describedby', 'gen-error');
    }

    function clearError() {
      errorEl.hidden = true;
      errorEl.textContent = '';
      inputEl.removeAttribute('aria-invalid');
      inputEl.removeAttribute('aria-describedby');
    }

    function hideOutput() {
      renderId += 1;
      encoded = '';
      outputEl.hidden = true;
    }

    /** @param {boolean} explicit true when the user pressed the Generate button (shows validation errors). */
    async function generate(explicit) {
      if (typeof QRCode === 'undefined') {
        showError('The QR library could not be loaded. Reload the page and try again.');
        return;
      }

      const result = buildPayload(typeEl.value, inputEl.value);

      if (result.empty) {
        hideOutput();
        if (explicit) { showError('Enter some text or data first.'); inputEl.focus(); } else clearError();
        return;
      }
      if (result.error) {
        hideOutput();
        if (explicit) showError(result.error); else clearError();
        return;
      }

      const id = ++renderId;
      try {
        await QRCode.toCanvas(canvas, result.value, QR_OPTIONS);
        if (id !== renderId) return; // a newer request superseded this one
        // The library sets inline pixel sizes; let the stylesheet control display size.
        canvas.style.width = '';
        canvas.style.height = '';
        encoded = result.value;
        encodedEl.textContent = encoded;
        outputEl.hidden = false;
        clearError();
      } catch (err) {
        if (id !== renderId) return;
        console.error(err);
        hideOutput();
        showError('This content is too long for a QR code. Try something shorter.');
        return;
      }

      // On small screens the code can be below the fold after pressing Generate.
      if (explicit && typeof outputEl.scrollIntoView === 'function') {
        outputEl.scrollIntoView({ block: 'nearest' });
      }
    }

    function applyType() {
      const meta = TYPES[typeEl.value] || TYPES.text;
      labelEl.textContent = meta.label;
      inputEl.placeholder = meta.placeholder;
      inputEl.setAttribute('inputmode', meta.inputMode);
    }

    function clear() {
      clearTimeout(liveTimer);
      inputEl.value = '';
      clearError();
      hideOutput();
      inputEl.focus();
    }

    function download() {
      if (!encoded) return;
      canvas.toBlob((blob) => {
        if (!blob) { toast('Could not create the PNG file.', 'error'); return; }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'qr-code.png';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, 'image/png');
    }

    function init() {
      applyType();

      $('#gen-btn').addEventListener('click', () => generate(true));
      $('#gen-clear').addEventListener('click', clear);
      $('#gen-download').addEventListener('click', download);
      $('#gen-copy').addEventListener('click', () => copyWithFeedback(encoded));

      typeEl.addEventListener('change', () => {
        applyType();
        clearError();
        generate(false);
      });

      // Update the QR code while typing (without nagging about half-typed input).
      inputEl.addEventListener('input', () => {
        clearTimeout(liveTimer);
        liveTimer = setTimeout(() => generate(false), 300);
      });

      inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          generate(true);
        }
      });
    }

    return { init };
  })();

  /* ======================================================================
     2. Live scanner (desktop webcam + mobile camera)
     ====================================================================== */

  const scanner = (() => {
    const viewer = $('#viewer');
    const video = $('#scan-video');
    const statusEl = $('#scan-status');
    const cameraField = $('#camera-field');
    const cameraSelect = $('#camera-select');
    const startBtn = $('#scan-start');
    const stopBtn = $('#scan-stop');
    const resultEl = $('#scan-result');
    const resultTitle = $('#scan-result-title');
    const resultText = $('#scan-result-text');
    const resultLink = $('#scan-result-link');

    const MAX_FRAME_SIDE = 800;   // downscale frames before decoding for speed
    const SCAN_INTERVAL_MS = 120; // ~8 decodes per second is plenty and keeps phones cool

    const frameCanvas = document.createElement('canvas');
    const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });

    let state = 'idle'; // idle | starting | scanning | done
    let stream = null;
    let rafId = 0;
    let session = 0;    // incremented on every start/stop so stale async work can be discarded
    let lastScan = 0;
    let scanCount = 0;
    let lastResult = '';
    let cameraCount = 0;

    /* ---- UI ---- */

    function render() {
      viewer.dataset.state = state;
      const selectable = state === 'idle' || state === 'starting' || state === 'scanning';
      startBtn.hidden = !(state === 'idle' || state === 'starting');
      startBtn.disabled = state === 'starting';
      startBtn.textContent = state === 'starting' ? 'Starting camera…' : 'Start Camera';
      stopBtn.hidden = state !== 'scanning';
      resultEl.hidden = state !== 'done';
      cameraField.hidden = !(cameraCount > 1 && selectable);
      cameraSelect.disabled = state === 'starting';
    }

    function setState(next) {
      state = next;
      render();
    }

    function describeError(error) {
      const name = error && error.name;
      switch (name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
          return {
            title: 'Camera permission required',
            text: 'Camera permission was denied. Please allow camera access in your browser settings and try again.',
          };
        case 'SecurityError':
          return {
            title: 'Camera blocked',
            text: 'Camera access requires HTTPS or localhost, and must not be blocked by the page that embeds this tool.',
          };
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          return { title: 'No camera found', text: 'No camera was detected on this device.' };
        case 'NotReadableError':
        case 'TrackStartError':
        case 'AbortError':
          return {
            title: 'Camera could not be accessed',
            text: 'Another app or browser tab may be using it. Close it and try again.',
          };
        case 'OverconstrainedError':
        case 'ConstraintNotSatisfiedError':
          return {
            title: 'Camera could not be accessed',
            text: 'The selected camera is not available. Choose another camera and try again.',
          };
        default:
          return { title: 'Camera could not be accessed', text: 'Check your browser settings and try again.' };
      }
    }

    function fail(info) {
      setState('idle');
      renderStatus(statusEl, 'error', info.text, info.title);
    }

    function supportProblem() {
      if (!window.isSecureContext) {
        return { title: 'Secure connection required', text: 'Camera access requires HTTPS or localhost.' };
      }
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        return {
          title: 'Camera not supported',
          text: 'This browser cannot access the camera. Try the latest Chrome, Edge, Firefox or Safari, or use Upload Image instead.',
        };
      }
      if (typeof jsQR === 'undefined') {
        return { title: 'Scanner unavailable', text: 'The QR decoder could not be loaded. Reload the page and try again.' };
      }
      return null;
    }

    /* ---- Camera ---- */

    function releaseCamera() {
      cancelAnimationFrame(rafId);
      rafId = 0;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      try { video.pause(); } catch (_) { /* ignore */ }
      video.srcObject = null;
    }

    async function openStream(deviceId) {
      const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
      const attempts = [];
      if (deviceId) attempts.push({ video: { deviceId: { exact: deviceId }, ...size }, audio: false });
      // Rear camera on phones; a normal webcam on laptops (the preference is simply ignored there).
      attempts.push({ video: { facingMode: { ideal: 'environment' }, ...size }, audio: false });
      attempts.push({ video: true, audio: false });

      let lastError;
      for (let i = 0; i < attempts.length; i += 1) {
        try {
          return await navigator.mediaDevices.getUserMedia(attempts[i]);
        } catch (error) {
          lastError = error;
          const name = error && error.name;
          const constraintProblem = name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError';
          const staleDevice = name === 'NotFoundError' && i === 0 && deviceId;
          if (!(constraintProblem || staleDevice)) throw error; // permission / hardware errors: stop here
        }
      }
      throw lastError;
    }

    async function refreshCameras(activeStream) {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter((device) => device.kind === 'videoinput');
        const track = activeStream && activeStream.getVideoTracks()[0];
        const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};

        cameraSelect.textContent = '';
        cameras.forEach((camera, index) => {
          const option = document.createElement('option');
          option.value = camera.deviceId;
          option.textContent = camera.label || `Camera ${index + 1}`;
          cameraSelect.appendChild(option);
        });
        if (settings.deviceId) cameraSelect.value = settings.deviceId;
        cameraCount = cameras.length;
        render();
      } catch (_) { /* the selector is a convenience; scanning still works without it */ }
    }

    async function start(deviceId) {
      const problem = supportProblem();
      if (problem) { fail(problem); return; }

      session += 1;
      const mySession = session;
      releaseCamera();
      setState('starting');
      renderStatus(statusEl, 'loading', 'Allow camera access if your browser asks.', 'Starting camera…');

      let newStream;
      try {
        newStream = await openStream(deviceId || null);
      } catch (error) {
        if (mySession !== session) return;
        console.warn('Camera error:', error);
        fail(describeError(error));
        return;
      }

      if (mySession !== session) { // user stopped or restarted while the permission prompt was open
        newStream.getTracks().forEach((track) => track.stop());
        return;
      }

      stream = newStream;
      const track = newStream.getVideoTracks()[0];
      if (track) {
        track.addEventListener('ended', () => {
          if (stream !== newStream) return;
          releaseCamera();
          fail({ title: 'Camera disconnected', text: 'The camera stopped working. Reconnect it and press Start Camera.' });
        });
      }

      video.srcObject = newStream;
      try {
        await video.play();
      } catch (error) {
        if (mySession !== session) return;
        console.warn('Video playback error:', error);
        releaseCamera();
        fail({ title: 'Camera could not be accessed', text: 'The video preview could not start. Try again.' });
        return;
      }
      if (mySession !== session) return;

      setState('scanning');
      renderStatus(statusEl, 'info', 'Point your camera at a QR code.');
      refreshCameras(newStream); // labels are only available after permission is granted

      lastScan = 0;
      scanCount = 0;
      rafId = requestAnimationFrame(tick);
    }

    function stop({ silent = false } = {}) {
      if (state !== 'scanning' && state !== 'starting') return;
      session += 1; // invalidates any pending start()
      releaseCamera();
      setState('idle');
      if (!silent) renderStatus(statusEl, 'info', 'Camera stopped. Press Start Camera to scan.');
      else renderStatus(statusEl, 'info', 'Press Start Camera to begin.');
    }

    /* ---- Decoding loop ---- */

    function tick(timestamp) {
      if (state !== 'scanning') return;
      rafId = requestAnimationFrame(tick);

      if (timestamp - lastScan < SCAN_INTERVAL_MS) return;
      lastScan = timestamp;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return;

      const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(vw, vh));
      const w = Math.max(1, Math.round(vw * scale));
      const h = Math.max(1, Math.round(vh * scale));
      if (frameCanvas.width !== w || frameCanvas.height !== h) {
        frameCanvas.width = w;
        frameCanvas.height = h;
      }

      frameCtx.drawImage(video, 0, 0, w, h);
      const frame = frameCtx.getImageData(0, 0, w, h);

      // Mostly fast "normal" decoding; every 4th pass also tries inverted (light-on-dark) codes.
      scanCount += 1;
      const code = jsQR(frame.data, w, h, {
        inversionAttempts: scanCount % 4 === 0 ? 'attemptBoth' : 'dontInvert',
      });

      if (code && code.data) onDetected(code.data);
    }

    function onDetected(text) {
      session += 1;
      releaseCamera(); // stop the camera as soon as we have a result
      lastResult = text;
      fillResult(resultText, resultLink, text);
      setState('done');
      renderStatus(statusEl, 'info', '');
      if (typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(60); } catch (_) { /* ignore */ }
      }
      revealAndFocus(resultEl, resultTitle);
    }

    /* ---- Actions ---- */

    function clearResult() {
      lastResult = '';
      resultText.textContent = '';
      resultLink.hidden = true;
      setState('idle');
      renderStatus(statusEl, 'info', 'Press Start Camera to begin.');
    }

    function scanAgain() {
      clearResult();
      start(cameraSelect.value || null);
    }

    function init() {
      render();

      const problem = supportProblem();
      if (problem && problem.title === 'Secure connection required') {
        renderStatus(statusEl, 'error', problem.text, problem.title);
      } else {
        renderStatus(statusEl, 'info', 'Press Start Camera to begin. Your browser will ask for permission.');
      }

      startBtn.addEventListener('click', () => start(cameraSelect.value || null));
      stopBtn.addEventListener('click', () => stop());
      $('#scan-copy').addEventListener('click', () => copyWithFeedback(lastResult));
      $('#scan-again').addEventListener('click', scanAgain);
      $('#scan-clear').addEventListener('click', clearResult);

      cameraSelect.addEventListener('change', () => {
        if (state === 'scanning') start(cameraSelect.value);
      });

      if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
        navigator.mediaDevices.addEventListener('devicechange', () => {
          if (stream) refreshCameras(stream);
        });
      }

      // Never leave the camera running in the background.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && (state === 'scanning' || state === 'starting')) {
          session += 1;
          releaseCamera();
          setState('idle');
          renderStatus(statusEl, 'info', 'Camera paused while the page was hidden. Press Start Camera to continue.');
        }
      });
      window.addEventListener('pagehide', releaseCamera);
    }

    return { init, stop };
  })();

  /* ======================================================================
     3. Upload image
     ====================================================================== */

  const uploader = (() => {
    const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
    const ACCEPTED_EXT = /\.(png|jpe?g|webp)$/i;
    const INVALID_TYPE_MESSAGE = 'Please upload a valid PNG, JPG, JPEG or WebP image.';

    const panel = $('#panel-upload');
    const input = $('#upload-input');
    const drop = $('#upload-drop');
    const typeError = $('#upload-type-error');
    const work = $('#upload-work');
    const preview = $('#upload-preview');
    const nameEl = $('#upload-name');
    const statusEl = $('#upload-status');
    const resultEl = $('#upload-result');
    const resultTitle = $('#upload-result-title');
    const resultText = $('#upload-result-text');
    const resultLink = $('#upload-result-link');

    let objectUrl = null;
    let job = 0;
    let lastResult = '';

    function isAccepted(file) {
      if (ACCEPTED_TYPES.includes(file.type)) return true;
      return file.type === '' && ACCEPTED_EXT.test(file.name); // some platforms omit the MIME type
    }

    function revokeUrl() {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    }

    function showTypeError(message) {
      typeError.textContent = message;
      typeError.hidden = false;
    }

    function loadImage(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image failed to load'));
        img.src = url;
      });
    }

    /** Longest-side sizes to try: native first, then smaller (smooths noise), then bigger for tiny images. */
    function candidateSizes(longest) {
      const sizes = new Set();
      sizes.add(Math.min(longest, 2000));
      [1400, 1000, 700, 450].forEach((size) => { if (size < longest) sizes.add(size); });
      if (longest < 500) { sizes.add(longest * 2); sizes.add(longest * 3); }
      return Array.from(sizes);
    }

    async function decodeImage(img, isCurrent) {
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (!nw || !nh) return null;

      const longest = Math.max(nw, nh);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      for (const target of candidateSizes(longest)) {
        if (!isCurrent()) return null;
        const scale = target / longest;
        const w = Math.max(1, Math.round(nw * scale));
        const h = Math.max(1, Math.round(nh * scale));

        canvas.width = w;  // resizing resets the context, so configure it afterwards
        canvas.height = h;
        ctx.fillStyle = '#FFFFFF'; // transparent PNGs would otherwise decode as black
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = scale < 1;
        ctx.drawImage(img, 0, 0, w, h);

        const data = ctx.getImageData(0, 0, w, h);
        const code = jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (code && code.data) return code.data;

        await nextFrame(); // keep the page responsive between attempts
      }
      return null;
    }

    function resetResult() {
      lastResult = '';
      resultEl.hidden = true;
      resultText.textContent = '';
      resultLink.hidden = true;
    }

    async function handleFile(file) {
      if (!file) return;
      typeError.hidden = true;

      if (!isAccepted(file)) {
        showTypeError(INVALID_TYPE_MESSAGE);
        return;
      }
      if (typeof jsQR === 'undefined') {
        showTypeError('The QR decoder could not be loaded. Reload the page and try again.');
        return;
      }

      const myJob = ++job;
      const isCurrent = () => myJob === job;

      resetResult();
      revokeUrl();
      objectUrl = URL.createObjectURL(file);
      preview.src = objectUrl;
      nameEl.textContent = file.name || 'Selected image';
      drop.hidden = true;
      work.hidden = false;
      renderStatus(statusEl, 'loading', '', 'Reading image…');

      let img;
      try {
        img = await loadImage(objectUrl);
      } catch (_) {
        if (!isCurrent()) return;
        renderStatus(statusEl, 'error', 'Please upload a valid image file.', 'This file could not be read');
        return;
      }
      if (!isCurrent()) return;

      await nextFrame(); // let the loading state paint before the heavy work starts

      let text = null;
      try {
        text = await decodeImage(img, isCurrent);
      } catch (error) {
        console.error(error);
      }
      if (!isCurrent()) return;

      if (text === null) {
        renderStatus(statusEl, 'error', 'Try a clearer or higher-resolution image.', 'No QR code found in this image.');
        return;
      }

      lastResult = text;
      renderStatus(statusEl, 'info', '');
      fillResult(resultText, resultLink, text);
      resultEl.hidden = false;
      revealAndFocus(resultEl, resultTitle);
    }

    function clear() {
      job += 1;
      revokeUrl();
      preview.removeAttribute('src');
      nameEl.textContent = '';
      resetResult();
      renderStatus(statusEl, 'info', '');
      typeError.hidden = true;
      work.hidden = true;
      drop.hidden = false;
    }

    function openPicker() {
      input.click();
    }

    function hasFiles(event) {
      const types = event.dataTransfer && event.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
    }

    function init() {
      $('#upload-pick').addEventListener('click', openPicker);
      $('#upload-another').addEventListener('click', openPicker);
      $('#upload-clear').addEventListener('click', clear);
      $('#upload-copy').addEventListener('click', () => copyWithFeedback(lastResult));

      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.value = ''; // allows choosing the same file again
        handleFile(file);
      });

      // Drag & drop anywhere on the upload card.
      let dragDepth = 0;
      panel.addEventListener('dragenter', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth += 1;
        panel.classList.add('is-dragover');
      });
      panel.addEventListener('dragover', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      });
      panel.addEventListener('dragleave', (event) => {
        if (!hasFiles(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) panel.classList.remove('is-dragover');
      });
      panel.addEventListener('drop', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth = 0;
        panel.classList.remove('is-dragover');
        const file = event.dataTransfer.files && event.dataTransfer.files[0];
        handleFile(file);
      });

      // Dropping a file outside the card must not make the browser navigate away to the image.
      ['dragover', 'drop'].forEach((name) => {
        window.addEventListener(name, (event) => {
          if (hasFiles(event) && !panel.contains(event.target)) event.preventDefault();
        });
      });
    }

    return { init };
  })();

  /* ======================================================================
     Tabs
     ====================================================================== */

  const TAB_NAMES = ['generate', 'scan', 'upload'];
  const tabEls = $$('[role="tab"]');
  const panelEls = TAB_NAMES.map((name) => $(`#panel-${name}`));

  function showTab(name, { updateHash = true, focusTab = false } = {}) {
    if (!TAB_NAMES.includes(name)) name = 'generate';

    tabEls.forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focusTab) tab.focus();
    });
    panelEls.forEach((panel) => { panel.hidden = panel.id !== `panel-${name}`; });

    if (name !== 'scan') scanner.stop({ silent: true }); // always release the camera when leaving

    if (updateHash) {
      try { history.replaceState(null, '', `#${name}`); } catch (_) { /* e.g. restricted contexts */ }
    }
  }

  function initTabs() {
    tabEls.forEach((tab, index) => {
      tab.addEventListener('click', () => showTab(tab.dataset.tab));
      tab.addEventListener('keydown', (event) => {
        const last = tabEls.length - 1;
        let next = null;
        if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
        else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = last;
        if (next !== null) {
          event.preventDefault();
          showTab(tabEls[next].dataset.tab, { focusTab: true });
        }
      });
    });

    window.addEventListener('hashchange', () => {
      showTab(location.hash.replace('#', ''), { updateHash: false });
    });
  }

  /* ======================================================================
     Init
     ====================================================================== */

  function init() {
    const missing = [];
    if (typeof QRCode === 'undefined') missing.push('QR generator');
    if (typeof jsQR === 'undefined') missing.push('QR decoder');
    if (missing.length) {
      const banner = $('#app-error');
      banner.textContent = `The ${missing.join(' and ')} could not be loaded. Reload the page; if the problem continues, check that the js/vendor files are deployed.`;
      banner.hidden = false;
    }

    generator.init();
    scanner.init();
    uploader.init();
    initTabs();
    showTab(location.hash.replace('#', ''), { updateHash: false });
  }

  init();
})();
