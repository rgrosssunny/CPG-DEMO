# Receipt Capture Web SDK — Technical Specification

`ReceiptCaptureSDK` (version **0.1.0**) is a dependency-free, browser-based SDK
that captures a receipt with the device camera, prepares an OCR-optimized image,
and runs it through a cloud backend powered by **Amazon Textract** — returning
structured receipt data (vendor, date, total, line items). It is a single
JavaScript file that injects its own full-screen guided-capture UI.

**How to read this document**

| If you are… | Read |
|---|---|
| A **stakeholder / lead** wanting to know what it does | **Part 1 — Overview** |
| A **developer integrating** the SDK into an app | Parts **1 + 2** |
| A **developer maintaining / extending** the SDK | Parts **1 + 3 + 4** |

*This document mirrors `static/receipt-capture-sdk.js` as built (v0.1.0). Where a
behavior is the integrating app's responsibility rather than the SDK's, it is
called out explicitly.*

---

# Part 1 — Overview

*Audience: everyone.*

### What it is
A single JavaScript file ([`static/receipt-capture-sdk.js`](../static/receipt-capture-sdk.js))
that you drop into a web page. Calling `captureFlow()` opens a full-screen, guided
camera experience, helps the user frame the receipt, captures an optimized image
(or several sections for a long receipt), sends it to a backend that extracts the
contents with Amazon Textract, and resolves with the structured result.

### What it does
- **Guided camera capture** — rear camera, a fixed alignment box with a dimmed
  surround and corner brackets, per-edge guides that turn from amber to **green**
  when the receipt edge is detected and aligned, live lighting/glare coaching, and
  a flash toggle (shown only when the device supports it). Capture is **manual**
  (the user taps the shutter).
- **On-device quality checks** — brightness and glare checks, OpenCV edge
  detection, and a **blur (sharpness) check** so only a real, readable, in-focus
  receipt is accepted; a failed check coaches the user and discards the frame.
- **Long receipts** — captured in multiple sections with an on-screen overlap
  sliver to line up the next part; the section results are merged into one clean
  item list (the overlap is removed once via fuzzy matching, real repeat purchases
  are kept).
- **Image preparation** — crops to the alignment box, corrects rotation, converts
  to a compressed grayscale JPEG sized for OCR, and enforces a client-side upload
  size cap.
- **Resilient, secure delivery** — uploads to the backend with progress reporting,
  automatic retry/backoff and timeouts, then polls for the result; the browser
  never holds cloud credentials and talks only to the app's own endpoints.

### Architecture at a glance (cloud-hybrid)

```
  ┌──────────────────────────────┐        ┌───────────────────────────┐      ┌────────────┐
  │  CLIENT (browser SDK)         │ HTTPS  │  SERVER (Flask on Render) │      │ AWS        │
  │  camera · guided UI · edge    │ ─────► │  /aws/* endpoints         │ ───► │ Textract   │
  │  + blur detection · crop/     │ ◄───── │  Textract + validation    │ ◄─── │ Analyze-   │
  │  grayscale · multi-section    │  JSON  │                           │      │ Expense    │
  └──────────────────────────────┘        └───────────────────────────┘      └────────────┘
```

**Security boundary:** all OCR, validation, and (when enabled) fraud/dedup logic
runs server-side. The client only prepares and delivers the image. The browser
talks only to the app's own `/aws/*` endpoints — never to AWS directly.

### The capture experience

```
 open ──► LIVE (aim; edges turn green; shutter enabled) ──tap shutter──► REVIEW (frozen still)
                                                              │
                                ┌── Retake ───────────────────┤
                                ├── Add section ──► LIVE (align to overlap sliver) ──► REVIEW
                                └── Use receipt photo ──► upload + analyze
                                                              │
                                                  result ◄────┘
```

---

# Part 2 — Integration Guide

*Audience: developers adding the SDK to an app.*

### Requirements
- **Secure context** — the camera requires `https://` (or `http://localhost`).
- A **modern browser** with `getUserMedia`. The SDK runs anywhere `getUserMedia`
  is available, **including desktop browsers** (Chrome/Edge/Firefox/Safari) — it
  does not gate itself by device type (see *Device gating*, below).
- A reachable **backend** exposing the `/aws/*` endpoints (see Part 3) with CORS
  allowing your page's origin.

### Quick start

```html
<!-- 1. Point at your backend, then load the SDK -->
<script>window.BACKEND_URL = "https://your-backend.example.com";</script>
<script src="receipt-capture-sdk.js"></script>
```

```js
// 2. Launch the guided capture and use the result.
async function scanReceipt() {
  const base = (window.BACKEND_URL || "").replace(/\/$/, "");
  const sdk = new ReceiptCaptureSDK({
    userId: "member-123",
    endpoints: {
      uploadUrl: base + "/aws/get-upload-url",
      status:    base + "/aws/analyze-status",
    },
  });

  sdk.on("status", s => console.log(s.phase, s.progress ?? ""));  // optional progress UI

  try {
    const receipt = await sdk.captureFlow();   // opens the full-screen UI
    console.log(receipt.vendor.name, receipt.total);
    receipt.line_items.forEach(li => console.log(li.description, li.total));
    // → credit cashback, match offers, etc.
  } catch (err) {
    if (err.cancelled) return;   // user closed the camera
    alert(err.message);          // camera couldn't start
  }
}
```

### The result object (what `captureFlow()` resolves to)

```json
{
  "vendor": { "name": "WHOLE FOODS MARKET" },
  "date": "06/13/2026",
  "total": 32.54,
  "currency_code": "USD",
  "document_type": "receipt",
  "line_items": [
    { "description": "OG HONEYCRISP APPLE", "total": 2.39, "quantity": "0.35 lb" }
  ],
  "line_item_count": 11,
  "avg_confidence": 95.38,
  "source": "aws-textract",
  "merged_sections": 2,
  "sdk_version": "0.1.0"
}
```

`merged_sections` and `sdk_version` are always present; `merged_sections` is `1`
for a single-section capture.

### Error handling
`captureFlow()` resolves with the result on success. Otherwise:

| Outcome | How it surfaces |
|---|---|
| User closes the camera | Promise **rejects** with `{ cancelled: true }` |
| Permission denied | An **in-UI recovery panel** appears with per-browser instructions (Try again / Cancel); the promise also **rejects** with an `Error` |
| Camera can't start (not HTTPS, no device) | Promise **rejects** with an `Error` |
| Server rejects the receipt (unreadable, low confidence, too old) | Shown **inside the SDK's UI** (error panel with Retake / Close); the user retakes or closes (→ `cancelled`) |

So your `try/catch` only needs to handle **cancel** and **camera-start failure** —
analysis rejections and permission recovery are presented in the capture UI itself.

### Options
| Option | Default | Description |
|--------|---------|-------------|
| `endpoints.uploadUrl` | `/aws/get-upload-url` | Endpoint returning a job id + PUT URL |
| `endpoints.status` | `/aws/analyze-status` | Poll endpoint |
| `userId` | `"demo-user"` | Sent as `X-User-Id` on upload (used by dedup) |
| `idealWidth` / `idealHeight` | `1920` / `1080` | Requested capture resolution |
| `jpegQuality` | `0.85` | Output JPEG quality (falls back to 0.6, then PNG) |
| `grayscale` | `true` | Convert output to grayscale |
| `lumaMin` / `lumaMax` | `40` / `230` | Luminance guardrail bounds |
| `glareMax` | `0.14` | Near-white fraction before a glare warning |
| `blurThreshold` | `80` | Min Laplacian-variance sharpness; below this a capture is discarded with a "blurry" coach |
| `edgeDetection` | `true` | Enable OpenCV edge detection |
| `box` | `{left:0.08, right:0.92, top:0.11}` | Fixed alignment box (viewport fractions) |
| `alignTol` | `0.12` | ±tolerance for an edge to count as aligned (green) |
| `contrastMin` / `textureMin` | `26` / `0.035` | Real-receipt detection gates |
| `maxUploadBytes` | `20 MB` | Client-side upload size cap (rejects larger images before upload) |
| `pollIntervalMs` / `maxPolls` | `2000` / `60` | Status polling cadence / ceiling (~2 min) |
| `fetchTimeoutMs` | `30000` | Per-request timeout |
| `retryAttempts` / `retryBaseMs` | `3` / `1000` | Retry count and backoff base for get-URL / poll requests (5xx / 429 / timeout) |
| `fuzzyMergeThreshold` | `0.75` | Token-similarity threshold for multi-section overlap merge |
| `opencvUrl` | `…/opencv.js` | OpenCV.js source (lazy-loaded) |

### Methods & events
| Method | Description |
|--------|-------------|
| `new ReceiptCaptureSDK(options)` | Create an instance |
| `captureFlow()` → `Promise<result>` | Open the guided UI; resolve with the OCR result |
| `on(event, cb)` | Subscribe to progress events (chainable) |
| `start()` / `stop()` | Start / stop the camera stream directly |
| `capture()` / `submit()` | Capture a frame / upload + analyze the captured section(s) |
| `segmentCount` · `clearSegments()` · `removeLastSegment()` | Inspect / manage captured sections |
| `close()` | Tear down the UI and stop the camera |

| Event | Payload | When |
|-------|---------|------|
| `ready` | `{ width }` | Camera started |
| `segment` | `{ count, luminance, box? }` | A section was captured |
| `status` | `{ phase, message, attempt?, status?, progress?, loaded?, bytes? }` | Pipeline progress. Phases: `detector-ready`, `fallback`, `requesting-url`, `uploading` (with `progress` %), `polling` (with `attempt`), `orientation-changed` |

### Device gating (desktop vs mobile)
The SDK itself is **device-agnostic**: `captureFlow()` opens the guided camera on
any browser that grants `getUserMedia`, desktop included. It does **not** restrict
capture to touch devices. Whether to offer live camera capture on desktop or steer
desktop users to a file **upload** instead is a **decision for the integrating
app** (and an open product decision — see requirement **CAP-10**). If the app
chooses to gate, `matchMedia("(pointer: coarse)")` is a reasonable touch-device
test; the upload path reuses the same `get-upload-url → PUT → poll` endpoints with
the chosen file as the body.

---

# Part 3 — Technical Internals

*Audience: developers maintaining or extending the SDK.*

### 3.1 Camera constraints
Requests the rear camera with `facingMode:{exact:"environment"}` and
`advanced:[{focusMode:"continuous"}]`; falls back to `facingMode:"environment"`
then the default sensor (emitting a `status:"fallback"` event). Ideal resolution
1920×1080. The `<video>` is forced `playsinline`/`autoplay`/`muted` (attributes
**and** properties) for iOS Safari. A debounced `resize` / `screen.orientation`
handler recomputes geometry and re-shows the overlap sliver on rotation.

### 3.2 On-device analysis loop
Every ~200 ms (while live and idle) the SDK samples a downscaled (240 px)
cover-crop of the video and computes mean Rec.709 luminance and a near-white glare
fraction, driving the coaching messages ("Too dark", "Too bright", "Glare — tilt
the receipt"). When OpenCV is ready it also runs edge detection and lights the
"ready" dot when both side edges are aligned.

### 3.3 Edge detection (OpenCV.js)
- **Lazy-loaded** (~8 MB WASM) from a CDN when the camera opens; falls back to the
  fixed guide box (no green feedback) if it fails to load or initialize (30 s cap).
- **Brightness-band** detection — the receipt is lighter than its background — not
  gradient-based, which would mistake interior text for an edge.
- **False-positive gates:** (1) a contrast gate (the bright band must exceed the
  background by `contrastMin`) and (2) a Canny **text-density** gate (`textureMin`)
  so smooth surfaces like walls or hands are rejected.
- **Per-edge state:** an edge is "in view" only when the band starts/ends inside
  the frame; it turns **green** when that edge lands within `alignTol` of the fixed
  box edge. The **bottom** line appears only when the receipt's end is detected.
- All OpenCV `Mat`s are tracked and released in a `finally` block (no leaks even on
  mid-function exceptions).

### 3.4 Image processing & quality gates
- **DPR-aware crop:** the fixed box is mapped onto the raw sensor matrix via
  `getBoundingClientRect()` ratios and rasterized at `devicePixelRatio`.
- **Skew correction:** landscape sensor + portrait layout → rotate the canvas 90° CW.
- **Luminance guardrail:** mean Rec.709 luminance must be within `[lumaMin, lumaMax]`,
  or the capture throws "Too dark/bright" and is discarded.
- **Blur gate:** the captured section's sharpness is measured as **Laplacian
  variance**; below `blurThreshold` the section is removed and the user is coached
  to hold steady and retake.
- **Output:** grayscale JPEG at `jpegQuality`, with automatic fallback to lower
  quality then PNG if the browser can't encode JPEG. A client-side **size cap**
  (`maxUploadBytes`) rejects oversized images before upload.

### 3.5 Multi-section merge
Sections are **not pixel-stitched** (fragile on thermal paper). Each section is
uploaded and analyzed independently, then results are merged:
- The capture overlap is a contiguous run of lines shared between sections.
- The merge finds where the next section's leading run matches a contiguous run
  **anywhere** in the accumulated items and drops that run **once**.
- Matching is **fuzzy token-similarity** (Jaccard-style token overlap ≥
  `fuzzyMergeThreshold`, default 0.75) rather than exact string equality, so OCR
  drift between sections still merges.
- Because it matches *runs*, legitimately repeated purchases are preserved.
- The merged result takes the first non-empty vendor/date, the last section's
  total, the averaged confidence, and stamps `merged_sections` and `sdk_version`.

### 3.6 Delivery pipeline
- **Get URL:** `POST endpoints.uploadUrl` → `{ job_id, upload_url }` (with retry +
  timeout).
- **Upload:** `PUT upload_url` via `XMLHttpRequest` for **upload-progress** events,
  sending `X-User-Id` and `X-SDK-Version` headers.
- **Poll:** `GET endpoints.status?job=<id>` every `pollIntervalMs` up to `maxPolls`;
  terminal statuses are `done` (→ result), `rejected` (server declined; surfaced in
  the error panel), `failed`, and `unknown` (job not found).
- **Resilience:** `get-upload-url` and each poll use timeouts and exponential
  backoff with jitter, retrying on 5xx / 429 / timeout (`retryAttempts`); 4xx are
  not retried. The upload itself is a single PUT with its own timeout.

### 3.7 Backend API (`/aws/*`)
Flask + boto3 ([`app.py`](../app.py)). The SDK client calls **get-upload-url**,
the returned presigned-style **PUT**, and **analyze-status**; the others are
server routes.

| Endpoint | Purpose |
|----------|---------|
| `GET /aws/status` | Whether boto3 + AWS credentials are available |
| `POST /aws/get-upload-url` | Returns `{ job_id, upload_url }` (absolute, CORS-friendly) |
| `PUT /aws/upload/<job_id>` | Receives image bytes; starts Textract in a background thread |
| `GET /aws/analyze-status?job=<id>` | `{ status: processing\|done\|rejected\|failed\|unknown, result?, error? }` |

**Server-side validation layer:** readability hard block · confidence gate
(`TEXTRACT_MIN_CONFIDENCE`, default 50) · temporal rules (future-dated / older than
`RECEIPT_MAX_AGE_DAYS`, default 14) · line-item cleanup (strips Textract phantom
rows + summary/payment lines; does **not** dedup by description, so repeats
survive) · deduplication (SHA-256 image hash + `user_vendor_total_date` semantic
key) — **gated by `DEDUP_ENABLED`** and off during prototyping.

### 3.8 Code map
| File | Contains |
|------|----------|
| `static/receipt-capture-sdk.js` | The SDK: UI build, camera, `_detectEdges`, `_captureBox`, blur (`_measureSharpness`), `submit`/`_analyzeBlob`/`_mergeResults`, `_fetchWithRetry` |
| `app.py` | `/aws/*` routes, `normalize_textract`, `run_analyze` (validation), `_clean_line_items` |
| `design_preview_noclip.html` | Reference integration: app-level device choice, upload path, result rendering |

---

# Part 4 — Limitations & Production Roadmap

### Known limitations
- **Edge/bottom detection** needs the receipt lighter than its background — best on
  a dark, non-shiny surface; weak on white tables. A heavier on-device ML model
  would improve robustness.
- **OpenCV.js is ~8 MB**, lazy-loaded on first camera open; on slow networks edge
  detection activates a few seconds in (manual capture still works meanwhile, using
  the fixed box).
- **Fuzzy overlap merge** is token-based; extreme OCR drift on a shared line could
  still merge imperfectly, though far less than exact-match would.
- **Textract synchronous `AnalyzeExpense`** supports JPEG/PNG, not PDF.

### Production extension points
The current backend is a lightweight stand-in: Textract runs synchronously on the
uploaded bytes (no S3), and jobs/dedup live in process memory. A production build
would use **API Gateway + Lambda + an S3 presigned PUT + asynchronous Textract +
DynamoDB** for the dedup indexes. The client pipeline (presigned PUT + polling)
already matches that shape, so **only the server changes** — the SDK is unaffected.

### Configuration (backend env)
`AWS_REGION` · AWS credentials (env or IAM role) · `ALLOWED_ORIGIN` (CORS) ·
`RECEIPT_MAX_AGE_DAYS` · `TEXTRACT_MIN_CONFIDENCE` · `DEDUP_ENABLED`.

### Tech stack
Vanilla ES + Canvas 2D + `getUserMedia` (SDK) · OpenCV.js 4.8 (WASM, lazy) ·
Flask + flask-cors + boto3 + gunicorn (backend) · Amazon Textract `AnalyzeExpense`
· GitHub Pages (frontend) + Render (backend).

---

*SDK version 0.1.0. This specification is generated from and kept in sync with
`static/receipt-capture-sdk.js`; update the code and regenerate this document
together.*
