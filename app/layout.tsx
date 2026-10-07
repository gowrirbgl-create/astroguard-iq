import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AstroGuard IQ",
  description: "Quantum Space Traffic Control & Orbital Debris Optimization",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="bg-[#050505] text-slate-100 overflow-hidden">
      <body className="antialiased relative min-h-screen w-screen selection:bg-emerald-500 selection:text-black">
        
        {/* PREMIUM HIGH-BRIGHTNESS SATELLITE VIDEO LOOP BACKDROP */}
        <div className="absolute inset-0 w-full h-full overflow-hidden z-0 pointer-events-none select-none">
          <video
            autoPlay
            loop
            muted
            playsInline
            className="absolute top-1/2 left-1/2 min-w-full min-h-full w-auto h-auto transform -translate-x-1/2 -translate-y-1/2 object-cover opacity-65 filter brightness-95 contrast-110"
          >
            <source src="/bg-loop.mp4" type="video/mp4" />
          </video>
          {/* VIBRANT GLOW MATRIX FILTER - DITCHING THE HEAVY GREY SHADOW */}
          <div className="absolute inset-0 bg-gradient-to-t from-[#050505] via-transparent to-[#050505]/40 opacity-40" />
        </div>

        {/* APP MAIN CONTENT PORTAL */}
        <main className="relative z-10 w-full h-screen overflow-y-auto">
          {children}
        </main>

      </body>
    </html>
  );
}