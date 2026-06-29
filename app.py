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
import logging
import os
import re
import threading
import time
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
DEDUP_ENABLED = os.getenv("DEDUP_ENABLED", "false").lower() == "true"

# In-memory stores (prototype only -- reset on restart).
SEEN_IMAGE_HASHES = {}
SEEN_SEMANTIC = {}

MAX_BYTES = 20 * 1024 * 1024
APP_DIR = os.path.dirname(os.path.abspath(__file__))
OFFERS_PATH = os.path.join(APP_DIR, "offers.json")

app = Flask(__name__, static_folder="static")

ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "*")
CORS(app, resources={r"/aws/*": {"origins": ALLOWED_ORIGIN}})

# --- Backend patch: ALLOWED_ORIGIN warning (#15) ---
logger = logging.getLogger(__name__)

if ALLOWED_ORIGIN == "*":
    logger.warning(
        "ALLOWED_ORIGIN is '*' (allow all origins). "
        "Set ALLOWED_ORIGIN to your frontend's exact origin for production "
        "(e.g., ALLOWED_ORIGIN=https://your-app.example.com)."
    )


# --- Backend patch: Thread-safe job store (#11 + #12) ---

class ThreadSafeJobStore:
    """Thread-safe job store with TTL eviction (#11 + #12).

    All reads/writes go through methods that hold the lock.
    Jobs older than `ttl_seconds` are evicted on every write."""

    def __init__(self, ttl_seconds=1800):
        self._lock = threading.Lock()
        self._jobs = {}             # job_id -> {status, result, error, key, _created}
        self._ttl = ttl_seconds     # 30 minutes default

    def create(self, job_id, data):
        with self._lock:
            self._evict()
            data["_created"] = time.time()
            self._jobs[job_id] = data

    def get(self, job_id):
        with self._lock:
            return self._jobs.get(job_id)

    def update(self, job_id, **kwargs):
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.update(kwargs)

    def exists(self, job_id):
        with self._lock:
            return job_id in self._jobs

    def _evict(self):
        """Remove jobs older than TTL. Called inside the lock."""
        now = time.time()
        expired = [k for k, v in self._jobs.items()
                   if now - v.get("_created", 0) > self._ttl]
        for k in expired:
            del self._jobs[k]

    @property
    def count(self):
        with self._lock:
            return len(self._jobs)


JOBS = ThreadSafeJobStore(ttl_seconds=1800)   # 30-minute TTL


def load_offers():
    try:
        with open(OFFERS_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return []


def upc_variants(code):
    digits = "".join(ch for ch in str(code) if ch.isdigit())
    if not digits:
        return set()
    variants = {digits}
    if len(digits) == 13 and digits.startswith("0"):
        variants.add(digits[1:])
    if len(digits) == 12:
        variants.add("0" + digits)
    if len(digits) >= 12:
        variants.add(digits[-11:-1])
    if len(digits) == 11:
        variants.add(digits[:10])
    return variants


def offer_candidate_upcs(offer):
    out = []
    base_cash = offer.get("cashback")
    sizes = offer.get("sizes") or []
    if sizes:
        for s in sizes:
            out.append((upc_variants(s.get("upc", "")),
                        s.get("size"), s.get("cashback", base_cash)))
    out.append((upc_variants(offer.get("upc", "")), None, base_cash))
    return out


def line_item_upcs(line_item):
    found = set()
    if line_item.get("upc"):
        found |= upc_variants(line_item["upc"])
    for pd in (line_item.get("product_details") or []):
        for key in ("ean", "gtin_14", "upc"):
            if pd.get(key):
                found |= upc_variants(pd[key])
    return found


# --- Quantity patch: new helpers ---

# Matches common receipt quantity patterns embedded in the description.
#   "2@ $3.99"  "2 @ 3.99"  "4X $1.50"  "4x 1.50"  "3 x 2.00"
#   "QTY 3"  "Qty: 3"  "QTY:3"
_QTY_FROM_DESC = re.compile(
    r"(?:^|\s)(\d{1,3})\s*[×xX@]\s"       # 2@  4X  3 x
    r"|\bQTY\s*:?\s*(\d{1,3})\b",          # QTY 3  Qty:3
    re.I,
)

# Weight units -- if the quantity string contains one of these, it's a weight,
# not a discrete count (e.g., "0.35 lb"). Cashback should apply once, not 0.35x.
_WEIGHT_UNITS = re.compile(r"\b(lb|lbs|oz|kg|g|gal|fl\.?\s*oz|pt|qt)\b", re.I)


def _parse_qty_int(qty_val):
    """Parse a quantity value (string or number) into an integer count.

    Returns 1 for weights ("0.35 lb"), fractional values, unparseable strings,
    or None. Only returns >1 for whole-number counts."""
    if qty_val is None:
        return 1
    s = str(qty_val).strip()
    if not s:
        return 1
    # Weights aren't discrete counts -- treat as qty 1 for cashback purposes.
    if _WEIGHT_UNITS.search(s):
        return 1
    # Pull the first number from the string.
    m = re.search(r"(\d+\.?\d*)", s)
    if not m:
        return 1
    try:
        n = float(m.group(1))
        # Only use it if it's a whole number >= 1 (fractional = weight).
        if n == int(n) and n >= 1:
            return int(n)
        return 1
    except (ValueError, TypeError):
        return 1


def _extract_quantity(row):
    """If the row has no quantity (or qty 1), try to extract one from the
    description text. Updates row['quantity'] and row['qty'] in place."""
    current = row.get("quantity")
    qty_int = _parse_qty_int(current)

    # If Textract already gave a real count, use it.
    if qty_int > 1:
        row["qty"] = qty_int
        return

    # Try to pull a count from the description (e.g., "2@ $3.99 BANANA").
    desc = row.get("description") or ""
    m = _QTY_FROM_DESC.search(desc)
    if m:
        raw = m.group(1) or m.group(2)
        parsed = _parse_qty_int(raw)
        if parsed > 1:
            row["quantity"] = raw
            row["qty"] = parsed
            row["qty_source"] = "description"  # for debugging
            return

    row["qty"] = qty_int   # default: 1


# --- Quantity patch: quantity-aware match_receipt_to_clipped ---

def match_receipt_to_clipped(line_items, offers, clipped_ids):
    """Match a parsed receipt's line items against the member's clipped offers.

    Ibotta model: only offers the member has clipped are eligible. Each clipped
    offer can be redeemed at most once per receipt -- but if the member bought
    multiple units (qty > 1), cashback is multiplied by the quantity.

    The quantity comes from three sources (in priority order):
      1. Textract QUANTITY field (e.g., "2")
      2. Parsed from description text (e.g., "2@ $3.99")
      3. Default: 1
    """
    clipped = [o for o in offers if o.get("campaign_id") in set(clipped_ids)]

    # Build a per-line-item UPC set + qty lookup so we can match at the item
    # level (not just a flat set of all UPCs). Multiple line items with the
    # same UPC are summed (e.g., two separate lines for the same product).
    # Structure: upc_variant -> total qty across all matching line items.
    upc_qty_map = {}
    receipt_upcs = set()
    for li in line_items:
        li_upcs = line_item_upcs(li)
        receipt_upcs |= li_upcs
        qty = li.get("qty", 1) or 1
        for u in li_upcs:
            upc_qty_map[u] = upc_qty_map.get(u, 0) + qty

    matched, unmatched, total = [], [], 0.0
    for offer in clipped:
        hit = None
        for variants, size_label, cashback in offer_candidate_upcs(offer):
            if variants and (variants & receipt_upcs):
                # Find the best quantity: check each variant and take the max
                # (all variants point to the same physical product).
                qty = max((upc_qty_map.get(v, 0) for v in variants), default=1)
                qty = max(qty, 1)
                hit = (size_label, cashback, qty)
                break
        if hit:
            size_label, cashback, qty = hit
            cashback = float(cashback or 0)
            line_total = round(cashback * qty, 2)
            total += line_total
            matched.append({
                "campaign_id": offer.get("campaign_id"),
                "product": offer.get("product"),
                "brand": offer.get("brand"),
                "icon": offer.get("icon"),
                "size": size_label,
                "cashback_per_unit": cashback,
                "quantity": qty,
                "cashback": line_total,
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


def veryfi_process(file_bytes, filename):
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
        "boost_mode": False,
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


def textract_client():
    import boto3
    return boto3.client("textract", region_name=AWS_REGION)


def _money_to_float(text):
    if not text:
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", str(text).replace(",", ""))
    try:
        return round(float(cleaned), 2)
    except (ValueError, TypeError):
        return None


_UPC_CONTIG = re.compile(r"(?<!\d)(\d{8,14})(?!\d)")
_UPC_SPACED = re.compile(r"(?<!\d)(\d[ ]?\d{5}[ ]?\d{5}[ ]?\d)(?!\d)")


def _attach_upc(row, row_text):
    if row.get("upc"):
        return
    hay = (row.get("description") or "") + " " + (row_text or "")
    m = _UPC_CONTIG.search(hay) or _UPC_SPACED.search(hay)
    if m:
        cand = re.sub(r"\D", "", m.group(1))
        if 8 <= len(cand) <= 14:
            row["upc"] = cand
            row["upc_source"] = "text"


def normalize_textract(resp):
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
                row_text = ""
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
                        if 8 <= len(code) <= 14:
                            row["upc"] = code
                    elif ftype == "EXPENSE_ROW":
                        row_text = value or ""
                if row:
                    _attach_upc(row, row_text)
                    _extract_quantity(row)
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


_LINEITEM_NOISE = re.compile(
    r"\b(savings|subtotal|sub total|tax|total|net sales|balance|change|"
    r"visa|mastercard|amex|debit|credit|chip card|paid|approval|auth|tender|"
    r"aid|account|ref|reg)\b", re.I)


def _clean_line_items(items):
    cleaned = []
    for li in items:
        desc = (li.get("description") or "").strip()
        if not desc or "\n" in desc:
            _harvest_orphan_upc(li, cleaned)
            continue
        if not re.search(r"[A-Za-z]", desc):
            _harvest_orphan_upc(li, cleaned)
            continue
        if _LINEITEM_NOISE.search(desc):
            continue
        cleaned.append(li)
    return cleaned


def _harvest_orphan_upc(li, cleaned):
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


# --- Backend patch: updated _reject (takes job_id, thread-safe) ---

def _reject(job_id, reason, result=None):
    """Reject a job by ID (thread-safe)."""
    JOBS.update(job_id, status="rejected", error=reason, result=result)


# --- Backend patch: updated run_analyze (thread-safe job store) ---

def run_analyze(job_id, file_bytes, user_id):
    """Worker: call Textract, then apply the server-side validation/fraud layer.
    Runs in a background thread so the upload PUT returns immediately and the
    SDK can poll /aws/analyze-status."""
    try:
        resp = textract_client().analyze_expense(Document={"Bytes": file_bytes})
    except Exception as exc:
        JOBS.update(job_id, status="failed", error=f"{exc.__class__.__name__}: {exc}")
        return

    norm = normalize_textract(resp)

    # 1. Readability hard block.
    if (norm["line_item_count"] == 0 and not (norm["vendor"] or {}).get("name")
            and norm["total"] is None):
        _reject(job_id, "Textract found no readable receipt structure.", norm)
        return
    if norm["avg_confidence"] is not None and norm["avg_confidence"] < TEXTRACT_MIN_CONFIDENCE:
        _reject(job_id, f"Low OCR confidence ({norm['avg_confidence']:.0f}%). Retake the photo.", norm)
        return

    # 2. Temporal ruleset.
    if norm["date"]:
        try:
            parsed = date_parser.parse(norm["date"])
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            now = datetime.now(timezone.utc)
            age_days = (now - parsed).days
            norm["receipt_age_days"] = age_days
            if parsed > now + timedelta(days=1):
                _reject(job_id, "Receipt date is in the future.", norm)
                return
            if RECEIPT_MAX_AGE_DAYS and age_days > RECEIPT_MAX_AGE_DAYS:
                _reject(job_id, f"Receipt is {age_days} days old (limit {RECEIPT_MAX_AGE_DAYS}).", norm)
                return
        except (ValueError, OverflowError):
            pass

    # 3. Dedup (when enabled).
    image_hash = hashlib.sha256(file_bytes).hexdigest()
    norm["image_sha256"] = image_hash

    JOBS.update(job_id, status="done", result=norm)


# --- Backend patch: rate limiter (#14) ---

class SimpleRateLimiter:
    """Token-bucket rate limiter keyed by IP + X-User-Id.

    Args:
        max_requests: max requests per window
        window_seconds: rolling window size
    """

    def __init__(self, max_requests=30, window_seconds=60):
        self._max = max_requests
        self._window = window_seconds
        self._lock = threading.Lock()
        self._buckets = {}   # key -> [timestamps]

    def _key(self):
        uid = request.headers.get("X-User-Id", "")
        ip = request.remote_addr or ""
        return f"{ip}:{uid}"

    def is_allowed(self):
        now = time.time()
        key = self._key()
        with self._lock:
            hits = self._buckets.get(key, [])
            # Prune old entries.
            cutoff = now - self._window
            hits = [t for t in hits if t > cutoff]
            if len(hits) >= self._max:
                self._buckets[key] = hits
                return False
            hits.append(now)
            self._buckets[key] = hits
            return True

    def check(self):
        """Call at the top of a route. Returns a 429 response if over limit,
        or None if allowed."""
        if not self.is_allowed():
            from flask import jsonify as _jsonify
            resp = _jsonify({"error": "Rate limit exceeded. Try again shortly."})
            resp.status_code = 429
            resp.headers["Retry-After"] = str(self._window)
            return resp
        return None


# Create the limiter (30 requests per 60 seconds per IP+user).
aws_limiter = SimpleRateLimiter(max_requests=30, window_seconds=60)


@app.errorhandler(Exception)
def handle_unexpected(exc):
    return jsonify({"error": f"Server error: {exc.__class__.__name__}: {exc}"}), 500


@app.route("/")
def index():
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
    uploaded = request.files.get("receipt")
    if uploaded is None:
        return jsonify({"error": "No file received (expected form field 'receipt')."}), 400
    data, err = veryfi_process(uploaded.read(), uploaded.filename)
    if err:
        return err
    return jsonify(data)


@app.route("/api/match-receipt", methods=["POST"])
def match_receipt():
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


@app.route("/noclip")
def noclip_preview():
    resp = send_from_directory(APP_DIR, "design_preview_noclip.html")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/cashback")
@app.route("/cashback.html")
def cashback_page():
    resp = send_from_directory(APP_DIR, "cashback.html")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/aws/status")
def aws_status():
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
    blocked = aws_limiter.check()
    if blocked:
        return blocked
    job_id = uuid.uuid4().hex
    key = f"receipts/{job_id}.jpg"
    JOBS.create(job_id, {"status": "awaiting-upload", "result": None, "error": None, "key": key})
    upload_url = request.host_url.rstrip("/") + f"/aws/upload/{job_id}"
    return jsonify({"job_id": job_id, "key": key, "upload_url": upload_url})


@app.route("/aws/upload/<job_id>", methods=["PUT", "POST"])
def aws_upload(job_id):
    blocked = aws_limiter.check()
    if blocked:
        return blocked
    job = JOBS.get(job_id)
    if job is None:
        return jsonify({"error": "Unknown job_id."}), 404
    file_bytes = request.get_data()
    if not file_bytes:
        return jsonify({"error": "Empty upload."}), 400
    if len(file_bytes) > MAX_BYTES:
        return jsonify({"error": "File exceeds the 20 MB limit."}), 400

    user_id = request.headers.get("X-User-Id", "demo-user")
    JOBS.update(job_id, status="processing")
    threading.Thread(target=run_analyze, args=(job_id, file_bytes, user_id),
                     daemon=True).start()
    return jsonify({"status": "processing", "job_id": job_id})


@app.route("/aws/analyze-status")
def aws_analyze_status():
    blocked = aws_limiter.check()
    if blocked:
        return blocked
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
