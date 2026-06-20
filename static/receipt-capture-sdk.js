/*
 * ReceiptCaptureSDK — client-side receipt capture engine.
 *
 * Responsibilities (client side of the cloud-hybrid architecture):
 *   - Real-time rear-camera capture with macro/continuous focus + fallbacks
 *   - Centered reticle overlay (guidance UI)
 *   - DPR-aware cropping of the reticle region from the raw sensor frame
 *   - Tilted-phone skew correction (90° rotation when sensor is landscape but
 *     the layout is portrait)
 *   - Local pre-screening: luminance guardrail
 *   - Grayscale JPEG compression at quality 0.85
 *   - Multi-image vertical stitching for long receipts
 *   - Secure transmission: presigned-PUT + 2s polling pipeline
 *
 * NO fraud / dedup / DB logic lives here — the backend owns all of that. This
 * SDK only prepares and delivers an optimized media payload.
 *
 * Usage:
 *   const sdk = new ReceiptCaptureSDK({ userId: 'member-123' });
 *   await sdk.mount(document.getElementById('camMount'));
 *   await sdk.start();
 *   sdk.capture();              // adds a page; throws RangeError if too dark/bright
 *   const result = await sdk.submit();   // normalized OCR result from Textract
 *   sdk.stop();
 */
(function (global) {
  "use strict";

  const DEFAULTS = {
    reticleWidthRatio: 0.8,   // green box covers ~80% width
    reticleHeightRatio: 0.5,  // ~50% height
    idealWidth: 1920,
    idealHeight: 1080,
    jpegQuality: 0.85,
    grayscale: true,
    lumaMin: 40,              // underexposed guardrail
    lumaMax: 230,             // overexposed guardrail
    pollIntervalMs: 2000,
    maxPolls: 60,             // ~2 min ceiling
    userId: "demo-user",
    endpoints: {
      uploadUrl: "/aws/get-upload-url",
      status: "/aws/analyze-status",
    },
  };

  class ReceiptCaptureSDK {
    constructor(opts = {}) {
      this.opts = Object.assign({}, DEFAULTS, opts, {
        endpoints: Object.assign({}, DEFAULTS.endpoints, opts.endpoints || {}),
      });
      this.stream = null;
      this.video = null;
      this.reticle = null;
      this.container = null;
      this.segments = [];        // array of captured canvases (long-receipt frames)
      this._listeners = {};
    }

    /* ----------------------------------------------------------- events --- */
    on(event, cb) {
      (this._listeners[event] = this._listeners[event] || []).push(cb);
      return this;
    }
    _emit(event, payload) {
      (this._listeners[event] || []).forEach((cb) => {
        try { cb(payload); } catch (_) { /* listener errors shouldn't break flow */ }
      });
    }

    /* ------------------------------------------------- mount video + UI --- */
    async mount(container) {
      this.container = container;
      container.style.position = container.style.position || "relative";

      const video = document.createElement("video");
      // Cross-browser lifecycle safeguards for iOS Safari / mobile inline play.
      video.setAttribute("playsinline", "");
      video.setAttribute("autoplay", "");
      video.setAttribute("muted", "");
      video.playsInline = true;
      video.autoplay = true;
      video.muted = true;
      Object.assign(video.style, {
        width: "100%", height: "100%", display: "block", objectFit: "cover",
        background: "#000",
      });
      this.video = video;
      container.appendChild(video);

      // Reticle overlay — centered high-contrast green guide box.
      const reticle = document.createElement("div");
      Object.assign(reticle.style, {
        position: "absolute",
        left: ((1 - this.opts.reticleWidthRatio) / 2 * 100) + "%",
        top: ((1 - this.opts.reticleHeightRatio) / 2 * 100) + "%",
        width: (this.opts.reticleWidthRatio * 100) + "%",
        height: (this.opts.reticleHeightRatio * 100) + "%",
        border: "3px solid #22c55e",
        borderRadius: "10px",
        boxShadow: "0 0 0 100vmax rgba(0,0,0,.35)",
        pointerEvents: "none",
        boxSizing: "border-box",
      });
      this.reticle = reticle;
      container.appendChild(reticle);
      return this;
    }

    /* --------------------------------------------------- camera lifecycle -- */
    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera API unavailable. Serve over http://localhost or HTTPS.");
      }
      const { idealWidth, idealHeight } = this.opts;

      // Preferred: exact rear lens + continuous/macro focus for close-up text.
      const preferred = {
        audio: false,
        video: {
          facingMode: { exact: "environment" },
          width: { ideal: idealWidth },
          height: { ideal: idealHeight },
          advanced: [{ focusMode: "continuous" }],
        },
      };
      // Fallback: default available sensor, still prefer environment.
      const fallback = {
        audio: false,
        video: {
          facingMode: "environment",
          width: { ideal: idealWidth },
          height: { ideal: idealHeight },
        },
      };

      try {
        this.stream = await navigator.mediaDevices.getUserMedia(preferred);
      } catch (err) {
        this._emit("status", { phase: "fallback", message: "Exact rear lens unavailable — using default camera." });
        this.stream = await navigator.mediaDevices.getUserMedia(fallback);
      }

      this.video.srcObject = this.stream;
      await this.video.play().catch(() => { /* some browsers autoplay anyway */ });
      this._emit("ready", { width: this.video.videoWidth, height: this.video.videoHeight });
      return this;
    }

    stop() {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      if (this.video) this.video.srcObject = null;
    }

    /* ---------------------------------------------- core capture + crop --- */
    /**
     * Extract the reticle region from the current frame at device-pixel
     * density, run the luminance guardrail, grayscale it, and push it onto the
     * segment stack. Returns { luminance }. Throws RangeError if the frame
     * fails the luminance guardrail (nothing is added in that case).
     */
    capture() {
      const v = this.video;
      if (!v || !v.videoWidth) throw new Error("Camera not started.");

      const vRect = v.getBoundingClientRect();
      const rRect = this.reticle.getBoundingClientRect();

      // Map the reticle (in CSS px) onto the raw sensor matrix. The video uses
      // object-fit:cover, so content is scaled by `scale` and overflow-cropped.
      const scale = Math.max(v.videoWidth / vRect.width, v.videoHeight / vRect.height);
      const dispW = v.videoWidth / scale;   // displayed content size within the element
      const dispH = v.videoHeight / scale;
      const offX = (vRect.width - dispW) / 2;  // cover offset (negative => cropped)
      const offY = (vRect.height - dispH) / 2;

      let sx = ((rRect.left - vRect.left) - offX) * scale;
      let sy = ((rRect.top - vRect.top) - offY) * scale;
      let sw = rRect.width * scale;
      let sh = rRect.height * scale;

      // Clamp to the actual frame bounds.
      sx = Math.max(0, Math.min(sx, v.videoWidth));
      sy = Math.max(0, Math.min(sy, v.videoHeight));
      sw = Math.max(1, Math.min(sw, v.videoWidth - sx));
      sh = Math.max(1, Math.min(sh, v.videoHeight - sy));

      // High-density normalization: rasterize at devicePixelRatio.
      const dpr = global.devicePixelRatio || 1;
      const outW = Math.round(rRect.width * dpr);
      const outH = Math.round(rRect.height * dpr);

      // Tilted-phone skew correction: landscape sensor + portrait layout => 90° CW.
      const sensorLandscape = v.videoWidth > v.videoHeight;
      const layoutPortrait = global.innerHeight >= global.innerWidth;
      const rotate = sensorLandscape && layoutPortrait;

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (rotate) {
        canvas.width = outH;
        canvas.height = outW;
        ctx.translate(canvas.width, 0);
        ctx.rotate(Math.PI / 2);  // 90° clockwise
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, outW, outH);
      } else {
        canvas.width = outW;
        canvas.height = outH;
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, outW, outH);
      }

      // Luminance guardrail + optional grayscale, sharing one getImageData pass.
      const luminance = this._screenAndGrayscale(ctx, canvas);
      if (luminance < this.opts.lumaMin) {
        throw new RangeError(`Too dark (luminance ${Math.round(luminance)}). Add light and retake.`);
      }
      if (luminance > this.opts.lumaMax) {
        throw new RangeError(`Too bright (luminance ${Math.round(luminance)}). Reduce glare and retake.`);
      }

      this.segments.push(canvas);
      this._emit("segment", { count: this.segments.length, luminance, rotated: rotate });
      return { luminance, rotated: rotate, count: this.segments.length };
    }

    /** Compute mean Rec.709 relative luminance; grayscale in-place if enabled. */
    _screenAndGrayscale(ctx, canvas) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = img.data;
      let sum = 0;
      const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        sum += y;
        if (this.opts.grayscale) {
          const g = y | 0;
          data[i] = data[i + 1] = data[i + 2] = g;
        }
      }
      if (this.opts.grayscale) ctx.putImageData(img, 0, 0);
      return sum / n;
    }

    get segmentCount() { return this.segments.length; }
    clearSegments() { this.segments = []; }
    removeLastSegment() { this.segments.pop(); this._emit("segment", { count: this.segments.length }); }

    /* ------------------------------------------- multi-image stitching ---- */
    /** Compound all captured segments into one tall canvas. */
    stitch() {
      if (!this.segments.length) throw new Error("No captured pages to stitch.");
      if (this.segments.length === 1) return this.segments[0];
      const width = Math.max(...this.segments.map((c) => c.width));
      const height = this.segments.reduce((sum, c) => sum + c.height, 0);
      const target = document.createElement("canvas");
      target.width = width;
      target.height = height;
      const ctx = target.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      let y = 0;
      for (const seg of this.segments) {
        ctx.drawImage(seg, 0, y);  // left-aligned, stacked downward
        y += seg.height;
      }
      return target;
    }

    _toJpegBlob(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode JPEG."))),
          "image/jpeg",
          this.opts.jpegQuality
        );
      });
    }

    /* --------------------------------------- transmission + poll pipeline -- */
    /**
     * Stitch -> JPEG -> request presigned URL -> PUT bytes -> poll status.
     * Resolves with the normalized OCR result; rejects on failure/rejection.
     */
    async submit() {
      const blob = await this._toJpegBlob(this.stitch());
      this._emit("status", { phase: "requesting-url", message: "Preparing secure upload…" });

      // 1. API Gateway / Lambda hands back a (presigned) PUT URL + job id.
      const urlResp = await fetch(this.opts.endpoints.uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_type: "image/jpeg" }),
      });
      if (!urlResp.ok) throw new Error("Could not get an upload URL (HTTP " + urlResp.status + ").");
      const { job_id, upload_url } = await urlResp.json();

      // 2. Stream the compressed receipt straight to the (S3) PUT URL.
      this._emit("status", { phase: "uploading", message: "Uploading receipt…", bytes: blob.size });
      const putResp = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg", "X-User-Id": this.opts.userId },
        body: blob,
      });
      if (!putResp.ok) throw new Error("Upload failed (HTTP " + putResp.status + ").");

      // 3. Poll /analyze-status every 2s until Textract finishes.
      for (let attempt = 1; attempt <= this.opts.maxPolls; attempt++) {
        await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs));
        const sResp = await fetch(
          this.opts.endpoints.status + "?job=" + encodeURIComponent(job_id)
        );
        const s = await sResp.json();
        this._emit("status", { phase: "polling", attempt, status: s.status });
        if (s.status === "done") return s.result;
        if (s.status === "rejected") {
          const e = new Error(s.error || "Receipt rejected.");
          e.rejected = true;
          e.result = s.result;
          throw e;
        }
        if (s.status === "failed") throw new Error(s.error || "Processing failed.");
        if (s.status === "unknown") throw new Error("Job not found on server.");
      }
      throw new Error("Timed out waiting for OCR result.");
    }
  }

  global.ReceiptCaptureSDK = ReceiptCaptureSDK;
})(window);
