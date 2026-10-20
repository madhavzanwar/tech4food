import os
import sys
import io
import time
import uuid
import sqlite3
import base64
import re
import numpy as np
from contextlib import closing
from datetime import date, datetime, timedelta
from pathlib import Path
from PIL import Image, ImageOps

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import torch
import torch.nn as nn
from torchvision.models import efficientnet_b0
from torchvision import transforms
from flask import Flask, request, jsonify, render_template, send_from_directory
from werkzeug.exceptions import HTTPException
from flask_cors import CORS

import ood

# --- App Configuration ---
BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
MODEL_PATH = MODELS_DIR / "efficientnet_b0_freshguard_multitask.pt"
UPLOAD_FOLDER = BASE_DIR / "static" / "uploads"
UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)
DB_PATH = BASE_DIR / "freshguard.db"
SAMPLES_DIR = BASE_DIR / "static" / "samples"
ALLOWED_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}

app = Flask(__name__, static_folder="static", template_folder="templates")
CORS(app)
app.config["UPLOAD_FOLDER"] = str(UPLOAD_FOLDER)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 MB max

def _determine_device() -> str:
    requested = os.environ.get("FRESHGUARD_DEVICE", "").strip().lower()
    if requested:
        if requested.startswith("cuda"):
            try:
                if torch.cuda.is_available():
                    return requested
                else:
                    print(f"[!] FRESHGUARD_DEVICE='{requested}' requested, but CUDA is not available. Falling back to CPU.")
                    return "cpu"
            except Exception as e:
                print(f"[!] CUDA check failed ({e}). Falling back to CPU.")
                return "cpu"
        return requested
    try:
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception as e:
        print(f"[!] CUDA availability check failed: {e}. Falling back to CPU.")
        return "cpu"

DEVICE = _determine_device()

# --- Database Initialization ---
def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            fruit_type TEXT NOT NULL,
            freshness TEXT NOT NULL,
            p_fresh REAL NOT NULL,
            confidence REAL NOT NULL,
            image_url TEXT,
            expiry_date TEXT,
            days_left INTEGER,
            storage_tip TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS scan_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fruit_type TEXT NOT NULL,
            fruit_name_kr TEXT NOT NULL,
            freshness TEXT NOT NULL,
            freshness_kr TEXT NOT NULL,
            p_fresh REAL NOT NULL,
            confidence REAL NOT NULL,
            image_url TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()

init_db()

UPLOAD_MAX_AGE_DAYS = 7


def _port_from_env(default: int = 5000) -> int:
    try:
        port = int(os.environ.get("FRESHGUARD_PORT", "").strip() or default)
    except ValueError:
        return default
    return port if 1 <= port <= 65535 else default


FRESHGUARD_PORT = _port_from_env()

def prune_uploads(max_age_days: int = UPLOAD_MAX_AGE_DAYS):
    """Delete old uploaded scan images that no inventory item or history row references."""
    try:
        with closing(get_db_connection()) as conn:
            referenced = set()
            for table in ("inventory", "scan_history"):
                for (url,) in conn.execute(f"SELECT image_url FROM {table} WHERE image_url IS NOT NULL"):
                    referenced.add(os.path.basename(str(url)))
        cutoff = time.time() - max_age_days * 86400
        removed = 0
        for f in UPLOAD_FOLDER.iterdir():
            if f.is_file() and f.name != ".gitkeep" and f.name not in referenced and f.stat().st_mtime < cutoff:
                f.unlink()
                removed += 1
        return removed
    except Exception as e:
        print(f"[!] Upload cleanup skipped: {e}")
        return 0

prune_uploads()

# --- Fruit Knowledge Base (see fruit_info.py) ---
from fruit_info import (  # noqa: E402
    FRUIT_INFO,
    DEFAULT_COOKING_TIP,
    DEFAULT_SHELF_LIFE_DAYS,
    DEFAULT_STORAGE_TIP,
    evaluate_freshness,
)

# --- PyTorch MultiTask Architecture ---
class MultiTaskEffB0(nn.Module):
    def __init__(self, n_fruit: int, n_fresh: int):
        super().__init__()
        backbone = efficientnet_b0(weights=None)
        in_ch = backbone.classifier[1].in_features
        backbone.classifier[1] = nn.Identity()
        self.backbone = backbone
        self.dropout = nn.Dropout(0.2)
        self.head_fruit = nn.Linear(in_ch, n_fruit)
        self.head_fresh = nn.Linear(in_ch, n_fresh)

    def forward(self, x):
        feat = self.backbone(x)
        feat = self.dropout(feat)
        return self.head_fruit(feat), self.head_fresh(feat)

# --- Model Loader ---
def _load_model():
    global DEVICE
    print(f"[*] Loading FreshGuard model on device: {DEVICE}...")
    try:
        try:
            ckpt = torch.load(MODEL_PATH, map_location=DEVICE, weights_only=True)
        except Exception:
            ckpt = torch.load(MODEL_PATH, map_location=DEVICE, weights_only=False)
        m = MultiTaskEffB0(len(ckpt["fruit_names"]), len(ckpt["fresh_labels"]))
        m.load_state_dict(ckpt["model_state"])
        m.to(DEVICE)
        m.eval()
        return m, ckpt
    except Exception as e:
        if DEVICE != "cpu":
            print(f"[!] Failed to load model on {DEVICE}: {e}. Falling back to CPU...")
            DEVICE = "cpu"
            try:
                ckpt = torch.load(MODEL_PATH, map_location="cpu", weights_only=True)
            except Exception:
                ckpt = torch.load(MODEL_PATH, map_location="cpu", weights_only=False)
            m = MultiTaskEffB0(len(ckpt["fruit_names"]), len(ckpt["fresh_labels"]))
            m.load_state_dict(ckpt["model_state"])
            m.to("cpu")
            m.eval()
            return m, ckpt
        raise

model, checkpoint = _load_model()
FRUIT_NAMES = checkpoint["fruit_names"]
FRESH_LABELS = checkpoint["fresh_labels"]
FRESH_IDX = FRESH_LABELS.index("fresh")
print(f"[+] FreshGuard model loaded on {DEVICE}! Fruits: {FRUIT_NAMES}")

# --- Image Preprocessing ---
inference_transform = transforms.Compose([
    transforms.Resize(256),
    transforms.CenterCrop(224),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
])

# evaluate_freshness lives in fruit_info.py (shared with the in-browser inference).

def to_rgb(image: Image.Image) -> Image.Image:
    """EXIF-upright RGB copy. Pillow's convert("RGB") clips 16-bit/int/float grayscale (modes I;16, I, F)
    to 0..255, which turns a 16-bit PNG almost entirely white; scale those modes to 8 bit first."""
    try:
        transposed = ImageOps.exif_transpose(image)
        if transposed is not None:
            image = transposed
    except Exception:
        pass

    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        image = Image.alpha_composite(canvas, rgba)

    if image.mode.startswith("I") or image.mode == "F":
        arr = np.asarray(image, dtype=np.float64)
        top = float(arr.max()) if arr.size else 0.0
        if image.mode == "F" and top <= 1.0:
            arr = arr * 255.0
        elif top > 65535.0:
            low = float(arr.min())
            arr = (arr - low) * (255.0 / max(top - low, 1.0))
        elif top > 255.0:
            arr = arr / 257.0
        image = Image.fromarray(np.rint(np.clip(arr, 0, 255)).astype(np.uint8))
    return image.convert("RGB")


def run_inference(image: Image.Image):
    image = to_rgb(image)
    tensor = inference_transform(image).unsqueeze(0).to(DEVICE)

    with torch.no_grad():
        pf, pb = model(tensor)
        fruit_logits = pf[0].cpu().numpy()
        fruit_probs = torch.softmax(pf, dim=1)[0].cpu().numpy()
        fresh_probs = torch.softmax(pb, dim=1)[0].cpu().numpy()

    best_idx = int(fruit_probs.argmax())
    fruit_code = FRUIT_NAMES[best_idx]
    confidence = float(fruit_probs[best_idx])
    p_fresh = float(fresh_probs[FRESH_IDX])

    all_fruits = []
    for idx, prob in enumerate(fruit_probs):
        fname = FRUIT_NAMES[idx]
        all_fruits.append({
            "code": fname,
            "name_kr": FRUIT_INFO.get(fname, {}).get("kr", fname),
            "probability": round(float(prob) * 100, 1)
        })
    all_fruits.sort(key=lambda x: x["probability"], reverse=True)

    status_data = evaluate_freshness(p_fresh)
    fruit_meta = FRUIT_INFO.get(fruit_code, {})
    status_key = status_data["status"]

    shelf_days = fruit_meta.get("shelf_life_days", {}).get(status_key, DEFAULT_SHELF_LIFE_DAYS)
    cooking_guide = fruit_meta.get(f"cooking_{status_key}", DEFAULT_COOKING_TIP)

    return {
        "fruit": fruit_code,
        "fruit_kr": fruit_meta.get("kr", fruit_code),
        "confidence": round(confidence * 100, 1),
        "p_fresh": round(p_fresh * 100, 1),
        "freshness_status": status_key,
        "freshness_kr": status_data["status_kr"],
        "badge_color": status_data["badge_color"],
        "status_message": status_data["message"],
        "shelf_life_days": shelf_days,
        "storage_tips": fruit_meta.get("storage", DEFAULT_STORAGE_TIP),
        "cooking_tips": cooking_guide,
        "top_candidates": all_fruits[:4],
        # Out-of-distribution verdict (see ood.py, docs/non-produce-rejection.md). Additive fields: the fruit
        # above is still the closed-set argmax even when is_produce is false.
        **ood.assess(fruit_logits),
    }


# --- English-only display helpers (see legacy_text.py) ---
from legacy_text import LEGACY_KO_TO_EN, englishify, _HANGUL_RE  # noqa: F401


def _englishify_row(row):
    for key in ("name", "fruit_name_kr", "freshness_kr"):
        if key in row:
            row[key] = englishify(row[key])
    if "storage_tip" in row and isinstance(row["storage_tip"], str) and _HANGUL_RE.search(row["storage_tip"]):
        info = FRUIT_INFO.get(row.get("fruit_type") or "", {})
        row["storage_tip"] = info.get("storage", "Store in a cool place.")
    return row

# --- Routes ---
@app.route("/healthz", methods=["GET"])
def healthz():
    return jsonify({"status": "ok", "device": DEVICE})


@app.route("/")
def index():
    return render_template("index.html")

def _parse_persist(raw_val, default: bool = True) -> bool:
    if raw_val is None:
        return default
    if isinstance(raw_val, bool):
        return raw_val
    if isinstance(raw_val, (int, float)):
        return raw_val != 0
    s = str(raw_val).strip().lower()
    if s in ("0", "false", "no", "off"):
        return False
    if s in ("1", "true", "yes", "on"):
        return True
    return default


def _bad_request(msg, code=400):
    return jsonify({"error": msg}), code

@app.errorhandler(HTTPException)
def handle_http_exception(e):
    # Always answer with JSON so the frontend can show e.error (e.g. 413 too large)
    return jsonify({"error": e.description or e.name}), e.code

@app.errorhandler(Exception)
def handle_unexpected_exception(e):
    # Any other failure (for example a sqlite error) must also be JSON, never Flask's HTML 500 page
    if app.testing or app.debug:
        raise e
    print(f"[!] Unhandled error on {request.path}: {e!r}")
    return jsonify({"error": "Internal server error"}), 500


@app.route("/api/predict", methods=["POST"])
def predict():
    saved_path = None
    try:
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            body = {}

        if "file" in request.files and request.files["file"].filename != "":
            file = request.files["file"]
            ext = os.path.splitext(file.filename)[1].lower()
            if ext not in ALLOWED_EXTS:
                ext = ".jpg"
            saved_filename = f"{uuid.uuid4().hex}{ext}"
            saved_path = UPLOAD_FOLDER / saved_filename
            file.save(saved_path)
            try:
                with Image.open(saved_path) as img:
                    img.load()
                    image = img.copy()
            except Exception:
                saved_path.unlink(missing_ok=True)
                return _bad_request("Invalid or unsupported image file.")
            image_url = f"/static/uploads/{saved_filename}"

        elif isinstance(body.get("image"), str) and body["image"]:
            raw_b64 = body["image"]
            if raw_b64.startswith("data:") and "," in raw_b64:
                raw_b64 = raw_b64.split(",", 1)[1]
            try:
                img_bytes = base64.b64decode(raw_b64, validate=False)
                with Image.open(io.BytesIO(img_bytes)) as img:
                    img.load()
                    image = img.copy()
            except Exception:
                return _bad_request("Invalid base64 image data.")
            saved_filename = f"{uuid.uuid4().hex}.jpg"
            saved_path = UPLOAD_FOLDER / saved_filename
            to_rgb(image).save(saved_path, "JPEG")
            image_url = f"/static/uploads/{saved_filename}"

        elif request.args.get("sample") or body.get("sample"):
            sample_name = request.args.get("sample") or body.get("sample")
            if not isinstance(sample_name, str):
                return _bad_request("Invalid sample name.")
            # Only plain file names inside static/samples are allowed (no traversal)
            sample_name = os.path.basename(sample_name.replace("\\", "/"))
            sample_path = SAMPLES_DIR / sample_name
            if not sample_name or not sample_path.is_file():
                return jsonify({"error": "Sample image not found"}), 404
            try:
                with Image.open(sample_path) as img:
                    img.load()
                    image = img.copy()
            except Exception:
                return _bad_request("Invalid sample image.")
            image_url = f"/static/samples/{sample_name}"

        else:
            return _bad_request("No image provided. Upload a file, send base64, or specify sample.")

        result = run_inference(image)
        result["image_url"] = image_url

        # Save to this service's own scan history, used only by the standalone page.
        # The IngreScan web app sends persist=0 and stores history per user in MySQL instead.
        # A photo flagged as not produce is not written to the standalone history (the response still carries it).
        persist_val = request.args.get("persist")
        if persist_val is None and isinstance(body, dict):
            persist_val = body.get("persist")
        persist_flag = _parse_persist(persist_val, default=True)

        if persist_flag and result["is_produce"]:
            with closing(get_db_connection()) as conn:
                conn.execute("""
                    INSERT INTO scan_history (fruit_type, fruit_name_kr, freshness, freshness_kr, p_fresh, confidence, image_url)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (
                    result["fruit"],
                    result["fruit_kr"],
                    result["freshness_status"],
                    result["freshness_kr"],
                    result["p_fresh"],
                    result["confidence"],
                    result["image_url"]
                ))
                conn.commit()

        return jsonify(result)

    except HTTPException:
        raise  # e.g. 413; handled by the JSON error handler
    except Exception as e:
        if saved_path is not None:
            saved_path.unlink(missing_ok=True)
        return jsonify({"error": str(e)}), 500

_detector = None
# Decided from tools/eval_shelf.py numbers, see docs/multi-item-detection.md
SHELF_SECOND_PASS_DEFAULT = False


def get_detector():
    global _detector
    if _detector is None:
        import detector as det
        _detector = det.Detector()
    return _detector


def _load_request_image():
    """Image from a multipart 'file' or a JSON {"image": base64}. Returns (image, error_response)."""
    if "file" in request.files and request.files["file"].filename != "":
        try:
            with Image.open(request.files["file"].stream) as img:
                img.load()
                return img.copy(), None
        except Exception:
            return None, _bad_request("Invalid or unsupported image file.")
    body = request.get_json(silent=True)
    if isinstance(body, dict) and isinstance(body.get("image"), str) and body["image"]:
        raw_b64 = body["image"]
        if raw_b64.startswith("data:") and "," in raw_b64:
            raw_b64 = raw_b64.split(",", 1)[1]
        try:
            with Image.open(io.BytesIO(base64.b64decode(raw_b64, validate=False))) as img:
                img.load()
                return img.copy(), None
        except Exception:
            return None, _bad_request("Invalid base64 image data.")
    return None, _bad_request("No image provided. Upload a file or send base64.")


def _env_flag(name, default):
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _batch_fruit_logits(crops):
    """Fruit logits (N, n_fruit) for several PIL crops in one forward pass (second pass only)."""
    batch = torch.stack([inference_transform(c.convert("RGB")) for c in crops]).to(DEVICE)
    with torch.no_grad():
        pf, _ = model(batch)
    return pf.cpu().numpy()


def _second_pass(image, existing_boxes):
    """Sliding-window proposals scored by the classifier with a much stricter bar than the detector path.

    Returns (boxes, stats). Boxes are xyxy ints, best first, already NMS'd and de-duplicated against
    `existing_boxes`. Every returned box is later classified like any other crop and marked second_pass.
    """
    import detector as det
    width, height = image.size
    windows = det.propose_windows(width, height)
    stats = {"windows": len(windows), "passed_bar": 0, "added": 0}
    if not windows:
        return [], stats
    logits = np.concatenate([_batch_fruit_logits([image.crop(w) for w in windows[i:i + 32]])
                             for i in range(0, len(windows), 32)])
    min_l = ood.env_float("SHELF_SECOND_PASS_MIN_LIKELIHOOD", ood.DEFAULT_SECOND_PASS_MIN_LIKELIHOOD)
    min_c = det.SECOND_PASS_MIN_CONFIDENCE
    boxes, scores = [], []
    for w, lg in zip(windows, logits):
        e = ood.energy_score(lg)
        conf = ood.max_softmax(lg) * 100
        if ood.likelihood_from_energy(e) >= min_l and conf >= min_c:
            boxes.append(w)
            scores.append(e)
    stats["passed_bar"] = len(boxes)
    if not boxes:
        return [], stats
    keep = det.select_extra(np.array(boxes, dtype=np.float32), np.array(scores), existing_boxes)
    stats["added"] = len(keep)
    return [boxes[i] for i in keep], stats


@app.route("/api/detect", methods=["POST"])
def detect_items():
    """Find several fruit/vegetables in one photo and classify each crop with the FreshGuard model.

    The COCO detector only localises; labels and freshness always come from the classifier, and a
    detection is kept only if the classifier is at least MIN_CLASSIFIER_CONFIDENCE percent sure and the
    crop does not look like a non-produce image (out-of-distribution score, PRODUCE_MIN_LIKELIHOOD).
    Kept items can carry needs_check / check_reasons; the web app leaves those unticked.

    Environment (read per request): PRODUCE_MIN_LIKELIHOOD (0 disables the OOD gate),
    SHELF_CHECKS (default 1), SHELF_SECOND_PASS (default per docs/multi-item-detection.md),
    SHELF_SURE_LIKELIHOOD (default 0.8).
    """
    import detector as det
    detector = get_detector()
    ok, why = detector.is_available()
    if not ok:
        return jsonify({"error": "Detector not installed. " + why, "code": "detector_not_installed"}), 503

    image, err = _load_request_image()
    if err is not None:
        return err
    image = to_rgb(image)
    width, height = image.size

    min_likelihood = ood.min_likelihood()
    sure_likelihood = max(min_likelihood, ood.env_float("SHELF_SURE_LIKELIHOOD", ood.DEFAULT_SHELF_SURE_LIKELIHOOD))
    checks_on = _env_flag("SHELF_CHECKS", True)
    second_pass_on = _env_flag("SHELF_SECOND_PASS", SHELF_SECOND_PASS_DEFAULT)

    saved = []
    try:
        try:
            found = detector.detect(image)
        except det.DetectorUnavailable as e:
            return jsonify({"error": "Detector not installed. " + str(e), "code": "detector_not_installed"}), 503

        items, rejected = [], []
        pass_stats = None

        def handle(box, label, score, second_pass):
            left, top, right, bottom = det.pad_box(box, width, height)
            if right <= left or bottom <= top:
                return
            crop = image.crop((left, top, right, bottom))
            if crop.width <= 0 or crop.height <= 0:
                return
            result = run_inference(crop)
            x1, y1, x2, y2 = box
            base = {
                "box": {"x": round(float(x1), 1), "y": round(float(y1), 1),
                        "w": round(float(x2 - x1), 1), "h": round(float(y2 - y1), 1)},
                "detector_label": label or ("second_pass" if second_pass else "unknown"),
                "detector_score": round(score * 100, 1) if score is not None else None,
                "source": "second_pass" if second_pass else "detector",
            }
            if min_likelihood > 0 and result["produce_likelihood"] < min_likelihood:
                rejected.append({**base, "fruit": result["fruit"], "confidence": result["confidence"],
                                 "produce_likelihood": result["produce_likelihood"], "reason": "not_produce"})
                return
            if result["confidence"] < det.MIN_CLASSIFIER_CONFIDENCE:
                rejected.append({**base, "fruit": result["fruit"], "confidence": result["confidence"],
                                 "produce_likelihood": result["produce_likelihood"],
                                 "reason": "low_classifier_confidence"})
                return
            reasons = []
            if checks_on:
                reasons = det.check_reasons(
                    detector_label=label, fruit=result["fruit"], confidence=result["confidence"],
                    top_candidates=result["top_candidates"],
                    produce_likelihood=result["produce_likelihood"] if min_likelihood > 0 else None,
                    sure_likelihood=sure_likelihood, second_pass=second_pass)
            thumb = crop.copy()
            thumb.thumbnail((256, 256))
            name = f"{uuid.uuid4().hex}.jpg"
            path = UPLOAD_FOLDER / name
            thumb.save(path, "JPEG", quality=85)
            saved.append(path)
            items.append({**base, **result, "image_url": f"/static/uploads/{name}",
                          "needs_check": bool(reasons), "check_reasons": reasons})

        for d in found:
            handle(d["box"], d["label"], d["score"], False)

        if second_pass_on:
            existing = [d["box"] for d in found]
            extra, pass_stats = _second_pass(image, existing)
            for box in extra:
                handle([float(v) for v in box], None, None, True)

        # reading order for the review list: top-to-bottom bands, then left-to-right
        items.sort(key=lambda it: (round(it["box"]["y"] / 40), it["box"]["x"]))

        return jsonify({
            "items": items,
            "rejected": rejected,
            "image": {"width": width, "height": height},
            "min_confidence": det.MIN_CLASSIFIER_CONFIDENCE,
            "ood": {"method": ood.METHOD, "min_likelihood": min_likelihood, "sure_likelihood": sure_likelihood},
            "second_pass": {"enabled": second_pass_on, **(pass_stats or {})},
            "detector": {"model": det.MODEL_NAME, "license": det.MODEL_LICENSE,
                         "classes": sorted(set(det.COCO_PRODUCE.values()))},
            "note": "The detector only knows apple, banana, orange and carrot as produce; other items "
                    "(mango, bell pepper, potato, tomato, cucumber, strawberry) are often missed.",
        })
    except HTTPException:
        raise
    except Exception as e:
        for p in saved:
            p.unlink(missing_ok=True)
        return jsonify({"error": str(e)}), 500


def _to_float(value, default):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    return f if f == f and f not in (float("inf"), float("-inf")) else default

def _days_until(expiry_date):
    """Whole days from today until expiry_date (YYYY-MM-DD); None if unparsable."""
    try:
        return (datetime.strptime(str(expiry_date)[:10], "%Y-%m-%d").date() - date.today()).days
    except ValueError:
        return None

@app.route("/api/inventory", methods=["GET", "POST"])
def inventory():
    if request.method == "POST":
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return _bad_request("JSON object body required.")
        name = englishify(str(data.get("name") or data.get("fruit_kr") or "Produce"))
        fruit_type = str(data.get("fruit") or "apple")
        freshness = data.get("freshness_status", "fresh")
        if freshness not in ("fresh", "normal", "rotten"):
            return _bad_request("freshness_status must be fresh, normal or rotten.")
        p_fresh = min(max(_to_float(data.get("p_fresh"), 90.0), 0.0), 100.0)
        confidence = min(max(_to_float(data.get("confidence"), 95.0), 0.0), 100.0)
        image_url = str(data.get("image_url") or "")
        storage_tip = str(data.get("storage_tip") or data.get("storage_tips") or "")

        expiry_date = str(data.get("expiry_date") or "")[:10]
        days_left = _days_until(expiry_date) if expiry_date else None
        if days_left is None:
            days_left = int(min(max(_to_float(data.get("shelf_life_days"), 5), 0.0), 36500.0))
            expiry_date = (date.today() + timedelta(days=max(days_left, 0))).isoformat()
        days_left = max(days_left, 0)

        with closing(get_db_connection()) as conn:
            cursor = conn.execute("""
                INSERT INTO inventory (name, fruit_type, freshness, p_fresh, confidence, image_url, expiry_date, days_left, storage_tip)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (name, fruit_type, freshness, p_fresh, confidence, image_url, expiry_date, days_left, storage_tip))
            conn.commit()
            new_id = cursor.lastrowid
        return jsonify({"success": True, "id": new_id})

    # GET inventory
    with closing(get_db_connection()) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM inventory ORDER BY id DESC").fetchall()
    items = [_englishify_row(dict(row)) for row in rows]
    for item in items:
        # days_left was a snapshot at save time; recompute from the expiry date
        remaining = _days_until(item["expiry_date"]) if item.get("expiry_date") else None
        if remaining is not None:
            item["days_left"] = max(remaining, 0)
    return jsonify(items)

@app.route("/api/inventory/<int:item_id>", methods=["DELETE"])
def delete_inventory_item(item_id):
    with closing(get_db_connection()) as conn:
        cur = conn.execute("DELETE FROM inventory WHERE id = ?", (item_id,))
        conn.commit()
        deleted = cur.rowcount
    if not deleted:
        return jsonify({"error": "Item not found"}), 404
    return jsonify({"success": True})

@app.route("/api/history", methods=["GET", "DELETE"])
def history():
    with closing(get_db_connection()) as conn:
        conn.row_factory = sqlite3.Row
        if request.method == "DELETE":
            conn.execute("DELETE FROM scan_history")
            conn.commit()
            return jsonify({"success": True})
        rows = conn.execute("SELECT * FROM scan_history ORDER BY id DESC LIMIT 50").fetchall()
    return jsonify([_englishify_row(dict(row)) for row in rows])

@app.route("/api/fruits", methods=["GET"])
def get_fruits():
    result = []
    for code, info in FRUIT_INFO.items():
        result.append({
            "code": code,
            "name_kr": info["kr"],
            "storage": info["storage"],
            "shelf_life_days": info["shelf_life_days"]
        })
    return jsonify(result)

@app.route("/api/samples", methods=["GET"])
def get_samples():
    samples_dir = BASE_DIR / "static" / "samples"
    files = []
    if samples_dir.exists():
        for f in sorted(samples_dir.glob("*.jpg")):
            fruit_key = f.stem.split("_")[0]
            info = FRUIT_INFO.get(fruit_key, {})
            files.append({
                "filename": f.name,
                "label": info.get("kr", f.stem.replace("_", " ").title()),
                "url": f"/static/samples/{f.name}"
            })
    return jsonify(files)

if __name__ == "__main__":
    print("\n" + "="*50)
    print(" FreshGuard (produce freshness AI service)")
    print(f" Running on http://127.0.0.1:{FRESHGUARD_PORT}")
    print("="*50 + "\n")
    app.run(host="127.0.0.1", port=FRESHGUARD_PORT, debug=False)
