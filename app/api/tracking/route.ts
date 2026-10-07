// app/api/tracking/route.ts
// npm i satellite.js   (v5+ required for json2satrec / OMM JSON support)
import { NextResponse } from 'next/server';
import {
  json2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  degreesLat,
  degreesLong,
} from 'satellite.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------- config
const GP_URL = 'https://celestrak.org/NORAD/elements/gp.php';

// NORAD catalog numbers. VERIFY: each response row includes OBJECT_NAME-derived `name`;
// if one doesn't match the asset you expect, fix the ID here.
const ISRO_NORAD_IDS = [42767, 30793, 43647, 44233];

// Real debris clouds published by CelesTrak (groups of GP data)
const DEBRIS_GROUPS = ['cosmos-1408-debris', 'fengyun-1c-debris'];
const MAX_DEBRIS_PER_GROUP = 150;

const HORIZON_MIN = 90; // screening window
const STEP_S = 60; // coarse grid step
const THRESHOLD_KM = Number(process.env.CONJUNCTION_THRESHOLD_KM ?? 50);
const SCREEN_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- types
type Omm = Record<string, any>; // CelesTrak OMM JSON record
type Satrec = ReturnType<typeof json2satrec>;
type Vec = { x: number; y: number; z: number };

interface Tracked {
  name: string;
  norad: number;
  type: 'SATELLITE' | 'DEBRIS';
  satrec: Satrec;
  inclination: number; // deg, from the OMM mean elements
  epoch: string;
}

interface Approach {
  sat: Tracked;
  debris: Tracked;
  missKm: number;
  tca: Date;
}

interface Screening {
  sats: Tracked[];
  watch: Tracked[]; // debris objects in the closest approaches
  closest: Approach | null;
  builtAt: number;
}

// ---------------------------------------------------------------- CelesTrak
async function fetchOmm(query: string): Promise<Omm[]> {
  // GP data refreshes roughly every 2h; CelesTrak asks clients not to poll faster.
  const res = await fetch(`${GP_URL}?${query}&FORMAT=json`, {
    next: { revalidate: 7200 },
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CelesTrak ${res.status} for ${query}`);
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // CelesTrak returns plain text (e.g. "No GP data found") on empty results
  }
}

function toTracked(o: Omm, type: Tracked['type']): Tracked | null {
  try {
    return {
      name: String(o.OBJECT_NAME),
      norad: Number(o.NORAD_CAT_ID),
      type,
      satrec: json2satrec(o as any), // SGP4 init straight from OMM mean elements
      inclination: Number(o.INCLINATION),
      epoch: String(o.EPOCH),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- SGP4 helpers
function pv(t: Tracked, date: Date): { p: Vec; v: Vec } | null {
  const r = propagate(t.satrec, date) as any;
  if (!r || !r.position || typeof r.position === 'boolean') return null;
  if (!r.velocity || typeof r.velocity === 'boolean') return null;
  return { p: r.position as Vec, v: r.velocity as Vec };
}

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// ---------------------------------------------------------------- screening
async function buildScreening(): Promise<Screening> {
  const [satOmm, debrisOmm] = await Promise.all([
    Promise.all(ISRO_NORAD_IDS.map((id) => fetchOmm(`CATNR=${id}`))).then((r) => r.flat()),
    Promise.all(DEBRIS_GROUPS.map((g) => fetchOmm(`GROUP=${g}`))).then((r) =>
      r.flatMap((x) => x.slice(0, MAX_DEBRIS_PER_GROUP)),
    ),
  ]);

  const sats = satOmm.map((o) => toTracked(o, 'SATELLITE')).filter((x): x is Tracked => !!x);
  const debris = debrisOmm.map((o) => toTracked(o, 'DEBRIS')).filter((x): x is Tracked => !!x);

  const t0 = Date.now();
  const steps = Array.from(
    { length: (HORIZON_MIN * 60) / STEP_S + 1 },
    (_, i) => new Date(t0 + i * STEP_S * 1000),
  );
  const grid = (t: Tracked) => steps.map((d) => pv(t, d)?.p ?? null);
  const satGrid = sats.map(grid);

  // Coarse pass: closest grid-sampled range for every satellite/debris pair
  const cands: { s: Tracked; d: Tracked; coarse: number; at: Date }[] = [];
  for (const d of debris) {
    const dg = grid(d);
    sats.forEach((s, si) => {
      let best = Infinity;
      let bi = -1;
      for (let i = 0; i < steps.length; i++) {
        const a = satGrid[si][i];
        const b = dg[i];
        if (!a || !b) continue;
        const r = dist(a, b);
        if (r < best) {
          best = r;
          bi = i;
        }
      }
      if (bi >= 0) cands.push({ s, d, coarse: best, at: steps[bi] });
    });
  }
  cands.sort((a, b) => a.coarse - b.coarse);

  // Fine pass: 1-second resolution around the best coarse candidates
  const refined: Approach[] = cands.slice(0, 8).map((c) => {
    let best = Infinity;
    let tca = c.at;
    for (let k = -STEP_S; k <= STEP_S; k++) {
      const d = new Date(c.at.getTime() + k * 1000);
      const a = pv(c.s, d);
      const b = pv(c.d, d);
      if (!a || !b) continue;
      const r = dist(a.p, b.p);
      if (r < best) {
        best = r;
        tca = d;
      }
    }
    return { sat: c.s, debris: c.d, missKm: best, tca };
  });
  refined.sort((a, b) => a.missKm - b.missKm);

  const watch: Tracked[] = [];
  for (const a of refined.slice(0, 4)) {
    if (!watch.includes(a.debris)) watch.push(a.debris);
  }

  return { sats, watch, closest: refined[0] ?? null, builtAt: Date.now() };
}

let cache: Screening | null = null;
let inflight: Promise<Screening> | null = null;

async function getScreening(): Promise<Screening> {
  if (cache && Date.now() - cache.builtAt < SCREEN_TTL_MS) return cache;
  inflight ??= buildScreening()
    .then((s) => (cache = s))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---------------------------------------------------------------- route
export async function GET() {
  try {
    const scr = await getScreening();
    const now = new Date();
    const gmst = gstime(now);
    const closest = scr.closest;
    const critical = !!closest && closest.missKm < THRESHOLD_KM;

    const objects = [...scr.sats, ...scr.watch].flatMap((t) => {
      const s = pv(t, now);
      if (!s) return []; // SGP4 error (e.g. decayed object): skip rather than fabricate
      const geo = eciToGeodetic(s.p as any, gmst);
      const flagged = critical && closest && (t === closest.sat || t === closest.debris);
      return [
        {
          name: t.name,
          norad: t.norad,
          type: t.type,
          altitude: Number(geo.height.toFixed(2)), // km
          velocity: Number(Math.hypot(s.v.x, s.v.y, s.v.z).toFixed(4)), // km/s (ECI)
          inclination: Number(t.inclination.toFixed(4)), // deg (OMM mean element)
          latitude: Number(degreesLat(geo.latitude).toFixed(4)),
          longitude: Number(degreesLong(geo.longitude).toFixed(4)),
          epoch: t.epoch,
          status: flagged ? 'CLOSE APPROACH' : 'TRACKING',
          threatLevel: flagged ? 'CRITICAL' : 'LOW',
        },
      ];
    });

    let conjunction = null;
    if (closest) {
      const a = pv(closest.sat, now);
      const b = pv(closest.debris, now);
      conjunction = {
        satellite: closest.sat.name,
        debris: closest.debris.name,
        missDistanceKm: Number(closest.missKm.toFixed(3)),
        tca: closest.tca.toISOString(),
        currentRangeKm: a && b ? Number(dist(a.p, b.p).toFixed(3)) : null,
        thresholdKm: THRESHOLD_KM,
        satelliteNorad: closest.sat.norad,
        debrisNorad: closest.debris.norad,
        critical,
      };
    }

    return NextResponse.json({
      generatedAt: now.toISOString(),
      source: 'CelesTrak GP (OMM JSON) + satellite.js SGP4',
      objects,
      conjunction,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'tracking failure' }, { status: 502 });
  }
}