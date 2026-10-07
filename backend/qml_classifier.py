"""
qml_classifier.py - Phase 2: variational quantum classifier (Qiskit), trained on real CelesTrak data.

pip install qiskit numpy scipy scikit-learn requests sgp4
python qml_classifier.py train            # trains and writes qml_model.json
python qml_classifier.py classify 25544   # classify any object by NORAD ID

What it does: classifies an object's orbital signature (radius, speed, inclination) as
DEBRIS_LIKE or PAYLOAD_LIKE. Labels come from CelesTrak's naming convention (DEB / R/B in the
name), so this is an orbit-signature classifier, NOT a collision-probability model.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import qiskit
from qiskit import QuantumCircuit
from qiskit.circuit import ParameterVector
from qiskit.primitives import StatevectorEstimator
from qiskit.quantum_info import SparsePauliOp
from scipy.optimize import minimize

from celestrak_client import (
    DEBRIS_GROUPS,
    RADIUS_SCALE_KM,
    CelesTrakError,
    _build_record,
    _fetch_tle_text,
    _parse_tle_blocks,
)

MODEL_PATH = Path("qml_model.json")
N_QUBITS = 3
REPS = 2  # REPS=1 reproduces the original 6-weight circuit
FEATURE_NAMES = ["orbital radius / 1000 km", "speed km/s", "inclination rad"]
TRAIN_DEBRIS_GROUPS = DEBRIS_GROUPS + ["iridium-33-debris", "cosmos-2251-debris"]
LEO_MIN_KM, LEO_MAX_KM = 6578.0, 8400.0  # LEO only, so GEO payloads don't make it trivial

# Explicit <Z> on qubit 0. (Qiskit is little-endian: the string "ZII" would measure qubit 2.)
OBSERVABLE = SparsePauliOp.from_sparse_list([("Z", [0], 1.0)], num_qubits=N_QUBITS)


# ---------------------------------------------------------------- circuit
def build_circuit(reps: int = REPS):
    """Angle-embedding (RY) + `reps` blocks of [RY layer, CX ring] + final RY layer."""
    x = ParameterVector("x", N_QUBITS)
    w = ParameterVector("w", N_QUBITS * (reps + 1))
    qc = QuantumCircuit(N_QUBITS)
    for i in range(N_QUBITS):
        qc.ry(x[i], i)
    for r in range(reps):
        for i in range(N_QUBITS):
            qc.ry(w[r * N_QUBITS + i], i)
        qc.cx(0, 1)
        qc.cx(1, 2)
        qc.cx(2, 0)
    for i in range(N_QUBITS):
        qc.ry(w[reps * N_QUBITS + i], i)
    return qc, x, w


def expectations(qc, x, w, X_scaled: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """<Z0> for every row of X_scaled, in one batched StatevectorEstimator call."""
    col = {p: i for i, p in enumerate(qc.parameters)}  # estimator uses qc.parameters order
    vals = np.zeros((len(X_scaled), len(qc.parameters)))
    for j, p in enumerate(x):
        vals[:, col[p]] = X_scaled[:, j]
    for j, p in enumerate(w):
        vals[:, col[p]] = weights[j]
    result = StatevectorEstimator().run([(qc, OBSERVABLE, vals)]).result()[0]
    return np.asarray(result.data.evs, dtype=float)


def scale(X: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    """Min-max scale each feature to [0, pi] using TRAINING statistics."""
    span = np.where(hi - lo == 0, 1.0, hi - lo)
    return np.clip((X - lo) / span, 0.0, 1.0) * np.pi


# ---------------------------------------------------------------- data
def build_dataset(n_per_class: int = 200, seed: int = 7):
    """Balanced LEO dataset: real payloads (CelesTrak 'active') vs real debris groups."""
    now = datetime.now(timezone.utc)
    by_norad = {}
    for query in ["GROUP=active"] + [f"GROUP={g}" for g in TRAIN_DEBRIS_GROUPS]:
        for name, l1, l2 in _parse_tle_blocks(_fetch_tle_text(query)):
            rec = _build_record(name, l1, l2, now)
            if rec is None or rec["epoch_age_days"] > 30:
                continue
            if LEO_MIN_KM <= rec["features"][0] * RADIUS_SCALE_KM <= LEO_MAX_KM:
                by_norad[rec["norad"]] = rec

    pos = [r for r in by_norad.values() if r["label"] == 1]
    neg = [r for r in by_norad.values() if r["label"] == -1]
    n = min(n_per_class, len(pos), len(neg))
    if n < 20:
        raise RuntimeError(f"Not enough data to train (debris={len(pos)}, payload={len(neg)}).")

    rng = np.random.default_rng(seed)
    pick = lambda L: [L[i] for i in rng.choice(len(L), n, replace=False)]
    chosen = pick(pos) + pick(neg)
    X = np.array([r["features"] for r in chosen])
    y = np.array([r["label"] for r in chosen], dtype=float)
    perm = rng.permutation(len(y))
    return X[perm], y[perm]


# ---------------------------------------------------------------- training
def train(n_per_class: int = 200, maxiter: int = 200, seed: int = 7):
    from sklearn.linear_model import LogisticRegression

    X, y = build_dataset(n_per_class, seed)
    n_test = len(y) // 4
    Xte, yte, Xtr, ytr = X[:n_test], y[:n_test], X[n_test:], y[n_test:]
    lo, hi = Xtr.min(axis=0), Xtr.max(axis=0)
    Str, Ste = scale(Xtr, lo, hi), scale(Xte, lo, hi)

    qc, xv, wv = build_circuit()
    rng = np.random.default_rng(seed)
    w0 = rng.uniform(-np.pi, np.pi, len(wv))

    def loss(w):  # mean squared error between <Z0> and the +/-1 target
        return float(np.mean((expectations(qc, xv, wv, Str, w) - ytr) ** 2))

    print(f"Training on {len(ytr)} objects, testing on {len(yte)} (COBYLA, {maxiter} iterations)...")
    res = minimize(loss, w0, method="COBYLA", options={"maxiter": maxiter})
    w = res.x

    def predict_labels(S):
        return np.where(expectations(qc, xv, wv, S, w) > 0, 1.0, -1.0)

    ptr, pte = predict_labels(Str), predict_labels(Ste)
    base = LogisticRegression(max_iter=1000).fit(Str, ytr)

    metrics = {
        "n_train": int(len(ytr)),
        "n_test": int(len(yte)),
        "final_loss": float(res.fun),
        "train_accuracy": float(np.mean(ptr == ytr)),
        "test_accuracy": float(np.mean(pte == yte)),
        "baseline_test_accuracy": float(base.score(Ste, yte)),  # classical logistic regression
        "confusion": {
            "tp": int(np.sum((pte == 1) & (yte == 1))),
            "fp": int(np.sum((pte == 1) & (yte == -1))),
            "tn": int(np.sum((pte == -1) & (yte == -1))),
            "fn": int(np.sum((pte == -1) & (yte == 1))),
        },
    }
    model = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "qiskit_version": qiskit.__version__,
        "n_qubits": N_QUBITS,
        "reps": REPS,
        "depth": qc.depth(),
        "gate_count": qc.size(),
        "weights": [float(v) for v in w],
        "scaler": {"min": lo.tolist(), "max": hi.tolist()},
        "feature_names": FEATURE_NAMES,
        "label_convention": "<Z0> > 0 => DEBRIS_LIKE; labels from CelesTrak names (DEB / R/B)",
        "metrics": metrics,
    }
    MODEL_PATH.write_text(json.dumps(model, indent=2))
    print(json.dumps(metrics, indent=2))
    print(f"Saved {MODEL_PATH}")
    return model


# ---------------------------------------------------------------- inference
def load_model() -> dict:
    return json.loads(MODEL_PATH.read_text())


def predict(features: np.ndarray, model: dict) -> np.ndarray:
    qc, xv, wv = build_circuit(model["reps"])
    S = scale(
        np.atleast_2d(features),
        np.array(model["scaler"]["min"]),
        np.array(model["scaler"]["max"]),
    )
    return expectations(qc, xv, wv, S, np.array(model["weights"]))


def classify_norad(norad: int, model: dict) -> dict:
    blocks = list(_parse_tle_blocks(_fetch_tle_text(f"CATNR={norad}")))
    if not blocks:
        raise ValueError(f"No GP data found for NORAD {norad}")
    rec = _build_record(*blocks[0], datetime.now(timezone.utc))
    if rec is None:
        raise ValueError(f"SGP4 could not propagate NORAD {norad} (decayed or bad elements)")

    ev = float(predict(rec["features"], model)[0])
    radius_km = float(rec["features"][0] * RADIUS_SCALE_KM)
    return {
        "norad": rec["norad"],
        "name": rec["name"],
        "expectation": ev,
        "prediction": "DEBRIS_LIKE" if ev > 0 else "PAYLOAD_LIKE",
        "confidence": abs(ev),  # distance from the decision boundary, NOT a probability
        "catalog_label": "DEBRIS_OR_ROCKET_BODY" if rec["label"] == 1 else "PAYLOAD",
        "features": {
            "radius_km": radius_km,
            "speed_kms": float(rec["features"][1]),
            "inclination_deg": float(np.degrees(rec["features"][2])),
        },
        "epoch_age_days": rec["epoch_age_days"],
        "in_training_range": LEO_MIN_KM <= radius_km <= LEO_MAX_KM,
    }


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if cmd == "train":
            train()
        elif cmd == "classify" and len(sys.argv) > 2:
            print(json.dumps(classify_norad(int(sys.argv[2]), load_model()), indent=2))
        else:
            print("Usage: python qml_classifier.py train | classify <NORAD_ID>")
    except (CelesTrakError, ValueError, FileNotFoundError, RuntimeError) as e:
        print(f"ERROR: {e}")
        sys.exit(1)