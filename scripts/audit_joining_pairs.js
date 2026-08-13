'use strict';

/**
 * Section A audit part 2 — per-pair measurements for candidate forward pairs
 * in the same physical boundary (Segments 14, 16). Measures for every forward
 * pair (endpoint gap <= search radius):
 *   - euclidean endpoint gap
 *   - along-track (s) gap
 *   - robust endpoint tangent difference (from several points)
 *   - lateral extrapolation error (predict A's continuation to B's start)
 *   - temporal separation (dt of A end vs B start)
 *   - corridor evidence density between the endpoints
 *   - revisit flag (temporal overlap / backward s)
 * Used to derive joining thresholds (Section F).
 */

const path = require('path');
const SLM = require('../lib/segment_local_map');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEGS = process.argv.slice(2).length ? process.argv.slice(2) : ['14', '16'];
const SEARCH_RADIUS_M = 40;

function dist(a, b) { return Math.hypot(a.east - b.east, a.north - b.north); }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Robust endpoint tangent: fit direction over the last/first k points. */
function endTangent(frag, which) {
  const pts = frag.points;
  if (pts.length < 2) return null;
  const k = Math.min(4, pts.length - 1);
  let i0, i1;
  if (which === 'end') { i0 = pts.length - 1 - k; i1 = pts.length - 1; }
  else { i0 = 0; i1 = k; }
  const a = pts[i0], b = pts[i1];
  const len = dist(a, b) || 1e-9;
  return { dx: (b.east - a.east) / len, dy: (b.north - a.north) / len };
}

function tangentDiffDeg(t1, t2) {
  if (!t1 || !t2) return null;
  const dot = Math.max(-1, Math.min(1, t1.dx * t2.dx + t1.dy * t2.dy));
  return Math.acos(dot) * 180 / Math.PI;
}

/** Lateral offset of point p from the line through segment-local (a, b). */
function lateralOffset(p, a, b) {
  const de = b.east - a.east, dn = b.north - a.north;
  const len = Math.hypot(de, dn) || 1e-9;
  // signed perpendicular distance
  return ((p.east - a.east) * (-dn) + (p.north - a.north) * de) / len;
}

function load(seg) {
  const file = `qlog_f449c_${seg}.bz2`;
  const full = path.join(ROOT, file);
  const me = extractModel(full).map((e) => ({ ...e, sourceFile: file }));
  const ge = extractGps(full).map((e) => ({ ...e, sourceFile: file }));
  const r = processRoute(me, ge, { pipelineMode: 'C' });
  const out = SLM.buildPointAccumulatedFragments(
    r.frames, r.frames.map((x, i) => ({ index: i, logMonoTime: x.logMonoTime })),
    { east: 0, north: 0, headingDeg: 0 }, 0, 0, r.routeChunks, {},
  );
  return { pa: out.pointAccumulated };
}

function run(seg) {
  const { pa } = load(seg);
  const frags = pa.constructedFragments.fragments;
  const allPoints = pa.points || [];

  const pairs = [];
  const byBoundary = {};
  for (const f of frags) {
    const key = `${f.chunkId}:${f.passId}:${f.groupTrackId}`;
    (byBoundary[key] = byBoundary[key] || []).push(f);
  }
  for (const [key, list] of Object.entries(byBoundary)) {
    const sorted = [...list].sort((a, b) => a.points[0].s - b.points[0].s);
    for (const A of sorted) {
      const Aend = A.points[A.points.length - 1];
      for (const B of sorted) {
        if (A.fragmentId === B.fragmentId) continue;
        const Bstart = B.points[0];
        if (Bstart.s <= Aend.s) continue; // forward in s only
        const gap = dist(Aend, Bstart);
        if (gap > SEARCH_RADIUS_M) continue;

        // robust tangents
        const tA = endTangent(A, 'end');
        const tB = endTangent(B, 'start');
        const tanDiff = tangentDiffDeg(tA, tB);

        // lateral extrapolation error: predict A's continuation at B's s
        // using A's endpoint tangent, then measure lateral offset of Bstart
        let lateralErr = null;
        if (tA) {
          const ds = Bstart.s - Aend.s;
          if (ds > 0) {
            const predE = Aend.east + tA.dx * ds;
            const predN = Aend.north + tA.dy * ds;
            // lateral offset of the actual Bstart from the predicted line
            lateralErr = Math.abs(lateralOffset(Bstart, Aend, { east: predE, north: predN }));
          }
        }

        // temporal separation
        let dtSec = null;
        if (A.endLogMonoTime != null && B.startLogMonoTime != null) {
          dtSec = (Number(BigInt(String(B.startLogMonoTime))) - Number(BigInt(String(A.endLogMonoTime)))) / 1e9;
        }
        const frameGap = B.startFrameIndex - A.endFrameIndex;

        // corridor evidence: count accumulated points (same boundary identity)
        // whose s lies between Aend.s and Bstart.s (inclusive window)
        const corridor = allPoints.filter((p) =>
          p.chunkId === A.chunkId && p.passId === A.passId && String(p.groupTrackId) === String(A.groupTrackId) &&
          p.s >= Aend.s - 2 && p.s <= Bstart.s + 2,
        );
        const corridorCount = corridor.length;
        const corridorDotsNear = corridor.filter((p) => dist({ east: p.localEast ?? p.east, north: p.localNorth ?? p.north }, Aend) <= gap + 6 || dist({ east: p.localEast ?? p.east, north: p.localNorth ?? p.north }, Bstart) <= gap + 6).length;

        // revisit flag: B starts temporally BEFORE A ends (overlap) -> spatial revisit
        const revisit = dtSec != null && dtSec < 0;

        pairs.push({
          boundary: key, from: A.fragmentId, to: B.fragmentId,
          gapM: +gap.toFixed(2),
          sGapM: +(Bstart.s - Aend.s).toFixed(2),
          tanDiffDeg: tanDiff != null ? +tanDiff.toFixed(1) : null,
          lateralErrM: lateralErr != null ? +lateralErr.toFixed(2) : null,
          dtSec: dtSec != null ? +dtSec.toFixed(1) : null,
          frameGap,
          corridorDots: corridorCount,
          revisit,
          fromSplit: A.splitReason,
          toSplit: B.splitReason,
        });
      }
    }
  }

  return { seg, pairs, pairCount: pairs.length };
}

function main() {
  const out = {};
  for (const seg of SEGS) {
    try { out[seg] = run(seg); console.log(`seg ${seg} done`); }
    catch (e) { out[seg] = { error: e.message }; console.log(`seg ${seg} ERROR ${e.message}`); }
  }
  const fs = require('fs');
  fs.mkdirSync(path.join(ROOT, 'reports', 'constructed_fragments_validation'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'constructed_fragments_validation', 'joining_pair_audit.json'), JSON.stringify(out, null, 2));

  for (const seg of SEGS) {
    const r = out[seg];
    if (r.error) continue;
    const ps = r.pairs;
    const gaps = ps.map((p) => p.gapM).sort((a, b) => a - b);
    const tans = ps.map((p) => p.tanDiffDeg).filter((x) => x != null).sort((a, b) => a - b);
    const lats = ps.map((p) => p.lateralErrM).filter((x) => x != null).sort((a, b) => a - b);
    const dts = ps.map((p) => p.dtSec).filter((x) => x != null).sort((a, b) => a - b);
    const corridors = ps.map((p) => p.corridorDots);
    const revisitCount = ps.filter((p) => p.revisit).length;
    const nearPairs = ps.filter((p) => p.gapM <= 12);
    console.log(`\nseg ${seg}: ${ps.length} forward candidate pairs (gap<=${SEARCH_RADIUS_M}m)`);
    console.log(`  gaps: min=${gaps[0]} med=${median(gaps)} p90=${gaps[Math.floor(gaps.length * 0.9)]} max=${gaps[gaps.length - 1]}`);
    console.log(`  tangent diff deg: med=${median(tans)} p90=${tans[Math.floor(tans.length * 0.9)]} max=${tans[tans.length - 1]}`);
    console.log(`  lateral extrapolation err m: med=${median(lats)} p90=${lats[Math.floor(lats.length * 0.9)]} max=${lats[lats.length - 1]}`);
    console.log(`  temporal dt s: min=${dts[0]} med=${median(dts)} max=${dts[dts.length - 1]}`);
    console.log(`  corridor dots: min=${Math.min(...corridors)} med=${median(corridors)} max=${Math.max(...corridors)}`);
    console.log(`  revisit pairs: ${revisitCount} | pairs gap<=12m: ${nearPairs.length}`);
    console.log(`  small-gap high-tangent pairs (gap<=6 & tanDiff>20): ${ps.filter((p) => p.gapM <= 6 && p.tanDiffDeg != null && p.tanDiffDeg > 20).length}`);
    console.log(`  small-gap low-tangent pairs (gap<=6 & tanDiff<=20): ${ps.filter((p) => p.gapM <= 6 && p.tanDiffDeg != null && p.tanDiffDeg <= 20).length}`);
  }
}

main();
