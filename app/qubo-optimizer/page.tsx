'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

interface Candidate {
  id: number; label: string; direction: string; dv_ms: number; miss_km: number;
  fuel_norm: number; penalty: number; qubo_coeff: number; cleared: boolean; qaoa_shots: number;
}
interface Stats { qubits: number; depth: number; size: number; two_qubit: number }
interface Result {
  qiskit_version: string;
  satellite: { norad: number; name: string };
  debris: { norad: number; name: string };
  conjunction: { tca_utc: string; burn_utc: string; lead_s: number; baseline_miss_km: number; keepout_km: number };
  candidates: Candidate[];
  qubo: { n: number; penalty_A: number; lambda_fuel: number; lambda_col: number; offset: number; Q: number[][]; ising_verified: boolean };
  qaoa: {
    p: number; gammas: number[]; betas: number[]; shots: number; expected_energy: number; approx_ratio: number;
    p_optimum: number; optimum_hits: number; evals: number; runtime_s: number;
    top: { bitstring: string; count: number; energy: number; feasible: boolean; candidate: number | null }[];
  };
  benchmark: {
    exact: { energy: number; candidate: number; runtime_ms: number };
    greedy: { candidate: number; runtime_ms: number };
    layers: { p: number; p_optimum: number; approx_ratio: number; evals: number; runtime_s: number }[];
    uniform_p_optimum: number; amplification: number;
  };
  decision: { status: string; chosen: number; exact: number; agrees_with_exact: boolean; source: string; new_miss_km: number; dv_ms: number };
  timeline: { t: number[]; baseline_km: number[]; maneuver_km: number[] };
  qasm: { logical: string; transpiled: string; logical_stats: Stats; transpiled_stats: Stats; target: string };
}

const STATUS: Record<string, { text: string; cls: string }> = {
  NO_MANEUVER_REQUIRED: { text: 'NO MANEUVER REQUIRED', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' },
  MANEUVER_SELECTED: { text: 'AVOIDANCE MANEUVER SELECTED', cls: 'text-cyan-300 border-cyan-500/30 bg-cyan-500/5' },
  NO_CANDIDATE_CLEARS_KEEPOUT: { text: 'NO CANDIDATE CLEARS KEEP-OUT', cls: 'text-amber-400 border-amber-500/30 bg-amber-500/5' },
};

const utc = (iso: string) => new Date(iso).toISOString().slice(11, 19) + ' UTC';
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function MissChart({ t, base, man, keepout }: { t: number[]; base: number[]; man: number[]; keepout: number }) {
  const W = 620, H = 210, L = 44, R = 12, T = 12, B = 30;
  const ymax = Math.max(...base, ...man, keepout) * 1.1;
  const x = (v: number) => L + ((v - t[0]) / (t[t.length - 1] - t[0])) * (W - L - R);
  const y = (v: number) => T + (1 - v / ymax) * (H - T - B);
  const pts = (arr: number[]) => arr.map((v, i) => `${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="#334155" />
      <line x1={L} y1={T} x2={L} y2={H - B} stroke="#334155" />
      <line x1={L} y1={y(keepout)} x2={W - R} y2={y(keepout)} stroke="#ef4444" strokeDasharray="5 4" />
      <text x={W - R - 2} y={y(keepout) - 4} textAnchor="end" fontSize="9" fill="#f87171">KEEP-OUT {keepout} KM</text>
      <polyline points={pts(base)} fill="none" stroke="#94a3b8" strokeWidth="1.6" />
      <polyline points={pts(man)} fill="none" stroke="#34d399" strokeWidth="2" />
      <text x={L} y={H - 10} fontSize="9" fill="#64748b">{t[0]} s</text>
      <text x={W - R} y={H - 10} fontSize="9" fill="#64748b" textAnchor="end">+{t[t.length - 1]} s from baseline TCA</text>
      <text x={L - 6} y={T + 8} fontSize="9" fill="#64748b" textAnchor="end">{ymax.toFixed(0)}</text>
      <text x={L - 6} y={H - B} fontSize="9" fill="#64748b" textAnchor="end">0 km</text>
    </svg>
  );
}

function QuboOptimizerInner() {
  const params = useSearchParams();
  const ids = params.getAll('norad');
  const idsKey = ids.join(',');

  const [sat, setSat] = useState(ids[0] ?? '');
  const [deb, setDeb] = useState(ids[1] ?? '');
  const [keepout, setKeepout] = useState('25');
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showQasm, setShowQasm] = useState(false);
  const [qasmTab, setQasmTab] = useState<'logical' | 'transpiled'>('logical');
  const [showMath, setShowMath] = useState(false);

  const run = async (k?: string) => {
    const keep = k ?? keepout;
    if (!/^\d+$/.test(sat) || !/^\d+$/.test(deb) || !(parseFloat(keep) > 0)) {
      setError('Enter two NORAD IDs and a positive keep-out radius.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/qml/optimize?norad=${sat}&norad=${deb}&keepout_km=${keep}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail ?? `HTTP ${r.status}`);
      setRes(j);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (ids.length >= 2) run();
  }, [idsKey]);

  const st = res ? STATUS[res.decision.status] : null;
  const chosen = res?.candidates[res.decision.chosen];
  const qasmText = res ? res.qasm[qasmTab] : '';
  const qasmLines = qasmText.split('\n');
  const qstats = res ? (qasmTab === 'logical' ? res.qasm.logical_stats : res.qasm.transpiled_stats) : null;
  const qmax = res ? Math.max(...res.qubo.Q.flat().map(Math.abs)) : 1;

  return (
    <div className="p-8 md:p-16 max-w-7xl mx-auto min-h-screen flex flex-col gap-8">
      <header className="flex justify-between items-center border-b border-white/5 pb-6">
        <div>
          <a href={`/qml-classifier${idsKey ? '?' + ids.map((i) => `norad=${i}`).join('&') : ''}`} className="text-xs font-mono tracking-widest text-emerald-400 hover:text-white transition-colors">← BACK TO PHASE 2 QML</a>
          <h1 className="text-xl font-bold tracking-[0.2em] text-white mt-2">QUBO · QAOA MANEUVER OPTIMIZER</h1>
        </div>
        <div className="font-mono text-[10px] text-slate-500 text-right">
          <p>ENGINE: QISKIT {res?.qiskit_version ?? '…'} · STATEVECTOR SIMULATION</p>
          {error ? <p className="text-red-400 mt-1">● {error}</p>
            : <p className="text-emerald-400 animate-pulse mt-1">● {busy ? 'RUNNING QAOA (p = 1, 2, 3) · ~15-30 s' : res ? 'SOLVED' : 'READY'}</p>}
        </div>
      </header>

      {/* CONTROLS */}
      <div className="bg-[#09090b]/80 border border-white/5 p-4 rounded-sm backdrop-blur-md flex flex-wrap gap-3 items-end font-mono text-xs">
        {[['SATELLITE NORAD', sat, setSat], ['DEBRIS NORAD', deb, setDeb], ['KEEP-OUT RADIUS (KM)', keepout, setKeepout]].map(([label, val, set]: any) => (
          <label key={label} className="flex flex-col gap-1 text-[10px] text-slate-500 tracking-widest">
            {label}
            <input value={val} onChange={(e) => set(e.target.value)} className="w-40 bg-black/40 border border-white/10 rounded-sm px-3 py-2 text-slate-200 text-xs outline-none focus:border-emerald-500/40" />
          </label>
        ))}
        <button onClick={() => run()} disabled={busy} className="px-5 py-2 font-bold tracking-widest border border-emerald-500/30 text-emerald-400 rounded-sm hover:bg-emerald-500/10 disabled:opacity-40">
          {busy ? 'SOLVING…' : 'RUN OPTIMIZER'}
        </button>
        {res && (
          <button
            onClick={() => {
              const best = (dv: number) => Math.max(...res.candidates.filter((c) => c.dv_ms === dv).map((c) => c.miss_km));
              const small = best(Math.min(...res.candidates.filter((c) => c.dv_ms > 0).map((c) => c.dv_ms)));
              const large = best(Math.max(...res.candidates.map((c) => c.dv_ms)));
              const target = large > small + 1 ? (small + large) / 2 : large - 1;
              const k = String(Math.max(Math.floor(target), Math.ceil(res.conjunction.baseline_miss_km) + 1));
              setKeepout(k);
              run(k);
            }}
            disabled={busy}
            className="px-5 py-2 font-bold tracking-widest border border-amber-500/30 text-amber-400 rounded-sm hover:bg-amber-500/10 disabled:opacity-40"
            title="Scenario parameter: sets the keep-out radius between what the small and large burns can achieve, so the optimizer must trade fuel against safety"
          >
            STRESS TEST: FORCE A FUEL-VS-SAFETY TRADE-OFF
          </button>
        )}
      </div>

      {!res && !busy && !error && <p className="text-xs font-mono text-slate-500">Enter the satellite and debris NORAD IDs (or arrive from Phase 2) and run the optimizer.</p>}

      {res && st && chosen && (
        <>
          {/* TOP CARDS */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className={`border p-5 rounded-sm ${st.cls}`}>
              <p className="text-[10px] font-mono tracking-widest text-slate-400">DECISION</p>
              <p className="text-sm font-black tracking-wider font-mono mt-1">{st.text}</p>
              <div className="mt-3 space-y-1 text-[11px] font-mono text-slate-300">
                <p>MANEUVER: {chosen.label}</p>
                <p>ΔV (FUEL PROXY): {res.decision.dv_ms} m/s</p>
                <p>MISS DISTANCE: {res.conjunction.baseline_miss_km} → {res.decision.new_miss_km} km</p>
                <p>{res.decision.agrees_with_exact ? '✓ MATCHES EXACT CLASSICAL OPTIMUM' : '✗ DIFFERS FROM EXACT OPTIMUM'}</p>
              </div>
            </div>
            <div className="border border-white/5 bg-[#09090b]/80 p-5 rounded-sm">
              <p className="text-[10px] font-mono tracking-widest text-slate-400">CONJUNCTION (LIVE CELESTRAK + SGP4)</p>
              <div className="mt-3 space-y-1 text-[11px] font-mono text-slate-300">
                <p>{res.satellite.name} ↔ {res.debris.name}</p>
                <p>TCA: {utc(res.conjunction.tca_utc)}</p>
                <p>BURN WINDOW: {utc(res.conjunction.burn_utc)} (LEAD {Math.round(res.conjunction.lead_s)} s)</p>
                <p>BASELINE MISS: {res.conjunction.baseline_miss_km} km</p>
                <p>KEEP-OUT: {res.conjunction.keepout_km} km</p>
              </div>
            </div>
            <div className="border border-white/5 bg-[#09090b]/80 p-5 rounded-sm">
              <p className="text-[10px] font-mono tracking-widest text-slate-400">QAOA RESULT (p = {res.qaoa.p})</p>
              <div className="mt-3 space-y-1 text-[11px] font-mono text-slate-300">
                <p>P(OPTIMUM): {pct(res.qaoa.p_optimum)}</p>
                <p>APPROX. RATIO: {res.qaoa.approx_ratio.toFixed(3)}</p>
                <p>OPTIMUM IN {res.qaoa.optimum_hits} / {res.qaoa.shots} SHOTS</p>
                <p>γ = [{res.qaoa.gammas.join(', ')}]</p>
                <p>β = [{res.qaoa.betas.join(', ')}]</p>
              </div>
            </div>
          </div>

          {/* PENALTY TABLE */}
          <div className="bg-[#09090b]/80 border border-white/5 p-6 rounded-sm backdrop-blur-md">
            <h2 className="text-xs font-mono font-bold tracking-widest text-slate-400 mb-4 uppercase">🧮 CANDIDATE MANEUVERS · PENALTY-POINTS QUBO</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse font-mono text-xs">
                <thead>
                  <tr className="border-b border-white/5 text-slate-500">
                    {['QUBIT', 'MANEUVER', 'MISS AFTER (KM)', 'FUEL', 'COLLISION PENALTY', 'QUBO COEFF', 'KEEP-OUT', 'QAOA SHOTS'].map((h) => (
                      <th key={h} className="pb-3 pr-4 tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {res.candidates.map((c) => (
                    <tr key={c.id} className={c.id === res.decision.chosen ? 'bg-emerald-500/10 text-emerald-200 font-bold' : 'text-slate-300'}>
                      <td className="py-2.5 pr-4">q{c.id}</td>
                      <td className="pr-4">{c.label}</td>
                      <td className="pr-4 tabular-nums">{c.miss_km.toLocaleString()}</td>
                      <td className="pr-4 tabular-nums">{c.fuel_norm.toFixed(2)}</td>
                      <td className="pr-4 tabular-nums">{c.penalty.toFixed(2)}</td>
                      <td className="pr-4 tabular-nums">{c.qubo_coeff.toFixed(2)}</td>
                      <td className={`pr-4 ${c.cleared ? 'text-emerald-400' : 'text-red-400'}`}>{c.cleared ? 'CLEARS' : 'VIOLATES'}</td>
                      <td className="tabular-nums">{c.qaoa_shots}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] font-mono text-slate-600 mt-3">
              E(x) = Σ aᵢxᵢ + A(Σ xᵢ − 1)², aᵢ = {res.qubo.lambda_fuel}·fuelᵢ + {res.qubo.lambda_col}·penaltyᵢ, A = {res.qubo.penalty_A}. One-hot: exactly one maneuver is selected.
            </p>
          </div>

          {/* CHART + BENCHMARK */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div className="bg-[#09090b]/80 border border-white/5 p-6 rounded-sm backdrop-blur-md">
              <h2 className="text-xs font-mono font-bold tracking-widest text-slate-400 mb-2 uppercase">📉 MISS DISTANCE AROUND CLOSEST APPROACH</h2>
              <MissChart t={res.timeline.t} base={res.timeline.baseline_km} man={res.timeline.maneuver_km} keepout={res.conjunction.keepout_km} />
              <p className="text-[10px] font-mono text-slate-600">GREY: NO BURN · GREEN: SELECTED MANEUVER</p>
            </div>

            <div className="bg-[#09090b]/80 border border-white/5 p-6 rounded-sm backdrop-blur-md">
              <h2 className="text-xs font-mono font-bold tracking-widest text-slate-400 mb-4 uppercase">⚖️ HONEST BENCHMARK</h2>
              <table className="w-full text-left font-mono text-xs mb-4">
                <thead>
                  <tr className="border-b border-white/5 text-slate-500">
                    <th className="pb-2">QAOA LAYERS</th><th className="pb-2">P(OPTIMUM)</th><th className="pb-2">APPROX. RATIO</th><th className="pb-2">EVALS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-slate-300">
                  {res.benchmark.layers.map((l) => (
                    <tr key={l.p}><td className="py-2">p = {l.p}</td><td>{pct(l.p_optimum)}</td><td>{l.approx_ratio.toFixed(3)}</td><td>{l.evals}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="space-y-1 text-[11px] font-mono text-slate-400">
                <p>RANDOM GUESS P(OPTIMUM): {pct(res.benchmark.uniform_p_optimum)} · QAOA p={res.qaoa.p}: <span className="text-emerald-400">{res.benchmark.amplification}× HIGHER</span></p>
                <p>EXACT BRUTE FORCE (2^{res.qubo.n} STATES): {res.benchmark.exact.runtime_ms} ms</p>
                <p>GREEDY CLASSICAL: {res.benchmark.greedy.runtime_ms} ms · {res.benchmark.greedy.candidate === res.benchmark.exact.candidate ? 'ALSO OPTIMAL' : 'SUBOPTIMAL'}</p>
                <p>QAOA SIMULATION ({res.qaoa.evals} EVALS): {res.qaoa.runtime_s} s</p>
              </div>
              <p className="text-[10px] font-sans text-slate-500 mt-3 leading-relaxed">
                At {res.qubo.n} qubits a classical solver is instant, and no quantum advantage is claimed. This benchmark validates QAOA against the exact optimum and shows how its success probability grows with circuit depth. The QUBO form is what extends to coupled multi-object, multi-burn scheduling.
              </p>
            </div>
          </div>

          {/* COLLAPSIBLE: MATH */}
          <div className="bg-[#09090b]/80 border border-white/5 rounded-sm">
            <button onClick={() => setShowMath(!showMath)} className="w-full flex justify-between items-center p-4 text-xs font-mono tracking-widest text-slate-400 hover:text-white">
              <span>∑ QUBO MATRIX &amp; ISING MAPPING</span><span>{showMath ? '▲' : '▼'}</span>
            </button>
            {showMath && (
              <div className="p-4 pt-0">
                <p className="text-[10px] font-mono text-emerald-400 mb-3">{res.qubo.ising_verified ? '✓ ISING ENERGIES VERIFIED AGAINST QUBO FOR ALL 2^n BITSTRINGS' : ''}</p>
                <div className="overflow-x-auto">
                  <div className="inline-grid gap-px" style={{ gridTemplateColumns: `repeat(${res.qubo.n}, minmax(44px, 1fr))` }}>
                    {res.qubo.Q.flatMap((row, i) => row.map((v, j) => (
                      <div key={`${i}-${j}`} className="h-9 flex items-center justify-center text-[9px] font-mono text-slate-200"
                        style={{ background: v === 0 ? 'transparent' : `rgba(34,211,238,${0.08 + 0.6 * Math.abs(v) / qmax})` }}>
                        {v === 0 ? '' : v.toFixed(1)}
                      </div>
                    )))}
                  </div>
                </div>
                <p className="text-[10px] font-mono text-slate-600 mt-3">Upper-triangular Q (diagonal = linear terms). xᵢ = (1 − Zᵢ)/2 maps it to H = Σ hᵢZᵢ + Σ JᵢⱼZᵢZⱼ + const.</p>
              </div>
            )}
          </div>

          {/* COLLAPSIBLE: OPENQASM */}
          <div className="bg-[#09090b]/80 border border-white/5 rounded-sm">
            <button onClick={() => setShowQasm(!showQasm)} className="w-full flex justify-between items-center p-4 text-xs font-mono tracking-widest text-slate-400 hover:text-white">
              <span>&lt;/&gt; OPENQASM 2.0 · HARDWARE PROFILE</span><span>{showQasm ? '▲' : '▼'}</span>
            </button>
            {showQasm && (
              <div className="p-4 pt-0">
                <div className="flex flex-wrap gap-2 mb-3 font-mono text-[10px]">
                  {(['logical', 'transpiled'] as const).map((t) => (
                    <button key={t} onClick={() => setQasmTab(t)}
                      className={`px-3 py-1.5 border rounded-sm tracking-widest ${qasmTab === t ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10' : 'border-white/10 text-slate-500'}`}>
                      {t === 'logical' ? 'LOGICAL CIRCUIT' : 'TRANSPILED · HEAVY-HEX'}
                    </button>
                  ))}
                  <span className="ml-auto text-slate-500 self-center">
                    DEPTH {qstats?.depth} · GATES {qstats?.size} · 2-QUBIT {qstats?.two_qubit}
                  </span>
                </div>
                <pre className="bg-black/60 border border-white/5 p-4 rounded-sm font-mono text-[11px] text-slate-300 overflow-auto max-h-[260px] leading-relaxed">
                  <code>{qasmLines.slice(0, 60).join('\n')}{qasmLines.length > 60 ? `\n… ${qasmLines.length - 60} more lines (use Download for the full file)` : ''}</code>
                </pre>
                <div className="flex gap-2 mt-3 font-mono text-[10px]">
                  <button onClick={() => navigator.clipboard.writeText(qasmText)} className="px-3 py-1.5 border border-white/10 text-slate-300 rounded-sm hover:bg-white/5 tracking-widest">COPY</button>
                  <button onClick={() => download(`astroguard_${qasmTab}.qasm`, qasmText)} className="px-3 py-1.5 border border-white/10 text-slate-300 rounded-sm hover:bg-white/5 tracking-widest">DOWNLOAD .QASM</button>
                </div>
                <p className="text-[10px] font-mono text-slate-600 mt-3">{res.qasm.target}</p>
              </div>
            )}
          </div>

          <p className="text-[10px] font-sans text-slate-600 leading-relaxed">
            Maneuver effect modeled as SGP4 baseline plus the difference between two-body propagations with and without the burn (impulsive burns, no covariance, no Pc). Fuel is shown as ΔV, not propellant mass. The keep-out radius is a scenario parameter.
          </p>
        </>
      )}

      <footer className="border-t border-white/5 pt-6 mt-auto flex justify-between text-[10px] font-mono tracking-widest text-slate-600">
        <p>QUBO → ISING → QAOA · QISKIT</p>
        <a href="/" className="hover:text-white">← RETURN TO MASTER CORE</a>
      </footer>
    </div>
  );
}

export default function QuboOptimizer() {
  return (
    <Suspense fallback={null}>
      <QuboOptimizerInner />
    </Suspense>
  );
}
