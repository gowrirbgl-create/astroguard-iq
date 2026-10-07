"""
celestrak_client.py - live CelesTrak GP data + SGP4 propagation (no simulated data).

pip install requests numpy sgp4
"""
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests
from sgp4.api import Satrec, jday

GP_URL = "https://celestrak.org/NORAD/elements/gp.php"
CACHE_DIR = Path(".celestrak_cache")
CACHE_TTL_S = 2 * 60 * 60  # GP data refreshes ~every 2h; CelesTrak asks clients not to poll faster
HEADERS = {"User-Agent": "AstroGuardIQ-QHack/1.0 (research prototype)"}

# ISRO payloads: CelesTrak NAME= does a substring match on the object name
ISRO_NAME_QUERIES = ["CARTOSAT", "INSAT", "GSAT", "RISAT"]
# Real debris clouds published as CelesTrak groups
DEBRIS_GROUPS = ["cosmos-1408-debris", "fengyun-1c-debris"]
MAX_DEBRIS_PER_GROUP = 50

# CelesTrak naming convention for non-payload objects
DEBRIS_TAGS = (" DEB", " R/B")

# Feature scaling kept from the original pipeline: radius in thousands of km
RADIUS_SCALE_KM = 1000.0


class CelesTrakError(RuntimeError):
    pass


# ---------------------------------------------------------------- fetching
def _fetch_tle_text(query: str) -> str:
    """GET one GP query as 3-line TLE text, with a 2h on-disk cache."""
    CACHE_DIR.mkdir(exist_ok=True)
    cache_file = CACHE_DIR / (query.replace("=", "_").replace("/", "_") + ".tle")

    fresh = cache_file.exists() and (time.time() - cache_file.stat().st_mtime) < CACHE_TTL_S
    if fresh:
        return cache_file.read_text()

    try:
        resp = requests.get(f"{GP_URL}?{query}&FORMAT=tle", headers=HEADERS, timeout=15)
        resp.raise_for_status()
        text = resp.text
        if not text.lstrip().startswith(("0 ", "1 ")) and "\n1 " not in text:
            # CelesTrak sends plain text such as "No GP data found" when nothing matches
            return ""
        cache_file.write_text(text)
        return text
    except requests.RequestException as exc:
        if cache_file.exists():
            # Real data from the last successful fetch, not a simulation. Clearly flagged.
            age_h = (time.time() - cache_file.stat().st_mtime) / 3600
            print(f"WARNING: live fetch failed ({exc}); using cached real data ({age_h:.1f} h old).")
            return cache_file.read_text()
        raise CelesTrakError(f"CelesTrak request failed for '{query}' and no cache exists: {exc}") from exc


def _parse_tle_blocks(text: str):
    """Yield (name, line1, line2) from 3-line (or 3LE with '0 ' prefix) blocks."""
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    i = 0
    while i + 2 < len(lines):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if l1.startswith("1 ") and l2.startswith("2 "):
            yield (name[2:] if name.startswith("0 ") else name).strip(), l1.strip(), l2.strip()
            i += 3
        else:
            i += 1  # resync if a block is malformed


# ---------------------------------------------------------------- propagation
def _state_now(sat: Satrec, now: datetime):
    """SGP4 state (TEME, km and km/s) at the current UTC time, not at the TLE epoch."""
    jd, fr = jday(now.year, now.month, now.day, now.hour, now.minute, now.second + now.microsecond / 1e6)
    err, r, v = sat.sgp4(jd, fr)
    if err != 0:
        return None
    epoch_age_days = (jd - sat.jdsatepoch) + (fr - sat.jdsatepochF)
    return np.array(r), np.array(v), epoch_age_days


def _build_record(name: str, l1: str, l2: str, now: datetime):
    sat = Satrec.twoline2rv(l1, l2)
    state = _state_now(sat, now)
    if state is None:
        return None  # SGP4 error (e.g. decayed): drop it instead of inventing numbers
    pos_km, vel_kms, age = state

    is_junk = any(tag in f" {name.upper()}" for tag in DEBRIS_TAGS)
    radius_km = float(np.linalg.norm(pos_km))
    speed_kms = float(np.linalg.norm(vel_kms))
    inclination_rad = float(sat.inclo)  # radians in sgp4's Satrec

    return {
        "name": name,
        "norad": int(sat.satnum),
        "features": np.array([radius_km / RADIUS_SCALE_KM, speed_kms, inclination_rad]),
        # Label comes from CelesTrak's naming convention (DEB / R/B), not from a collision truth source
        "label": 1 if is_junk else -1,
        "position_km": pos_km,
        "velocity_kms": vel_kms,
        "epoch_age_days": float(age),
    }


# ---------------------------------------------------------------- public API
def fetch_celestrak_data(max_epoch_age_days: float = 30.0):
    """Return real tracked objects (ISRO payloads + debris) with SGP4 state at the current time."""
    now = datetime.now(timezone.utc)
    queries = [f"NAME={n}" for n in ISRO_NAME_QUERIES] + [f"GROUP={g}" for g in DEBRIS_GROUPS]

    pool, seen, skipped = [], set(), 0
    for q in queries:
        text = _fetch_tle_text(q)
        blocks = list(_parse_tle_blocks(text))
        if q.startswith("GROUP="):
            blocks = blocks[:MAX_DEBRIS_PER_GROUP]
        for name, l1, l2 in blocks:
            rec = _build_record(name, l1, l2, now)
            if rec is None or rec["epoch_age_days"] > max_epoch_age_days or rec["norad"] in seen:
                skipped += 1
                continue
            seen.add(rec["norad"])
            pool.append(rec)

    if not pool:
        raise CelesTrakError("No usable objects returned from CelesTrak.")

    n_junk = sum(1 for r in pool if r["label"] == 1)
    print(f"Loaded {len(pool)} objects ({n_junk} debris/rocket bodies, {len(pool) - n_junk} payloads); skipped {skipped}.")
    return pool


if __name__ == "__main__":
    data = fetch_celestrak_data()
    s = data[0]
    print("\n=== LIVE DATA DIAGNOSTIC ===")
    print(f"Sample: {s['name']} (NORAD {s['norad']})")
    print(f"Features [radius/1000 km, speed km/s, inclination rad]: {s['features']}")
    print(f"Label: {s['label']}  |  TLE epoch age: {s['epoch_age_days']:.2f} days")