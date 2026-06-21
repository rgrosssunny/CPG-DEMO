# CPG Cashback Demo

Member-facing prototype for **CPG (Consumer Packaged Goods) cashback** on the Sunny
Benefits platform. A member browses cashback offers, drills into a product to see which
sizes qualify, drills into a store to see its offers, and earns cash back by scanning a
**receipt** (Veryfi OCR) or a **product barcode**.

The UI follows the Sunny / ABC Health design system. A small Flask server holds the
Veryfi credentials and proxies requests, so the API key never reaches the browser.

## Run locally

```bash
pip install -r requirements.txt
cp .env.example .env        # then paste in your Veryfi credentials
python app.py               # serves on http://localhost:5050
```

Open http://localhost:5050.

> No setup needed for a quick look: open `design_preview.html` directly in a browser —
> it’s the full UI with a mocked backend (no real Veryfi calls).

## Run in GitHub Codespaces

1. **Code → Codespaces → Create codespace** on this repo. The `.devcontainer`
   installs dependencies automatically.
2. Add your Veryfi keys as Codespaces secrets (repo **Settings → Secrets and variables
   → Codespaces**): `VERYFI_CLIENT_ID`, `VERYFI_USERNAME`, `VERYFI_API_KEY`.
3. In the Codespace terminal: `python app.py`
4. Open the forwarded **port 5050** (it’s served over HTTPS, so the camera /
   barcode scanner works).

## Deploy to a host (Render / Railway / Fly)

The app honors a `$PORT` env var and includes a `Procfile` (`web: python app.py`).
Set the three `VERYFI_*` values as environment variables / secrets on the host.
For production, swap to a WSGI server (e.g. `gunicorn app:app`).

## AWS Textract camera-capture SDK (experimental)

📄 **Full technical spec:** [docs/RECEIPT_CAPTURE_SDK.md](docs/RECEIPT_CAPTURE_SDK.md)


`design_preview_noclip.html` includes a client-side capture SDK
(`static/receipt-capture-sdk.js`) that tests **Amazon Textract** alongside the
Veryfi path. It runs the full client engine from the spec — rear-camera capture
with macro focus + fallback, a centered reticle, DPR-aware cropping, tilted-phone
rotation, a luminance guardrail, grayscale JPEG compression, multi-page vertical
stitching — then ships the payload through a presigned-PUT + 2s-polling pipeline.

For local testing the backend keeps AWS setup minimal: **no S3 bucket needed.**
The `/aws/*` endpoints call Textract `AnalyzeExpense` synchronously on the
uploaded bytes (in a background thread, so the SDK still exercises the real
polling flow). It also applies the server-side validation layer: readability
hard block, temporal rules (future / >14 days), and SHA-256 + semantic
deduplication — all in memory.

```bash
pip install -r requirements.txt          # now includes boto3 + python-dateutil
# Provide AWS creds via env, ~/.aws/credentials, or a role. Set AWS_REGION in .env.
python app.py
```

Open **http://localhost:5050/noclip** (must be localhost/HTTPS for the camera),
go to **Shop → Snap a receipt → 📸 Capture with camera**. Opening the file
directly (`file://`) falls back to canned Textract data so the UI still demos.

> No fraud/dedup/DB logic runs in the browser — the SDK only prepares and
> delivers the media payload; the backend owns all validation.

## Endpoints

| Route | Purpose |
|-------|---------|
| `GET /` | Serves the member UI (`static/index.html`) |
| `GET /noclip` | Serves the camera-capture preview (`design_preview_noclip.html`) |
| `GET /api/offers` | Active cashback offer catalog (from `offers.json`) |
| `GET /api/config-status` | Reports whether Veryfi credentials are set |
| `GET /api/check-offer?upc=…` | Barcode lookup — matches primary or size UPC |
| `POST /api/process` | Receipt → Veryfi OCR → parsed JSON |
| `GET /aws/status` | Reports whether boto3 + AWS credentials are available |
| `POST /aws/get-upload-url` | Returns a job id + (presigned-style) PUT URL |
| `PUT /aws/upload/<job_id>` | Receives image bytes, starts Textract analysis |
| `GET /aws/analyze-status?job=…` | Poll for `processing` / `done` / `rejected` / `failed` |

## Offer catalog

Edit `offers.json` to manage offers (no restart needed). Each offer has a primary
`upc`, `cashback`, `expires`, `status` (`active` / `exhausted`), and a `sizes[]`
array — each size carries its own `upc` and `cashback`.

## Security

- `.env` is gitignored — **never commit real credentials.**
- Veryfi keys live only on the server; the browser only ever sends a barcode number
  or a receipt image to this app’s own endpoints.
