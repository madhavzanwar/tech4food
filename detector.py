"""Multi-item produce localiser: YOLOX-S (COCO, Apache-2.0) via onnxruntime.

The detector only LOCALISES fruit; the label of every kept item always comes from the FreshGuard
classifier run on the padded crop (see app.py /api/detect). Everything here except `Detector.detect`
is pure numpy/Pillow and is unit tested without any model file (tests/test_detector.py).

Runtime dependencies: onnxruntime, numpy, Pillow. No torch / ultralytics.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_PATH = BASE_DIR / "models" / "detector" / "yolox_s.onnx"
MODEL_PATH = Path(os.environ.get("FRESHGUARD_DETECTOR_PATH", str(DEFAULT_MODEL_PATH)))

MODEL_NAME = "yolox_s"
MODEL_LICENSE = "Apache-2.0"
INPUT_SIZE = 640
PAD_VALUE = 114  # YOLOX letterbox grey
STRIDES = (8, 16, 32)

# COCO-80 class index -> FreshGuard fruit code. COCO has no mango/pepper/potato/tomato/cucumber/
# strawberry classes, and broccoli is not a class the FreshGuard classifier supports, so it is not listed.
COCO_PRODUCE = {
    46: "banana",
    47: "apple",
    49: "orange",
    51: "carrot",
}

SCORE_THRESHOLD = 0.25      # detector objectness * class probability
NMS_IOU = 0.45              # per-class NMS
CROSS_CLASS_IOU = 0.6       # overlapping boxes of different COCO classes -> keep the better one
CONTAINMENT = 0.85          # smaller box this inside a better box -> duplicate
MAX_ITEMS = 20
CROP_PAD = 0.10
MIN_BOX_SIDE = 24           # px in the original image
MIN_CLASSIFIER_CONFIDENCE = 70.0  # percent; detections the classifier is less sure about are dropped


# ---------------------------------------------------------------- pure helpers
def letterbox(image: Image.Image, size: int = INPUT_SIZE):
    """Resize keeping aspect ratio, pad bottom/right with grey. Returns (CHW float32 BGR 0-255, ratio)."""
    rgb = image.convert("RGB")
    w, h = rgb.size
    ratio = min(size / h, size / w)
    nw, nh = max(1, int(round(w * ratio))), max(1, int(round(h * ratio)))
    resized = rgb.resize((nw, nh), Image.BILINEAR)
    canvas = np.full((size, size, 3), PAD_VALUE, dtype=np.float32)
    canvas[:nh, :nw, :] = np.asarray(resized, dtype=np.float32)
    bgr = canvas[:, :, ::-1]
    return np.ascontiguousarray(bgr.transpose(2, 0, 1)), ratio


def decode_yolox(raw: np.ndarray, size: int = INPUT_SIZE, strides: Iterable[int] = STRIDES):
    """Decode the raw YOLOX head output (N, A, 5+C) into xyxy boxes (letterbox px), scores, class ids.

    Raw output stores cell offsets and log-sizes; anchors are laid out stride by stride, row by row.
    Returns (boxes[N,4], best_score[N], best_class[N], class_scores[N,C]).
    """
    out = np.asarray(raw, dtype=np.float32)
    if out.ndim == 3:
        out = out[0]
    grids, strd = [], []
    for s in strides:
        n = size // s
        ys, xs = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
        grids.append(np.stack((xs, ys), axis=-1).reshape(-1, 2))
        strd.append(np.full((n * n, 1), s))
    grid = np.concatenate(grids, 0).astype(np.float32)
    stride = np.concatenate(strd, 0).astype(np.float32)
    if out.shape[0] != grid.shape[0]:
        raise ValueError(f"unexpected detector output: {out.shape[0]} anchors, expected {grid.shape[0]}")
    xy = (out[:, 0:2] + grid) * stride
    wh = np.exp(np.clip(out[:, 2:4], -20, 10)) * stride
    boxes = np.concatenate((xy - wh / 2, xy + wh / 2), axis=1)
    cls_scores = out[:, 4:5] * out[:, 5:]
    best_class = cls_scores.argmax(1)
    best_score = cls_scores[np.arange(len(cls_scores)), best_class]
    return boxes, best_score, best_class, cls_scores


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = np.asarray(a, dtype=np.float32).reshape(-1, 4)
    b = np.asarray(b, dtype=np.float32).reshape(-1, 4)
    tl = np.maximum(a[:, None, :2], b[None, :, :2])
    br = np.minimum(a[:, None, 2:], b[None, :, 2:])
    inter = np.clip(br - tl, 0, None).prod(axis=2)
    area_a = (a[:, 2] - a[:, 0]).clip(0) * (a[:, 3] - a[:, 1]).clip(0)
    area_b = (b[:, 2] - b[:, 0]).clip(0) * (b[:, 3] - b[:, 1]).clip(0)
    union = area_a[:, None] + area_b[None, :] - inter
    return np.where(union > 0, inter / np.maximum(union, 1e-9), 0.0)


def nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float = NMS_IOU) -> list[int]:
    """Greedy non-maximum suppression. Returns kept indices, best score first."""
    boxes = np.asarray(boxes, dtype=np.float32).reshape(-1, 4)
    scores = np.asarray(scores, dtype=np.float32)
    order = list(np.argsort(-scores, kind="stable"))
    keep: list[int] = []
    while order:
        i = order.pop(0)
        keep.append(int(i))
        if not order:
            break
        ious = iou_matrix(boxes[i:i + 1], boxes[order])[0]
        order = [j for j, v in zip(order, ious) if v <= iou_threshold]
    return keep


def _containment(inner: np.ndarray, outer: np.ndarray) -> float:
    tl = np.maximum(inner[:2], outer[:2])
    br = np.minimum(inner[2:], outer[2:])
    inter = float(np.clip(br - tl, 0, None).prod())
    area = float(max(inner[2] - inner[0], 0) * max(inner[3] - inner[1], 0))
    return inter / area if area > 0 else 0.0


def dedupe(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float = CROSS_CLASS_IOU,
           containment: float = CONTAINMENT, max_items: int = MAX_ITEMS) -> list[int]:
    """Class-agnostic de-duplication: drop a box that overlaps or is mostly inside a better one, or that
    contains two or more better boxes (a group box around a pile); cap the count."""
    boxes = np.asarray(boxes, dtype=np.float32).reshape(-1, 4)
    scores = np.asarray(scores, dtype=np.float32)
    keep: list[int] = []
    for i in np.argsort(-scores, kind="stable"):
        i = int(i)
        dup = False
        for k in keep:
            if iou_matrix(boxes[i:i + 1], boxes[k:k + 1])[0, 0] > iou_threshold or \
                    _containment(boxes[i], boxes[k]) > containment:
                dup = True
                break
        if not dup:
            # a lower-scoring box that swallows two or more better boxes is a group box (a whole pile), not an item
            inside = sum(1 for k in keep if _containment(boxes[k], boxes[i]) > containment)
            dup = inside >= 2
        if not dup:
            keep.append(i)
        if len(keep) >= max_items:
            break
    return keep


def unletterbox(boxes: np.ndarray, ratio: float, width: int, height: int) -> np.ndarray:
    """Map letterbox-space xyxy boxes back to original image pixels, clipped to the image."""
    b = np.asarray(boxes, dtype=np.float32).reshape(-1, 4) / ratio
    b[:, [0, 2]] = b[:, [0, 2]].clip(0, width)
    b[:, [1, 3]] = b[:, [1, 3]].clip(0, height)
    return b


def pad_box(box, width: int, height: int, pad: float = CROP_PAD) -> tuple[int, int, int, int]:
    """Grow an xyxy box by `pad` of its size per side and clip to the image. Returns int (l, t, r, b)."""
    x1, y1, x2, y2 = [float(v) for v in box]
    pw, ph = (x2 - x1) * pad, (y2 - y1) * pad
    left = int(max(0, np.floor(x1 - pw)))
    top = int(max(0, np.floor(y1 - ph)))
    right = int(min(width, np.ceil(x2 + pw)))
    bottom = int(min(height, np.ceil(y2 + ph)))
    if width > 0 and right <= left:
        if left < width:
            right = min(width, left + 1)
        else:
            left = max(0, width - 1)
            right = width
    if height > 0 and bottom <= top:
        if top < height:
            bottom = min(height, top + 1)
        else:
            top = max(0, height - 1)
            bottom = height
    return left, top, right, bottom


def select_produce(boxes, scores, classes, *, score_threshold: float = SCORE_THRESHOLD,
                   width: int, height: int, max_items: int = MAX_ITEMS,
                   min_side: int = MIN_BOX_SIDE) -> list[dict]:
    """From decoded detections keep produce classes above threshold, NMS per class, then de-duplicate."""
    boxes = np.asarray(boxes, dtype=np.float32).reshape(-1, 4)
    scores = np.asarray(scores, dtype=np.float32)
    classes = np.asarray(classes)
    wanted = np.isin(classes, list(COCO_PRODUCE)) & (scores >= score_threshold)
    idx = np.flatnonzero(wanted)
    candidates: list[int] = []
    for cid in COCO_PRODUCE:
        sub = idx[classes[idx] == cid]
        if sub.size:
            candidates.extend(int(sub[k]) for k in nms(boxes[sub], scores[sub]))
    candidates = [i for i in candidates
                  if (boxes[i, 2] - boxes[i, 0]) >= min_side and (boxes[i, 3] - boxes[i, 1]) >= min_side]
    if not candidates:
        return []
    cand = np.array(candidates)
    kept = dedupe(boxes[cand], scores[cand], max_items=max_items)
    result = []
    for k in kept:
        i = int(cand[k])
        result.append({"box": boxes[i].tolist(), "score": float(scores[i]),
                       "coco_class": int(classes[i]), "label": COCO_PRODUCE[int(classes[i])]})
    # reading order: top-to-bottom, then left-to-right (stable list for the review UI)
    result.sort(key=lambda d: (round(d["box"][1] / 40), d["box"][0]))
    return result


# ---------------------------------------------------------------- second pass + consistency (pure)
SECOND_PASS_SCALES = (0.5, 0.34, 0.24)  # window side as a fraction of the shorter image side
SECOND_PASS_OVERLAP = 0.5               # stride = side * (1 - overlap)
SECOND_PASS_MAX_WINDOWS = 120
SECOND_PASS_MAX_EXTRA = 6
SECOND_PASS_MIN_CONFIDENCE = 90.0       # percent, stricter than MIN_CLASSIFIER_CONFIDENCE
SECOND_PASS_NMS_IOU = 0.25
SECOND_PASS_COVERED = 0.4               # window overlapping an existing item by this fraction of its area is dropped
AMBIGUOUS_MARGIN = 25.0                 # percent points between the top two fruits below which a crop is "ambiguous"

REASON_LABEL_MISMATCH = "label_mismatch"
REASON_LOW_PRODUCE = "low_produce_likelihood"
REASON_AMBIGUOUS = "ambiguous_type"
REASON_SECOND_PASS = "second_pass"


def propose_windows(width: int, height: int, scales=SECOND_PASS_SCALES, overlap: float = SECOND_PASS_OVERLAP,
                    min_side: int = 64, max_windows: int = SECOND_PASS_MAX_WINDOWS) -> list[tuple[int, int, int, int]]:
    """Square sliding windows (xyxy ints) at several scales, deterministic, capped in count.

    Coarse scales come first so that, when the cap bites, large windows are kept and fine ones are dropped.
    """
    short = min(width, height)
    out: list[tuple[int, int, int, int]] = []
    seen = set()
    for sc in scales:
        side = int(round(short * sc))
        if side < min_side:
            continue
        stride = max(1, int(round(side * (1.0 - overlap))))
        xs = list(range(0, max(width - side, 0) + 1, stride))
        ys = list(range(0, max(height - side, 0) + 1, stride))
        if xs[-1] + side < width:
            xs.append(width - side)
        if ys[-1] + side < height:
            ys.append(height - side)
        for y in ys:
            for x in xs:
                box = (x, y, min(x + side, width), min(y + side, height))
                if box not in seen:
                    seen.add(box)
                    out.append(box)
    return out[:max_windows]


def covered_fraction(box, others: Iterable) -> float:
    """Largest fraction of `box` area that lies inside any single box in `others`."""
    box = np.asarray(box, dtype=np.float32)
    best = 0.0
    for o in others:
        best = max(best, _containment(box, np.asarray(o, dtype=np.float32)))
    return best


def select_extra(boxes, scores, existing, *, max_extra: int = SECOND_PASS_MAX_EXTRA,
                 nms_iou: float = SECOND_PASS_NMS_IOU, covered: float = SECOND_PASS_COVERED) -> list[int]:
    """Choose second-pass proposals: not already covered by an existing item, NMS among themselves, capped.

    Also drops a proposal that mostly contains an existing item (a window around a detected fruit).
    Returns indices into `boxes`, best score first.
    """
    boxes = np.asarray(boxes, dtype=np.float32).reshape(-1, 4)
    scores = np.asarray(scores, dtype=np.float32)
    existing = [np.asarray(e, dtype=np.float32) for e in existing]
    ok = []
    for i in range(len(boxes)):
        if covered_fraction(boxes[i], existing) > covered:
            continue
        if any(_containment(e, boxes[i]) > 0.6 for e in existing):
            continue
        ok.append(i)
    if not ok:
        return []
    ok_arr = np.array(ok)
    keep = nms(boxes[ok_arr], scores[ok_arr], nms_iou)
    return [int(ok_arr[k]) for k in keep][:max_extra]


def check_reasons(*, detector_label: str | None, fruit: str, confidence: float, top_candidates=None,
                  produce_likelihood: float | None = None, sure_likelihood: float = 0.8,
                  second_pass: bool = False) -> list[str]:
    """Why a kept shelf item should be double-checked by the user (empty list means no concern).

    - label_mismatch: the localiser's COCO class and a classifier fruit that COCO can also name disagree
      (for example detector "orange" vs classifier "carrot");
    - low_produce_likelihood: out-of-distribution score above the reject level but below `sure_likelihood`;
    - ambiguous_type: the classifier's top two fruits are within AMBIGUOUS_MARGIN percentage points;
    - second_pass: found by the sliding-window pass instead of the detector.
    """
    reasons: list[str] = []
    if second_pass:
        reasons.append(REASON_SECOND_PASS)
    elif detector_label and detector_label != fruit and fruit in COCO_PRODUCE.values():
        # Only a conflict between two labels the localiser itself can produce is informative. If the classifier
        # names a fruit COCO has no class for (tomato, mango, ...), the localiser cannot agree by construction.
        reasons.append(REASON_LABEL_MISMATCH)
    if produce_likelihood is not None and produce_likelihood < sure_likelihood:
        reasons.append(REASON_LOW_PRODUCE)
    tc = list(top_candidates or [])
    if len(tc) >= 2:
        margin = float(tc[0].get("probability", 0)) - float(tc[1].get("probability", 0))
        if margin < AMBIGUOUS_MARGIN:
            reasons.append(REASON_AMBIGUOUS)
    return reasons


# ---------------------------------------------------------------- runtime
class DetectorUnavailable(RuntimeError):
    """The model file or onnxruntime is missing."""


class Detector:
    def __init__(self, model_path: Path | str = MODEL_PATH):
        self.model_path = Path(model_path)
        self._session = None

    def is_available(self) -> tuple[bool, str]:
        if not self.model_path.is_file():
            return False, f"Detector model not found at {self.model_path}. Run: python tools/fetch_detector.py"
        try:
            import onnxruntime  # noqa: F401
        except Exception:
            return False, "onnxruntime is not installed. Run: pip install onnxruntime"
        return True, ""

    def _load(self):
        if self._session is None:
            ok, why = self.is_available()
            if not ok:
                raise DetectorUnavailable(why)
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.log_severity_level = 3
            self._session = ort.InferenceSession(str(self.model_path), sess_options=opts,
                                                 providers=["CPUExecutionProvider"])
        return self._session

    def detect(self, image: Image.Image) -> list[dict]:
        """Return produce detections [{box (xyxy original px), score, coco_class, label}], best effort."""
        session = self._load()
        width, height = image.size
        tensor, ratio = letterbox(image)
        raw = session.run(None, {session.get_inputs()[0].name: tensor[None]})[0]
        boxes, scores, classes, _ = decode_yolox(raw)
        boxes = unletterbox(boxes, ratio, width, height)
        return select_produce(boxes, scores, classes, width=width, height=height)
