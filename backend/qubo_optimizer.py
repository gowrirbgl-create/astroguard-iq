"""
qubo_optimizer.py - Phase 3: collision-avoidance maneuver selection with QUBO + QAOA (Qiskit).

Pipeline (everything computed, nothing typed in):
  1. Live CelesTrak GP data for the satellite and the debris object (SGP4 propagation).
  2. Find the next actionable closest approach (TCA) in the next 2 hours.
  3. Build candidate impulsive burns. Effect of each burn on miss distance =
     SGP4 baseline + (two-body propagation with burn - two-body propagation without burn).
  4. Penalty-points QUBO:  E(x) = sum_i a_i x_i + A (sum_i x_i - 1)^2
        a_i = lambda_fuel * (dv_i / dv_max) + lambda_col * collision_penalty_i
  5. QUBO -> Ising Hamiltonian (verified against brute force), solved with a QAOA circuit
     whose gamma/beta are optimized with COBYLA using StatevectorEstimator, then sampled.
  6. Benchmarked against exact brute force and a greedy classical solver. OpenQASM exported.

pip install qiskit numpy scipy sgp4 requests
python qubo_optimizer.py <SAT_NORAD> <DEBRIS_NORAD> [keepout_km]
"""
import sys
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import qiskit
from qiskit import QuantumCircuit, qasm2, transpile
from qiskit.circuit import ParameterVector
from qiskit.primitives import StatevectorEstimator, StatevectorSampler
from qiskit.quantum_info import SparsePauliOp, Statevector
from qiskit.transpiler import CouplingMap
from scipy.integrate import solve_ivp
from scipy.optimize import minimize
from sgp4.api import Satrec, jday

from celestrak_client import DEBRIS_TAGS, _fetch_tle_text, _parse_tle_blocks

# ---------------------------------------------------------------- configuration
MU = 398600.4418  # km^3/s^2, Earth's gravitational parameter
HORIZON_S = 7200  # search window: next 2 hours
COARSE_DT = 2.0
FINE_HALF = 90.0  # +/- seconds around TCA
FINE_DT = 0.25
BURN_DELAY_S = 300  # earliest burn: 5 min from now (command uplink)

DV_OPTIONS = [2.0, 6.0]  # m/s
DIRECTIONS = ["PROGRADE", "RETROGRADE", "NORMAL+", "NORMAL-"]
LAMBDA_FUEL = 1.0
LAMBDA_COL = 10.0  # any violating burn costs more than any compliant burn

P_LAYERS = [1, 2, 3]
SHOTS = 4096
MAXITER = 100
SEED = 7
CACHE_TTL_S = 600

_CACHE: dict = {}


# ---------------------------------------------------------------- orbit data
def _load(norad: int) -> dict:
    blocks = list(_parse_tle_blocks(_fetch_tle_text(f"CATNR={norad}")))
    if not blocks:
        raise ValueError(f"No GP data found for NORAD {norad}")
    name, l1, l2 = blocks[0]
    return {
        "norad": norad,
        "name": name,
        "sat": Satrec.twoline2rv(l1, l2),
        "is_debris": any(t in f" {name.upper()}" for t in DEBRIS_TAGS),
    }


def _states(sat: Satrec, jd0: float, fr0: float, offsets: np.ndarray):
    """SGP4 TEME position (km) and velocity (km/s) at now + offsets (seconds)."""
    off = np.atleast_1d(np.asarray(offsets, dtype=float))
    e, r, v = sat.sgp4_array(np.full(len(off), jd0), fr0 + off / 86400.0)
    if np.any(e != 0):
        raise ValueError("SGP4 propagation error (object decayed or elements invalid)")
    return r, v


def _two_body(y0: np.ndarray, times: np.ndarray) -> np.ndarray:
    def f(_, y):
        r = y[:3]
        return np.concatenate([y[3:], -MU * r / np.linalg.norm(r) ** 3])

    sol = solve_ivp(f, (0.0, float(times[-1])), y0, t_eval=times,
                    method="DOP853", rtol=1e-10, atol=1e-9)
    if not sol.success:
        raise RuntimeError("Two-body propagation failed")
    return sol.y[:3].T


# ---------------------------------------------------------------- QUBO / Ising
def _all_energies(Q: np.ndarray, offset: float) -> np.ndarray:
    n = Q.shape[0]
    X = ((np.arange(2 ** n)[:, None] >> np.arange(n)) & 1).astype(float)
    return offset + X @ np.diag(Q) + np.einsum("ni,ij,nj->n", X, np.triu(Q, 1), X)


def _qubo_to_ising(Q: np.ndarray, offset: float):
    """x_i = (1 - z_i)/2  =>  E = const + sum h_i z_i + sum J_ij z_i z_j."""
    n = Q.shape[0]
    h = np.zeros(n)
    J = {}
    const = offset
    for i in range(n):
        h[i] -= Q[i, i] / 2
        const += Q[i, i] / 2
        for j in range(i + 1, n):
            q = Q[i, j]
            if q == 0:
                continue
            J[(i, j)] = q / 4
            h[i] -= q / 4
            h[j] -= q / 4
            const += q / 4
    return h, J, const


# ---------------------------------------------------------------- QAOA
def _build_qaoa(n, h, J, scale, p):
    g = ParameterVector("g", p)
    b = ParameterVector("b", p)
    qc = QuantumCircuit(n)
    qc.h(range(n))
    for l in range(p):
        for i in range(n):  # cost layer: e^{-i g h_i Z_i} = RZ(2 g h_i)
            qc.rz(2 * g[l] * (h[i] / scale), i)
        for (i, j), v in J.items():  # e^{-i g J Z_i Z_j} = RZZ(2 g J)
            qc.rzz(2 * g[l] * (v / scale), i, j)
        for i in range(n):  # transverse-field mixer e^{-i b X} = RX(2 b)
            qc.rx(2 * b[l], i)
    return qc, g, b


def _run_qaoa(n, h, J, scale, energies, p):
    qc, g, b = _build_qaoa(n, h, J, scale, p)
    terms = [("Z", [i], float(h[i] / scale)) for i in range(n)]
    terms += [("ZZ", [i, j], float(v / scale)) for (i, j), v in J.items()]
    H = SparsePauliOp.from_sparse_list(terms, num_qubits=n)

    col = {par: i for i, par in enumerate(qc.parameters)}
    estimator = StatevectorEstimator()
    evals = 0

    def vec(theta):
        v = np.zeros(len(qc.parameters))
        for l in range(p):
            v[col[g[l]]] = theta[l]
            v[col[b[l]]] = theta[p + l]
        return v

    def objective(theta):
        nonlocal evals
        evals += 1
        return float(estimator.run([(qc, H, vec(theta))]).result()[0].data.evs)

    rng = np.random.default_rng(SEED + p)
    ramp = np.r_[0.8 * (np.arange(p) + 0.5) / p, 0.8 * (1 - (np.arange(p) + 0.5) / p)]
    t0 = time.perf_counter()
    best = None
    for start in (ramp, rng.uniform(0.0, 1.0, 2 * p)):
        res = minimize(objective, start, method="COBYLA", options={"maxiter": MAXITER})
        if best is None or res.fun < best.fun:
            best = res
    theta = best.x
    runtime = time.perf_counter() - t0

    bound = qc.assign_parameters({par: float(vec(theta)[col[par]]) for par in qc.parameters})
    probs = Statevector(bound).probabilities()
    e_min, e_max = energies.min(), energies.max()
    opt_mask = np.isclose(energies, e_min)
    exp_e = float(energies @ probs)
    return {
        "p": p,
        "theta": theta,
        "bound": bound,
        "probs": probs,
        "expected_energy": exp_e,
        "approx_ratio": float((e_max - exp_e) / (e_max - e_min)),
        "p_optimum": float(probs[opt_mask].sum()),
        "evals": evals,
        "runtime_s": runtime,
    }


# ---------------------------------------------------------------- helpers
def _qasm(circ) -> str:
    try:
        return qasm2.dumps(circ)
    except Exception:
        from qiskit import qasm3
        return qasm3.dumps(circ)


def _stats(c) -> dict:
    return {"qubits": c.num_qubits, "depth": c.depth(), "size": c.size(), "two_qubit": c.num_nonlocal_gates()}


def _r(x, nd=4):
    return float(np.round(x, nd))


# ---------------------------------------------------------------- main entry
def solve(sat_norad: int, deb_norad: int, keepout_km: float = 25.0) -> dict:
    key = (sat_norad, deb_norad, round(keepout_km, 3))
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL_S:
        return hit[1]

    a, b = _load(sat_norad), _load(deb_norad)
    if b["is_debris"] and not a["is_debris"]:
        sat_o, deb_o = a, b
    elif a["is_debris"] and not b["is_debris"]:
        sat_o, deb_o = b, a
    else:
        sat_o, deb_o = a, b  # fall back to the order given: satellite first
    sat, deb = sat_o["sat"], deb_o["sat"]

    now = datetime.now(timezone.utc)
    jd0, fr0 = jday(now.year, now.month, now.day, now.hour, now.minute,
                    now.second + now.microsecond / 1e6)

    # --- next ACTIONABLE closest approach: true local minima of range after the earliest burn
    t_b = float(BURN_DELAY_S)
    t_c = np.arange(0.0, HORIZON_S, COARSE_DT)
    rs_c, _ = _states(sat, jd0, fr0, t_c)
    rd_c, _ = _states(deb, jd0, fr0, t_c)
    d_c = np.linalg.norm(rs_c - rd_c, axis=1)
    lo = max(int((t_b + 120) / COARSE_DT), 1)
    hi = len(t_c) - int(FINE_HALF / COARSE_DT) - 2
    inner = np.arange(lo, hi)
    is_min = (d_c[inner] <= d_c[inner - 1]) & (d_c[inner] < d_c[inner + 1])
    minima = inner[is_min]
    if len(minima) == 0:
        raise ValueError(
            "No closest-approach event for this pair in the next 2 hours after the earliest burn time "
            "(the objects are only moving apart, or the approach is too soon)."
        )
    tca0 = float(t_c[minima[np.argmin(d_c[minima])]])

    win = np.arange(tca0 - FINE_HALF, tca0 + FINE_HALF + FINE_DT, FINE_DT)
    rs, _ = _states(sat, jd0, fr0, win)
    rd, _ = _states(deb, jd0, fr0, win)
    d_base = np.linalg.norm(rs - rd, axis=1)
    miss0 = float(d_base.min())
    tca_ref = float(win[np.argmin(d_base)])

    # --- candidate burns (RTN-style directions at burn time)
    rb, vb = (x[0] for x in _states(sat, jd0, fr0, np.array([t_b])))
    that = vb / np.linalg.norm(vb)
    nhat = np.cross(rb, vb)
    nhat /= np.linalg.norm(nhat)
    dirs = {"PROGRADE": that, "RETROGRADE": -that, "NORMAL+": nhat, "NORMAL-": -nhat}
    rel_t = win - t_b
    nominal = _two_body(np.r_[rb, vb], rel_t)

    cands, dists = [{"label": "NO BURN", "direction": "NONE", "dv_ms": 0.0}], [d_base]
    for dv in DV_OPTIONS:
        for dname in DIRECTIONS:
            pert = _two_body(np.r_[rb, vb + dirs[dname] * dv / 1000.0], rel_t)
            dist = np.linalg.norm((rs + (pert - nominal)) - rd, axis=1)
            cands.append({"label": f"{dname} {dv:g} m/s", "direction": dname, "dv_ms": dv})
            dists.append(dist)
    n = len(cands)
    miss = np.array([d.min() for d in dists])
    fuel = np.array([c["dv_ms"] for c in cands]) / max(DV_OPTIONS)
    pen = np.where(miss < keepout_km, 1.0 + (keepout_km - miss) / keepout_km, 0.0)

    # --- QUBO: penalty-points cost + one-hot constraint
    lin = LAMBDA_FUEL * fuel + LAMBDA_COL * pen
    A = 1.5 * lin.max() + 1.0
    Q = np.zeros((n, n))
    np.fill_diagonal(Q, lin - A)
    Q[np.triu_indices(n, 1)] = 2 * A
    offset = A
    energies = _all_energies(Q, offset)

    h, J, const = _qubo_to_ising(Q, offset)
    z = 1 - 2 * ((np.arange(2 ** n)[:, None] >> np.arange(n)) & 1)
    Jm = np.zeros((n, n))
    for (i, j), v in J.items():
        Jm[i, j] = v
    ising_e = const + z @ h + np.einsum("ni,ij,nj->n", z, Jm, z)
    if not np.allclose(ising_e, energies):
        raise RuntimeError("Ising mapping failed verification against the QUBO")
    scale = max(np.abs(h).max(), max(abs(v) for v in J.values()))

    # --- classical references
    t0 = time.perf_counter()
    e_all = _all_energies(Q, offset)
    exact_idx = int(np.argmin(e_all))
    exact_ms = (time.perf_counter() - t0) * 1000
    t0 = time.perf_counter()
    greedy_c = int(np.argmin(lin))
    greedy_ms = (time.perf_counter() - t0) * 1000
    exact_cand = int(np.log2(exact_idx)) if exact_idx and exact_idx & (exact_idx - 1) == 0 else 0

    # --- QAOA at p = 1, 2, 3 (largest p is the solver used for the decision)
    runs = [_run_qaoa(n, h, J, scale, energies, p) for p in P_LAYERS]
    main = runs[-1]
    measured = main["bound"].copy()
    measured.measure_all()
    counts = StatevectorSampler(default_shots=SHOTS, seed=SEED).run([measured]).result()[0].data.meas.get_counts()

    rows, feas_best = [], None
    for s, c in counts.items():
        idx = int(s, 2)  # Qiskit bitstrings are little-endian: qubit 0 = rightmost bit
        feasible = bin(idx).count("1") == 1
        cand = int(np.log2(idx)) if feasible else None
        rows.append({"bitstring": s, "count": int(c), "energy": _r(energies[idx]),
                     "feasible": feasible, "candidate": cand})
        if feasible and (feas_best is None or energies[idx] < energies[1 << feas_best]):
            feas_best = cand
    rows.sort(key=lambda r: -r["count"])
    source = "QAOA_SAMPLES"
    if feas_best is None:
        feas_best, source = exact_cand, "EXACT_FALLBACK"
    chosen = int(feas_best)
    opt_hits = int(counts.get(format(exact_idx, f"0{n}b"), 0))

    for i, c in enumerate(cands):
        c.update({
            "id": i, "miss_km": _r(miss[i], 3), "fuel_norm": _r(fuel[i]), "penalty": _r(pen[i]),
            "qubo_coeff": _r(lin[i]), "cleared": bool(miss[i] >= keepout_km),
            "qaoa_shots": int(counts.get(format(1 << i, f"0{n}b"), 0)),
        })

    if chosen == 0 and miss0 >= keepout_km:
        status = "NO_MANEUVER_REQUIRED"
    elif miss[chosen] >= keepout_km:
        status = "MANEUVER_SELECTED"
    else:
        status = "NO_CANDIDATE_CLEARS_KEEPOUT"

    # --- OpenQASM (logical + heavy-hex transpiled; IBM-style basis, simulated)
    tqc = transpile(measured, coupling_map=CouplingMap.from_heavy_hex(3),
                    basis_gates=["rz", "sx", "x", "cx"], optimization_level=1, seed_transpiler=SEED)

    step = int(round(1.0 / FINE_DT))
    result = {
        "generated_at": now.isoformat(),
        "qiskit_version": qiskit.__version__,
        "satellite": {"norad": sat_o["norad"], "name": sat_o["name"]},
        "debris": {"norad": deb_o["norad"], "name": deb_o["name"]},
        "conjunction": {
            "tca_utc": (now + timedelta(seconds=tca_ref)).isoformat(),
            "burn_utc": (now + timedelta(seconds=t_b)).isoformat(),
            "lead_s": _r(tca_ref - t_b, 1),
            "baseline_miss_km": _r(miss0, 3),
            "keepout_km": float(keepout_km),
        },
        "candidates": cands,
        "qubo": {
            "n": n, "penalty_A": _r(A), "lambda_fuel": LAMBDA_FUEL, "lambda_col": LAMBDA_COL,
            "offset": _r(offset), "Q": np.round(Q, 3).tolist(), "ising_verified": True,
        },
        "qaoa": {
            "p": main["p"], "gammas": [_r(x) for x in main["theta"][: main["p"]]],
            "betas": [_r(x) for x in main["theta"][main["p"]:]], "shots": SHOTS,
            "expected_energy": _r(main["expected_energy"]), "approx_ratio": _r(main["approx_ratio"]),
            "p_optimum": _r(main["p_optimum"], 5), "optimum_hits": opt_hits,
            "evals": main["evals"], "runtime_s": _r(main["runtime_s"], 2), "top": rows[:8],
        },
        "benchmark": {
            "exact": {"energy": _r(energies[exact_idx]), "candidate": exact_cand, "runtime_ms": _r(exact_ms, 3)},
            "greedy": {"candidate": greedy_c, "runtime_ms": _r(greedy_ms, 4)},
            "layers": [{"p": r["p"], "p_optimum": _r(r["p_optimum"], 5), "approx_ratio": _r(r["approx_ratio"]),
                        "evals": r["evals"], "runtime_s": _r(r["runtime_s"], 2)} for r in runs],
            "uniform_p_optimum": 1.0 / 2 ** n,
            "amplification": _r(main["p_optimum"] * 2 ** n, 1),
        },
        "decision": {
            "status": status, "chosen": chosen, "exact": exact_cand,
            "agrees_with_exact": chosen == exact_cand, "source": source,
            "new_miss_km": _r(miss[chosen], 3), "dv_ms": cands[chosen]["dv_ms"],
        },
        "timeline": {
            "t": np.round((win - tca_ref)[::step], 2).tolist(),
            "baseline_km": np.round(d_base[::step], 3).tolist(),
            "maneuver_km": np.round(dists[chosen][::step], 3).tolist(),
        },
        "qasm": {
            "logical": _qasm(measured), "transpiled": _qasm(tqc),
            "logical_stats": _stats(measured), "transpiled_stats": _stats(tqc),
            "target": "Heavy-hex coupling map (distance 3, 19 qubits), basis {rz, sx, x, cx}. Simulated, not a specific IBM device.",
        },
    }
    _CACHE[key] = (time.time(), result)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python qubo_optimizer.py <SAT_NORAD> <DEBRIS_NORAD> [keepout_km]")
        sys.exit(1)
    out = solve(int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3]) if len(sys.argv) > 3 else 25.0)
    c, d, q, bm = out["conjunction"], out["decision"], out["qaoa"], out["benchmark"]
    print(f"{out['satellite']['name']} vs {out['debris']['name']}")
    print(f"Baseline miss {c['baseline_miss_km']} km | keep-out {c['keepout_km']} km | lead {c['lead_s']} s")
    print(f"Decision: {d['status']} -> {out['candidates'][d['chosen']]['label']} (new miss {d['new_miss_km']} km)")
    print(f"QAOA p={q['p']}: P(opt)={q['p_optimum']}, approx ratio={q['approx_ratio']}, agrees with exact: {d['agrees_with_exact']}")
    print("Layers:", [(l["p"], l["p_optimum"]) for l in bm["layers"]])
    print(f"Transpiled: {out['qasm']['transpiled_stats']}")