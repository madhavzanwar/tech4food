"""Out-of-distribution ("does this look like produce at all?") score for the FreshGuard classifier.

The multitask classifier is a closed-set softmax over 10 fruits, so it names *some* fruit for any photo.
The score used here is the energy score of the fruit head, E = logsumexp(fruit_logits) (Liu et al. 2020),
chosen because it needs no training data of its own and can be computed from the `fruit_logits` output
that the ONNX export already has (no re-export, no extra output). Larger E means "more in-distribution".

`produce_likelihood` is a monotone logistic rescale of E to (0, 1) so that the configurable threshold is
easy to read. It is NOT a calibrated probability: see docs/non-produce-rejection.md for the measured
numbers and their limits (tiny, partly synthetic evaluation sets).

Pure numpy/stdlib, no torch: unit tested without model weights (tests/test_ood.py).
"""
from __future__ import annotations

import math
import os
from typing import Sequence

import numpy as np

METHOD = "energy"
# likelihood = sigmoid((E - ENERGY_MIDPOINT) / ENERGY_SCALE); E == ENERGY_MIDPOINT gives exactly 0.5.
ENERGY_MIDPOINT = 6.0
ENERGY_SCALE = 1.5

DEFAULT_MIN_LIKELIHOOD = 0.5      # single photo: below this the result is flagged "not produce"
DEFAULT_SHELF_MIN_LIKELIHOOD = 0.5  # shelf crops: below this the crop is dropped (see detector/app)
DEFAULT_SHELF_SURE_LIKELIHOOD = 0.8  # shelf crops between reject and this are listed but "check this item"
DEFAULT_SECOND_PASS_MIN_LIKELIHOOD = 0.9  # extra proposals must clear a much stricter bar

ENV_MIN = "PRODUCE_MIN_LIKELIHOOD"


def energy_score(logits: Sequence[float] | np.ndarray, temperature: float = 1.0) -> float:
    """T * logsumexp(logits / T), numerically stable. One logit vector (1-D)."""
    t = max(float(temperature), 1e-6)
    x = np.asarray(logits, dtype=np.float64).reshape(-1) / t
    if x.size == 0 or not np.all(np.isfinite(x)):
        return float("-inf")
    m = float(x.max())
    return t * (m + math.log(float(np.exp(x - m).sum())))


def max_softmax(logits: Sequence[float] | np.ndarray) -> float:
    x = np.asarray(logits, dtype=np.float64).reshape(-1)
    e = np.exp(x - x.max())
    return float(e.max() / e.sum())


def likelihood_from_energy(score: float, midpoint: float = ENERGY_MIDPOINT, scale: float = ENERGY_SCALE) -> float:
    if not math.isfinite(score):
        return 0.0
    z = (score - midpoint) / scale
    return float(1.0 / (1.0 + math.exp(-max(min(z, 60.0), -60.0))))


def energy_from_likelihood(p: float, midpoint: float = ENERGY_MIDPOINT, scale: float = ENERGY_SCALE) -> float:
    """Inverse of likelihood_from_energy (p clipped to (1e-6, 1-1e-6))."""
    p = min(max(float(p), 1e-6), 1 - 1e-6)
    return midpoint + scale * math.log(p / (1 - p))


def env_float(name: str, default: float, environ=None) -> float:
    """Read a float in [0, 1] from the environment; invalid or missing values fall back to `default`."""
    raw = (environ if environ is not None else os.environ).get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        v = float(raw)
    except ValueError:
        return default
    return v if 0.0 <= v <= 1.0 else default


def min_likelihood(environ=None) -> float:
    """Configured threshold (PRODUCE_MIN_LIKELIHOOD). 0 disables flagging (the score is still reported)."""
    return env_float(ENV_MIN, DEFAULT_MIN_LIKELIHOOD, environ)


def assess(fruit_logits, threshold: float | None = None) -> dict:
    """OOD verdict for one fruit-logit vector. `is_produce` is False only when below the threshold."""
    thr = min_likelihood() if threshold is None else float(threshold)
    score = energy_score(fruit_logits)
    p = likelihood_from_energy(score)
    p_rounded = round(p, 3)
    return {
        "produce_score": round(score, 3) if math.isfinite(score) else None,
        "produce_likelihood": p_rounded,
        "is_produce": bool(p_rounded >= thr),
        "produce_min_likelihood": thr,
        "ood_method": METHOD,
    }
