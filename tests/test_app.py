import base64
import io
import sys
import types
from datetime import date, timedelta

import numpy as np
import pytest
from PIL import Image

from pathlib import Path
ROOT = str(Path(__file__).resolve().parent.parent)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


class FakeT:
    def __init__(self, a):
        self.a = np.asarray(a, dtype=float)

    def __getitem__(self, i):
        return FakeT(self.a[i])

    def cpu(self):
        return self

    def numpy(self):
        return self.a

    def unsqueeze(self, _):
        return self

    def to(self, _):
        return self


def _install_fake_torch():
    """Lightweight stand-ins so app.py imports without torch/torchvision."""
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: False)

    class NoGrad:
        def __enter__(self): return self
        def __exit__(self, *a): return False
    torch.no_grad = NoGrad

    def softmax(x, dim=1):
        e = np.exp(x.a - x.a.max(axis=dim, keepdims=True))
        return FakeT(e / e.sum(axis=dim, keepdims=True))
    torch.softmax = softmax
    names = ["apple", "banana", "bell_pepper", "carrot", "cucumber",
             "mango", "orange", "potato", "strawberry", "tomato"]
    torch.load = lambda *a, **k: {"fruit_names": names, "fresh_labels": ["rotten", "fresh"],
                                  "model_state": {}}

    nn = types.ModuleType("torch.nn")

    class Module:
        def __call__(self, *a): return self.forward(*a)
        def load_state_dict(self, *_): pass
        def to(self, *_): return self
        def eval(self): return self
    nn.Module = Module
    nn.Identity = lambda: None
    nn.Dropout = lambda p: None
    nn.Linear = lambda a, b: None
    torch.nn = nn

    tv = types.ModuleType("torchvision")
    models = types.ModuleType("torchvision.models")
    models.efficientnet_b0 = lambda weights=None: types.SimpleNamespace(
        classifier=[None, types.SimpleNamespace(in_features=4)])
    tr = types.ModuleType("torchvision.transforms")
    tr.Compose = lambda ts: (lambda img: FakeT(np.zeros((3, 224, 224))))
    tr.Resize = tr.CenterCrop = tr.ToTensor = lambda *a, **k: None
    tr.Normalize = lambda **k: None
    tv.models, tv.transforms = models, tr
    sys.modules.update({"torch": torch, "torch.nn": nn, "torchvision": tv,
                        "torchvision.models": models, "torchvision.transforms": tr})


# These are unit tests of the Flask layer, so they always run against the stub model
# (fast and deterministic, with or without torch installed). The real checkpoint is
# exercised separately in test_model_integration.py.
_install_fake_torch()


@pytest.fixture(scope="module")
def appmod(tmp_path_factory):
    import app as m
    return m


@pytest.fixture
def client(appmod, tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setattr(appmod, "UPLOAD_FOLDER", tmp_path / "up")
    (tmp_path / "up").mkdir()
    appmod.init_db()
    # logits: apple strongly (energy ~9, i.e. clearly produce), p_fresh ~ 0.9 ("fresh" is index 1)
    monkeypatch.setattr(appmod, "model", lambda t: (FakeT([[9, 0, 0, 0, 0, 0, 0, 0, 0, 0]]),
                                                    FakeT([[0.0, 2.2]])))
    appmod.app.config["TESTING"] = True
    c = appmod.app.test_client()
    c.up = tmp_path / "up"
    return c


def png_bytes(mode="RGB"):
    buf = io.BytesIO()
    Image.new(mode, (40, 30), "red").save(buf, "PNG")
    return buf.getvalue()


# ---- predict ----
def test_predict_no_input(client):
    r = client.post("/api/predict")
    assert r.status_code == 400 and "error" in r.get_json()


def test_predict_malformed_and_non_dict_json(client):
    assert client.post("/api/predict", data="{bad", content_type="application/json").status_code == 400
    assert client.post("/api/predict", json=[1, 2]).status_code == 400


def test_predict_upload_ok_and_unsafe_ext_sanitized(client):
    r = client.post("/api/predict", data={"file": (io.BytesIO(png_bytes()), "x.html")})
    assert r.status_code == 200, r.get_json()
    d = r.get_json()
    assert d["fruit"] == "apple" and d["freshness_status"] == "fresh"
    assert d["image_url"].endswith(".jpg")
    assert len(list(client.up.iterdir())) == 1


def test_predict_bad_image_is_400_and_file_removed(client):
    r = client.post("/api/predict", data={"file": (io.BytesIO(b"not an image"), "a.png")})
    assert r.status_code == 400
    assert list(client.up.iterdir()) == []


def test_predict_base64(client):
    b64 = "data:image/png;base64," + base64.b64encode(png_bytes("RGBA")).decode()
    r = client.post("/api/predict", json={"image": b64})
    assert r.status_code == 200, r.get_json()


def test_predict_bad_base64_and_non_string(client):
    assert client.post("/api/predict", json={"image": "!!!"}).status_code == 400
    assert client.post("/api/predict", json={"image": 123}).status_code == 400


@pytest.mark.parametrize("name", ["../../app.py", "..\\app.py", "/etc/passwd", "nope.jpg", "."])
def test_predict_sample_traversal_rejected(client, name):
    r = client.post("/api/predict", json={"sample": name})
    assert r.status_code == 404


def test_predict_sample_ok(client):
    r = client.post("/api/predict?sample=apple.jpg")
    assert r.status_code == 200
    assert r.get_json()["image_url"] == "/static/samples/apple.jpg"


def test_too_large_returns_json(client, appmod, monkeypatch):
    monkeypatch.setitem(appmod.app.config, "MAX_CONTENT_LENGTH", 100)
    r = client.post("/api/predict", data={"file": (io.BytesIO(b"x" * 1000), "a.jpg")})
    assert r.status_code == 413 and "error" in r.get_json()


def test_freshness_thresholds(appmod):
    assert appmod.evaluate_freshness(0.7)["status"] == "fresh"
    assert appmod.evaluate_freshness(0.69)["status"] == "normal"
    assert appmod.evaluate_freshness(0.3)["status"] == "rotten"


# ---- inventory ----
def test_inventory_rejects_non_json_and_bad_status(client):
    assert client.post("/api/inventory", data="x").status_code == 400
    assert client.post("/api/inventory", json={"freshness_status": "weird"}).status_code == 400


def test_inventory_non_numeric_and_expiry_computed(client):
    r = client.post("/api/inventory", json={"name": "A", "p_fresh": "abc", "confidence": None,
                                            "shelf_life_days": "x", "freshness_status": "normal"})
    assert r.status_code == 200
    item = client.get("/api/inventory").get_json()[0]
    assert item["p_fresh"] == 90.0 and item["days_left"] == 5
    assert item["expiry_date"] == (date.today() + timedelta(days=5)).isoformat()


def test_inventory_days_left_recomputed_from_expiry(client):
    exp = (date.today() + timedelta(days=3)).isoformat()
    client.post("/api/inventory", json={"name": "B", "expiry_date": exp, "shelf_life_days": 99})
    assert client.get("/api/inventory").get_json()[0]["days_left"] == 3
    past = (date.today() - timedelta(days=2)).isoformat()
    client.post("/api/inventory", json={"name": "C", "expiry_date": past})
    assert client.get("/api/inventory").get_json()[0]["days_left"] == 0


def test_inventory_bad_expiry_falls_back(client):
    client.post("/api/inventory", json={"name": "D", "expiry_date": "garbage", "shelf_life_days": 2})
    assert client.get("/api/inventory").get_json()[0]["days_left"] == 2


def test_inventory_negative_days_clamped(client):
    client.post("/api/inventory", json={"shelf_life_days": -4})
    assert client.get("/api/inventory").get_json()[0]["days_left"] == 0


def test_delete_missing_item_404(client):
    assert client.delete("/api/inventory/9999").status_code == 404
    iid = client.post("/api/inventory", json={"name": "E"}).get_json()["id"]
    assert client.delete(f"/api/inventory/{iid}").status_code == 200


# ---- history / misc ----
def test_history_roundtrip(client):
    client.post("/api/predict?sample=apple.jpg")
    assert len(client.get("/api/history").get_json()) == 1
    assert client.delete("/api/history").get_json()["success"]
    assert client.get("/api/history").get_json() == []


def test_samples_and_fruits(client):
    assert client.get("/api/fruits").status_code == 200
    files = [s["filename"] for s in client.get("/api/samples").get_json()]
    assert files == sorted(files)
    assert client.get("/").status_code == 200


def test_prune_uploads_removes_only_old_unreferenced(client, appmod):
    import os, sqlite3, time
    up = appmod.UPLOAD_FOLDER
    up.mkdir(exist_ok=True)
    old_free, old_kept, fresh_new = up / "a.jpg", up / "b.jpg", up / "c.jpg"
    for f in (old_free, old_kept, fresh_new):
        f.write_bytes(b"x")
    old = time.time() - 30 * 86400
    os.utime(old_free, (old, old))
    os.utime(old_kept, (old, old))
    with sqlite3.connect(appmod.DB_PATH) as conn:
        conn.execute(
            "INSERT INTO inventory (name, fruit_type, freshness, p_fresh, confidence, image_url, expiry_date, days_left, storage_tip)"
            " VALUES ('n','apple','fresh',90,90,'/static/uploads/b.jpg','2099-01-01',10,'')"
        )
    assert appmod.prune_uploads(7) == 1
    assert not old_free.exists() and old_kept.exists() and fresh_new.exists()


import re as _re

_NON_ENGLISH = _re.compile("[\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fff\U0001F000-\U0001FAFF\u2600-\u27bf\ufe0f]")


def test_fruit_knowledge_base_is_english_and_emoji_free(appmod):
    for code, info in appmod.FRUIT_INFO.items():
        assert "emoji" not in info
        for value in (info["kr"], info["storage"], info["cooking_fresh"], info["cooking_normal"], info["cooking_rotten"]):
            assert not _NON_ENGLISH.search(value), (code, value)
    for p in (0.9, 0.5, 0.1):
        status = appmod.evaluate_freshness(p)
        assert not _NON_ENGLISH.search(status["status_kr"] + status["message"])


def test_api_responses_are_english_only(client):
    for url in ("/api/fruits", "/api/samples"):
        body = client.get(url).get_data(as_text=True)
        assert not _NON_ENGLISH.search(body), url
    r = client.post("/api/predict", json={"sample": "apple.jpg"})
    assert r.status_code == 200
    data = r.get_json()
    assert "emoji" not in data and all("emoji" not in c for c in data["top_candidates"])
    assert not _NON_ENGLISH.search(r.get_data(as_text=True))


def test_legacy_korean_rows_are_translated_on_read(client, appmod):
    import sqlite3
    with sqlite3.connect(appmod.DB_PATH) as conn:
        conn.execute(
            "INSERT INTO inventory (name, fruit_type, freshness, p_fresh, confidence, image_url, expiry_date, days_left, storage_tip)"
            " VALUES (?, 'apple', 'fresh', 90, 90, '', '2099-01-01', 10, ?)",
            ("\U0001F34E \uc0ac\uacfc", "\ub0c9\uc7a5 \ubcf4\uad00"),
        )
        conn.execute(
            "INSERT INTO scan_history (fruit_type, fruit_name_kr, freshness, freshness_kr, p_fresh, confidence, image_url)"
            " VALUES ('bell_pepper', ?, 'normal', ?, 50, 80, '')",
            ("\ud30c\ud504\ub9ac\uce74/\ud53c\ub9dd", "\ubcf4\ud1b5 (Normal)"),
        )
    inv = client.get("/api/inventory").get_json()[0]
    assert inv["name"] == "Apple"
    assert not _NON_ENGLISH.search(inv["storage_tip"])
    hist = client.get("/api/history").get_json()[0]
    assert hist["fruit_name_kr"] == "Bell Pepper" and hist["freshness_kr"] == "Normal"
    # POSTed legacy names are normalised too
    client.post("/api/inventory", json={"name": "\U0001F34C \ubc14\ub098\ub098", "freshness_status": "fresh"})
    assert client.get("/api/inventory").get_json()[0]["name"] == "Banana"


def test_persist_zero_skips_flask_history(client):
    assert client.post("/api/predict?sample=apple.jpg&persist=0").status_code == 200
    assert client.get("/api/history").get_json() == []
    assert client.post("/api/predict?sample=apple.jpg").status_code == 200
    assert len(client.get("/api/history").get_json()) == 1


def test_import_script_emits_english_sql_for_one_user(client, appmod, tmp_path):
    import sqlite3, subprocess, sys
    from pathlib import Path
    db = tmp_path / "legacy.db"
    with sqlite3.connect(db) as conn:
        conn.executescript(
            "CREATE TABLE inventory (id INTEGER PRIMARY KEY, name TEXT, fruit_type TEXT, freshness TEXT, p_fresh REAL, confidence REAL,"
            " image_url TEXT, expiry_date TEXT, days_left INTEGER, storage_tip TEXT, created_at TEXT);"
            "CREATE TABLE scan_history (id INTEGER PRIMARY KEY, fruit_type TEXT, fruit_name_kr TEXT, freshness TEXT, freshness_kr TEXT,"
            " p_fresh REAL, confidence REAL, image_url TEXT, created_at TEXT);"
        )
        conn.execute("INSERT INTO inventory VALUES (1, ?, 'apple', 'fresh', 90, 95, '/static/uploads/a.jpg', '2030-01-02', 5, ?, '2026-01-01 10:00:00')",
                     ("\U0001F34E \uC0AC\uACFC", "O'Brien \uB0C9\uC7A5"))
        conn.execute("INSERT INTO scan_history VALUES (1, 'bell_pepper', ?, 'weird', ?, 50, 80, '', '2026-01-01 10:00:00')",
                     ("\uD30C\uD504\uB9AC\uCE74/\uD53C\uB9DD", "\uBCF4\uD1B5 (Normal)"))
    root = Path(appmod.__file__).parent
    proc = subprocess.run([sys.executable, str(root / "tools" / "import_freshguard_data.py"), "--user-id", "7", "--db", str(db)],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    sql = proc.stdout
    assert not _NON_ENGLISH.search(sql)
    assert "INSERT INTO produce_inventory" in sql and "VALUES (7, 'Apple', 'apple', 'fresh'" in sql
    assert "Refrigerate at 0" in sql      # Korean tip replaced by that fruit's English tip
    assert "'Bell Pepper', 'normal', 'Normal'" in sql   # label translated, bad status normalised
    assert "1 pantry items, 1 history rows for user 7" in proc.stderr


# ---- multi-item detection (/api/detect) with a fake localiser; the real one is in test_detector_integration.py ----
class FakeDetector:
    def __init__(self, found=None, available=True):
        self.found, self.available = found or [], available

    def is_available(self):
        return (True, "") if self.available else (False, "Detector model not found. Run: python tools/fetch_detector.py")

    def detect(self, image):
        return self.found


def test_detect_503_when_detector_missing(client, appmod, monkeypatch):
    monkeypatch.setattr(appmod, "_detector", FakeDetector(available=False))
    r = client.post("/api/detect", data={"file": (io.BytesIO(png_bytes()), "x.png")})
    assert r.status_code == 503
    assert r.get_json()["code"] == "detector_not_installed" and "fetch_detector" in r.get_json()["error"]


def test_detect_no_image_and_bad_image(client, appmod, monkeypatch):
    monkeypatch.setattr(appmod, "_detector", FakeDetector())
    assert client.post("/api/detect").status_code == 400
    assert client.post("/api/detect", data={"file": (io.BytesIO(b"junk"), "a.png")}).status_code == 400
    assert client.post("/api/detect", json={"image": "!!!"}).status_code == 400


def test_detect_returns_items_with_classifier_labels_and_thumbnails(client, appmod, monkeypatch):
    found = [{"box": [2, 2, 20, 20], "score": 0.9, "coco_class": 49, "label": "orange"},
             {"box": [22, 3, 38, 25], "score": 0.5, "coco_class": 46, "label": "banana"}]
    monkeypatch.setattr(appmod, "_detector", FakeDetector(found))
    r = client.post("/api/detect", json={"image": base64.b64encode(png_bytes()).decode()})
    assert r.status_code == 200, r.get_json()
    d = r.get_json()
    assert d["image"] == {"width": 40, "height": 30} and len(d["items"]) == 2
    first = d["items"][0]
    # classifier (stub: apple, strongly) overrides the detector label
    assert first["fruit"] == "apple" and first["detector_label"] == "orange"
    assert first["box"] == {"x": 2.0, "y": 2.0, "w": 18.0, "h": 18.0}
    assert first["image_url"].startswith("/static/uploads/") and first["shelf_life_days"] > 0
    assert len(list(client.up.iterdir())) == 2
    assert d["rejected"] == [] and d["detector"]["license"] == "Apache-2.0"


def test_detect_drops_low_classifier_confidence(client, appmod, monkeypatch):
    found = [{"box": [2, 2, 20, 20], "score": 0.9, "coco_class": 47, "label": "apple"}]
    monkeypatch.setattr(appmod, "_detector", FakeDetector(found))
    # two equally strong fruits -> confidence ~50 percent (below the 70 percent minimum) but clearly produce-like energy
    monkeypatch.setattr(appmod, "model", lambda t: (FakeT([[9.0, 9.0] + [0.0] * 8]), FakeT([[0.0, 1.0]])))
    r = client.post("/api/detect", data={"file": (io.BytesIO(png_bytes()), "x.png")})
    d = r.get_json()
    assert r.status_code == 200 and d["items"] == []
    assert d["rejected"][0]["reason"] == "low_classifier_confidence"
    assert list(client.up.iterdir()) == []


def test_detect_zero_detections_is_ok(client, appmod, monkeypatch):
    monkeypatch.setattr(appmod, "_detector", FakeDetector([]))
    r = client.post("/api/detect", data={"file": (io.BytesIO(png_bytes()), "x.png")})
    assert r.status_code == 200 and r.get_json()["items"] == []


# ---- non-produce rejection (out-of-distribution score) ----
NOT_PRODUCE = [[1.0, 0.5, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1]]  # low, flat logits: energy ~2.8


def _set_logits(monkeypatch, appmod, logits):
    monkeypatch.setattr(appmod, "model", lambda t: (FakeT(logits), FakeT([[0.0, 2.2]])))


def test_predict_reports_produce_fields_and_keeps_old_fields(client):
    d = client.post("/api/predict", data={"file": (io.BytesIO(png_bytes()), "x.png")}).get_json()
    for key in ("fruit", "fruit_kr", "confidence", "p_fresh", "freshness_status", "top_candidates", "image_url"):
        assert key in d
    assert d["is_produce"] is True and d["produce_likelihood"] > 0.5
    assert d["produce_score"] == pytest.approx(9.0, abs=0.01) and d["ood_method"] == "energy"


def test_predict_flags_non_produce_but_still_200_and_does_not_persist(client, appmod, monkeypatch):
    _set_logits(monkeypatch, appmod, NOT_PRODUCE)
    r = client.post("/api/predict", data={"file": (io.BytesIO(png_bytes()), "x.png")})
    d = r.get_json()
    assert r.status_code == 200 and d["is_produce"] is False and d["produce_likelihood"] < 0.5
    assert d["fruit"]  # closed-set argmax is still reported for backwards compatibility
    assert client.get("/api/history").get_json() == []


def test_predict_threshold_is_configurable_and_zero_disables(client, appmod, monkeypatch):
    _set_logits(monkeypatch, appmod, NOT_PRODUCE)
    monkeypatch.setenv("PRODUCE_MIN_LIKELIHOOD", "0")
    d = client.post("/api/predict", data={"file": (io.BytesIO(png_bytes()), "x.png")}).get_json()
    assert d["is_produce"] is True and d["produce_min_likelihood"] == 0.0
    assert d["produce_likelihood"] < 0.5  # the score is still reported
    monkeypatch.setenv("PRODUCE_MIN_LIKELIHOOD", "0.99")
    _set_logits(monkeypatch, appmod, [[9.0] + [0.0] * 9])
    d = client.post("/api/predict", data={"file": (io.BytesIO(png_bytes()), "x.png")}).get_json()
    assert d["is_produce"] is False  # a strict threshold flags even a confident apple


def test_detect_rejects_non_produce_crops(client, appmod, monkeypatch):
    found = [{"box": [2, 2, 20, 20], "score": 0.9, "coco_class": 47, "label": "apple"}]
    monkeypatch.setattr(appmod, "_detector", FakeDetector(found))
    _set_logits(monkeypatch, appmod, [[6.5] + [0.0] * 9])  # energy 6.5 -> likelihood ~0.58 -> kept but not "sure"
    d = client.post("/api/detect", data={"file": (io.BytesIO(png_bytes()), "x.png")}).get_json()
    assert len(d["items"]) == 1 and d["items"][0]["needs_check"] is True
    assert "low_produce_likelihood" in d["items"][0]["check_reasons"]
    _set_logits(monkeypatch, appmod, [[3.0] + [0.0] * 9])  # confident softmax (~95%) but low energy: not produce
    d = client.post("/api/detect", data={"file": (io.BytesIO(png_bytes()), "x.png")}).get_json()
    assert d["items"] == [] and d["rejected"][0]["reason"] == "not_produce"
    assert len(list(client.up.iterdir())) == 1  # only the first (kept) item has a thumbnail; the rejected crop has none


def test_detect_marks_label_mismatch_and_clean_item(client, appmod, monkeypatch):
    found = [{"box": [2, 2, 20, 20], "score": 0.9, "coco_class": 49, "label": "orange"},
             {"box": [22, 3, 38, 25], "score": 0.9, "coco_class": 47, "label": "apple"}]
    monkeypatch.setattr(appmod, "_detector", FakeDetector(found))
    d = client.post("/api/detect", data={"file": (io.BytesIO(png_bytes()), "x.png")}).get_json()
    by_label = {i["detector_label"]: i for i in d["items"]}  # stub classifier says apple, strongly
    assert by_label["orange"]["needs_check"] is True and by_label["orange"]["check_reasons"] == ["label_mismatch"]
    assert by_label["apple"]["needs_check"] is False and by_label["apple"]["check_reasons"] == []
    assert by_label["apple"]["source"] == "detector"


def test_detect_checks_can_be_disabled(client, appmod, monkeypatch):
    found = [{"box": [2, 2, 20, 20], "score": 0.9, "coco_class": 49, "label": "orange"}]
    monkeypatch.setattr(appmod, "_detector", FakeDetector(found))
    monkeypatch.setenv("SHELF_CHECKS", "0")
    d = client.post("/api/detect", data={"file": (io.BytesIO(png_bytes()), "x.png")}).get_json()
    assert d["items"][0]["needs_check"] is False


def test_detect_second_pass_flag_uses_stricter_bar(client, appmod, monkeypatch):
    monkeypatch.setattr(appmod, "_detector", FakeDetector([]))
    monkeypatch.setenv("SHELF_SECOND_PASS", "1")
    monkeypatch.setattr(appmod, "_batch_fruit_logits",
                        lambda crops: np.array([[10.0] + [0.0] * 9] * len(crops)))
    buf = io.BytesIO()
    Image.new("RGB", (400, 300), "white").save(buf, "PNG")
    d = client.post("/api/detect", data={"file": (io.BytesIO(buf.getvalue()), "x.png")}).get_json()
    assert d["second_pass"]["enabled"] is True and d["second_pass"]["windows"] > 0
    assert 0 < len(d["items"]) <= 6  # capped
    assert all(i["source"] == "second_pass" and i["needs_check"] for i in d["items"])
    # off by default
    monkeypatch.delenv("SHELF_SECOND_PASS")
    d = client.post("/api/detect", data={"file": (io.BytesIO(buf.getvalue()), "x.png")}).get_json()
    assert d["second_pass"]["enabled"] is False


# ---- bug-hunt regressions ----
def _png16(value, w=8, h=8):
    buf = io.BytesIO()
    Image.fromarray(np.full((h, w), value, dtype=np.uint16)).save(buf, "PNG")
    return buf.getvalue()


def test_to_rgb_scales_16bit_grayscale_instead_of_saturating(appmod):
    with Image.open(io.BytesIO(_png16(30000))) as im:
        im.load()
        assert im.mode.startswith("I")
        px = appmod.to_rgb(im).getpixel((0, 0))
    # 30000 / 257 ~= 117; Pillow's own convert("RGB") would give (255, 255, 255)
    assert px == (117, 117, 117)


def test_predict_16bit_png_is_not_stored_as_white(client):
    b64 = base64.b64encode(_png16(10000)).decode()
    r = client.post("/api/predict", json={"image": b64})
    assert r.status_code == 200, r.get_json()
    saved = next(client.up.iterdir())
    with Image.open(saved) as im:
        assert im.getpixel((0, 0))[0] < 100


@pytest.mark.parametrize("days", [1e9, 1e300, 10 ** 30, -1e300])
def test_inventory_absurd_shelf_life_does_not_crash(client, days):
    r = client.post("/api/inventory", json={"name": "A", "shelf_life_days": days})
    assert r.status_code == 200, r.get_data()
    assert client.get("/api/inventory").status_code == 200


def test_unexpected_error_is_json_not_html(client, appmod, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("db exploded")
    monkeypatch.setattr(appmod.sqlite3, "connect", boom)
    monkeypatch.setattr(appmod.app, "testing", False)
    r = client.get("/api/inventory")
    assert r.status_code == 500 and r.is_json and "error" in r.get_json()
    assert "db exploded" not in r.get_data(as_text=True)


@pytest.mark.parametrize("raw,expected", [("abc", 5000), ("", 5000), ("0", 5000), ("70000", 5000), (" 5533 ", 5533)])
def test_port_env_parsing(appmod, monkeypatch, raw, expected):
    monkeypatch.setenv("FRESHGUARD_PORT", raw)
    assert appmod._port_from_env() == expected


def test_healthz_endpoint(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    data = r.get_json()
    assert data["status"] == "ok"
    assert "device" in data


def test_to_rgb_corrupt_exif(appmod):
    # Bug P-3: Corrupt EXIF metadata should not raise
    img = Image.new("RGB", (30, 30), "red")
    # Calling to_rgb should succeed
    rgb = appmod.to_rgb(img)
    assert rgb.mode == "RGB"


def test_to_rgb_transparency_white_background(appmod):
    # Bug P-4: Transparency should be composited onto white background
    img = Image.new("RGBA", (10, 10), (0, 0, 0, 0))  # fully transparent black
    rgb = appmod.to_rgb(img)
    assert rgb.mode == "RGB"
    # Should be white (255, 255, 255), not pitch black (0, 0, 0)
    assert rgb.getpixel((5, 5)) == (255, 255, 255)


def test_sqlite_wal_and_busy_timeout(appmod):
    # Bug P-5: Connection must have WAL and busy_timeout
    conn = appmod.get_db_connection()
    mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
    timeout = conn.execute("PRAGMA busy_timeout;").fetchone()[0]
    conn.close()
    assert mode.lower() == "wal"
    assert timeout == 5000


@pytest.mark.parametrize("persist_val", ["0", "false", "no", "off", "False", "NO"])
def test_predict_persist_false_query(client, appmod, persist_val):
    # Bug P-6: Robust persist parsing from query parameter
    img_b64 = base64.b64encode(png_bytes()).decode()
    r = client.post(f"/api/predict?persist={persist_val}", json={"image": img_b64})
    assert r.status_code == 200
    history = client.get("/api/history").get_json()
    assert len(history) == 0


def test_predict_persist_false_body(client, appmod):
    # Bug P-6: Robust persist parsing from JSON body
    img_b64 = base64.b64encode(png_bytes()).decode()
    r = client.post("/api/predict", json={"image": img_b64, "persist": False})
    assert r.status_code == 200
    history = client.get("/api/history").get_json()
    assert len(history) == 0


def test_inventory_storage_tip_both_keys(client):
    # Bug P-9: Support both storage_tip and storage_tips
    r1 = client.post("/api/inventory", json={"name": "Orange", "storage_tip": "Keep dry"})
    assert r1.status_code == 200
    r2 = client.post("/api/inventory", json={"name": "Banana", "storage_tips": "Hang up"})
    assert r2.status_code == 200

    items = client.get("/api/inventory").get_json()
    tips = {it["name"]: it.get("storage_tip") for it in items}
    assert tips["Orange"] == "Keep dry"
    assert tips["Banana"] == "Hang up"


def test_device_selection_env(appmod, monkeypatch):
    # Bug P-8: FRESHGUARD_DEVICE handling
    monkeypatch.setenv("FRESHGUARD_DEVICE", "cpu")
    assert appmod._determine_device() == "cpu"
