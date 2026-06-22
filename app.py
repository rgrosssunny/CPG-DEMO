"""
Veryfi receipt-capture prototype (Ibotta-style clip & redeem).

A tiny Flask server that:
  1. Serves a single-page UI: clip multiple cashback offers, then scan ONE receipt.
  2. Proxies receipt images to Veryfi's "Process a Document" endpoint
     (keeping your API credentials on the server, never in the browser).
  3. Matches the parsed receipt against the member's clipped offers and returns
     which offers were redeemed plus the total cashback earned.

Run:
    pip install -r requirements.txt
    cp .env.example .env   # then fill in your Veryfi credentials
    python app.py
    open http://localhost:5050
"""

import base64
import hashlib
import json
import os
import re
import threading
import uuid
from datetime import datetime, timedelta, timezone

import requests
from dateutil import parser as date_parser
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

load_dotenv()

VERYFI_CLIENT_ID = os.getenv("VERYFI_CLIENT_ID", "")
VERYFI_USERNAME = os.getenv("VERYFI_USERNAME", "")
VERYFI_API_KEY = os.getenv("VERYFI_API_KEY", "")
VERYFI_URL = "https://api.veryfi.com/api/v8/partner/documents"

# ---- AWS Textract (camera-capture SDK path) ----------------------------------
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
RECEIPT_MAX_AGE_DAYS = int(os.getenv("RECEIPT_MAX_AGE_DAYS", "14"))
TEXTRACT_MIN_CONFIDENCE = float(os.getenv("TEXTRACT_MIN_CONFIDENCE", "50"))
# Off by default during prototyping so the same receipt can be re-scanned.
# Set DEDUP_ENABLED=true in production to enforce the anti-fraud guards.
DEDUP_ENABLED = os.getenv("DEDUP_ENABLED", "false").lower() == "true"

# In-memory stores (prototype only — reset on restart). A real deployment would
# use S3 + Textract async jobs + DynamoDB for the dedup indexes.
JOBS = {}              # job_id -> {status, result, error, key}
SEEN_IMAGE_HASHES = {}  # sha256 -> job_id  (strict image collision)
SEEN_SEMANTIC = {}      # composite string -> job_id  (semantic collision)

MAX_BYTES = 20 * 1024 * 1024  # Veryfi max file size is 20 MB
APP_DIR = os.path.dirname(os.path.abspath(__file__))
OFFERS_PATH = os.path.join(APP_DIR, "offers.json")

app = Flask(__name__, static_folder="static")

# Allow the GitHub Pages frontend (a different origin) to call the /aws/* API.
# Set ALLOWED_ORIGIN to your Pages origin in production; "*" is fine for testing
# since these endpoints carry no cookies/credentials.
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "*")
CORS(app, resources={r"/aws/*": {"origins": ALLOWED_ORIGIN}})


# ---------------------------------------------------------------- offers/UPC --
def load_offers():
    """Load the offer catalog. Read on each request so you can edit offers.json
    without restarting the server during the POC."""
    try:
        with open(OFFERS_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return []


def upc_variants(code):
    """Equivalent forms of a barcode so UPC-A and EAN-13 match each other."""
    digits = "".join(ch for ch in str(code) if ch.isdigit())
    if not digits:
        return set()
    variants = {digits}
    if len(digits) == 13 and digits.startswith("0"):
        variants.add(digits[1:])      # EAN-13 -> UPC-A
    if len(digits) == 12:
        variants.add("0" + digits)    # UPC-A -> EAN-13
    # UPC-A/EAN "core" = manufacturer+product digits (drop the leading
    # number-system/pad digit(s) and the trailing check digit) so a full
    # 12/13/14-digit code reconciles with a 10-digit catalog code, and vice-versa.
    if len(digits) >= 12:
        variants.add(digits[-11:-1])
    if len(digits) == 11:
        variants.add(digits[:10])     # drop check digit only
    return variants


def offer_candidate_upcs(offer):
    """Every UPC that should qualify for an offer, with the cashback + size that
    applies. Returns list of (variant_set, size_label, cashback)."""
    out = []
    base_cash = offer.get("cashback")
    sizes = offer.get("sizes") or []
    if sizes:
        for s in sizes:
            out.append((upc_variants(s.get("upc", "")),
                        s.get("size"), s.get("cashback", base_cash)))
    # Always include the top-level UPC as a fallback candidate.
    out.append((upc_variants(offer.get("upc", "")), None, base_cash))
    return out


def line_item_upcs(line_item):
    """Collect every barcode signal Veryfi gives for a line item: the printed
    `upc`, plus `ean`/`gtin_14` from the product_details enrichment."""
    found = set()
    if line_item.get("upc"):
        found |= upc_variants(line_item["upc"])
    for pd in (line_item.get("product_details") or []):
        for key in ("ean", "gtin_14", "upc"):
            if pd.get(key):
                found |= upc_variants(pd[key])
    return found


def match_receipt_to_clipped(line_items, offers, clipped_ids):
    """Match a parsed receipt's line items against the member's clipped offers.

    Ibotta model: only offers the member has clipped are eligible. Each clipped
    offer can be redeemed at most once per receipt.
    """
    clipped = [o for o in offers if o.get("campaign_id") in set(clipped_ids)]

    # All UPC signals present on the receipt (for transparency in the POC).
    receipt_upcs = set()
    for li in line_items:
        receipt_upcs |= line_item_upcs(li)

    matched, unmatched, total = [], [], 0.0
    for offer in clipped:
        hit = None
        for variants, size_label, cashback in offer_candidate_upcs(offer):
            if variants and (variants & receipt_upcs):
                hit = (size_label, cashback)
                break
        if hit:
            size_label, cashback = hit
            cashback = float(cashback or 0)
            total += cashback
            matched.append({
                "campaign_id": offer.get("campaign_id"),
                "product": offer.get("product"),
                "brand": offer.get("brand"),
                "icon": offer.get("icon"),
                "size": size_label,
                "cashback": cashback,
            })
        else:
            unmatched.append({
                "campaign_id": offer.get("campaign_id"),
                "product": offer.get("product"),
                "icon": offer.get("icon"),
            })

    return {
        "matched": matched,
        "unmatched": unmatched,
        "total_cashback": round(total, 2),
        "receipt_upcs": sorted(receipt_upcs),
        "line_item_count": len(line_items),
    }


# --------------------------------------------------------------------- Veryfi --
def veryfi_process(file_bytes, filename):
    """Send an image to Veryfi. Returns (data, error_response). On success
    error_response is None; on failure data is None and error_response is a
    (json, status) tuple ready to return."""
    if not all([VERYFI_CLIENT_ID, VERYFI_USERNAME, VERYFI_API_KEY]):
        return None, (jsonify({
            "error": "Veryfi credentials are not set. Fill in .env and restart the server."
        }), 500)
    if not file_bytes:
        return None, (jsonify({"error": "Uploaded file is empty."}), 400)
    if len(file_bytes) > MAX_BYTES:
        return None, (jsonify({"error": "File exceeds Veryfi's 20 MB limit."}), 400)

    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Client-Id": VERYFI_CLIENT_ID,
        "Authorization": f"apikey {VERYFI_USERNAME}:{VERYFI_API_KEY}",
    }
    payload = {
        "file_name": filename or "receipt.jpg",
        "file_data": base64.b64encode(file_bytes).decode("utf-8"),
        "boost_mode": False,  # keep enrichment (product_details) on
    }
    try:
        resp = requests.post(VERYFI_URL, headers=headers, json=payload, timeout=120)
    except requests.RequestException as exc:
        return None, (jsonify({"error": f"Request to Veryfi failed: {exc}"}), 502)

    try:
        data = resp.json()
    except ValueError:
        return None, (jsonify({"error": "Veryfi returned a non-JSON response.",
                               "status_code": resp.status_code,
                               "body": resp.text[:2000]}), 502)
    if resp.status_code >= 400:
        return None, (jsonify({"error": "Veryfi returned an error.",
                               "status_code": resp.status_code,
                               "details": data}), resp.status_code)
    return data, None


# ------------------------------------------------------------------- Textract --
def textract_client():
    """Lazily build a boto3 Textract client so the rest of the app runs even if
    boto3 / credentials aren't installed yet."""
    import boto3  # imported lazily so missing creds don't break the Veryfi path
    return boto3.client("textract", region_name=AWS_REGION)


def _money_to_float(text):
    if not text:
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", str(text).replace(",", ""))
    try:
        return round(float(cleaned), 2)
    except (ValueError, TypeError):
        return None


# Contiguous 8–14 digit run, or a UPC-A printed with the standard 1-5-5-1 spacing.
# 8 digits covers UPC-E/EAN-8 and short catalog codes; 14 covers GTIN-14.
_UPC_CONTIG = re.compile(r"(?<!\d)(\d{8,14})(?!\d)")
_UPC_SPACED = re.compile(r"(?<!\d)(\d[ ]?\d{5}[ ]?\d{5}[ ]?\d)(?!\d)")


def _attach_upc(row, row_text):
    """Recover a UPC/GTIN for a line item when Textract didn't populate
    PRODUCT_CODE. Many receipts print the UPC in the item text, which Textract
    files under ITEM/EXPENSE_ROW rather than PRODUCT_CODE — so scan that text for
    a 12–14 digit number (or a standard-spaced UPC-A) and use it for matching."""
    if row.get("upc"):
        return
    hay = (row.get("description") or "") + " " + (row_text or "")
    m = _UPC_CONTIG.search(hay) or _UPC_SPACED.search(hay)
    if m:
        cand = re.sub(r"\D", "", m.group(1))
        if 8 <= len(cand) <= 14:
            row["upc"] = cand
            row["upc_source"] = "text"   # vs Textract PRODUCT_CODE; useful for debugging


def normalize_textract(resp):
    """Map a Textract AnalyzeExpense response into the same shape the front-end
    already understands for Veryfi: {vendor:{name}, date, total, line_items[]}.
    line_items expose description/total/quantity/upc so matchReceipt() works
    unchanged."""
    vendor = date = total = None
    confidences = []
    line_items = []

    for doc in resp.get("ExpenseDocuments") or []:
        for field in doc.get("SummaryFields") or []:
            ftype = (field.get("Type") or {}).get("Text")
            value = (field.get("ValueDetection") or {}).get("Text")
            conf = (field.get("ValueDetection") or {}).get("Confidence")
            if conf is not None:
                confidences.append(conf)
            if ftype in ("VENDOR_NAME", "NAME") and not vendor:
                vendor = value
            elif ftype == "INVOICE_RECEIPT_DATE" and not date:
                date = value
            elif ftype == "TOTAL" and total is None:
                total = _money_to_float(value)

        for group in doc.get("LineItemGroups") or []:
            for item in group.get("LineItems") or []:
                row = {}
                row_text = ""   # Textract's full row text (EXPENSE_ROW) — best place to find a UPC
                for ef in item.get("LineItemExpenseFields") or []:
                    ftype = (ef.get("Type") or {}).get("Text")
                    value = (ef.get("ValueDetection") or {}).get("Text")
                    conf = (ef.get("ValueDetection") or {}).get("Confidence")
                    if conf is not None:
                        confidences.append(conf)
                    if ftype == "ITEM":
                        row["description"] = value
                    elif ftype == "PRICE":
                        row["total"] = _money_to_float(value)
                    elif ftype == "QUANTITY":
                        row["quantity"] = value
                    elif ftype == "PRODUCT_CODE":
                        code = re.sub(r"\D", "", value or "")
                        if 8 <= len(code) <= 14:   # UPC-E/EAN-8 up through GTIN-14
                            row["upc"] = code
                    elif ftype == "EXPENSE_ROW":
                        row_text = value or ""
                if row:
                    _attach_upc(row, row_text)
                    line_items.append(row)

    line_items = _clean_line_items(line_items)
    avg_conf = round(sum(confidences) / len(confidences), 2) if confidences else None
    return {
        "vendor": {"name": vendor},
        "date": date,
        "total": total,
        "currency_code": "USD",
        "document_type": "receipt",
        "line_items": line_items,
        "line_item_count": len(line_items),
        "avg_confidence": avg_conf,
        "source": "aws-textract",
    }


# Summary/payment terms that Textract sometimes mis-classifies as line items.
_LINEITEM_NOISE = re.compile(
    r"\b(savings|subtotal|sub total|tax|total|net sales|balance|change|"
    r"visa|mastercard|amex|debit|credit|chip card|paid|approval|auth|tender|"
    r"aid|account|ref|reg)\b", re.I)


def _clean_line_items(items):
    """Drop Textract's phantom line items (garbled multi-line fragments, summary
    or payment rows). AnalyzeExpense over-segments multi-line entries ("Qty .. @
    ../lb", "Savings with Prime") into junk rows — strip those here.

    NOTE: we intentionally do NOT de-duplicate by description — a customer can
    legitimately buy several of the same product (multiple identical lines), and
    each must be kept. Cross-section overlap from multi-photo capture is removed
    separately by boundary-sequence matching in the client merge."""
    cleaned = []
    for li in items:
        desc = (li.get("description") or "").strip()
        if not desc or "\n" in desc:          # multi-line => fragment, not a product
            _harvest_orphan_upc(li, cleaned)
            continue
        if not re.search(r"[A-Za-z]", desc):   # digits-only row => likely a bare UPC
            _harvest_orphan_upc(li, cleaned)
            continue
        if _LINEITEM_NOISE.search(desc):        # summary / payment line
            continue
        cleaned.append(li)
    return cleaned


def _harvest_orphan_upc(li, cleaned):
    """A UPC printed on its own line lands as a separate digits-only / fragment
    row that _clean_line_items would otherwise drop. Recover the code and attach
    it to the most recent product row that still has no UPC."""
    hay = (li.get("description") or "") + " " + (li.get("upc") or "")
    m = _UPC_CONTIG.search(hay) or _UPC_SPACED.search(hay)
    if not m:
        return
    cand = re.sub(r"\D", "", m.group(1))
    if not 8 <= len(cand) <= 14:
        return
    for prev in reversed(cleaned):
        if not prev.get("upc"):
            prev["upc"] = cand
            prev["upc_source"] = "orphan-line"
            return


def _reject(job, reason, result=None):
    job.update(status="rejected", error=reason, result=result)


def run_analyze(job_id, file_bytes, user_id):
    """Worker: call Textract, then apply the server-side validation/fraud layer.
    Runs in a background thread so the upload PUT returns immediately and the
    SDK can poll /aws/analyze-status (mirrors the async pipeline in the spec)."""
    job = JOBS[job_id]
    try:
        resp = textract_client().analyze_expense(Document={"Bytes": file_bytes})
    except Exception as exc:  # noqa: BLE001 — surface any boto/credential/API error
        job.update(status="failed", error=f"{exc.__class__.__name__}: {exc}")
        return

    norm = normalize_textract(resp)

    # 1. Readability hard block — no structural text at all.
    if (norm["line_item_count"] == 0 and not (norm["vendor"] or {}).get("name")
            and norm["total"] is None):
        _reject(job, "Textract found no readable receipt structure.", norm)
        return
    if norm["avg_confidence"] is not None and norm["avg_confidence"] < TEXTRACT_MIN_CONFIDENCE:
        _reject(job, f"Low OCR confidence ({norm['avg_confidence']:.0f}%). Retake the photo.", norm)
        return

    # 2. Temporal ruleset — reject future-dated or stale receipts.
    if norm["date"]:
        try:
            parsed = date_parser.parse(norm["date"])
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            now = datetime.now(timezone.utc)
            age_days = (now - parsed).days
            norm["receipt_age_days"] = age_days
            if parsed > now + timedelta(days=1):
                _reject(job, "Receipt date is in the future.", norm)
                return
            if RECEIPT_MAX_AGE_DAYS and age_days > RECEIPT_MAX_AGE_DAYS:
                _reject(job, f"Receipt is {age_days} days old (limit {RECEIPT_MAX_AGE_DAYS}).", norm)
                return
        except (ValueError, OverflowError):
            pass  # unparseable date — let it through, real system would flag for review

    # 3. Anti-fraud deduplication (two indexes).
    #    TEMPORARILY DISABLED while validating basic processing — this lets the
    #    same receipt be scanned repeatedly. Uncomment the block below (and/or
    #    set DEDUP_ENABLED=true) to restore the anti-fraud guards for production.
    image_hash = hashlib.sha256(file_bytes).hexdigest()
    norm["image_sha256"] = image_hash
    # semantic = "_".join([
    #     user_id,
    #     str((norm["vendor"] or {}).get("name")),
    #     str(norm["total"]),
    #     str(norm["date"]),
    # ])
    # if DEDUP_ENABLED:
    #     if image_hash in SEEN_IMAGE_HASHES:
    #         _reject(job, "Duplicate image — this exact file was already submitted.", norm)
    #         return
    #     if semantic in SEEN_SEMANTIC:
    #         _reject(job, "Duplicate receipt — same vendor, total, and date already claimed.", norm)
    #         return
    #     SEEN_IMAGE_HASHES[image_hash] = job_id
    #     SEEN_SEMANTIC[semantic] = job_id
    job.update(status="done", result=norm)


# --------------------------------------------------------------------- routes --
@app.errorhandler(Exception)
def handle_unexpected(exc):
    return jsonify({"error": f"Server error: {exc.__class__.__name__}: {exc}"}), 500


@app.route("/")
def index():
    # Root now serves the camera/edge-detection experience (the old "clip"
    # prototype is still at /static/index.html if ever needed). no-store stops
    # the browser painting a stale cached copy before revalidating.
    resp = send_from_directory(APP_DIR, "design_preview_noclip.html")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/config-status")
def config_status():
    return jsonify({"configured": all([VERYFI_CLIENT_ID, VERYFI_USERNAME, VERYFI_API_KEY])})


@app.route("/api/offers")
def list_offers():
    return jsonify(load_offers())


@app.route("/api/check-offer")
def check_offer():
    """Validate a single scanned barcode against the catalog (barcode-scan path)."""
    raw = request.args.get("upc", "")
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits:
        return jsonify({"error": "No barcode provided."}), 400
    wanted = upc_variants(digits)
    for offer in load_offers():
        for variants, size_label, cashback in offer_candidate_upcs(offer):
            if variants and (variants & wanted):
                return jsonify({"eligible": True, "scanned_upc": digits,
                                "matched_size": size_label,
                                "cashback": cashback, **offer})
    return jsonify({"eligible": False, "scanned_upc": digits})


@app.route("/api/process", methods=["POST"])
def process():
    """Raw parse: returns Veryfi's full JSON for a single receipt (debug view)."""
    uploaded = request.files.get("receipt")
    if uploaded is None:
        return jsonify({"error": "No file received (expected form field 'receipt')."}), 400
    data, err = veryfi_process(uploaded.read(), uploaded.filename)
    if err:
        return err
    return jsonify(data)


@app.route("/api/match-receipt", methods=["POST"])
def match_receipt():
    """Scan one receipt and redeem every clipped offer found on it."""
    uploaded = request.files.get("receipt")
    if uploaded is None:
        return jsonify({"error": "No file received (expected form field 'receipt')."}), 400

    try:
        clipped_ids = json.loads(request.form.get("clipped", "[]"))
    except ValueError:
        clipped_ids = []
    if not clipped_ids:
        return jsonify({"error": "No clipped offers. Clip at least one offer before scanning."}), 400

    data, err = veryfi_process(uploaded.read(), uploaded.filename)
    if err:
        return err

    line_items = data.get("line_items") or []
    result = match_receipt_to_clipped(line_items, load_offers(), clipped_ids)
    result["vendor"] = (data.get("vendor") or {}).get("name")
    result["date"] = data.get("date")
    result["document_id"] = data.get("id")
    return jsonify(result)


# ---------------------------------------------------------- AWS Textract path --
@app.route("/noclip")
def noclip_preview():
    """Alias for the camera-capture page (same as /)."""
    resp = send_from_directory(APP_DIR, "design_preview_noclip.html")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/cashback")
@app.route("/cashback.html")
def cashback_page():
    """Standalone, linked-out cashback experience (separate responsive page)."""
    resp = send_from_directory(APP_DIR, "cashback.html")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/aws/status")
def aws_status():
    """Report whether boto3 + AWS credentials are available so the UI can warn."""
    try:
        import boto3
    except ImportError:
        return jsonify({"configured": False, "region": AWS_REGION,
                        "detail": "boto3 not installed (pip install -r requirements.txt)"})
    creds = boto3.Session().get_credentials()
    return jsonify({
        "configured": creds is not None,
        "region": AWS_REGION,
        "detail": "AWS credentials found" if creds else
                  "No AWS credentials in environment / ~/.aws / role.",
    })


@app.route("/aws/get-upload-url", methods=["POST"])
def aws_get_upload_url():
    """Stand-in for the API Gateway + Lambda presigned-URL handshake. Returns a
    job id and the URL the SDK should PUT the image to. In production this URL
    would be an S3 presigned PUT; here it's a local endpoint."""
    job_id = uuid.uuid4().hex
    key = f"receipts/{job_id}.jpg"
    JOBS[job_id] = {"status": "awaiting-upload", "result": None, "error": None, "key": key}
    # Absolute URL so a cross-origin frontend (GitHub Pages) PUTs to THIS server,
    # not to its own origin. In production this would be an S3 presigned PUT URL.
    upload_url = request.host_url.rstrip("/") + f"/aws/upload/{job_id}"
    return jsonify({"job_id": job_id, "key": key, "upload_url": upload_url})


@app.route("/aws/upload/<job_id>", methods=["PUT", "POST"])
def aws_upload(job_id):
    """Receive the raw image bytes (as an S3 presigned PUT would) and kick off
    Textract analysis in the background."""
    job = JOBS.get(job_id)
    if job is None:
        return jsonify({"error": "Unknown job_id."}), 404
    file_bytes = request.get_data()
    if not file_bytes:
        return jsonify({"error": "Empty upload."}), 400
    if len(file_bytes) > MAX_BYTES:
        return jsonify({"error": "File exceeds the 20 MB limit."}), 400

    user_id = request.headers.get("X-User-Id", "demo-user")
    job["status"] = "processing"
    threading.Thread(target=run_analyze, args=(job_id, file_bytes, user_id),
                     daemon=True).start()
    return jsonify({"status": "processing", "job_id": job_id})


@app.route("/aws/analyze-status")
def aws_analyze_status():
    """Poll endpoint. The SDK hits this every 2s until status is terminal."""
    job = JOBS.get(request.args.get("job", ""))
    if job is None:
        return jsonify({"status": "unknown"}), 404
    out = {"status": job["status"]}
    if job["status"] == "done":
        out["result"] = job["result"]
    elif job["status"] in ("failed", "rejected"):
        out["error"] = job.get("error")
        out["result"] = job.get("result")
    return jsonify(out)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    app.run(host="0.0.0.0", port=port, debug=False)
