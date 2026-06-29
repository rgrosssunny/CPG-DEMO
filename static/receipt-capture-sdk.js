(function (global) {
  "use strict";

  const SDK_VERSION = "0.1.0";

  const DEFAULTS = {
    idealWidth: 1920,
    idealHeight: 1080,
    jpegQuality: 0.85,
    grayscale: true,
    lumaMin: 40,
    lumaMax: 230,
    glareMax: 0.14,
    edgeDetection: true,
    box: { left: 0.08, right: 0.92, top: 0.11 },
    alignTol: 0.12,
    contrastMin: 26,
    textureMin: 0.035,
    pollIntervalMs: 2000,
    maxPolls: 60,
    userId: "demo-user",
    endpoints: { uploadUrl: "/aws/get-upload-url", status: "/aws/analyze-status" },
    opencvUrl: "https://docs.opencv.org/4.8.0/opencv.js",
    maxUploadBytes: 20 * 1024 * 1024,
    fetchTimeoutMs: 30000,
    retryAttempts: 3,
    retryBaseMs: 1000,
    blurThreshold: 80,
    fuzzyMergeThreshold: 0.75,
  };

  const AMBER = "#F5B301";
  const GREEN = "#22c55e";

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
      this._busy = false;
      this._torchOn = false;
      this._mode = "live";
      this._cvReady = false;
      this._cvLoading = null;
      this._edges = null;
    }

    on(event, cb) { (this._listeners[event] = this._listeners[event] || []).push(cb); return this; }
    _emit(event, payload) { (this._listeners[event] || []).forEach((cb) => { try { cb(payload); } catch (_) {} }); }

    captureFlow() {
      return new Promise(async (resolve, reject) => {
        this._resolveFlow = resolve;
        this._rejectFlow = reject;
        try {
          this._buildUI();
          if (this.opts.edgeDetection) this._loadCV().catch(() => { this._cvReady = false; });
          await this.start();
          this._startAnalysisLoop();
          this._setMode("live");
        } catch (err) {
          this._teardownUI();
          reject(err);
        }
      });
    }

    _buildUI() {
      this._injectStyles();
      const root = document.createElement("div");
      root.className = "rcap-root"; root.dataset.mode = "live";

      const video = document.createElement("video");
      video.className = "rcap-video";
      video.setAttribute("playsinline", ""); video.setAttribute("autoplay", ""); video.setAttribute("muted", "");
      video.playsInline = true; video.autoplay = true; video.muted = true;
      this.video = video; root.appendChild(video);

      const mkRail = (cls) => {
        const r = document.createElement("div");
        r.className = "rcap-rail " + cls;
        r.innerHTML = '<span class="rcap-pill"><b class="badge">?</b><span class="lbl">Receipt edge</span></span>';
        r.style.display = "none";
        root.appendChild(r);
        return r;
      };
      const rails = { left: mkRail("v left"), right: mkRail("v right"),
                      bottom: mkRail("h bottom"), top: mkRail("h top") };

      const reticle = document.createElement("div");
      reticle.className = "rcap-reticle";
      root.appendChild(reticle);
      this.reticle = reticle;

      const overlap = document.createElement("canvas");
      overlap.className = "rcap-overlap"; overlap.style.display = "none";
      root.appendChild(overlap);

      const still = document.createElement("img");
      still.className = "rcap-still"; still.alt = "Captured section";
      root.appendChild(still);
      const checklist = document.createElement("div");
      checklist.className = "rcap-checklist";
      checklist.innerHTML = '<span><b>?</b> Store</span><span><b>?</b> Date/Time</span><span><b>?</b> Total</span>';
      root.appendChild(checklist);

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

      const coach = document.createElement("div");
      coach.className = "rcap-coach"; root.appendChild(coach);

      const hint = document.createElement("div");
      hint.className = "rcap-hint";
      hint.textContent = "Have a long receipt? You can add more sections next.";
      root.appendChild(hint);

      const help = document.createElement("div");
      help.className = "rcap-help-panel"; help.hidden = true;
      help.innerHTML =
        '<div class="rcap-help-card"><h3>Capturing your receipt</h3>' +
        '<ul><li>Lay it on a dark, non-shiny surface for the best edge detection.</li>' +
        '<li>The side edges turn <b>green ✓</b> when detected; tap the button to capture.</li>' +
        '<li>Long receipt? Capture the top, tap <b>Add section</b>, then line the next part up with the highlighted sliver.</li>' +
        '<li>The <b>bottom edge</b> turns green when the end of the receipt is in view.</li></ul>' +
        '<button class="rcap-btn-solid rcap-help-close">Got it</button></div>';
      root.appendChild(help);

      const bottom = document.createElement("div");
      bottom.className = "rcap-bottom";
      bottom.innerHTML =
        '<div class="rcap-shutter-row"><button class="rcap-shutter" aria-label="Capture"></button></div>' +
        '<div class="rcap-review-actions">' +
          '<button class="rcap-use">↑ Use receipt photo</button>' +
          '<button class="rcap-add">Long receipt? Add section</button>' +
        '</div>';
      root.appendChild(bottom);

      const proc = document.createElement("div");
      proc.className = "rcap-proc"; proc.hidden = true;
      proc.innerHTML = '<div class="rcap-spin"></div><div class="rcap-proc-msg">Uploading…</div>';
      root.appendChild(proc);

      const errp = document.createElement("div");
      errp.className = "rcap-errpanel"; errp.hidden = true;
      errp.innerHTML =
        '<div class="rcap-err-card"><div class="rcap-err-icon">⚠️</div>' +
        '<div class="rcap-err-msg"></div>' +
        '<button class="rcap-btn-solid rcap-err-retake">Retake</button>' +
        '<button class="rcap-add rcap-err-close">Close</button></div>';
      root.appendChild(errp);

      document.body.appendChild(root);
      this._ui = {
        root, rails, overlap, still, checklist, coach, help, proc, errp,
        dot: top.querySelector(".rcap-dot"), count: top.querySelector(".rcap-count"),
        flash: top.querySelector(".rcap-flash"),
        shutter: bottom.querySelector(".rcap-shutter"), procMsg: proc.querySelector(".rcap-proc-msg"),
        errMsg: errp.querySelector(".rcap-err-msg"),
      };

      top.querySelector(".rcap-close").onclick = () => this._cancel();
      top.querySelector(".rcap-help").onclick = () => { help.hidden = false; };
      top.querySelector(".rcap-retake").onclick = () => this._retake();
      help.querySelector(".rcap-help-close").onclick = () => { help.hidden = true; };
      this._ui.flash.onclick = () => this._toggleTorch();
      this._ui.shutter.onclick = () => this._manualCapture();
      bottom.querySelector(".rcap-use").onclick = () => this._useReceipt();
      bottom.querySelector(".rcap-add").onclick = () => this._addSection();
      errp.querySelector(".rcap-err-retake").onclick = () => { errp.hidden = true; this.segments = []; this._setMode("live"); };
      errp.querySelector(".rcap-err-close").onclick = () => this._cancel();

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
.rcap-reticle{position:absolute;top:11%;bottom:0;left:8%;right:8%;pointer-events:none}
.rcap-rail{position:absolute;z-index:3;pointer-events:none}
.rcap-rail.v{top:11%;bottom:0;width:0;border-left:3px solid ${AMBER}}
.rcap-rail.v.on{border-left-color:${GREEN}}
.rcap-rail.v.left{left:8%}
.rcap-rail.v.right{left:92%}
.rcap-rail.h{left:8%;width:84%;height:0;border-top:3px solid ${AMBER}}
.rcap-rail.h.on{border-top-color:${GREEN}}
.rcap-rail.top{top:11%}
.rcap-pill{position:absolute;background:${AMBER};color:#1a1a1a;font-size:11px;font-weight:700;
  padding:5px 9px;border-radius:999px;white-space:nowrap;display:flex;align-items:center;gap:5px}
.rcap-rail.on .rcap-pill{background:${GREEN};color:#fff}
.rcap-pill .badge{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;
  background:rgba(0,0,0,.18);font-size:10px;line-height:1}
.rcap-rail.v .rcap-pill{top:42%;writing-mode:vertical-rl}
.rcap-rail.v.left .rcap-pill{left:5px;transform:rotate(180deg)}
.rcap-rail.v.right .rcap-pill{right:5px}
.rcap-rail.h .rcap-pill{left:50%;top:6px;transform:translateX(-50%)}
.rcap-overlap{position:absolute;top:9%;left:8%;right:8%;height:60px;object-fit:cover;object-position:bottom;
  z-index:4;border-bottom:2px dashed ${GREEN};filter:hue-rotate(280deg) saturate(1.4);opacity:.92}
.rcap-still{position:absolute;top:9%;left:8%;right:8%;height:78%;object-fit:contain;border-radius:6px;background:#111}
.rcap-checklist{position:absolute;left:50%;top:82%;transform:translateX(-50%);display:flex;gap:14px;
  background:rgba(15,15,18,.82);padding:9px 14px;border-radius:12px;font-size:14px;font-weight:600;white-space:nowrap}
.rcap-checklist b{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;
  background:${AMBER};color:#1a1a1a;font-size:11px;margin-right:5px;vertical-align:middle}
.rcap-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;
  padding:max(14px,env(safe-area-inset-top,14px)) 14px 14px;background:linear-gradient(#000a,#0000);z-index:6}
.rcap-actions{display:flex;gap:6px;align-items:center}
.rcap-btn{width:42px;height:42px;border:0;background:rgba(0,0,0,.35);color:#fff;border-radius:999px;
  font-size:18px;cursor:pointer;display:grid;place-items:center}
.rcap-btn[hidden]{display:none}
.rcap-flash.on{background:${AMBER};color:#1a1a1a}
.rcap-retake{border:0;background:transparent;color:#fff;font-family:inherit;font-size:16px;font-weight:700;cursor:pointer;padding:8px}
.rcap-title{display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px}
.rcap-dot{width:10px;height:10px;border-radius:50%;background:#888;transition:.2s}
.rcap-dot.ready{background:${GREEN};box-shadow:0 0 10px 2px ${GREEN}aa}
.rcap-coach{position:absolute;top:44%;left:50%;transform:translate(-50%,-50%);
  background:rgba(15,15,18,.82);padding:12px 18px;border-radius:14px;font-size:16px;font-weight:600;
  max-width:80%;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none;z-index:3}
.rcap-coach.show{opacity:1}
.rcap-hint{position:absolute;left:50%;bottom:118px;transform:translateX(-50%);
  background:rgba(0,0,0,.5);color:#fff;font-size:13px;font-weight:600;padding:7px 14px;border-radius:999px;
  max-width:88vw;text-align:center;z-index:3}
.rcap-bottom{position:absolute;left:0;right:0;bottom:0;padding:14px 14px max(20px,env(safe-area-inset-bottom,20px));
  background:linear-gradient(#0000,#000a);z-index:6}
.rcap-shutter-row{display:flex;align-items:center;justify-content:center}
.rcap-shutter{width:74px;height:74px;border-radius:50%;background:#fff;border:5px solid #1DB0C9;cursor:pointer;transition:transform .1s}
.rcap-shutter:active{transform:scale(.92)}
.rcap-review-actions{display:flex;flex-direction:column;gap:10px}
.rcap-use{border:0;border-radius:14px;padding:16px;background:#0E7C86;color:#fff;font-weight:800;font-size:16px;cursor:pointer;font-family:inherit}
.rcap-add{border:1px solid rgba(255,255,255,.6);background:transparent;border-radius:14px;padding:15px;color:#fff;font-weight:700;font-size:15px;cursor:pointer;font-family:inherit}
.rcap-root[data-mode="live"] .rcap-still,
.rcap-root[data-mode="live"] .rcap-checklist,
.rcap-root[data-mode="live"] .rcap-review-actions,
.rcap-root[data-mode="live"] .rcap-retake{display:none}
.rcap-root[data-mode="review"] .rcap-rail,
.rcap-root[data-mode="review"] .rcap-overlap,
.rcap-root[data-mode="review"] .rcap-reticle,
.rcap-root[data-mode="review"] .rcap-coach,
.rcap-root[data-mode="review"] .rcap-hint,
.rcap-root[data-mode="review"] .rcap-shutter-row,
.rcap-root[data-mode="review"] .rcap-flash,
.rcap-root[data-mode="review"] .rcap-help{display:none}
.rcap-flash-anim{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:5}
.rcap-help-panel{position:absolute;inset:0;background:rgba(0,0,0,.7);display:grid;place-items:center;z-index:7;padding:24px}
.rcap-help-panel[hidden]{display:none}
.rcap-help-card{background:#fff;color:#173D53;border-radius:18px;padding:22px;max-width:340px}
.rcap-help-card h3{margin:0 0 12px;font-size:18px}
.rcap-help-card ul{margin:0 0 18px;padding-left:18px;font-size:14px;line-height:1.5;color:#444}
.rcap-btn-solid{width:100%;border:0;border-radius:999px;padding:13px;background:#2269B5;color:#fff;font-weight:700;font-size:15px;cursor:pointer;font-family:inherit}
.rcap-proc{position:absolute;inset:0;background:rgba(0,0,0,.78);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:8}
.rcap-proc[hidden]{display:none}
.rcap-errpanel{position:absolute;inset:0;background:rgba(0,0,0,.82);display:grid;place-items:center;z-index:9;padding:24px}
.rcap-errpanel[hidden]{display:none}
.rcap-err-card{background:#fff;color:#173D53;border-radius:18px;padding:24px 22px;max-width:340px;text-align:center}
.rcap-err-icon{font-size:40px;margin-bottom:8px}
.rcap-err-msg{font-size:15px;font-weight:600;line-height:1.45;margin-bottom:18px}
.rcap-err-card .rcap-add{color:#173D53;border-color:#cbd5e1;margin-top:10px}
.rcap-spin{width:42px;height:42px;border:4px solid #fff3;border-top-color:#1DB0C9;border-radius:50%;animation:rcap-spin .8s linear infinite}
.rcap-proc-msg{font-size:16px;font-weight:600}
@keyframes rcap-spin{to{transform:rotate(360deg)}}`;
      const style = document.createElement("style");
      style.id = "rcap-styles"; style.textContent = css;
      document.head.appendChild(style);
    }

    _setMode(mode) {
      this._mode = mode;
      if (this._ui) this._ui.root.dataset.mode = mode;
      this._showOverlap();
      this._updateCounter();
    }
    _updateCounter() {
      if (!this._ui) return;
      const n = this._mode === "review" ? this.segments.length : this.segments.length + 1;
      this._ui.count.textContent = "Photo " + Math.max(1, n);
    }
    _coach(msg) {
      if (!this._ui) return;
      const c = this._ui.coach;
      if (msg) { c.textContent = msg; c.classList.add("show"); } else { c.classList.remove("show"); }
    }
    _showOverlap() {
      if (!this._ui) return;
      const ov = this._ui.overlap;
      if (this._mode === "live" && this.segments.length > 0) {
        const last = this.segments[this.segments.length - 1];
        const sliceH = Math.max(1, Math.round(last.height * 0.18));
        ov.width = last.width; ov.height = sliceH;
        ov.getContext("2d").drawImage(last, 0, last.height - sliceH, last.width, sliceH, 0, 0, last.width, sliceH);
        ov.style.display = "block";
        this._ui.root.dataset.cont = "1";
      } else {
        ov.style.display = "none";
        this._ui.root.dataset.cont = "";
      }
    }
    _flashAnim() {
      const f = document.createElement("div");
      f.className = "rcap-flash-anim";
      this._ui.root.appendChild(f);
      f.animate([{ opacity: 0 }, { opacity: .85 }, { opacity: 0 }], { duration: 220 });
      setTimeout(() => f.remove(), 240);
    }

    _startAnalysisLoop() {
      this._loopTimer = setInterval(() => {
        if (this._busy || this._mode !== "live" || !this.video || !this.video.videoWidth) return;
        const cap = this._coverCropCanvas(240);
        if (!cap) return;
        let data;
        try { data = cap.getContext("2d").getImageData(0, 0, cap.width, cap.height).data; }
        catch (_) { return; }
        let sum = 0, glare = 0; const n = cap.width * cap.height;
        for (let i = 0; i < data.length; i += 4) {
          const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          sum += y; if (y > 245) glare++;
        }
        const mean = sum / n, glareFrac = glare / n;

        const edges = (this._cvReady && this.opts.edgeDetection) ? this._detectEdges(cap) : null;
        this._edges = edges;
        this._updateEdges(edges, cap);

        if (mean < this.opts.lumaMin) this._coach("Too dark — add light or tap ⚡");
        else if (mean > this.opts.lumaMax) this._coach("Too bright — reduce light");
        else if (glareFrac > this.opts.glareMax) this._coach("Glare — tilt the receipt");
        else this._coach(null);

        if (this._ui) this._ui.dot.classList.toggle("ready", !!(edges && edges.left.on && edges.right.on));
      }, 200);
    }

    _updateEdges(edges, cap) {
      const u = this._ui; if (!u) return;
      const o = this.opts, VW = global.innerWidth, VH = global.innerHeight;
      const cont = this.segments.length > 0 && this._mode === "live";
      const setOn = (r, on) => { r.classList.toggle("on", on); r.querySelector(".badge").textContent = on ? "✓" : "?"; };

      u.rails.left.style.display = "block";
      u.rails.right.style.display = "block";
      u.rails.top.style.display = cont ? "none" : "block";

      const boxL = VW * o.box.left, boxR = VW * o.box.right, boxT = VH * o.box.top;
      const tolX = VW * o.alignTol, tolY = VH * o.alignTol;
      let lOn = false, rOn = false, tOn = false;

      if (edges && cap) {
        const sx = VW / cap.width, sy = VH / cap.height;
        if (edges.left.on) lOn = Math.abs(edges.left.x * sx - boxL) <= tolX;
        if (edges.right.on) rOn = Math.abs(edges.right.x * sx - boxR) <= tolX;
        if (!cont && edges.top.on) tOn = Math.abs(edges.top.y * sy - boxT) <= tolY;
        if (edges.bottom.on) {
          u.rails.bottom.style.top = (edges.bottom.y * sy) + "px";
          setOn(u.rails.bottom, true); u.rails.bottom.style.display = "block";
        } else u.rails.bottom.style.display = "none";
      } else {
        u.rails.bottom.style.display = "none";
      }
      setOn(u.rails.left, lOn); setOn(u.rails.right, rOn); setOn(u.rails.top, tOn);
    }

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
          await new Promise((res, rej) => {
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

    _detectEdges(canvas) {
      if (!this._cvReady || !global.cv) return null;
      const cv = global.cv, o = this.opts;

      // Track ALL Mats (including intermediate ROIs) for guaranteed cleanup.
      const mats = [];
      const track = (m) => { mats.push(m); return m; };

      const band = (arr, len, minContrast) => {
        let lo = 1e9, hi = -1e9;
        for (let i = 0; i < len; i++) { const v = arr[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi - lo < minContrast) return null;
        const thr = lo + (hi - lo) * 0.45;
        let s = -1, e = -1;
        for (let i = 0; i < len; i++) if (arr[i] > thr) { if (s < 0) s = i; e = i; }
        return s < 0 ? null : { s, e };
      };

      try {
        const src = track(cv.imread(canvas));
        const gray = track(new cv.Mat());
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const grayB = track(new cv.Mat());
        cv.GaussianBlur(gray, grayB, new cv.Size(5, 5), 0);
        const w = gray.cols, h = gray.rows;

        const colM = track(new cv.Mat());
        cv.reduce(grayB, colM, 0, cv.REDUCE_AVG, cv.CV_32F);
        const cb = band(colM.data32F, w, o.contrastMin);
        if (!cb || cb.e - cb.s < w * 0.12) return null;

        // Texture gate — Canny edge density inside the band.
        const bx = Math.max(0, cb.s), bw = Math.max(4, Math.min(w - bx, cb.e - cb.s));
        const roiE = track(gray.roi(new cv.Rect(bx, 0, bw, h)));   // tracked!
        const ed = track(new cv.Mat());
        cv.Canny(roiE, ed, 60, 180);
        const density = cv.countNonZero(ed) / (bw * h);
        if (density < o.textureMin) return null;

        const leftOn = cb.s > w * 0.03, rightOn = cb.e < w * 0.97;
        const left = { x: leftOn ? cb.s : Math.round(w * 0.08), on: leftOn };
        const right = { x: rightOn ? cb.e : Math.round(w * 0.92), on: rightOn };

        // Row brightness - top/bottom edges.
        let top = { y: 0, on: false }, bottom = { y: h, on: false };
        const roi = track(grayB.roi(new cv.Rect(bx, 0, bw, h)));   // tracked!
        const rowM = track(new cv.Mat());
        cv.reduce(roi, rowM, 1, cv.REDUCE_AVG, cv.CV_32F);
        const rb = band(rowM.data32F, h, 12);
        if (rb) {
          if (rb.s > h * 0.03) top = { y: rb.s, on: true };
          if (rb.e < h * 0.97) bottom = { y: rb.e, on: true };
        }
        return { left, right, top, bottom, w, h };
      } catch (_) {
        return null;
      } finally {
        // Delete ALL tracked Mats — no leaks even on mid-function exceptions.
        for (let i = mats.length - 1; i >= 0; i--) {
          try { if (mats[i] && mats[i].delete) mats[i].delete(); } catch (_) {}
        }
      }
    }

    _manualCapture() { if (this._mode === "live" && !this._busy) this._doCapture(); }

    _doCapture() {
      try {
        if (!this._captureBox()) this.capture();
        // #8 — Blur check on the just-captured segment.
        const lastSeg = this.segments[this.segments.length - 1];
        if (lastSeg) {
          const sharpness = this._measureSharpness(lastSeg);
          if (sharpness !== null && sharpness < this.opts.blurThreshold) {
            this._coach("Image looks blurry — hold steady and retake");
            this.removeLastSegment();
            return;
          }
        }
        this._flashAnim();
        this._enterReview();
      } catch (err) { this._coach(err.message); }
    }

    _captureBox() {
      const hi = this._coverCropCanvas(1600);
      if (!hi) return false;
      const o = this.opts;
      const x = Math.round(hi.width * o.box.left);
      const w = Math.round(hi.width * (o.box.right - o.box.left));
      const top = Math.round(hi.height * o.box.top);
      let bottom = hi.height;
      const e = this._cvReady ? this._detectEdges(hi) : null;
      if (e && e.bottom.on) bottom = Math.min(hi.height, Math.round(e.bottom.y) + Math.round(hi.width * 0.01));
      const h = bottom - top;
      if (w < 10 || h < 40) return false;
      const out = document.createElement("canvas");
      out.width = w; out.height = h;
      out.getContext("2d").drawImage(hi, x, top, w, h, 0, 0, w, h);
      const ctx = out.getContext("2d");
      const luminance = this._screenAndGrayscale(ctx, out);
      if (luminance < o.lumaMin) throw new RangeError(`Too dark (${Math.round(luminance)})`);
      if (luminance > o.lumaMax) throw new RangeError(`Too bright (${Math.round(luminance)})`);
      this.segments.push(out);
      this._emit("segment", { count: this.segments.length, luminance, box: true });
      return true;
    }

    capture() {
      const v = this.video;
      if (!v || !v.videoWidth) throw new Error("Camera not started.");
      const vRect = v.getBoundingClientRect(), rRect = this.reticle.getBoundingClientRect();
      const scale = Math.max(v.videoWidth / vRect.width, v.videoHeight / vRect.height);
      const dispW = v.videoWidth / scale, dispH = v.videoHeight / scale;
      const offX = (vRect.width - dispW) / 2, offY = (vRect.height - dispH) / 2;
      let sx = ((rRect.left - vRect.left) - offX) * scale, sy = ((rRect.top - vRect.top) - offY) * scale;
      let sw = rRect.width * scale, sh = rRect.height * scale;
      sx = Math.max(0, Math.min(sx, v.videoWidth)); sy = Math.max(0, Math.min(sy, v.videoHeight));
      sw = Math.max(1, Math.min(sw, v.videoWidth - sx)); sh = Math.max(1, Math.min(sh, v.videoHeight - sy));
      const dpr = global.devicePixelRatio || 1;
      const outW = Math.round(rRect.width * dpr), outH = Math.round(rRect.height * dpr);
      const rotate = v.videoWidth > v.videoHeight && global.innerHeight >= global.innerWidth;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (rotate) { canvas.width = outH; canvas.height = outW; ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(v, sx, sy, sw, sh, 0, 0, outW, outH); }
      else { canvas.width = outW; canvas.height = outH; ctx.drawImage(v, sx, sy, sw, sh, 0, 0, outW, outH); }
      const luminance = this._screenAndGrayscale(ctx, canvas);
      if (luminance < this.opts.lumaMin) throw new RangeError(`Too dark (${Math.round(luminance)})`);
      if (luminance > this.opts.lumaMax) throw new RangeError(`Too bright (${Math.round(luminance)})`);
      this.segments.push(canvas);
      this._emit("segment", { count: this.segments.length, luminance });
      return { luminance, count: this.segments.length };
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

    _enterReview() {
      const last = this.segments[this.segments.length - 1];
      if (this._ui && last) { try { this._ui.still.src = last.toDataURL("image/jpeg", 0.85); } catch (_) {} }
      this._setMode("review");
    }
    _retake() { this.removeLastSegment(); this._setMode("live"); }
    _addSection() { this._setMode("live"); }
    _useReceipt() { this._finish(); }

    async _finish() {
      if (!this.segments.length || this._busy) return;
      this._busy = true;
      this._ui.proc.hidden = false; this._ui.procMsg.textContent = "Uploading…";
      try {
        const result = await this.submit();
        this.close();
        if (this._resolveFlow) this._resolveFlow(result);
      } catch (err) {
        this._busy = false; this._ui.proc.hidden = true;
        this._showErr((err && err.message) ? err.message : "Something went wrong.");
      }
    }

    _showErr(msg) {
      if (!this._ui) return;
      this._ui.errMsg.textContent = msg;
      this._ui.errp.hidden = false;
    }
    _cancel() { this.close(); if (this._rejectFlow) this._rejectFlow({ cancelled: true }); }
    close() { this.stop(); this._teardownUI(); }
    _teardownUI() {
      if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
      this._teardownOrientationHandler();
      if (this._ui && this._ui.root) this._ui.root.remove();
      this._ui = null; this._edges = null;
    }

    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
        throw new Error("Camera API unavailable. Serve over HTTPS.");

      const { idealWidth, idealHeight } = this.opts;
      const preferred = {
        audio: false,
        video: {
          facingMode: { exact: "environment" },
          width: { ideal: idealWidth }, height: { ideal: idealHeight },
          advanced: [{ focusMode: "continuous" }],
        },
      };
      const fallback = {
        audio: false,
        video: { facingMode: "environment", width: { ideal: idealWidth }, height: { ideal: idealHeight } },
      };

      try {
        this.stream = await navigator.mediaDevices.getUserMedia(preferred);
      } catch (err) {
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          // #6 — Show an in-UI recovery panel instead of a raw rejection.
          this._showPermissionDenied();
          throw err;   // still reject captureFlow(), but UI is up
        }
        // Not a permission issue — try simpler constraints.
        this._emit("status", { phase: "fallback", message: "Using default camera." });
        try {
          this.stream = await navigator.mediaDevices.getUserMedia(fallback);
        } catch (err2) {
          if (err2.name === "NotAllowedError" || err2.name === "PermissionDeniedError") {
            this._showPermissionDenied();
          }
          throw err2;
        }
      }

      if (this.video) {
        this.video.srcObject = this.stream;
        await this.video.play().catch(() => {});
      }
      this._setupTorch();
      this._setupOrientationHandler();   // #7
      this._emit("ready", { width: this.video && this.video.videoWidth });
      return this;
    }

    _showPermissionDenied() {
      if (!this._ui) return;
      const panel = document.createElement("div");
      panel.className = "rcap-help-panel";
      panel.innerHTML =
        '<div class="rcap-help-card">' +
        '<h3>Camera access needed</h3>' +
        '<p style="font-size:14px;line-height:1.5;color:#444;margin:0 0 12px">' +
        'To scan a receipt, allow camera access in your browser settings:' +
        '</p>' +
        '<ul style="font-size:13px;line-height:1.6;color:#555;margin:0 0 16px;padding-left:18px">' +
        '<li><b>iOS Safari:</b> Settings → Safari → Camera → Allow</li>' +
        '<li><b>Android Chrome:</b> Tap the lock icon in the address bar → Permissions → Camera</li>' +
        '<li><b>Desktop:</b> Click the camera icon in the address bar</li>' +
        '</ul>' +
        '<button class="rcap-btn-solid rcap-perm-retry">Try again</button>' +
        '<button class="rcap-add rcap-perm-close" style="color:#173D53;border-color:#cbd5e1;margin-top:10px">Cancel</button>' +
        '</div>';
      this._ui.root.appendChild(panel);

      panel.querySelector(".rcap-perm-retry").onclick = async () => {
        panel.remove();
        try { await this.start(); this._startAnalysisLoop(); this._setMode("live"); }
        catch (_) { /* start() will re-show the panel if still denied */ }
      };
      panel.querySelector(".rcap-perm-close").onclick = () => { this._cancel(); };
    }

    _setupOrientationHandler() {
      // Debounced handler — recalculate crop geometry when the device rotates.
      this._onOrientationChange = () => {
        if (this._orientDebounce) clearTimeout(this._orientDebounce);
        this._orientDebounce = setTimeout(() => {
          // Re-show the overlap sliver at the correct new dimensions.
          this._showOverlap();
          this._emit("status", { phase: "orientation-changed" });
        }, 300);
      };
      global.addEventListener("resize", this._onOrientationChange);
      // screen.orientation.onchange is more reliable than orientationchange on modern browsers.
      if (global.screen && global.screen.orientation) {
        global.screen.orientation.addEventListener("change", this._onOrientationChange);
      }
    }

    _teardownOrientationHandler() {
      if (this._onOrientationChange) {
        global.removeEventListener("resize", this._onOrientationChange);
        if (global.screen && global.screen.orientation) {
          global.screen.orientation.removeEventListener("change", this._onOrientationChange);
        }
        this._onOrientationChange = null;
      }
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
      try { await track.applyConstraints({ advanced: [{ torch: this._torchOn }] }); if (this._ui) this._ui.flash.classList.toggle("on", this._torchOn); } catch (_) {}
    }
    stop() {
      if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
      if (this.video) this.video.srcObject = null;
    }

    get segmentCount() { return this.segments.length; }
    clearSegments() { this.segments = []; }
    removeLastSegment() { this.segments.pop(); this._emit("segment", { count: this.segments.length }); }

    _toJpegBlob(canvas) {
      return new Promise((resolve, reject) => {
        // Try JPEG first at configured quality.
        canvas.toBlob(
          (b) => {
            if (b) return resolve(b);
            // JPEG failed (some Android WebViews) — try lower quality.
            canvas.toBlob(
              (b2) => {
                if (b2) return resolve(b2);
                // JPEG completely broken — fall back to PNG.
                canvas.toBlob(
                  (b3) => {
                    if (b3) return resolve(b3);
                    reject(new Error("Failed to encode image in any format."));
                  },
                  "image/png"
                );
              },
              "image/jpeg",
              0.6  // lower quality fallback
            );
          },
          "image/jpeg",
          this.opts.jpegQuality
        );
      });
    }

    async _fetchWithRetry(url, fetchOpts = {}, retryOpts = {}) {
      const timeoutMs = retryOpts.timeoutMs ?? this.opts.fetchTimeoutMs;
      const maxRetries = retryOpts.noRetry ? 0 : (retryOpts.retries ?? this.opts.retryAttempts);
      let lastErr;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetch(url, { ...fetchOpts, signal: controller.signal });
          clearTimeout(timer);
          // Retry on 5xx or 429 (rate-limited); don't retry 4xx (client error).
          if ((resp.status >= 500 || resp.status === 429) && attempt < maxRetries) {
            lastErr = new Error(`HTTP ${resp.status}`);
            await this._backoff(attempt);
            continue;
          }
          return resp;
        } catch (err) {
          clearTimeout(timer);
          lastErr = err;
          if (err.name === "AbortError") {
            lastErr = new Error(`Request timed out after ${timeoutMs}ms`);
          }
          if (attempt < maxRetries) {
            await this._backoff(attempt);
            continue;
          }
        }
      }
      throw lastErr;
    }

    _backoff(attempt) {
      const base = this.opts.retryBaseMs;
      const delay = base * Math.pow(2, attempt) + Math.random() * base * 0.5;
      return new Promise((r) => setTimeout(r, delay));
    }

    async submit() {
      if (this.segments.length <= 1) {
        const blob = await this._toJpegBlob(this.segments[0]);
        return this._analyzeBlob(blob, 1, 1);
      }
      const results = [];
      for (let i = 0; i < this.segments.length; i++) {
        const blob = await this._toJpegBlob(this.segments[i]);
        try {
          const r = await this._analyzeBlob(blob, i + 1, this.segments.length);
          if (r) results.push(r);
        } catch (err) {
          if (!err || !err.rejected) throw err;
          if (err.result) results.push(err.result);
        }
      }
      if (!results.length) throw new Error("Couldn't read any section of the receipt.");
      return this._mergeResults(results);
    }

    async _analyzeBlob(blob, idx, total) {
      const label = total > 1 ? ` section ${idx}/${total}` : "";

      // #3 — Client-side upload size guard.
      if (blob.size > this.opts.maxUploadBytes) {
        throw new Error(
          `Image too large (${(blob.size / 1024 / 1024).toFixed(1)} MB). ` +
          `Max is ${(this.opts.maxUploadBytes / 1024 / 1024).toFixed(0)} MB.`
        );
      }

      // Step 1: Get upload URL (with retry + timeout).
      this._emit("status", { phase: "requesting-url", message: "Preparing upload" + label + "…" });
      const urlResp = await this._fetchWithRetry(this.opts.endpoints.uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_type: "image/jpeg" }),
      });
      if (!urlResp.ok) throw new Error("Could not get an upload URL (HTTP " + urlResp.status + ").");
      const { job_id, upload_url } = await urlResp.json();

      // Step 2: Upload with XHR for progress reporting (#10).
      this._emit("status", { phase: "uploading", message: "Uploading" + label + "…", bytes: blob.size, progress: 0 });
      await this._uploadWithProgress(upload_url, blob, label);

      // Step 3: Poll (no retry on individual polls — the loop IS the retry).
      for (let attempt = 1; attempt <= this.opts.maxPolls; attempt++) {
        await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs));
        const pollResp = await this._fetchWithRetry(
          this.opts.endpoints.status + "?job=" + encodeURIComponent(job_id),
          {},
          { noRetry: true, timeoutMs: 10000 }
        );
        const s = await pollResp.json();
        this._emit("status", { phase: "polling", attempt, status: s.status, message: "Analyzing" + label + "…" });
        if (s.status === "done") return s.result;
        if (s.status === "rejected") {
          const e = new Error(s.error || "Receipt rejected.");
          e.rejected = true; e.result = s.result; throw e;
        }
        if (s.status === "failed") throw new Error(s.error || "Processing failed.");
        if (s.status === "unknown") throw new Error("Job not found on server.");
      }
      throw new Error("Timed out waiting for OCR result.");
    }

    _uploadWithProgress(url, blob, label) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Content-Type", "image/jpeg");
        xhr.setRequestHeader("X-User-Id", this.opts.userId);
        xhr.setRequestHeader("X-SDK-Version", SDK_VERSION);   // #20

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            this._emit("status", {
              phase: "uploading",
              message: `Uploading${label}… ${pct}%`,
              bytes: e.total,
              loaded: e.loaded,
              progress: pct,
            });
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error("Upload failed (HTTP " + xhr.status + ")."));
        };
        xhr.onerror = () => reject(new Error("Upload failed (network error)."));
        xhr.ontimeout = () => reject(new Error("Upload timed out."));
        xhr.timeout = this.opts.fetchTimeoutMs;
        xhr.send(blob);
      });
    }

    _measureSharpness(canvas) {
      if (!this._cvReady || !global.cv) return null;
      const cv = global.cv;
      const mats = [];
      const track = (m) => { mats.push(m); return m; };
      try {
        const src = track(cv.imread(canvas));
        const gray = track(new cv.Mat());
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const lap = track(new cv.Mat());
        cv.Laplacian(gray, lap, cv.CV_64F);
        const mean = track(new cv.Mat());
        const stddev = track(new cv.Mat());
        cv.meanStdDev(lap, mean, stddev);
        // Variance = stddev^2
        const sd = stddev.data64F[0];
        return sd * sd;
      } catch (_) {
        return null;
      } finally {
        for (let i = mats.length - 1; i >= 0; i--) {
          try { if (mats[i] && mats[i].delete) mats[i].delete(); } catch (_) {}
        }
      }
    }

    _tokenSimilarity(a, b) {
      const tokenize = (s) => new Set((s || "").replace(/[^a-z0-9\s]/gi, "").toLowerCase().split(/\s+/).filter(Boolean));
      const ta = tokenize(a), tb = tokenize(b);
      if (!ta.size || !tb.size) return 0;
      let inter = 0;
      for (const t of ta) if (tb.has(t)) inter++;
      return inter / Math.max(ta.size, tb.size);
    }

    _mergeResults(results) {
      const firstOf = (sel) => {
        for (const r of results) { const v = sel(r); if (v != null && v !== "") return v; }
        return null;
      };
      const vendor = firstOf((r) => r && r.vendor && r.vendor.name);
      const date = firstOf((r) => r && r.date);
      const totals = results.map((r) => r && r.total).filter((v) => v != null);
      const total = totals.length ? totals[totals.length - 1] : null;
      const confs = results.map((r) => r && r.avg_confidence).filter((v) => v != null);

      const threshold = this.opts.fuzzyMergeThreshold;
      const fuzzyMatch = (a, b) => this._tokenSimilarity(a.description, b.description) >= threshold;

      // Does `sub` appear as a contiguous run anywhere in `arr`?
      // Uses fuzzy matching instead of exact string comparison.
      const findRun = (arr, sub) => {
        for (let start = arr.length - sub.length; start >= 0; start--) {
          let ok = true;
          for (let j = 0; j < sub.length; j++) {
            if (!fuzzyMatch(arr[start + j], sub[j])) { ok = false; break; }
          }
          if (ok) return start;
        }
        return -1;
      };

      let items = ((results[0] && results[0].line_items) || []).slice();
      for (let s = 1; s < results.length; s++) {
        const next = (results[s] && results[s].line_items) || [];
        let L = 0;
        for (let cand = Math.min(items.length, next.length); cand >= 1; cand--) {
          if (findRun(items, next.slice(0, cand)) !== -1) { L = cand; break; }
        }
        items = items.concat(next.slice(L));
      }

      return {
        vendor: { name: vendor }, date, total, currency_code: "USD", document_type: "receipt",
        line_items: items, line_item_count: items.length,
        avg_confidence: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) / 100 : null,
        source: "aws-textract", merged_sections: results.length,
        sdk_version: SDK_VERSION,   // #20 — version in every result
      };
    }

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
  }

  ReceiptCaptureSDK.VERSION = SDK_VERSION;
  global.ReceiptCaptureSDK = ReceiptCaptureSDK;
})(window);
