'use client';

import { useState } from 'react';

export default function Home() {
  const [activeHover, setActiveHover] = useState<number | null>(null);

  const navigationGates = [
    {
      id: 1,
      title: "LIVE ORBITAL RADAR",
      subtitle: "Multi-Satellite State Vectors",
      desc: "Real-time telemetry stream parsing INSAT, GSAT, CARTOSAT, and RISAT constellations with dynamic spatial debris indexing.",
      metric: "300 NODES QUEUED",
      tag: "PHASE 1",
      path: "/live-tracking"
    },
    {
      id: 2,
      title: "QUANTUM QML THREAT CLASSIFIER",
      subtitle: "3-Qubit Hilbert Space Evaluation",
      desc: "Heuristic data-encoding circuits routing space telemetry states through raw Pauli rotation gates to flag fragmentation threats.",
      metric: "<Z0> VALUE DEPLOYED",
      tag: "PHASE 2",
      path: "/qml-classifier"
    },
    {
      id: 3,
      title: "ISING TRANSJECTORY SOLVER",
      subtitle: "QAOA Combinatorial Physics Matrix",
      desc: "Resolving complex satellite collision penalty constraints via transverse field mixer layers and explicit low-level OpenQASM assembly strings.",
      metric: "127-Q BIT MAP READY",
      tag: "PHASE 3",
      path: "/qubo-optimizer"
    }
  ];

  return (
    <div className="min-h-screen w-full flex flex-col justify-between p-8 md:p-16 relative">
      
      {/* HEADER META BAR */}
      <header className="flex justify-between items-start border-b border-white/5 pb-6">
        <div>
          <h1 className="text-2xl font-black tracking-[0.3em] text-white">ASTROGUARD <span className="text-emerald-500">IQ</span></h1>
          <p className="text-[10px] tracking-[0.4em] text-slate-500 font-mono mt-1">HELIOS INTERACTIVE TRAFFIC CONTROL CORE</p>
        </div>
        <div className="text-right font-mono">
          <div className="text-xs text-emerald-400 bg-emerald-500/5 border border-emerald-500/20 px-3 py-1 rounded-sm tracking-widest uppercase">
            ● SYSTEM LIVE
          </div>
          <p className="text-[9px] text-slate-500 mt-2 tracking-wider">MSRIT QHACK // DEV_CORE_1.0</p>
        </div>
      </header>

      {/* MID-CANVAS GATEWAYS: THE DYNAMIC VISUAL LOOP ENGINE */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 my-auto pt-12 pb-12 relative z-20">
        {navigationGates.map((gate, index) => {
          const isHovered = activeHover === index;
          const isAnyHovered = activeHover !== null;
          
          return (
            <a
              key={gate.id}
              href={gate.path}
              onMouseEnter={() => setActiveHover(index)}
              onMouseLeave={() => setActiveHover(null)}
              className={`
                group relative bg-[#09090b]/80 border rounded-sm p-8 flex flex-col justify-between h-[380px]
                transition-all duration-500 ease-out cursor-pointer overflow-hidden
                ${isHovered 
                  ? 'border-emerald-500/40 shadow-[0_0_40px_rgba(16,185,129,0.08)] scale-[1.02] bg-[#0c0c0e]/95' 
                  : 'border-white/5'
                }
                ${isAnyHovered && !isHovered ? 'opacity-40 filter blur-[1px] scale-[0.98]' : 'opacity-100'}
              `}
            >
              {/* MATHEMATICAL GEOMETRIC CORNER BRACKETS */}
              <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-white/10 group-hover:border-emerald-500/40 transition-colors" />
              <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-white/10 group-hover:border-emerald-500/40 transition-colors" />
              <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-white/10 group-hover:border-emerald-500/40 transition-colors" />
              <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-white/10 group-hover:border-emerald-500/40 transition-colors" />

              {/* TOP METADATA LAYER */}
              <div className="flex justify-between items-start">
                <span className="font-mono text-[10px] tracking-widest text-slate-500 group-hover:text-emerald-400 transition-colors">
                  {gate.tag}
                </span>
                <span className="font-mono text-[9px] tracking-wider text-slate-600 border border-white/5 px-2 py-0.5 rounded-sm">
                  {gate.metric}
                </span>
              </div>

              {/* MAIN CONTENT BLOCK */}
              <div className="my-auto">
                <h2 className="text-lg font-bold tracking-widest text-white group-hover:text-emerald-400 transition-colors duration-300">
                  {gate.title}
                </h2>
                <h3 className="text-xs font-medium text-slate-400 tracking-wider font-mono mt-1">
                  {gate.subtitle}
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed font-sans mt-4 font-light group-hover:text-slate-300 transition-colors">
                  {gate.desc}
                </p>
              </div>

              {/* ACTION CALL TRACE STRIP */}
              <div className="border-t border-white/5 pt-4 flex justify-between items-center mt-auto">
                <span className="text-[10px] font-mono tracking-[0.2em] text-slate-500 group-hover:text-white transition-colors">
                  INITIALIZE GATE PASS
                </span>
                <div className="w-5 h-5 rounded-full border border-white/10 flex items-center justify-center group-hover:border-emerald-500/40 group-hover:bg-emerald-500/10 transition-all duration-300">
                  <span className="text-xs text-slate-500 group-hover:text-emerald-400 transform group-hover:translate-x-0.5 transition-all">
                    →
                  </span>
                </div>
              </div>
            </a>
          );
        })}
      </div>

      {/* FOOTER STATE STRIP */}
      <footer className="flex flex-col sm:flex-row justify-between items-center border-t border-white/5 pt-6 text-[10px] font-mono tracking-widest text-slate-600">
        <p>COORDINATE RESOLUTION LAYER // SECTOR_LEO_01</p>
        <p className="mt-2 sm:mt-0">SECURE QUANTUM TELEMETRY SYSTEM</p>
      </footer>

    </div>
  );
}