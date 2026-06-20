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
 * Guided UI (full-screen, Ibotta-style):
 *   - Edge-to-edge live preview with a corner-bracket framing guide
 *   - Top bar: close, "Photo N" counter, help, flash/torch toggle
 *   - Real-time coaching from a live analysis loop: lighting, glare, steadiness
 *   - "Ready" indicator + optional auto-capture when conditions are good
 *   - Thumbnail strip for multi-page long receipts
 *
 * High-level usage:
 *   const sdk = new ReceiptCaptureSDK({ userId, endpoints, autoCapture:true });
 *   const result = await sdk.captureFlow();   // opens UI, returns OCR result
 *   // rejects with {cancelled:true} if the user closes it,
 *   // or an Error (err.rejected / err.result) on a server rejection.
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
    glareMax: 0.12,        // fraction of near-white pixels before "reduce glare"
    motionMax: 8,          // mean abs luma delta between frames before "hold steady"
    autoCapture: true,
    autoCaptureFrames: 4,  // consecutive "ready" frames before auto-shoot (~0.9s)
    pollIntervalMs: 2000,
    maxPolls: 60,
    userId: "demo-user",
    endpoints: {
      uploadUrl: "/aws/get-upload-url",
      status: "/aws/analyze-status",
    },
  };

  const ACCENT_SEARCH = "#F5B301";  // amber while searching
  const ACCENT_READY = "#22c55e";   // green when ready

  class ReceiptCaptureSDK {
    constructor(opts = {}) {
      this.opts = Object.assign({}, DEFAULTS, opts, {
        endpoints: Object.assign({}, DEFAULTS.endpoints, opts.endpoints || {}),
      });
      this.stream = null;
      this.video = null;
      this.reticle = null;
      this.container = null;
      this.segments = [];
      this._listeners = {};
      this._ui = null;
      this._loopTimer = null;
      this._prevLuma = null;
      this._goodStreak = 0;
      this._cooldownUntil = 0;
      this._busy = false;
      this._torchOn = false;
    }

    /* ----------------------------------------------------------- events --- */
    on(event, cb) {
      (this._listeners[event] = this._listeners[event] || []).push(cb);
      return this;
    }
    _emit(event, payload) {
      (this._listeners[event] || []).forEach((cb) => {
        try { cb(payload); } catch (_) {}
      });
    }

    /* ============================ HIGH-LEVEL FLOW ====================== */
    /** Open the full-screen guided UI; resolve with the OCR result. */
    captureFlow() {
      return new Promise(async (resolve, reject) => {
        this._resolveFlow = resolve;
        this._rejectFlow = reject;
        try {
          this._buildUI();
          await this.start();
          this._startAnalysisLoop();
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
      root.style.setProperty("--rcap-accent", ACCENT_SEARCH);

      const video = document.createElement("video");
      video.className = "rcap-video";
      video.setAttribute("playsinline", "");
      video.setAttribute("autoplay", "");
      video.setAttribute("muted", "");
      video.playsInline = true; video.autoplay = true; video.muted = true;
      this.video = video;
      root.appendChild(video);

      // Framing guide: faint full border + bold corner brackets + edge labels.
      const frame = document.createElement("div");
      frame.className = "rcap-frame";
      frame.innerHTML =
        '<span class="rcap-corner tl"></span><span class="rcap-corner tr"></span>' +
        '<span class="rcap-corner bl"></span><span class="rcap-corner br"></span>' +
        '<span class="rcap-edge top">Receipt edge</span>' +
        '<span class="rcap-edge left">Receipt edge</span>' +
        '<span class="rcap-edge right">Receipt edge</span>';
      this.reticle = frame;   // capture() crops to this element's rect
      root.appendChild(frame);

      // Top bar
      const top = document.createElement("div");
      top.className = "rcap-top";
      top.innerHTML =
        '<button class="rcap-btn rcap-close" aria-label="Close">✕</button>' +
        '<div class="rcap-title"><span class="rcap-dot"></span><span class="rcap-count">Photo 1</span></div>' +
        '<div class="rcap-actions">' +
          '<button class="rcap-btn rcap-help" aria-label="Help">ⓘ</button>' +
          '<button class="rcap-btn rcap-flash" aria-label="Flash" hidden>⚡</button>' +
        '</div>';
      root.appendChild(top);

      // Coaching toast
      const coach = document.createElement("div");
      coach.className = "rcap-coach";
      root.appendChild(coach);

      // Help panel (hidden)
      const help = document.createElement("div");
      help.className = "rcap-help-panel";
      help.hidden = true;
      help.innerHTML =
        '<div class="rcap-help-card"><h3>Capturing your receipt</h3>' +
        '<ul><li>Fill the frame — get the whole receipt inside the brackets.</li>' +
        '<li>Flatten it on a dark, non-shiny surface.</li>' +
        '<li>Avoid glare and shadows; tap ⚡ for the flash.</li>' +
        '<li>Long receipt? Capture it in sections — tap the shutter for each, top to bottom.</li></ul>' +
        '<button class="rcap-btn-solid rcap-help-close">Got it</button></div>';
      root.appendChild(help);

      // Bottom: thumbnails + shutter + done
      const bottom = document.createElement("div");
      bottom.className = "rcap-bottom";
      bottom.innerHTML =
        '<div class="rcap-thumbs"></div>' +
        '<div class="rcap-shutter-row">' +
          '<button class="rcap-undo" hidden>Undo</button>' +
          '<button class="rcap-shutter" aria-label="Capture"></button>' +
          '<button class="rcap-done" hidden>Use 1 →</button>' +
        '</div>';
      root.appendChild(bottom);

      // Processing overlay (during upload/analyze)
      const proc = document.createElement("div");
      proc.className = "rcap-proc";
      proc.hidden = true;
      proc.innerHTML = '<div class="rcap-spin"></div><div class="rcap-proc-msg">Uploading…</div>';
      root.appendChild(proc);

      document.body.appendChild(root);
      this._ui = {
        root, frame, coach, help, proc,
        dot: top.querySelector(".rcap-dot"),
        count: top.querySelector(".rcap-count"),
        flash: top.querySelector(".rcap-flash"),
        thumbs: bottom.querySelector(".rcap-thumbs"),
        shutter: bottom.querySelector(".rcap-shutter"),
        undo: bottom.querySelector(".rcap-undo"),
        done: bottom.querySelector(".rcap-done"),
        procMsg: proc.querySelector(".rcap-proc-msg"),
      };

      // Wire controls
      top.querySelector(".rcap-close").onclick = () => this._cancel();
      top.querySelector(".rcap-help").onclick = () => { help.hidden = false; };
      help.querySelector(".rcap-help-close").onclick = () => { help.hidden = true; };
      this._ui.flash.onclick = () => this._toggleTorch();
      this._ui.shutter.onclick = () => this._manualCapture();
      this._ui.undo.onclick = () => this._undo();
      this._ui.done.onclick = () => this._finish();

      // Surface upload/analyze progress in the processing overlay.
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
.rcap-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;
  padding:max(14px,env(safe-area-inset-top,14px)) 14px 14px;background:linear-gradient(#000a,#0000)}
.rcap-actions{display:flex;gap:6px}
.rcap-btn{width:42px;height:42px;border:0;background:rgba(0,0,0,.35);color:#fff;border-radius:999px;
  font-size:18px;cursor:pointer;display:grid;place-items:center}
.rcap-btn[hidden]{display:none}
.rcap-flash.on{background:#F5B301;color:#1a1a1a}
.rcap-title{display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px}
.rcap-dot{width:10px;height:10px;border-radius:50%;background:#888;box-shadow:0 0 0 0 #22c55e80;transition:.2s}
.rcap-dot.ready{background:#22c55e;box-shadow:0 0 10px 2px #22c55eaa}
.rcap-coach{position:absolute;top:46%;left:50%;transform:translate(-50%,-50%);
  background:rgba(15,15,18,.82);padding:12px 18px;border-radius:14px;font-size:16px;font-weight:600;
  max-width:80%;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none}
.rcap-coach.show{opacity:1}
.rcap-bottom{position:absolute;left:0;right:0;bottom:0;padding:14px 14px max(20px,env(safe-area-inset-bottom,20px));
  background:linear-gradient(#0000,#000a)}
.rcap-thumbs{display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin-bottom:14px;min-height:0}
.rcap-thumb{width:38px;height:50px;border-radius:5px;border:2px solid #fff;object-fit:cover;background:#333}
.rcap-shutter-row{display:flex;align-items:center;justify-content:center;gap:18px;position:relative}
.rcap-shutter{width:74px;height:74px;border-radius:50%;background:#fff;border:5px solid #1DB0C9;cursor:pointer;
  transition:transform .1s}
.rcap-shutter:active{transform:scale(.92)}
.rcap-undo,.rcap-done{position:absolute;border:0;border-radius:999px;padding:11px 16px;font-weight:700;
  font-size:14px;cursor:pointer;font-family:inherit}
.rcap-undo{left:6px;background:rgba(255,255,255,.18);color:#fff}
.rcap-done{right:6px;background:#1DB0C9;color:#fff}
.rcap-done[hidden],.rcap-undo[hidden]{display:none}
.rcap-flash-anim{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:5}
.rcap-help-panel{position:absolute;inset:0;background:rgba(0,0,0,.7);display:grid;place-items:center;z-index:6;padding:24px}
.rcap-help-panel[hidden]{display:none}
.rcap-help-card{background:#fff;color:#173D53;border-radius:18px;padding:22px;max-width:340px}
.rcap-help-card h3{margin:0 0 12px;font-size:18px}
.rcap-help-card ul{margin:0 0 18px;padding-left:18px;font-size:14px;line-height:1.5;color:#444}
.rcap-btn-solid{width:100%;border:0;border-radius:999px;padding:13px;background:#2269B5;color:#fff;
  font-weight:700;font-size:15px;cursor:pointer;font-family:inherit}
.rcap-proc{position:absolute;inset:0;background:rgba(0,0,0,.78);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:16px;z-index:7}
.rcap-proc[hidden]{display:none}
.rcap-spin{width:42px;height:42px;border:4px solid #fff3;border-top-color:#1DB0C9;border-radius:50%;
  animation:rcap-spin .8s linear infinite}
.rcap-proc-msg{font-size:16px;font-weight:600}
@keyframes rcap-spin{to{transform:rotate(360deg)}}`;
      const style = document.createElement("style");
      style.id = "rcap-styles";
      style.textContent = css;
      document.head.appendChild(style);
    }

    _setAccent(ready) {
      if (!this._ui) return;
      this._ui.root.style.setProperty("--rcap-accent", ready ? ACCENT_READY : ACCENT_SEARCH);
      this._ui.dot.classList.toggle("ready", !!ready);
    }
    _setCoach(msg, ready) {
      if (!this._ui) return;
      const c = this._ui.coach;
      if (msg) { c.textContent = msg; c.classList.add("show"); }
      else { c.classList.remove("show"); }
      this._setAccent(ready);
    }
    _updateCounter() {
      if (!this._ui) return;
      this._ui.count.textContent = "Photo " + (this.segments.length + 1);
      const n = this.segments.length;
      this._ui.done.hidden = n === 0;
      this._ui.undo.hidden = n === 0;
      this._ui.done.textContent = `Use ${n} →`;
    }
    _addThumb(canvas) {
      const t = document.createElement("canvas");
      t.className = "rcap-thumb";
      t.width = 38; t.height = 50;
      t.getContext("2d").drawImage(canvas, 0, 0, 38, 50);
      this._ui.thumbs.appendChild(t);
    }
    _flashAnim() {
      const f = document.createElement("div");
      f.className = "rcap-flash-anim";
      this._ui.root.appendChild(f);
      f.animate([{ opacity: .0 }, { opacity: .85 }, { opacity: 0 }], { duration: 220 });
      setTimeout(() => f.remove(), 240);
    }

    /* ---------------------------------------------------- live analysis --- */
    _startAnalysisLoop() {
      const an = document.createElement("canvas");
      const ctx = an.getContext("2d", { willReadFrequently: true });
      this._loopTimer = setInterval(() => {
        if (this._busy || !this.video || !this.video.videoWidth) return;
        const w = 160, h = Math.max(60, Math.round(160 * this.video.videoHeight / this.video.videoWidth));
        an.width = w; an.height = h;
        ctx.drawImage(this.video, 0, 0, w, h);
        let data;
        try { data = ctx.getImageData(0, 0, w, h).data; } catch (_) { return; }

        let sum = 0, glare = 0, motion = 0;
        const n = w * h;
        const luma = new Uint8Array(n);
        for (let i = 0, p = 0; i < data.length; i += 4, p++) {
          const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          luma[p] = y; sum += y;
          if (y > 245) glare++;
        }
        const mean = sum / n;
        const glareFrac = glare / n;
        if (this._prevLuma && this._prevLuma.length === n) {
          let d = 0;
          for (let p = 0; p < n; p++) d += Math.abs(luma[p] - this._prevLuma[p]);
          motion = d / n;
        } else { motion = 999; }
        this._prevLuma = luma;

        this._evaluate(mean, glareFrac, motion);
      }, 220);
    }

    _evaluate(mean, glareFrac, motion) {
      const o = this.opts;
      let msg, ready = false;
      if (mean < o.lumaMin) msg = "Too dark — add light or tap ⚡";
      else if (mean > o.lumaMax) msg = "Too bright — reduce light";
      else if (glareFrac > o.glareMax) msg = "Glare detected — tilt the receipt";
      else if (motion > o.motionMax) msg = "Hold steady…";
      else { msg = "Looks good — hold still"; ready = true; }

      this._setCoach(msg, ready);

      if (ready) this._goodStreak++; else this._goodStreak = 0;
      if (o.autoCapture && ready && this._goodStreak >= o.autoCaptureFrames &&
          Date.now() > this._cooldownUntil) {
        this._goodStreak = 0;
        this._doCapture(true);
      }
    }

    /* ---------------------------------------------------- capture actions -- */
    _manualCapture() { this._doCapture(false); }

    _doCapture(auto) {
      if (this._busy) return;
      try {
        const r = this.capture();   // throws RangeError on luminance fail
        this._flashAnim();
        this._addThumb(this.segments[this.segments.length - 1]);
        this._updateCounter();
        this._cooldownUntil = Date.now() + 1300;   // pause auto-capture briefly
        this._setCoach(`Page ${r.count} captured` + (auto ? " (auto)" : ""), true);
      } catch (err) {
        // Luminance guardrail rejected this frame — coach instead of failing.
        this._setCoach(err.message, false);
      }
    }

    _undo() {
      this.removeLastSegment();
      if (this._ui && this._ui.thumbs.lastChild) this._ui.thumbs.lastChild.remove();
      this._updateCounter();
    }

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
          // Server rejected (e.g. unreadable / duplicate / stale) — let the user retake.
          this._setCoach(err.message, false);
          this.segments = [];
          this._ui.thumbs.innerHTML = "";
          this._updateCounter();
        } else {
          this.close();
          if (this._rejectFlow) this._rejectFlow(err);
        }
      }
    }

    _cancel() {
      this.close();
      if (this._rejectFlow) this._rejectFlow({ cancelled: true });
    }

    close() {
      this.stop();
      this._teardownUI();
    }
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
        facingMode: "environment",
        width: { ideal: idealWidth }, height: { ideal: idealHeight },
      }};
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(preferred);
      } catch (err) {
        this._emit("status", { phase: "fallback", message: "Using default camera." });
        this.stream = await navigator.mediaDevices.getUserMedia(fallback);
      }
      if (this.video) {
        this.video.srcObject = this.stream;
        await this.video.play().catch(() => {});
      }
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
      try {
        await track.applyConstraints({ advanced: [{ torch: this._torchOn }] });
        if (this._ui) this._ui.flash.classList.toggle("on", this._torchOn);
      } catch (_) {}
    }

    stop() {
      if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
      if (this.video) this.video.srcObject = null;
    }

    /* ---------------------------------------------- core capture + crop --- */
    capture() {
      const v = this.video;
      if (!v || !v.videoWidth) throw new Error("Camera not started.");
      const vRect = v.getBoundingClientRect();
      const rRect = this.reticle.getBoundingClientRect();

      const scale = Math.max(v.videoWidth / vRect.width, v.videoHeight / vRect.height);
      const dispW = v.videoWidth / scale, dispH = v.videoHeight / scale;
      const offX = (vRect.width - dispW) / 2, offY = (vRect.height - dispH) / 2;

      let sx = ((rRect.left - vRect.left) - offX) * scale;
      let sy = ((rRect.top - vRect.top) - offY) * scale;
      let sw = rRect.width * scale, sh = rRect.height * scale;
      sx = Math.max(0, Math.min(sx, v.videoWidth));
      sy = Math.max(0, Math.min(sy, v.videoHeight));
      sw = Math.max(1, Math.min(sw, v.videoWidth - sx));
      sh = Math.max(1, Math.min(sh, v.videoHeight - sy));

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
        sum += y;
        if (this.opts.grayscale) { const g = y | 0; data[i] = data[i + 1] = data[i + 2] = g; }
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
