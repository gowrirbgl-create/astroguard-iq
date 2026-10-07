'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

interface Model {
  n_qubits: number;
  depth: number;
  gate_count: number;
  reps: number;
  weights: number[];
  qiskit_version: string;
  trained_at: string;
  metrics: {
    n_train: number;
    n_test: number;
    train_accuracy: number;
    test_accuracy: number;
    baseline_test_accuracy: number;
    confusion: { tp: number; fp: number; tn: number; fn: number };
  };
}

interface Result {
  norad: number;
  name?: string;
  error?: string;
  expectation?: number;
  prediction?: 'DEBRIS_LIKE' | 'PAYLOAD_LIKE';
  confidence?: number;
  catalog_label?: 'DEBRIS_OR_ROCKET_BODY' | 'PAYLOAD';
  features?: { radius_km: number; speed_kms: number; inclination_deg: number };
  in_training_range?: boolean;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function QmlClassifierInner() {
  const params = useSearchParams();
  const idsKey = params.getAll('norad').join(',');

  const [model, setModel] = useState<Model | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/qml/model')
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail ?? `HTTP ${r.status}`);
        setModel(j);
      })
      .catch((e) => setError(e.message));
  }, []);

  const classify = async (ids: string[]) => {
    const clean = ids.filter((s) => /^\d+$/.test(s.trim())).map((s) => s.trim());
    if (!clean.length) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/qml/classify?${clean.map((i) => `norad=${i}`).join('&')}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.detail ?? `HTTP ${res.status}`);
      setResults(j.results);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (idsKey) classify(idsKey.split(','));
  }, [idsKey]);

  const nextHref = `/qubo-optimizer${idsKey ? '?' + idsKey.split(',').map((i) => `norad=${i}`).join('&') : ''}`;

  return (
    <div className="p-8 md:p-16 max-w-7xl mx-auto min-h-screen flex flex-col justify-between">
      <header className="flex justify-between items-center border-b border-white/5 pb-6">
        <div>
          <a href="/live-tracking" className="text-xs font-mono tracking-widest text-emerald-400 hover:text-white transition-colors">← BACK TO PHASE 1 RADAR</a>
          <h1 className="text-xl font-bold tracking-[0.2em] text-white mt-2">QUANTUM DEBRIS CLASSIFIER</h1>
        </div>
        <div className="font-mono text-[10px] text-slate-500 text-right">
          <p>ENGINE: QISKIT {model?.qiskit_version ?? '…'} · StatevectorEstimator</p>
          {error ? (
            <p className="text-red-400 mt-1">● ERROR: {error}</p>
          ) : (
            <p className="text-emerald-400 animate-pulse mt-1">● {model ? 'MODEL LOADED' : 'LOADING MODEL…'}</p>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 my-auto py-8">
        {/* LEFT: real model facts */}
        <div className="xl:col-span-2 bg-[#09090b]/80 border border-white/5 p-6 rounded-sm backdrop-blur-md">
          <h2 className="text-xs font-mono font-bold tracking-widest text-slate-400 mb-6 uppercase">🔬 TRAINED VARIATIONAL CIRCUIT</h2>

          {model ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                {[
                  ['QUBITS', model.n_qubits],
                  ['CIRCUIT DEPTH', model.depth],
                  ['GATES', model.gate_count],
                  ['TRAINABLE PARAMS', model.weights.length],
                ].map(([k, v]) => (
                  <div key={k} className="border border-white/5 bg-white/5 p-4 rounded-sm font-mono text-center">
                    <p className="text-[10px] text-slate-500 tracking-wider">{k}</p>
                    <p className="text-2xl font-black text-white mt-1">{v}</p>
                  </div>
                ))}
              </div>

              <h3 className="text-xs font-mono font-bold tracking-widest text-slate-400 mb-3 uppercase">📊 HELD-OUT EVALUATION (REAL CELESTRAK DATA)</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8 font-mono">
                <div className="border border-white/5 bg-black/40 p-4 rounded-sm text-center">
                  <p className="text-[10px] text-slate-500">QUANTUM TEST ACC.</p>
                  <p className="text-xl font-black text-emerald-400 mt-1">{pct(model.metrics.test_accuracy)}</p>
                </div>
                <div className="border border-white/5 bg-black/40 p-4 rounded-sm text-center">
                  <p className="text-[10px] text-slate-500">CLASSICAL BASELINE</p>
                  <p className="text-xl font-black text-slate-300 mt-1">{pct(model.metrics.baseline_test_accuracy)}</p>
                </div>
                <div className="border border-white/5 bg-black/40 p-4 rounded-sm text-center">
                  <p className="text-[10px] text-slate-500">TRAIN / TEST SIZE</p>
                  <p className="text-xl font-black text-slate-300 mt-1">{model.metrics.n_train} / {model.metrics.n_test}</p>
                </div>
                <div className="border border-white/5 bg-black/40 p-4 rounded-sm text-center text-[11px] text-slate-300">
                  <p className="text-[10px] text-slate-500">CONFUSION (TP FP TN FN)</p>
                  <p className="text-xl font-black mt-1">
                    {model.metrics.confusion.tp} {model.metrics.confusion.fp} {model.metrics.confusion.tn} {model.metrics.confusion.fn}
                  </p>
                </div>
              </div>

              <h3 className="text-xs font-mono font-bold tracking-widest text-slate-400 mb-3 uppercase">🎛️ TRAINED WEIGHTS (RADIANS)</h3>
              <div className="grid grid-cols-3 md:grid-cols-6 gap-3 font-mono text-xs">
                {model.weights.map((w, i) => (
                  <div key={i} className="border border-white/5 bg-black/40 p-3 rounded-sm text-center">
                    <span className="text-[9px] text-slate-500 block mb-1">W_{i}</span>
                    <span className={w >= 0 ? 'text-emerald-400' : 'text-amber-400'}>{w.toFixed(3)}</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] font-mono text-slate-600 mt-4">
                Trained {new Date(model.trained_at).toUTCString()}. Labels come from CelesTrak naming (DEB / R/B).
              </p>
            </>
          ) : (
            <p className="text-xs font-mono text-slate-500">{error ? 'Model unavailable.' : 'Loading…'}</p>
          )}
        </div>

        {/* RIGHT: live classification */}
        <div className="bg-[#09090b]/80 border border-white/5 p-6 rounded-sm backdrop-blur-md flex flex-col justify-between">
          <div>
            <h2 className="text-xs font-mono font-bold tracking-widest text-slate-400 mb-4 uppercase">🔮 LIVE CLASSIFICATION</h2>

            <div className="flex gap-2 mb-4">
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                placeholder="NORAD ID(s), e.g. 25544"
                className="flex-1 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-xs font-mono text-slate-200 outline-none focus:border-emerald-500/40"
              />
              <button
                onClick={() => classify(manual.split(/[\s,]+/))}
                disabled={busy}
                className="px-4 text-xs font-mono font-bold tracking-widest border border-emerald-500/30 text-emerald-400 rounded-sm hover:bg-emerald-500/10 disabled:opacity-40"
              >
                {busy ? '…' : 'RUN'}
              </button>
            </div>

            {results.length === 0 && (
              <p className="text-xs text-slate-500 font-mono">No objects classified yet. Forward a pair from Phase 1 or enter a NORAD ID.</p>
            )}

            {results.map((r) => {
              if (r.error) {
                return <div key={r.norad} className="border border-red-500/20 bg-red-500/5 p-3 rounded-sm mb-3 text-[11px] font-mono text-red-400">NORAD {r.norad}: {r.error}</div>;
              }
              const debris = r.prediction === 'DEBRIS_LIKE';
              const agrees = debris === (r.catalog_label === 'DEBRIS_OR_ROCKET_BODY');
              return (
                <div key={r.norad} className={`border p-4 rounded-sm mb-3 ${debris ? 'border-red-500/20 bg-red-500/5' : 'border-emerald-500/20 bg-emerald-500/5'}`}>
                  <p className="text-[10px] font-mono tracking-widest text-slate-400">{r.name} · NORAD {r.norad}</p>
                  <p className={`text-sm font-black tracking-wider font-mono mt-1 ${debris ? 'text-red-400' : 'text-emerald-400'}`}>
                    {debris ? 'DEBRIS-LIKE ORBIT SIGNATURE' : 'ACTIVE-PAYLOAD-LIKE SIGNATURE'}
                  </p>
                  <div className="mt-3 space-y-1 text-[10px] font-mono text-slate-400">
                    <p>⟨Z₀⟩ = {r.expectation!.toFixed(4)} (margin {r.confidence!.toFixed(3)})</p>
                    <p>CATALOG SAYS: {r.catalog_label} · MODEL {agrees ? 'AGREES' : 'DISAGREES'}</p>
                    <p>RADIUS {r.features!.radius_km.toFixed(0)} KM · SPEED {r.features!.speed_kms.toFixed(3)} KM/S · INCL {r.features!.inclination_deg.toFixed(2)}°</p>
                    {!r.in_training_range && <p className="text-amber-400">OUTSIDE LEO TRAINING RANGE: unreliable</p>}
                  </div>
                </div>
              );
            })}

            <p className="text-[11px] text-slate-500 font-sans font-light leading-relaxed mt-2">
              Output is an orbit-signature classification, not a collision probability. The margin is the distance from the decision boundary, not a confidence percentage.
            </p>
          </div>

          <a
            href={nextHref}
            className="w-full mt-6 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-mono font-bold tracking-widest text-center py-4 rounded-sm hover:bg-emerald-500/20 transition-all duration-300 block uppercase"
          >
            INITIALIZE PHASE 3 OPTIMIZER →
          </a>
        </div>
      </div>

      <footer className="border-t border-white/5 pt-6 flex justify-between text-[10px] font-mono tracking-widest text-slate-600">
        <p>SOURCE: CELESTRAK GP · SGP4 · QISKIT VQC</p>
        <p>SYS_REF: VQC_ESTIMATOR_LOOP</p>
      </footer>
    </div>
  );
}

export default function QmlClassifier() {
  return (
    <Suspense fallback={null}>
      <QmlClassifierInner />
    </Suspense>
  );
}
