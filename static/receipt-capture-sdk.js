/*
 * ReceiptCaptureSDK — client-side receipt capture engine + guided full-screen UI.
 *
 * Client side of the cloud-hybrid architecture. Prepares and delivers an
 * optimized media payload; NO fraud / dedup / DB logic lives here.
 *
 * Engine (headless): rear camera (macro focus) w/ fallback, DPR-aware crop,
 * skew rotation, luminance guard, grayscale JPEG @0.85, vertical stitching,
 * presigned-PUT + 2s polling pipeline.
 *
 * Guided UI (full-screen), two modes:
 *   LIVE   — edge-to-edge preview with per-edge detection: each of the left /
 *            right / bottom edges shows GREEN ✓ when its edge is detected, AMBER
 *            ? when not. The bottom edge only appears when the receipt's end is
 *            actually in view. Capture is MANUAL (tap the shutter). On a
 *            continuation section a tinted sliver of the previous capture is
 *            pinned to the top to line up the stitch.
 *   REVIEW  — frozen still + "Store / Date/Time / Total" checklist, with
 *            Retake · Use receipt photo · Long receipt? Add section.
 *
 * Usage:
 *   const sdk = new ReceiptCaptureSDK({ userId, endpoints });
 *   const result = await sdk.captureFlow();   // rejects {cancelled:true} on close
 */
(function (global) {
  "use strict";

  const DEFAULTS = {
    idealWidth: 1920,
    idealHeight: 1080,
    jpegQuality: 0.85,
    grayscale: true,
    lumaMin: 40,
    lumaMax: 230,
    glareMax: 0.14,
    edgeDetection: true,   // OpenCV.js: detect receipt edges
    // Fixed bounding box (fractions of the viewport). The box never moves; the
    // user aligns the receipt to it. An edge lights green when the receipt's
    // matching edge lands within `alignTol` of the box edge.
    box: { left: 0.08, right: 0.92, top: 0.11 },
    alignTol: 0.12,        // ±fraction within which an edge counts as aligned (green)
    contrastMin: 26,       // min brightness range for a band to exist (vs blank scene)
    textureMin: 0.035,     // min Canny edge-density in the band => text => real receipt
    pollIntervalMs: 2000,
    maxPolls: 60,
    userId: "demo-user",
    endpoints: { uploadUrl: "/aws/get-upload-url", status: "/aws/analyze-status" },
    opencvUrl: "https://docs.opencv.org/4.8.0/opencv.js",
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

    /* ----------------------------------------------------- full-screen UI -- */
    _buildUI() {
      this._injectStyles();
      const root = document.createElement("div");
      root.className = "rcap-root"; root.dataset.mode = "live";

      const video = document.createElement("video");
      video.className = "rcap-video";
      video.setAttribute("playsinline", ""); video.setAttribute("autoplay", ""); video.setAttribute("muted", "");
      video.playsInline = true; video.autoplay = true; video.muted = true;
      this.video = video; root.appendChild(video);

      // Per-edge guide rails (positioned/colored live).
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

      // Hidden reticle: the capture region for the fixed-rect fallback crop.
      const reticle = document.createElement("div");
      reticle.className = "rcap-reticle";
      root.appendChild(reticle);
      this.reticle = reticle;

      // Continuation sliver (tinted) of the previous section's bottom.
      const overlap = document.createElement("canvas");
      overlap.className = "rcap-overlap"; overlap.style.display = "none";
      root.appendChild(overlap);

      // Frozen still (review) + field checklist
      const still = document.createElement("img");
      still.className = "rcap-still"; still.alt = "Captured section";
      root.appendChild(still);
      const checklist = document.createElement("div");
      checklist.className = "rcap-checklist";
      checklist.innerHTML = '<span><b>?</b> Store</span><span><b>?</b> Date/Time</span><span><b>?</b> Total</span>';
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

      // Lighting coach (only shown for dark/glare problems)
      const coach = document.createElement("div");
      coach.className = "rcap-coach"; root.appendChild(coach);

      // Long-receipt hint (live)
      const hint = document.createElement("div");
      hint.className = "rcap-hint";
      hint.textContent = "Have a long receipt? You can add more sections next.";
      root.appendChild(hint);

      // Help panel
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

      // Bottom controls
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

      // Error / rejection panel (shows the reason — never fails silently).
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
/* fixed bounding-box edges — positions never change; only the color toggles */
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
/* continuation sliver */
.rcap-overlap{position:absolute;top:9%;left:8%;right:8%;height:60px;object-fit:cover;object-position:bottom;
  z-index:4;border-bottom:2px dashed ${GREEN};filter:hue-rotate(280deg) saturate(1.4);opacity:.92}
/* review still + checklist */
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
/* mode visibility */
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

    /* ------------------------------------------------------- mode + UI ---- */
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

    /* ---------------------------------------------------- live analysis --- */
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

        // Lighting-only coaching (capture is manual — no "hold still" / auto-fire).
        if (mean < this.opts.lumaMin) this._coach("Too dark — add light or tap ⚡");
        else if (mean > this.opts.lumaMax) this._coach("Too bright — reduce light");
        else if (glareFrac > this.opts.glareMax) this._coach("Glare — tilt the receipt");
        else this._coach(null);

        if (this._ui) this._ui.dot.classList.toggle("ready", !!(edges && edges.left.on && edges.right.on));
      }, 200);
    }

    /** Color the FIXED box edges: green ✓ when the receipt's matching edge lands
     *  within tolerance of that box edge (so the receipt fills the box at a
     *  readable size); amber ? otherwise. The box itself never moves. The bottom
     *  edge is the only dynamic line — shown only when the receipt's bottom is
     *  detected in view. */
    _updateEdges(edges, cap) {
      const u = this._ui; if (!u) return;
      const o = this.opts, VW = global.innerWidth, VH = global.innerHeight;
      const cont = this.segments.length > 0 && this._mode === "live";
      const setOn = (r, on) => { r.classList.toggle("on", on); r.querySelector(".badge").textContent = on ? "✓" : "?"; };

      // Side rails + top edge are always visible (the fixed guide); only color toggles.
      u.rails.left.style.display = "block";
      u.rails.right.style.display = "block";
      u.rails.top.style.display = cont ? "none" : "block";   // sliver replaces top on continuation

      const boxL = VW * o.box.left, boxR = VW * o.box.right, boxT = VH * o.box.top;
      const tolX = VW * o.alignTol, tolY = VH * o.alignTol;
      let lOn = false, rOn = false, tOn = false;

      if (edges && cap) {
        const sx = VW / cap.width, sy = VH / cap.height;
        // green only when the edge is in view AND aligned to the fixed box edge
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

    /** Detect receipt edges by the BRIGHTNESS BAND (receipt is lighter than the
     *  background) — robust to interior text, which gradient methods mistake for
     *  edges. An edge is "on" (detected/green) only when the bright band starts
     *  or ends INSIDE the frame; if the band touches a border, that edge is
     *  off-screen (amber ?). Returns {left,right,top,bottom (each {x|y,on}),w,h}.*/
    _detectEdges(canvas) {
      if (!this._cvReady || !global.cv) return null;
      const cv = global.cv, o = this.opts;
      let src, gray, grayB, colM, rowM, ed;
      const band = (arr, len, minContrast) => {  // first/last index above a brightness threshold
        let lo = 1e9, hi = -1e9;
        for (let i = 0; i < len; i++) { const v = arr[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi - lo < minContrast) return null;   // not enough contrast => no band
        const thr = lo + (hi - lo) * 0.45;
        let s = -1, e = -1;
        for (let i = 0; i < len; i++) if (arr[i] > thr) { if (s < 0) s = i; e = i; }
        return s < 0 ? null : { s, e };
      };
      try {
        src = cv.imread(canvas); gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        grayB = new cv.Mat(); cv.GaussianBlur(gray, grayB, new cv.Size(5, 5), 0);
        const w = gray.cols, h = gray.rows;

        // Column brightness band (receipt is lighter than the background).
        colM = new cv.Mat(); cv.reduce(grayB, colM, 0, cv.REDUCE_AVG, cv.CV_32F);
        const cb = band(colM.data32F, w, o.contrastMin);
        if (!cb || cb.e - cb.s < w * 0.12) return null;

        // GATE: the band must be text-dense (a real receipt) — not a blank bright
        // surface, hand, or wall. Canny edge density inside the band.
        const bx = Math.max(0, cb.s), bw = Math.max(4, Math.min(w - bx, cb.e - cb.s));
        ed = new cv.Mat();
        const roiE = gray.roi(new cv.Rect(bx, 0, bw, h));
        cv.Canny(roiE, ed, 60, 180); roiE.delete();
        const density = cv.countNonZero(ed) / (bw * h);
        if (density < o.textureMin) return null;   // not enough text => not a receipt

        const leftOn = cb.s > w * 0.03, rightOn = cb.e < w * 0.97;
        const left = { x: leftOn ? cb.s : Math.round(w * 0.08), on: leftOn };
        const right = { x: rightOn ? cb.e : Math.round(w * 0.92), on: rightOn };

        // Row brightness within the band -> top/bottom edges (in view or not).
        let top = { y: 0, on: false }, bottom = { y: h, on: false };
        const roi = grayB.roi(new cv.Rect(bx, 0, bw, h));
        rowM = new cv.Mat(); cv.reduce(roi, rowM, 1, cv.REDUCE_AVG, cv.CV_32F); roi.delete();
        const rb = band(rowM.data32F, h, 12);
        if (rb) {
          if (rb.s > h * 0.03) top = { y: rb.s, on: true };
          if (rb.e < h * 0.97) bottom = { y: rb.e, on: true };
        }
        return { left, right, top, bottom, w, h };
      } catch (_) { return null; }
      finally { [src, gray, grayB, colM, rowM, ed].forEach((m) => { if (m && m.delete) { try { m.delete(); } catch (_) {} } }); }
    }

    /* ---------------------------------------------------- capture actions -- */
    _manualCapture() { if (this._mode === "live" && !this._busy) this._doCapture(); }

    _doCapture() {
      try {
        if (!this._captureBox()) this.capture();   // capture() = fixed-rect fallback
        this._flashAnim();
        this._enterReview();
      } catch (err) { this._coach(err.message); }
    }

    /** Capture the FIXED bounding-box region (consistent size for OCR), cropped
     *  down to the receipt's bottom edge when it's detected in view. */
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

    /* ---------------------------------------------- fixed-rect fallback --- */
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

    /* ----------------------------------------------------- review actions -- */
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
        // Always surface the reason (rejection or error) — never silently revert.
        this._showErr((err && err.message) ? err.message : "Something went wrong.");
      }
    }

    /** Full-screen error/rejection panel with the reason + Retake / Close. */
    _showErr(msg) {
      if (!this._ui) return;
      this._ui.errMsg.textContent = msg;
      this._ui.errp.hidden = false;
    }
    _cancel() { this.close(); if (this._rejectFlow) this._rejectFlow({ cancelled: true }); }
    close() { this.stop(); this._teardownUI(); }
    _teardownUI() {
      if (this._loopTimer) { clearInterval(this._loopTimer); this._loopTimer = null; }
      if (this._ui && this._ui.root) this._ui.root.remove();
      this._ui = null; this._edges = null;
    }

    /* --------------------------------------------------- camera lifecycle -- */
    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Camera API unavailable. Serve over HTTPS.");
      const { idealWidth, idealHeight } = this.opts;
      const preferred = { audio: false, video: { facingMode: { exact: "environment" }, width: { ideal: idealWidth }, height: { ideal: idealHeight }, advanced: [{ focusMode: "continuous" }] } };
      const fallback = { audio: false, video: { facingMode: "environment", width: { ideal: idealWidth }, height: { ideal: idealHeight } } };
      try { this.stream = await navigator.mediaDevices.getUserMedia(preferred); }
      catch (err) { this._emit("status", { phase: "fallback", message: "Using default camera." }); this.stream = await navigator.mediaDevices.getUserMedia(fallback); }
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
      try { await track.applyConstraints({ advanced: [{ torch: this._torchOn }] }); if (this._ui) this._ui.flash.classList.toggle("on", this._torchOn); } catch (_) {}
    }
    stop() {
      if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
      if (this.video) this.video.srcObject = null;
    }

    get segmentCount() { return this.segments.length; }
    clearSegments() { this.segments = []; }
    removeLastSegment() { this.segments.pop(); this._emit("segment", { count: this.segments.length }); }

    /* ------------------------------------------- transmission + merge ----- */
    _toJpegBlob(canvas) {
      return new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to encode JPEG."))), "image/jpeg", this.opts.jpegQuality);
      });
    }

    /** Analyze EACH captured section with Textract separately, then merge the
     *  structured line items (dedup by name). This avoids fragile pixel
     *  stitching of thermal receipts — each section is read cleanly and the
     *  overlapping band's items are de-duplicated in the structured data. */
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
          // A single unreadable section shouldn't sink the whole receipt —
          // skip rejections, but surface hard failures.
          if (!err || !err.rejected) throw err;
          if (err.result) results.push(err.result);
        }
      }
      if (!results.length) throw new Error("Couldn't read any section of the receipt.");
      return this._mergeResults(results);
    }

    /** One image through the pipeline: get-upload-url -> PUT -> poll. */
    async _analyzeBlob(blob, idx, total) {
      const label = total > 1 ? ` section ${idx}/${total}` : "";
      this._emit("status", { phase: "requesting-url", message: "Preparing upload" + label + "…" });
      const urlResp = await fetch(this.opts.endpoints.uploadUrl, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content_type: "image/jpeg" }),
      });
      if (!urlResp.ok) throw new Error("Could not get an upload URL (HTTP " + urlResp.status + ").");
      const { job_id, upload_url } = await urlResp.json();
      this._emit("status", { phase: "uploading", message: "Uploading" + label + "…", bytes: blob.size });
      const putResp = await fetch(upload_url, { method: "PUT", headers: { "Content-Type": "image/jpeg", "X-User-Id": this.opts.userId }, body: blob });
      if (!putResp.ok) throw new Error("Upload failed (HTTP " + putResp.status + ").");
      for (let attempt = 1; attempt <= this.opts.maxPolls; attempt++) {
        await new Promise((r) => setTimeout(r, this.opts.pollIntervalMs));
        const s = await fetch(this.opts.endpoints.status + "?job=" + encodeURIComponent(job_id)).then((r) => r.json());
        this._emit("status", { phase: "polling", attempt, status: s.status, message: "Analyzing" + label + "…" });
        if (s.status === "done") return s.result;
        if (s.status === "rejected") { const e = new Error(s.error || "Receipt rejected."); e.rejected = true; e.result = s.result; throw e; }
        if (s.status === "failed") throw new Error(s.error || "Processing failed.");
        if (s.status === "unknown") throw new Error("Job not found on server.");
      }
      throw new Error("Timed out waiting for OCR result.");
    }

    /** Merge per-section results. The capture overlap is a CONTIGUOUS RUN of
     *  lines shared at the seam (end of section N == start of section N+1), so
     *  we drop that boundary run once and keep everything else — preserving
     *  legitimately repeated purchases (e.g. 3x the same item) anywhere on the
     *  receipt. Vendor/date come from any section; total from the section that
     *  has one (the bottom section carries the receipt total). */
    _mergeResults(results) {
      const firstOf = (sel) => { for (const r of results) { const v = sel(r); if (v != null && v !== "") return v; } return null; };
      const vendor = firstOf((r) => r && r.vendor && r.vendor.name);
      const date = firstOf((r) => r && r.date);
      const totals = results.map((r) => r && r.total).filter((v) => v != null);
      const total = totals.length ? totals[totals.length - 1] : null;
      const confs = results.map((r) => r && r.avg_confidence).filter((v) => v != null);

      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const eq = (a, b) => norm(a.description) === norm(b.description) &&
        (a.total == null || b.total == null || Math.abs((a.total || 0) - (b.total || 0)) < 0.01);

      let items = ((results[0] && results[0].line_items) || []).slice();
      for (let s = 1; s < results.length; s++) {
        const next = (results[s] && results[s].line_items) || [];
        // largest k where the last k of `items` equals the first k of `next`
        let k = 0;
        for (let cand = Math.min(items.length, next.length); cand >= 1; cand--) {
          let match = true;
          for (let j = 0; j < cand; j++) { if (!eq(items[items.length - cand + j], next[j])) { match = false; break; } }
          if (match) { k = cand; break; }
        }
        items = items.concat(next.slice(k));   // drop only the overlapping run
      }

      return {
        vendor: { name: vendor }, date, total, currency_code: "USD", document_type: "receipt",
        line_items: items, line_item_count: items.length,
        avg_confidence: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) / 100 : null,
        source: "aws-textract", merged_sections: results.length,
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

  global.ReceiptCaptureSDK = ReceiptCaptureSDK;
})(window);
