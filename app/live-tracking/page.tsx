'use client';

import { useState, useEffect } from 'react';

interface SpaceObject {
  name: string;
  norad: number;
  altitude: number;
  velocity: number;
  inclination: number;
  latitude: number;
  longitude: number;
  type: 'SATELLITE' | 'DEBRIS';
  status: string;
  threatLevel: 'LOW' | 'CRITICAL';
}

interface Conjunction {
  satellite: string;
  debris: string;
  missDistanceKm: number;
  tca: string;
  currentRangeKm: number | null;
  thresholdKm: number;
  critical: boolean;
  satelliteNorad: number;
  debrisNorad: number;
}

export default function LiveTracking() {
  const [satelliteData, setSatelliteData] = useState<SpaceObject[]>([]);
  const [conjunction, setConjunction] = useState<Conjunction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Poll the backend: real CelesTrak GP data, propagated server-side with SGP4
  useEffect(() => {
    const ctrl = new AbortController();

    const load = async () => {
      try {
        const res = await fetch('/api/tracking', { signal: ctrl.signal, cache: 'no-store' });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setSatelliteData(json.objects);
        setConjunction(json.conjunction);
        setError(null);
      } catch (e: any) {
        if (e.name !== 'AbortError') setError(e.message);
      } finally {
        setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, 2000);
    return () => {
      ctrl.abort();
      clearInterval(interval);
    };
  }, []);

  const critical = conjunction?.critical ?? false;

  return (
    <div className="p-8 md:p-16 max-w-7xl mx-auto min-h-screen flex flex-col justify-between">
      {/* NAVIGATION INTERCEPT BAR */}
      <header className="flex justify-between items-center border-b border-white/5 pb-6">
        <div>
          <a href="/" className="text-xs font-mono tracking-widest text-emerald-400 hover:text-white transition-colors">← BACK TO SYSTEMS CORE</a>
          <h1 className="text-xl font-bold tracking-[0.2em] text-white mt-2">LIVE ORBITAL RADAR INTERFACE</h1>
        </div>
        <div className="font-mono text-[10px] text-slate-500 text-right">
          <p>DATAFEED: CELESTRAK_GP_REST · SGP4</p>
          {error ? (
            <p className="text-red-400 mt-1">● FEED ERROR: {error}</p>
          ) : (
            <p className="text-emerald-400 animate-pulse mt-1">● {loading ? 'CONNECTING…' : 'PARSING LIVE CHANNELS'}</p>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 my-auto py-8">
        <div className="xl:col-span-2 space-y-6">
          {/* RADAR (schematic: blip placement is decorative, labels are real) */}
          <div className="bg-black/60 border border-white/5 p-4 h-[220px] rounded-sm relative overflow-hidden backdrop-blur-md flex items-center justify-center">
            <div className="absolute w-[200px] h-[200px] border border-white/5 rounded-full" />
            <div className="absolute w-[120px] h-[120px] border border-white/5 rounded-full" />
            <div className="absolute w-[40px] h-[40px] border border-white/5 rounded-full" />
            <div className="absolute inset-0 bg-gradient-to-tr from-emerald-500/0 via-emerald-500/5 to-emerald-500/0 animate-[spin_4s_linear_infinite] origin-center pointer-events-none" />
            <div className="absolute top-4 left-4 font-mono text-[9px] text-slate-500 tracking-widest uppercase">🌌 MONITOR SCANNER DISPLAY (SCHEMATIC)</div>

            {conjunction && (
              <>
                <div className="absolute top-[40%] left-[35%] text-center animate-pulse">
                  <div className="w-2 h-2 bg-emerald-400 rounded-full shadow-[0_0_8px_#34d399]" />
                  <span className="font-mono text-[8px] text-emerald-400/80 block mt-1">{conjunction.satellite}</span>
                </div>
                <div className="absolute top-[48%] left-[39%] text-center">
                  <div className="w-2 h-2 bg-red-500 rounded-full shadow-[0_0_8px_#ef4444]" />
                  <span className="font-mono text-[8px] text-red-400 block mt-1">{conjunction.debris}</span>
                </div>
              </>
            )}
          </div>

          {/* TELEMETRY TABLE */}
          <div className="bg-[#09090b]/80 border border-white/5 p-6 rounded-sm backdrop-blur-md">
            <h2 className="text-xs font-mono font-bold tracking-widest text-slate-400 mb-4 uppercase">🚀 REAL-TIME DATA STREAM (SGP4 PROPAGATED)</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse font-mono text-xs">
                <thead>
                  <tr className="border-b border-white/5 text-slate-500">
                    <th className="pb-3 tracking-wider">OBJECT IDENTIFIER</th>
                    <th className="pb-3 tracking-wider">ALT (KM)</th>
                    <th className="pb-3 tracking-wider">VEL (KM/S)</th>
                    <th className="pb-3 tracking-wider">INCL</th>
                    <th className="pb-3 tracking-wider">LAT</th>
                    <th className="pb-3 tracking-wider">LON</th>
                    <th className="pb-3 tracking-wider text-right">STATUS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {satelliteData.map((obj) => (
                    <tr key={obj.norad} className={`transition-colors duration-200 ${obj.threatLevel === 'CRITICAL' ? 'bg-red-500/5 text-red-200 font-bold' : 'text-slate-300'}`}>
                      <td className="py-3.5 flex items-center gap-2">
                        <span>{obj.type === 'DEBRIS' ? '⚠️' : '🛰️'}</span>
                        {obj.name}
                      </td>
                      <td className="py-3.5 text-emerald-400/90 tabular-nums">{obj.altitude.toLocaleString()}</td>
                      <td className="py-3.5 text-emerald-400/90 tabular-nums">{obj.velocity}</td>
                      <td className="py-3.5 text-slate-400 tabular-nums">{obj.inclination}°</td>
                      <td className="py-3.5 text-slate-400 tabular-nums">{obj.latitude}°</td>
                      <td className="py-3.5 text-slate-400 tabular-nums">{obj.longitude}°</td>
                      <td className="py-3.5 text-right">
                        <span className={`px-2 py-0.5 rounded-sm text-[9px] border ${
                          obj.threatLevel === 'CRITICAL'
                            ? 'bg-red-500/10 border-red-500/30 text-red-400 animate-pulse font-bold'
                            : 'bg-white/5 border-white/10 text-slate-400'
                        }`}>
                          {obj.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: CONJUNCTION ASSESSMENT */}
        <div className="bg-[#09090b]/80 border border-white/5 p-6 rounded-sm backdrop-blur-md flex flex-col justify-between h-full">
          <div>
            <h2 className="text-xs font-mono font-bold tracking-widest text-slate-400 mb-4 uppercase">🚨 CONJUNCTION SCREENING</h2>

            {conjunction ? (
              <div className={`border p-4 rounded-sm mb-4 ${critical ? 'border-red-500/20 bg-red-500/5' : 'border-emerald-500/20 bg-emerald-500/5'}`}>
                <div className={`flex justify-between items-center text-xs font-mono font-bold ${critical ? 'text-red-400' : 'text-emerald-400'}`}>
                  <span>{critical ? 'CLOSE APPROACH DETECTED' : 'NO APPROACH BELOW THRESHOLD'}</span>
                  {critical && <span className="animate-ping text-red-500">●</span>}
                </div>
                <p className="text-xs text-slate-300 font-sans mt-2 leading-relaxed font-light">
                  Closest predicted pass in the next 90 min: <strong>{conjunction.satellite}</strong> and <strong>{conjunction.debris}</strong>.
                </p>
                <div className="mt-4 pt-3 border-t border-white/10 space-y-1 text-[10px] font-mono text-slate-400">
                  <p>MISS DISTANCE: {conjunction.missDistanceKm.toLocaleString()} KM</p>
                  <p>TCA: {new Date(conjunction.tca).toISOString().slice(11, 19)} UTC</p>
                  <p>CURRENT RANGE: {conjunction.currentRangeKm?.toLocaleString() ?? '—'} KM</p>
                  <p>ALERT THRESHOLD: {conjunction.thresholdKm} KM</p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500 font-mono">{loading ? 'Screening…' : 'No screening result available.'}</p>
            )}

            <p className="text-xs text-slate-400 leading-relaxed font-sans font-light mt-2">
              Screening uses public GP element sets, so miss distance is an estimate without covariance. Forward the candidate pair to the next phase for classification.
            </p>
          </div>

          <a
            href={conjunction ? `/qml-classifier?norad=${conjunction.satelliteNorad}&norad=${conjunction.debrisNorad}` : '/qml-classifier'}
            className="w-full mt-6 bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-mono font-bold tracking-widest text-center py-4 rounded-sm hover:bg-red-500/20 transition-all duration-300 block uppercase"
          >
            FORWARD ENVELOPE TO PHASE 2 →
          </a>
        </div>
      </div>

      <footer className="border-t border-white/5 pt-6 flex justify-between text-[10px] font-mono tracking-widest text-slate-600">
        <p>SOURCE: CELESTRAK GP · SGP4 (satellite.js)</p>
        <p>SYS_REF: LEO_RADAR_STREAM</p>
      </footer>
    </div>
  );
}
