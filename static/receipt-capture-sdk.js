/*
 * ReceiptCaptureSDK — client-side receipt capture engine + guided full-screen UI.
 *
 * Client side of the cloud-hybrid architecture. Prepares and delivers an
 * optimized media payload; NO fraud / dedup / DB logic lives here.
 *
 * Engine (headless):
 *   - Rear camera (macro/continuous focus) with graceful fallback
 *   - DPR-aware crop of the frame region from the raw sensor matrix
 *   - Tilted-phone skew rotation (landscape sensor + portrait layout -> 90° CW)
 *   - Luminance guardrail, grayscale JPEG @ 0.85
 *   - Multi-image vertical stitching
 *   - Presigned-PUT + 2s polling transmission pipeline
 *
 * Guided UI (full-screen, Ibotta-style), two modes:
 *   LIVE  — edge-to-edge preview, corner-bracket frame, real-time coaching
 *           (lighting / glare / steadiness), ready indicator, optional
 *           auto-capture, flash/torch toggle.
 *   REVIEW — after each shot: frozen still + "Store / Date/Time / Total" field
 *           checklist, with Retake · Use receipt photo · Long receipt? Add
 *           section. "Add section" loops back to LIVE for the next part of a
 *           long receipt; "Use receipt photo" stitches + uploads + analyzes.
 *
 * High-level usage:
 *   const sdk = new ReceiptCaptureSDK({ userId, endpoints, autoCapture:true });
 *   const result = await sdk.captureFlow();
 *   // rejects {cancelled:true} if the user closes it, or an Error on failure.
 */
(function (global) {
  "use strict";

  const DEFAULTS = {
    reticleWidthRatio: 0.88,
    reticleHeightRatio: 0.6,
    idealWidth: 1920,
    idealHeight: 1080,
    jpegQuality: 0.85,
    grayscale: true,
    lumaMin: 40,
    lumaMax: 230,
    glareMax: 0.12,
    motionMax: 8,
    autoCapture: true,
    autoCaptureFrames: 4,
    edgeDetection: true,   // OpenCV.js + jscanify: detect receipt edges + deskew
    minQuadArea: 0.12,     // detected quad must cover >=12% of the frame to count
    pollIntervalMs: 2000,
    maxPolls: 60,
    userId: "demo-user",
    endpoints: { uploadUrl: "/aws/get-upload-url", status: "/aws/analyze-status" },
    // CDN source for the (lazy-loaded) OpenCV.js WASM build (~8 MB).
    opencvUrl: "https://docs.opencv.org/4.8.0/opencv.js",
  };

  const ACCENT_SEARCH = "#F5B301";
  const ACCENT_READY = "#22c55e";

  class ReceiptCaptureSDK {
    constructor(opts = {}) {
      this.opts = Object.assign({}, DEFAULTS, opts, {
        endpoints: Object.assign({}, DEFAULTS.endpoints, opts.endpoints || {}),
      });
      this.stream = null;
      this.video = null;
      this.reticle = null;
      this.segments = [];
      this._listeners = {};
      this._ui = null;
      this._loopTimer = null;
      this._prevLuma = null;
      this._goodStreak = 0;
      this._cooldownUntil = 0;
      this._busy = false;
      this._torchOn = false;
      this._mode = "live";
      this._cvReady = false;     // OpenCV.js loaded + initialized?
      this._cvLoading = null;
      this._quad = null;         // last detected quad (in detection-canvas space)
    }

    /* ----------------------------------------------------------- events --- */
    on(event, cb) { (this._listeners[event] = this._listeners[event] || []).push(cb); return this; }
    _emit(event, payload) { (this._listeners[event] || []).forEach((cb) => { try { cb(payload); } catch (_) {} }); }

    /* ============================ HIGH-LEVEL FLOW ====================== */
    captureFlow() {
      return new Promise(async (resolve, reject) => {
        this._resolveFlow = resolve;
        this._rejectFlow = reject;
        try {
          this._buildUI();
          // Lazy-load edge detection in the background — don't block the camera.
          if (this.opts.edgeDetection) {
            this._loadCV().catch(() => { this._cvReady = false; });  // silent fallback
          }
          await this.start();
          this._startAnalysisLoop();
          this._setMode("live");
          this._setCoach("Point at your receipt", false);
        } catch (err) {
          this._teardownUI();
          reject(err);
        }
      });
    }

    /* ----------------------------------------------------- full-screen UI -- */
    _buildUI() {
      this._injectStyles();
      const root = document.createElement("div");
      root.className = "rcap-root";
      root.dataset.mode = "live";
      root.style.setProperty("--rcap-accent", ACCENT_SEARCH);

      const video = document.createElement("video");
      video.className = "rcap-video";
      video.setAttribute("playsinline", ""); video.setAttribute("autoplay", ""); video.setAttribute("muted", "");
      video.playsInline = true; video.autoplay = true; video.muted = true;
      this.video = video;
      root.appendChild(video);

      // LIVE: framing guide
      const frame = document.createElement("div");
      frame.className = "rcap-frame";
      frame.innerHTML =
        '<span class="rcap-corner tl"></span><span class="rcap-corner tr"></span>' +
        '<span class="rcap-corner bl"></span><span class="rcap-corner br"></span>' +
        '<span class="rcap-edge top">Receipt edge</span>' +
        '<span class="rcap-edge left">Receipt edge</span>' +
        '<span class="rcap-edge right">Receipt edge</span>';
      this.reticle = frame;
      root.appendChild(frame);

      // LIVE: detected-receipt polygon overlay (snaps to the real edges).
      const SVGNS = "http://www.w3.org/2000/svg";
      const detect = document.createElementNS(SVGNS, "svg");
      detect.setAttribute("class", "rcap-detect");
      detect.setAttribute("preserveAspectRatio", "none");
      const detectPoly = document.createElementNS(SVGNS, "polygon");
      detectPoly.setAttribute("points", "");
      detect.appendChild(detectPoly);
      root.appendChild(detect);

      // REVIEW: frozen still + field checklist (occupies the same framed area)
      const still = document.createElement("img");
      still.className = "rcap-still"; still.alt = "Captured section";
      root.appendChild(still);
      const checklist = document.createElement("div");
      checklist.className = "rcap-checklist";
      checklist.innerHTML =
        '<span><b>?</b> Store</span><span><b>?</b> Date/Time</span><span><b>?</b> Total</span>';
      root.appendChild(checklist);

      // Top bar
      const top = document.createElement("div");
      top.className = "rcap-top";
      top.innerHTML =
        '<button class="rcap-btn rcap-close" aria-label="Close">✕</button>' +
        '<div class="rcap-title"><span class="rcap-dot"></span><span class="rcap-count">Photo 1</span></div>' +
        '<div class="rcap-actions">' +
          '<button class="rcap-btn rcap-help" aria-label="Help">ⓘ</button>' +
          '<button class="rcap-btn rcap-flash" aria-label="Flash" hidden>⚡</button>' +
          '<button class="rcap-retake">Retake</button>' +
        '</div>';
      root.appendChild(top);

      // Coaching toast (LIVE)
      const coach = document.createElement("div");
      coach.className = "rcap-coach";
      root.appendChild(coach);

      // Help panel
      const help = document.createElement("div");
      help.className = "rcap-help-panel"; help.hidden = true;
      help.innerHTML =
        '<div class="rcap-help-card"><h3>Capturing your receipt</h3>' +
        '<ul><li>Fill the frame — get the whole receipt inside the brackets.</li>' +
        '<li>Make sure the <b>store name, date, and total</b> are readable.</li>' +
        '<li>Flatten it on a dark, non-shiny surface; avoid glare.</li>' +
        '<li>Long receipt? Use <b>Add section</b> to capture it top to bottom.</li></ul>' +
        '<button class="rcap-btn-solid rcap-help-close">Got it</button></div>';
      root.appendChild(help);

      // Bottom: LIVE shutter row + REVIEW actions
      const bottom = document.createElement("div");
      bottom.className = "rcap-bottom";
      bottom.innerHTML =
        '<div class="rcap-shutter-row"><button class="rcap-shutter" aria-label="Capture"></button></div>' +
        '<div class="rcap-review-actions">' +
          '<button class="rcap-use">↑ Use receipt photo</button>' +
          '<button class="rcap-add">Long receipt? Add section</button>' +
        '</div>';
      root.appendChild(bottom);

      // Processing overlay
      const proc = document.createElement("div");
      proc.className = "rcap-proc"; proc.hidden = true;
      proc.innerHTML = '<div class="rcap-spin"></div><div class="rcap-proc-msg">Uploading…</div>';
      root.appendChild(proc);

      document.body.appendChild(root);
      this._ui = {
        root, frame, detect, detectPoly, still, checklist, coach, help, proc,
        dot: top.querySelector(".rcap-dot"),
        count: top.querySelector(".rcap-count"),
        flash: top.querySelector(".rcap-flash"),
        shutter: bottom.querySelector(".rcap-shutter"),
        procMsg: proc.querySelector(".rcap-proc-msg"),
      };

      top.querySelector(".rcap-close").onclick = () => this._cancel();
      top.querySelector(".rcap-help").onclick = () => { help.hidden = false; };
      top.querySelector(".rcap-retake").onclick = () => this._retake();
      help.querySelector(".rcap-help-close").onclick = () => { help.hidden = true; };
      this._ui.flash.onclick = () => this._toggleTorch();
      this._ui.shutter.onclick = () => this._manualCapture();
      bottom.querySelector(".rcap-use").onclick = () => this._useReceipt();
      bottom.querySelector(".rcap-add").onclick = () => this._addSection();

      this.on("status", (s) => {
        if (this._ui && !this._ui.proc.hidden) {
          this._ui.procMsg.textContent = s.message ||
            (s.phase === "polling" ? `Analyzing on AWS… (${s.attempt})` : s.phase);
        }
      });
    }

    _injectStyles() {
      if (document.getElementById("rcap-styles")) return;
      const css = `
.rcap-root{position:fixed;inset:0;z-index:2147483000;background:#000;overflow:hidden;
  font-family:Manrope,system-ui,-apple-system,sans-serif;color:#fff;-webkit-user-select:none;user-select:none}
.rcap-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}
.rcap-frame{position:absolute;left:6%;right:6%;top:15%;bottom:24%;
  border:1px solid rgba(255,255,255,.35);border-radius:6px;pointer-events:none;transition:border-color .25s}
.rcap-corner{position:absolute;width:26px;height:26px;border:3px solid var(--rcap-accent);transition:border-color .25s}
.rcap-corner.tl{top:-2px;left:-2px;border-right:0;border-bottom:0;border-radius:8px 0 0 0}
.rcap-corner.tr{top:-2px;right:-2px;border-left:0;border-bottom:0;border-radius:0 8px 0 0}
.rcap-corner.bl{bottom:-2px;left:-2px;border-right:0;border-top:0;border-radius:0 0 0 8px}
.rcap-corner.br{bottom:-2px;right:-2px;border-left:0;border-top:0;border-radius:0 0 8px 0}
.rcap-edge{position:absolute;background:var(--rcap-accent);color:#1a1a1a;font-size:11px;font-weight:700;
  padding:3px 9px;border-radius:999px;white-space:nowrap;transition:background-color .25s}
.rcap-edge.top{top:-12px;left:50%;transform:translateX(-50%)}
.rcap-edge.left{left:-11px;top:50%;transform:translateY(-50%) rotate(180deg);writing-mode:vertical-rl}
.rcap-edge.right{right:-11px;top:50%;transform:translateY(-50%);writing-mode:vertical-rl}
.rcap-detect{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;opacity:0;transition:opacity .15s}
.rcap-detect polygon{fill:rgba(34,197,94,.12);stroke:var(--rcap-accent);stroke-width:3;
  stroke-linejoin:round;vector-effect:non-scaling-stroke}
.rcap-still{position:absolute;left:6%;top:15%;width:88%;height:61%;
  object-fit:cover;border-radius:6px;background:#111}
.rcap-checklist{position:absolute;left:50%;bottom:25%;transform:translateX(-50%);display:flex;gap:14px;
  background:rgba(15,15,18,.82);padding:9px 14px;border-radius:12px;font-size:14px;font-weight:600;white-space:nowrap}
.rcap-checklist b{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;
  background:var(--rcap-accent);color:#1a1a1a;font-size:11px;margin-right:5px;vertical-align:middle}
.rcap-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;
  padding:max(14px,env(safe-area-inset-top,14px)) 14px 14px;background:linear-gradient(#000a,#0000);z-index:4}
.rcap-actions{display:flex;gap:6px;align-items:center}
.rcap-btn{width:42px;height:42px;border:0;background:rgba(0,0,0,.35);color:#fff;border-radius:999px;
  font-size:18px;cursor:pointer;display:grid;place-items:center}
.rcap-btn[hidden]{display:none}
.rcap-flash.on{background:#F5B301;color:#1a1a1a}
.rcap-retake{border:0;background:transparent;color:#fff;font-family:inherit;font-size:16px;font-weight:700;cursor:pointer;padding:8px}
.rcap-title{display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px}
.rcap-dot{width:10px;height:10px;border-radius:50%;background:#888;transition:.2s}
.rcap-dot.ready{background:#22c55e;box-shadow:0 0 10px 2px #22c55eaa}
.rcap-coach{position:absolute;top:46%;left:50%;transform:translate(-50%,-50%);
  background:rgba(15,15,18,.82);padding:12px 18px;border-radius:14px;font-size:16px;font-weight:600;
  max-width:80%;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none;z-index:3}
.rcap-coach.show{opacity:1}
.rcap-bottom{position:absolute;left:0;right:0;bottom:0;padding:14px 14px max(20px,env(safe-area-inset-bottom,20px));
  background:linear-gradient(#0000,#000a);z-index:4}
.rcap-shutter-row{display:flex;align-items:center;justify-content:center}
.rcap-shutter{width:74px;height:74px;border-radius:50%;background:#fff;border:5px solid #1DB0C9;cursor:pointer;transition:transform .1s}
.rcap-shutter:active{transform:scale(.92)}
.rcap-review-actions{display:flex;flex-direction:column;gap:10px}
.rcap-use{border:0;border-radius:14px;padding:16px;background:#0E7C86;color:#fff;font-weight:800;font-size:16px;cursor:pointer;font-family:inherit}
.rcap-add{border:1px solid rgba(255,255,255,.6);background:transparent;border-radius:14px;padding:15px;color:#fff;font-weight:700;font-size:15px;cursor:pointer;font-family:inherit}
/* mode visibility */
.rcap-root[data-mode="live"] .rcap-still,
.rcap-root[data-mode="live"] .rcap-checklist,
.rcap-root[data-mode="live"] .rcap-review-actions,
.rcap-root[data-mode="live"] .rcap-retake{display:none}
.rcap-root[data-mode="review"] .rcap-frame,
.rcap-root[data-mode="review"] .rcap-detect,
.rcap-root[data-mode="review"] .rcap-coach,
.rcap-root[data-mode="review"] .rcap-shutter-row,
.rcap-root[data-mode="review"] .rcap-flash,
.rcap-root[data-mode="review"] .rcap-help{display:none}
.rcap-flash-anim{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:5}
.rcap-help-panel{position:absolute;inset:0;background:rgba(0,0,0,.7);display:grid;place-items:center;z-index:6;padding:24px}
.rcap-help-panel[hidden]{display:none}
.rcap-help-card{background:#fff;color:#173D53;border-radius:18px;padding:22px;max-width:340px}
.rcap-help-card h3{margin:0 0 12px;font-size:18px}
.rcap-help-card ul{margin:0 0 18px;padding-left:18px;font-size:14px;line-height:1.5;color:#444}
.rcap-btn-solid{width:100%;border:0;border-radius:999px;padding:13px;background:#2269B5;color:#fff;font-weight:700;font-size:15px;cursor:pointer;font-family:inherit}
.rcap-proc{position:absolute;inset:0;background:rgba(0,0,0,.78);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:7}
.rcap-proc[hidden]{display:none}
.rcap-spin{width:42px;height:42px;border:4px solid #fff3;border-top-color:#1DB0C9;border-radius:50%;animation:rcap-spin .8s linear infinite}
.rcap-proc-msg{font-size:16px;font-weight:600}
@keyframes rcap-spin{to{transform:rotate(360deg)}}`;
      const style = document.createElement("style");
      style.id = "rcap-styles"; style.textContent = css;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------- mode + coach -- */
    _setMode(mode) {
      this._mode = mode;
      if (this._ui) this._ui.root.dataset.mode = mode;
      if (mode === "live") {
        // Re-arm: require fresh framing before auto-capture fires again.
        this._prevLuma = null; this._goodStreak = 0;
        this._cooldownUntil = Date.now() + 1800;
        this._setCoach("Point at your receipt", false);
      }
      this._updateCounter();
    }
    _setAccent(ready) {
      if (!this._ui) return;
      this._ui.root.style.setProperty("--rcap-accent", ready ? ACCENT_READY : ACCENT_SEARCH);
      this._ui.dot.classList.toggle("ready", !!ready);
    }
    _setCoach(msg, ready) {
      if (!this._ui) return;
      const c = this._ui.coach;
      if (msg) { c.textContent = msg; c.classList.add("show"); } else { c.classList.remove("show"); }
      this._setAccent(ready);
    }
    _updateCounter() {
      if (!this._ui) return;
      const n = this._mode === "review" ? this.segments.length : this.segments.length + 1;
      this._ui.count.textContent = "Photo " + Math.max(1, n);
    }
    _flashAnim() {
      const f = document.createElement("div");
      f.className = "rcap-flash-anim";
      this._ui.root.appendChild(f);
      f.animate([{ opacity: 0 }, { opacity: .85 }, { opacity: 0 }], { duration: 220 });
      setTimeout(() => f.remove(), 240);
    }

    /* ---------------------------------------------------- live analysis --- */
    _startAnalysisLoop() {
      this._loopTimer = setInterval(() => {
        if (this._busy || this._mode !== "live" || !this.video || !this.video.videoWidth) return;
        // One cover-cropped canvas (matches what's shown on screen) feeds both
        // the lighting/steadiness checks and edge detection.
        const cap = this._coverCropCanvas(240);
        if (!cap) return;
        let data;
        try { data = cap.getContext("2d").getImageData(0, 0, cap.width, cap.height).data; }
        catch (_) { return; }
        let sum = 0, glare = 0, motion = 0;
        const n = cap.width * cap.height, luma = new Uint8Array(n);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
          const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          luma[p] = y; sum += y; if (y > 245) glare++;
        }
        const mean = sum / n, glareFrac = glare / n;
        if (this._prevLuma && this._prevLuma.length === n) {
          let d = 0; for (let p = 0; p < n; p++) d += Math.abs(luma[p] - this._prevLuma[p]); motion = d / n;
        } else { motion = 999; }
        this._prevLuma = luma;

        const quad = (this._cvReady && this.opts.edgeDetection) ? this._detectQuad(cap) : null;
        this._quad = quad;
        this._updateDetectOverlay(quad);
        this._evaluate(mean, glareFrac, motion, quad);
      }, 220);
    }

    _evaluate(mean, glareFrac, motion, quad) {
      const o = this.opts;
      const useDet = this._cvReady && o.edgeDetection;
      let msg, ready = false;
      if (useDet && (!quad || quad.areaFrac < o.minQuadArea)) msg = "Fit the whole receipt in view";
      else if (useDet && quad.areaFrac < 0.25) msg = "Move closer to the receipt";
      else if (mean < o.lumaMin) msg = "Too dark — add light or tap ⚡";
      else if (mean > o.lumaMax) msg = "Too bright — reduce light";
      else if (glareFrac > o.glareMax) msg = "Glare detected — tilt the receipt";
      else if (motion > o.motionMax) msg = "Hold steady…";
      else { msg = useDet ? "Receipt detected — hold still" : "Looks good — hold still"; ready = true; }
      this._setCoach(msg, ready);
      if (ready) this._goodStreak++; else this._goodStreak = 0;
      if (o.autoCapture && ready && this._goodStreak >= o.autoCaptureFrames && Date.now() > this._cooldownUntil) {
        this._goodStreak = 0;
        this._doCapture(true);
      }
    }

    _updateDetectOverlay(quad) {
      if (!this._ui) return;
      const svg = this._ui.detect, poly = this._ui.detectPoly;
      if (quad && quad.areaFrac >= this.opts.minQuadArea) {
        const c = quad.c;
        svg.setAttribute("viewBox", `0 0 ${quad.w} ${quad.h}`);
        poly.setAttribute("points",
          [c.topLeftCorner, c.topRightCorner, c.bottomRightCorner, c.bottomLeftCorner]
            .map((p) => `${p.x},${p.y}`).join(" "));
        svg.style.opacity = "1";
      } else {
        svg.style.opacity = "0";
      }
    }

    /* ------------------------------------------------ edge detection (CV) -- */
    _loadCV() {
      if (this._cvReady) return Promise.resolve(true);
      if (this._cvLoading) return this._cvLoading;
      const loadScript = (src) => new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = src; s.async = true; s.onload = () => res(); s.onerror = () => rej(new Error("load failed: " + src));
        document.head.appendChild(s);
      });
      this._cvLoading = (async () => {
        if (!(global.cv && global.cv.Mat)) {
          await loadScript(this.opts.opencvUrl);
          await new Promise((res, rej) => {   // OpenCV WASM finishes init after script load
            const t0 = Date.now();
            (function wait() {
              if (global.cv && global.cv.Mat) return res();
              if (Date.now() - t0 > 30000) return rej(new Error("OpenCV init timeout"));
              setTimeout(wait, 150);
            })();
          });
        }
        this._cvReady = true;
        this._emit("status", { phase: "detector-ready" });
        return true;
      })();
      return this._cvLoading;
    }

    /** Order 4 unsorted points into tl/tr/br/bl using sum/diff of coordinates. */
    _orderCorners(pts) {
      const sum = (p) => p.x + p.y, diff = (p) => p.y - p.x;
      const bySum = [...pts].sort((a, b) => sum(a) - sum(b));
      const byDiff = [...pts].sort((a, b) => diff(a) - diff(b));
      return {
        topLeftCorner: bySum[0], bottomRightCorner: bySum[3],
        topRightCorner: byDiff[0], bottomLeftCorner: byDiff[3],
      };
    }

    /** Draw the on-screen (cover-cropped) region into a canvas at most maxW wide. */
    _coverCropCanvas(maxW) {
      const v = this.video;
      if (!v || !v.videoWidth) return null;
      const VW = global.innerWidth, VH = global.innerHeight;
      const scaleCover = Math.max(VW / v.videoWidth, VH / v.videoHeight);
      const cropW = VW / scaleCover, cropH = VH / scaleCover;
      const cropX = (v.videoWidth - cropW) / 2, cropY = (v.videoHeight - cropH) / 2;
      const outW = Math.max(1, Math.min(maxW, Math.round(cropW)));
      const outH = Math.max(1, Math.round(outW * cropH / cropW));
      const cv2 = document.createElement("canvas");
      cv2.width = outW; cv2.height = outH;
      cv2.getContext("2d").drawImage(v, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
      return cv2;
    }

    /** Detect the largest receipt-like quadrilateral in a canvas via
     *  grayscale -> blur -> Canny -> contours -> 4-point convex approximation.
     *  Returns {c, areaFrac, w, h} (c = ordered corners) or null. */
    _detectQuad(canvas) {
      if (!this._cvReady || !global.cv) return null;
      const cv = global.cv;
      let src, gray, edged, k, contours, hier;
      try {
        src = cv.imread(canvas); gray = new cv.Mat(); edged = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
        cv.Canny(gray, edged, 50, 150);
        k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
        cv.dilate(edged, edged, k);   // close small gaps in the edge outline
        contours = new cv.MatVector(); hier = new cv.Mat();
        cv.findContours(edged, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        let best = null, bestArea = 0;
        for (let i = 0; i < contours.size(); i++) {
          const cnt = contours.get(i);
          const peri = cv.arcLength(cnt, true);
          const approx = new cv.Mat();
          cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const a = cv.contourArea(approx);
            if (a > bestArea) {
              bestArea = a;
              const pts = [];
              for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
              best = pts;
            }
          }
          approx.delete(); cnt.delete();
        }
        if (!best) return null;
        const areaFrac = bestArea / (canvas.width * canvas.height);
        if (!(areaFrac > 0) || areaFrac > 0.999) return null;
        return { c: this._orderCorners(best), areaFrac, w: canvas.width, h: canvas.height };
      } catch (_) { return null; }
      finally {
        [src, gray, edged, k, contours, hier].forEach((m) => { if (m && m.delete) { try { m.delete(); } catch (_) {} } });
      }
    }

    /** Capture using perspective de-warp from the detected quad. Returns true if
     *  a segment was pushed, false if no usable quad (caller falls back). */
    _captureDeskewed() {
      if (!this._cvReady || !global.cv) return false;
      const cv = global.cv;
      const cap = this._coverCropCanvas(1600);
      if (!cap) return false;
      const det = this._detectQuad(cap);
      if (!det || det.areaFrac < this.opts.minQuadArea) return false;
      const c = det.c, d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const W = Math.max(40, Math.round((d(c.topLeftCorner, c.topRightCorner) + d(c.bottomLeftCorner, c.bottomRightCorner)) / 2));
      const H = Math.max(40, Math.round((d(c.topLeftCorner, c.bottomLeftCorner) + d(c.topRightCorner, c.bottomRightCorner)) / 2));
      const out = document.createElement("canvas");
      let src, dst, sT, dT, M;
      try {
        src = cv.imread(cap); dst = new cv.Mat();
        sT = cv.matFromArray(4, 1, cv.CV_32FC2, [
          c.topLeftCorner.x, c.topLeftCorner.y, c.topRightCorner.x, c.topRightCorner.y,
          c.bottomRightCorner.x, c.bottomRightCorner.y, c.bottomLeftCorner.x, c.bottomLeftCorner.y,
        ]);
        dT = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
        M = cv.getPerspectiveTransform(sT, dT);
        cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_LINEAR,
          cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
        cv.imshow(out, dst);
      } catch (_) { return false; }
      finally { [src, dst, sT, dT, M].forEach((m) => { if (m && m.delete) { try { m.delete(); } catch (_) {} } }); }
      const ctx = out.getContext("2d");
      const luminance = this._screenAndGrayscale(ctx, out);
      if (luminance < this.opts.lumaMin) throw new RangeError(`Too dark (${Math.round(luminance)})`);
      if (luminance > this.opts.lumaMax) throw new RangeError(`Too bright (${Math.round(luminance)})`);
      this.segments.push(out);
      this._emit("segment", { count: this.segments.length, luminance, deskewed: true });
      return true;
    }

    /* ---------------------------------------------------- capture actions -- */
    _manualCapture() { if (this._mode === "live") this._doCapture(false); }

    _doCapture(auto) {
      if (this._busy || this._mode !== "live") return;
      try {
        // Prefer perspective-corrected capture from the detected edges; fall
        // back to the fixed-rect crop if no usable quad was found.
        let ok = false;
        if (this._cvReady && this.opts.edgeDetection) ok = this._captureDeskewed();
        if (!ok) this.capture();   // throws RangeError on luminance fail
        this._flashAnim();
        this._enterReview();
      } catch (err) {
        this._setCoach(err.message, false);
      }
    }

    _enterReview() {
      const last = this.segments[this.segments.length - 1];
      if (this._ui && last) {
        try { this._ui.still.src = last.toDataURL("image/jpeg", 0.85); } catch (_) {}
      }
      this._setMode("review");
    }

    _retake() {
      // Discard the just-captured section and go back to live.
      this.removeLastSegment();
      this._setMode("live");
    }

    _addSection() {
      // Keep this section; capture the next part of the long receipt.
      this._setMode("live");
    }

    _useReceipt() { this._finish(); }

    async _finish() {
      if (!this.segments.length || this._busy) return;
      this._busy = true;
      this._ui.proc.hidden = false;
      this._ui.procMsg.textContent = "Uploading…";
      try {
        const result = await this.submit();
        this.close();
        if (this._resolveFlow) this._resolveFlow(result);
      } catch (err) {
        this._busy = false;
        this._ui.proc.hidden = true;
        if (err && err.rejected) {
          // Server rejected (unreadable / duplicate / stale) — let the user retake.
          this.segments = [];
          this._setMode("live");
          this._setCoach(err.message, false);
        } else {
          this.close();
          if (this._rejectFlow) this._rejectFlow(err);
        }
      }
    }

    _cancel() { this.close(); if (this._rejectFlow) this._rejectFlow({ cancelled: true }); }

    close() { this.stop(); this._teardownUI(); }
    _teardownUI() {
      if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
      if (this._ui && this._ui.root) this._ui.root.remove();
      this._ui = null; this._prevLuma = null; this._goodStreak = 0;
    }

    /* --------------------------------------------------- camera lifecycle -- */
    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera API unavailable. Serve over HTTPS.");
      }
      const { idealWidth, idealHeight } = this.opts;
      const preferred = { audio: false, video: {
        facingMode: { exact: "environment" },
        width: { ideal: idealWidth }, height: { ideal: idealHeight },
        advanced: [{ focusMode: "continuous" }],
      }};
      const fallback = { audio: false, video: {
        facingMode: "environment", width: { ideal: idealWidth }, height: { ideal: idealHeight },
      }};
      try { this.stream = await navigator.mediaDevices.getUserMedia(preferred); }
      catch (err) { this._emit("status", { phase: "fallback", message: "Using default camera." });
        this.stream = await navigator.mediaDevices.getUserMedia(fallback); }
      if (this.video) { this.video.srcObject = this.stream; await this.video.play().catch(() => {}); }
      this._setupTorch();
      this._emit("ready", { width: this.video && this.video.videoWidth });
      return this;
    }

    _setupTorch() {
      const track = this.stream && this.stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities && track.getCapabilities();
      if (this._ui && caps && caps.torch) this._ui.flash.hidden = false;
    }
    async _toggleTorch() {
      const track = this.stream && this.stream.getVideoTracks()[0];
      const caps = track && track.getCapabilities && track.getCapabilities();
      if (!track || !caps || !caps.torch) return;
      this._torchOn = !this._torchOn;
      try { await track.applyConstraints({ advanced: [{ torch: this._torchOn }] });
        if (this._ui) this._ui.flash.classList.toggle("on", this._torchOn); } catch (_) {}
    }

    stop() {
      if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
      if (this.video) this.video.srcObject = null;
    }

    /* ---------------------------------------------- core capture + crop --- */
    capture() {
      const v = this.video;
      if (!v || !v.videoWidth) throw new Error("Camera not started.");
      const vRect = v.getBoundingClientRect(), rRect = this.reticle.getBoundingClientRect();
      const scale = Math.max(v.videoWidth / vRect.width, v.videoHeight / vRect.height);
      const dispW = v.videoWidth / scale, dispH = v.videoHeight / scale;
      const offX = (vRect.width - dispW) / 2, offY = (vRect.height - dispH) / 2;
      let sx = ((rRect.left - vRect.left) - offX) * scale;
      let sy = ((rRect.top - vRect.top) - offY) * scale;
      let sw = rRect.width * scale, sh = rRect.height * scale;
      sx = Math.max(0, Math.min(sx, v.videoWidth)); sy = Math.max(0, Math.min(sy, v.videoHeight));
      sw = Math.max(1, Math.min(sw, v.videoWidth - sx)); sh = Math.max(1, Math.min(sh, v.videoHeight - sy));

      const dpr = global.devicePixelRatio || 1;
      const outW = Math.round(rRect.width * dpr), outH = Math.round(rRect.height * dpr);
      const rotate = v.videoWidth > v.videoHeight && global.innerHeight >= global.innerWidth;

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (rotate) {
        canvas.width = outH; canvas.height = outW;
        ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2);
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, outW, outH);
      } else {
        canvas.width = outW; canvas.height = outH;
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, outW, outH);
      }
      const luminance = this._screenAndGrayscale(ctx, canvas);
      if (luminance < this.opts.lumaMin) throw new RangeError(`Too dark (${Math.round(luminance)})`);
      if (luminance > this.opts.lumaMax) throw new RangeError(`Too bright (${Math.round(luminance)})`);
      this.segments.push(canvas);
      this._emit("segment", { count: this.segments.length, luminance, rotated: rotate });
      return { luminance, rotated: rotate, count: this.segments.length };
    }

    _screenAndGrayscale(ctx, canvas) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = img.data; let sum = 0; const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        sum += y; if (this.opts.grayscale) { const g = y | 0; data[i] = data[i + 1] = data[i + 2] = g; }
      }
      if (this.opts.grayscale) ctx.putImageData(img, 0, 0);
      return sum / n;
    }

    get segmentCount() { return this.segments.length; }
    clearSegments() { this.segments = []; }
    removeLastSegment() { this.segments.pop(); this._emit("segment", { count: this.segments.length }); }

    /* ------------------------------------------- multi-image stitching ---- */
    stitch() {
      if (!this.segments.length) throw new Error("No captured pages to stitch.");
      if (this.segments.length === 1) return this.segments[0];
      const width = Math.max(...this.segments.map((c) => c.width));
      const height = this.segments.reduce((s, c) => s + c.height, 0);
      const target = document.createElement("canvas");
      target.width = width; target.height = height;
      const ctx = target.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
      let y = 0;
      for (const seg of this.segments) { ctx.drawImage(seg, 0, y); y += seg.height; }
      return target;
    }

    _toJpegBlob(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to encode JPEG."))),
          "image/jpeg", this.opts.jpegQuality);
      });
    }

    /* --------------------------------------- transmission + poll pipeline -- */
    async submit() {
      const blob = await this._toJpegBlob(this.stitch());
      this._emit("status", { phase: "requesting-url", message: "Preparing secure upload…" });
      const urlResp = await fetch(this.opts.endpoints.uploadUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_type: "image/jpeg" }),
      });
      if (!urlResp.ok) throw new Error("Could not get an upload URL (HTTP " + urlResp.status + ").");
      const { job_id, upload_url } = await urlResp.json();
      this._emit("status", { phase: "uploading", message: "Uploading receipt…", bytes: blob.size });
      const putResp = await fetch(upload_url, {
        method: "PUT", headers: { "Content-Type": "image/jpeg", "X-User-Id": this.opts.userId }, body: blob,
      });
      if (!putResp.ok) throw new Error("Upload failed (HTTP " + putResp.status + ").");
      for (let attempt = 1; attempt <= this.opts.maxPolls; attempt++) {
        await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs));
        const s = await fetch(this.opts.endpoints.status + "?job=" + encodeURIComponent(job_id)).then((r) => r.json());
        this._emit("status", { phase: "polling", attempt, status: s.status });
        if (s.status === "done") return s.result;
        if (s.status === "rejected") { const e = new Error(s.error || "Receipt rejected."); e.rejected = true; e.result = s.result; throw e; }
        if (s.status === "failed") throw new Error(s.error || "Processing failed.");
        if (s.status === "unknown") throw new Error("Job not found on server.");
      }
      throw new Error("Timed out waiting for OCR result.");
    }
  }

  global.ReceiptCaptureSDK = ReceiptCaptureSDK;
})(window);
