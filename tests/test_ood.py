"""Pure unit tests for ood.py (no model, no torch)."""
import math
import sys

import numpy as np
import pytest

from pathlib import Path
ROOT = str(Path(__file__).resolve().parent.parent)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import ood  # noqa: E402


def test_energy_is_logsumexp_and_stable():
    assert ood.energy_score([0.0, 0.0]) == pytest.approx(math.log(2))
    assert ood.energy_score([1000.0, 0.0]) == pytest.approx(1000.0)
    assert ood.energy_score([-1000.0, -1001.0]) == pytest.approx(-1000.0 + math.log(1 + math.exp(-1)))
    assert ood.energy_score([2.0, 3.0], temperature=1.0) > ood.energy_score([1.0, 1.0])


def test_energy_handles_bad_input():
    assert ood.energy_score([]) == float("-inf")
    assert ood.energy_score([float("nan"), 1.0]) == float("-inf")
    assert ood.likelihood_from_energy(float("-inf")) == 0.0


def test_likelihood_monotone_bounded_and_midpoint():
    assert ood.likelihood_from_energy(ood.ENERGY_MIDPOINT) == pytest.approx(0.5)
    xs = np.linspace(-20, 40, 50)
    ys = [ood.likelihood_from_energy(x) for x in xs]
    assert all(0.0 <= y <= 1.0 for y in ys) and ys == sorted(ys)


def test_inverse_roundtrip():
    for p in (0.1, 0.5, 0.8, 0.9):
        assert ood.likelihood_from_energy(ood.energy_from_likelihood(p)) == pytest.approx(p, abs=1e-6)


def test_max_softmax():
    assert ood.max_softmax([0.0, 0.0, 0.0, 0.0]) == pytest.approx(0.25)
    assert ood.max_softmax([50.0, 0.0]) == pytest.approx(1.0)


def test_env_float_validation():
    assert ood.env_float("X", 0.5, {}) == 0.5
    assert ood.env_float("X", 0.5, {"X": "0.7"}) == 0.7
    assert ood.env_float("X", 0.5, {"X": "0"}) == 0.0
    for bad in ("abc", "1.5", "-0.1", "nan", ""):
        assert ood.env_float("X", 0.5, {"X": bad}) == 0.5


def test_assess_flags_flat_logits_and_accepts_peaked(monkeypatch):
    monkeypatch.delenv(ood.ENV_MIN, raising=False)
    flat = ood.assess([0.5] * 10)
    assert flat["is_produce"] is False and flat["produce_likelihood"] < 0.5
    peaked = ood.assess([12.0] + [0.0] * 9)
    assert peaked["is_produce"] is True and peaked["produce_score"] == pytest.approx(12.0, abs=0.01)
    assert peaked["ood_method"] == "energy"


def test_assess_threshold_from_env(monkeypatch):
    logits = [7.0] + [0.0] * 9
    monkeypatch.setenv(ood.ENV_MIN, "0.95")
    assert ood.assess(logits)["is_produce"] is False
    monkeypatch.setenv(ood.ENV_MIN, "0")
    r = ood.assess(logits)
    assert r["is_produce"] is True and r["produce_min_likelihood"] == 0.0
    assert ood.assess(logits, threshold=0.99)["is_produce"] is False


def test_energy_score_temperature_zero():
    # Bug P-10: Guard against ZeroDivisionError when temperature <= 0
    res = ood.energy_score([1.0, 2.0], temperature=0.0)
    assert math.isfinite(res)
    assert res == pytest.approx(2.0)


def test_assess_rounding_consistency(monkeypatch):
    # Bug P-1: is_produce matches rounded likelihood
    monkeypatch.delenv(ood.ENV_MIN, raising=False)
    # Target p = 0.4996 -> rounds to 0.500
    e_val = ood.energy_from_likelihood(0.4996)
    r = ood.assess([e_val] + [-100.0] * 9, threshold=0.5)
    assert r["produce_likelihood"] == 0.5
    assert r["is_produce"] is True
