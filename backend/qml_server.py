"""
qml_server.py - serves Phase 2 (classifier) and Phase 3 (QUBO/QAOA optimizer) to the Next.js frontend.

pip install fastapi uvicorn
uvicorn qml_server:app --port 8000
"""
from fastapi import FastAPI, HTTPException, Query

import qml_classifier as q
import qubo_optimizer as qo
from celestrak_client import CelesTrakError

app = FastAPI(title="AstroGuard IQ - Quantum service")


def _model() -> dict:
    try:
        return q.load_model()
    except FileNotFoundError:
        raise HTTPException(503, "No trained model found. Run: python qml_classifier.py train")


@app.get("/qml/model")
def model_info():
    return _model()


@app.get("/qml/classify")
def classify(norad: list[int] = Query(...)):
    model = _model()
    results = []
    for n in norad[:10]:
        try:
            results.append(q.classify_norad(n, model))
        except (ValueError, CelesTrakError) as e:
            results.append({"norad": n, "error": str(e)})
    return {"results": results}


# Phase 3 lives under /qml/ so the existing Next.js rewrite (/api/qml/:path*) already covers it.
@app.get("/qml/optimize")
def optimize(
    norad: list[int] = Query(..., min_length=2, max_length=2),
    keepout_km: float = Query(25.0, gt=0, le=2000),
):
    try:
        return qo.solve(norad[0], norad[1], keepout_km)
    except (ValueError, CelesTrakError) as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(500, str(e))