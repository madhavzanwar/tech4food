"""Pure unit tests for detector.py (no model file, no torch)."""
import sys

import numpy as np
import pytest
from PIL import Image

from pathlib import Path
ROOT = str(Path(__file__).resolve().parent.parent)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import detector as d  # noqa: E402


def test_letterbox_shape_ratio_and_padding():
    img = Image.new("RGB", (1280, 640), (10, 20, 30))  # RGB
    t, ratio = d.letterbox(img, 640)
    assert t.shape == (3, 640, 640) and t.dtype == np.float32
    assert ratio == 0.5
    # BGR order: channel 0 is blue (30), channel 2 is red (10); image fills the top 320 rows
    assert t[0, 0, 0] == 30 and t[2, 0, 0] == 10
    assert t[0, 400, 5] == d.PAD_VALUE  # padding below the image


def test_letterbox_tall_image():
    t, ratio = d.letterbox(Image.new("RGB", (300, 600)), 640)
    assert ratio == pytest.approx(640 / 600)
    assert t[0, 10, 639] == d.PAD_VALUE  # right padding


def test_decode_yolox_places_a_known_box():
    n = 8400
    raw = np.zeros((1, n, 85), dtype=np.float32)
    raw[..., 4] = 0.0
    # anchor at stride 8, cell (x=10, y=5) is index 5*80+10
    i = 5 * 80 + 10
    raw[0, i, 0:2] = 0.5                       # offset inside the cell
    raw[0, i, 2:4] = np.log(4.0)               # w = h = 4 cells * stride 8 = 32 px
    raw[0, i, 4] = 0.9
    raw[0, i, 5 + 47] = 0.8                    # apple
    boxes, score, cls, _ = d.decode_yolox(raw)
    assert int(score.argmax()) == i and int(cls[i]) == 47
    assert score[i] == pytest.approx(0.72, abs=1e-5)
    cx, cy = (10 + 0.5) * 8, (5 + 0.5) * 8
    assert boxes[i] == pytest.approx([cx - 16, cy - 16, cx + 16, cy + 16], abs=1e-3)


def test_decode_yolox_rejects_wrong_anchor_count():
    with pytest.raises(ValueError):
        d.decode_yolox(np.zeros((1, 100, 85), dtype=np.float32))


def test_decode_second_and_third_stride_offsets():
    raw = np.zeros((1, 8400, 85), dtype=np.float32)
    raw[0, 6400, 0:2] = 0  # first anchor of stride 16 -> grid (0,0)
    raw[0, 6400, 2:4] = 0
    raw[0, 8000, 0:2] = 0  # first anchor of stride 32
    boxes, *_ = d.decode_yolox(raw)
    assert boxes[6400] == pytest.approx([-8, -8, 8, 8])
    assert boxes[8000] == pytest.approx([-16, -16, 16, 16])


def test_iou_and_nms():
    b = np.array([[0, 0, 10, 10], [1, 1, 11, 11], [50, 50, 60, 60]], dtype=np.float32)
    s = np.array([0.6, 0.9, 0.5])
    assert d.iou_matrix(b[:1], b[:1])[0, 0] == pytest.approx(1.0)
    assert d.iou_matrix(b[:1], b[2:3])[0, 0] == 0.0
    assert d.nms(b, s, 0.45) == [1, 2]
    assert d.nms(b, s, 0.95) == [1, 0, 2]
    assert d.nms(np.zeros((0, 4)), np.zeros(0)) == []


def test_dedupe_removes_overlap_and_contained_boxes_and_caps():
    boxes = np.array([[0, 0, 100, 100], [5, 5, 95, 95], [200, 0, 300, 100], [20, 20, 60, 60]], dtype=np.float32)
    scores = np.array([0.9, 0.8, 0.7, 0.6])
    # box 1 overlaps box 0 heavily, box 3 is inside box 0
    assert d.dedupe(boxes, scores) == [0, 2]
    grid = np.array([[i * 30, 0, i * 30 + 20, 20] for i in range(30)], dtype=np.float32)
    assert len(d.dedupe(grid, np.linspace(1, 0.5, 30))) == d.MAX_ITEMS
    assert len(d.dedupe(grid, np.linspace(1, 0.5, 30), max_items=3)) == 3


def test_dedupe_drops_group_box_around_several_better_boxes():
    boxes = np.array([[0, 0, 100, 100], [110, 0, 210, 100], [0, 0, 400, 300], [500, 0, 600, 100]], dtype=np.float32)
    scores = np.array([0.9, 0.8, 0.6, 0.5])
    assert d.dedupe(boxes, scores) == [0, 1, 3]
    # a larger box around ONE better box is still kept (not a group)
    assert d.dedupe(boxes[[0, 2]], scores[[0, 2]]) == [0, 1]


def test_unletterbox_scales_and_clips():
    out = d.unletterbox(np.array([[0, 0, 700, 320]]), 0.5, 1280, 640)
    assert out[0].tolist() == [0, 0, 1280, 640]


def test_pad_box_ten_percent_and_clipping():
    assert d.pad_box([100, 100, 200, 200], 1000, 1000) == (90, 90, 210, 210)
    assert d.pad_box([0, 5, 50, 100], 60, 105) == (0, 0, 55, 105)


def test_select_produce_filters_classes_scores_size_and_orders():
    boxes = np.array([[300, 10, 400, 110],      # apple, right
                      [10, 10, 110, 110],       # banana, left
                      [10, 200, 110, 300],      # cup (class 41): not produce
                      [500, 10, 510, 20],       # orange but tiny
                      [600, 10, 700, 110],      # orange but below score
                      [12, 12, 108, 108]], dtype=np.float32)  # duplicate banana, lower score
    scores = np.array([0.9, 0.8, 0.95, 0.9, 0.1, 0.6])
    classes = np.array([47, 46, 41, 49, 49, 46])
    out = d.select_produce(boxes, scores, classes, width=800, height=400)
    assert [o["label"] for o in out] == ["banana", "apple"]  # reading order, one banana, nothing else
    assert out[0]["score"] == pytest.approx(0.8)


def test_select_produce_never_exceeds_cap():
    boxes = np.array([[i * 40, 0, i * 40 + 30, 30] for i in range(40)], dtype=np.float32)
    out = d.select_produce(boxes, np.full(40, 0.9), np.full(40, 47), width=2000, height=100)
    assert len(out) == d.MAX_ITEMS


def test_broccoli_not_accepted():
    assert 50 not in d.COCO_PRODUCE  # classifier cannot label broccoli


def test_detector_reports_missing_model(tmp_path):
    det = d.Detector(tmp_path / "nope.onnx")
    ok, why = det.is_available()
    assert not ok and "fetch_detector" in why
    with pytest.raises(d.DetectorUnavailable):
        det.detect(Image.new("RGB", (64, 64)))


# ---- second pass + consistency checks ----
def test_propose_windows_cover_image_and_are_capped():
    w = d.propose_windows(1200, 900)
    assert 0 < len(w) <= d.SECOND_PASS_MAX_WINDOWS
    assert all(0 <= x1 < x2 <= 1200 and 0 <= y1 < y2 <= 900 for x1, y1, x2, y2 in w)
    assert len(set(w)) == len(w)
    assert any(x2 == 1200 for _, _, x2, _ in w) and any(y2 == 900 for _, _, _, y2 in w)  # edges reachable
    assert len(d.propose_windows(1200, 900, max_windows=5)) == 5
    assert d.propose_windows(40, 30) == []  # smaller than min_side


def test_propose_windows_is_deterministic():
    assert d.propose_windows(800, 600) == d.propose_windows(800, 600)


def test_select_extra_skips_covered_nms_and_caps():
    existing = [[0, 0, 100, 100]]
    boxes = np.array([[10, 10, 90, 90],       # inside an existing item -> dropped
                      [0, 0, 300, 300],       # contains the existing item -> dropped
                      [200, 200, 300, 300],   # new
                      [210, 205, 310, 305],   # overlaps the new one, worse score -> NMS
                      [400, 0, 500, 100],     # new
                      [600, 0, 700, 100]], dtype=float)
    scores = np.array([9, 9, 8, 7, 6, 5], dtype=float)
    assert d.select_extra(boxes, scores, existing, max_extra=10) == [2, 4, 5]
    assert d.select_extra(boxes, scores, existing, max_extra=2) == [2, 4]
    assert d.select_extra(boxes[:2], scores[:2], existing) == []
    assert d.select_extra(np.zeros((0, 4)), np.zeros(0), existing) == []


def test_covered_fraction():
    assert d.covered_fraction([0, 0, 10, 10], [[0, 0, 10, 10]]) == 1.0
    assert d.covered_fraction([0, 0, 10, 10], [[5, 0, 15, 10]]) == pytest.approx(0.5)
    assert d.covered_fraction([0, 0, 10, 10], []) == 0.0


def test_check_reasons():
    top_clear = [{"probability": 95.0}, {"probability": 3.0}]
    assert d.check_reasons(detector_label="apple", fruit="apple", confidence=95, top_candidates=top_clear,
                           produce_likelihood=0.95) == []
    assert d.check_reasons(detector_label="orange", fruit="carrot", confidence=95, top_candidates=top_clear,
                           produce_likelihood=0.95) == [d.REASON_LABEL_MISMATCH]
    # classifier names a fruit COCO cannot name: not informative, no mismatch
    assert d.check_reasons(detector_label="apple", fruit="tomato", confidence=95, top_candidates=top_clear,
                           produce_likelihood=0.95) == []
    assert d.check_reasons(detector_label="apple", fruit="apple", confidence=80, top_candidates=top_clear,
                           produce_likelihood=0.6) == [d.REASON_LOW_PRODUCE]
    assert d.check_reasons(detector_label="apple", fruit="apple", confidence=80,
                           top_candidates=[{"probability": 55.0}, {"probability": 40.0}]) == [d.REASON_AMBIGUOUS]
    assert d.check_reasons(detector_label=None, fruit="mango", confidence=99, top_candidates=top_clear,
                           second_pass=True) == [d.REASON_SECOND_PASS]
    assert d.check_reasons(detector_label=None, fruit="mango", confidence=99) == []  # no detector label, not second pass


def test_pad_box_degenerate():
    # Bug P-2: degenerate/zero box ensures right > left and bottom > top
    l, t, r, b = d.pad_box([50, 50, 50, 50], 100, 100)
    assert r > l and b > t
