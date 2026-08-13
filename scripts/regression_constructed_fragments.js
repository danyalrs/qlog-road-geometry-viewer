'use strict';

/**
 * Regression checks for the constructed-fragments layer on segments
 * 2, 6, 54, 58, 99 — the segments NOT in the two detailed verification
 * segments (14, 16). Each segment has a specific attention point:
 *   99  spatial revisit and curves
 *    6  GPS discontinuity
 *    2  dense boundaries
 *   58  uneven track distribution
 *   54  general multi-boundary behaviour
 *
 * The algorithm is NOT tuned here; these are regression measurements over the
 * existing layer output.
 */

const fs = require('fs');
const path = require('path');
const SLM = require('../lib/segment_local_map');
const CF = require('../lib/constructed_fragments');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'constructed_fragments_validation');
const REGRESSION = [
  { seg: '99', attention: 'spatial revisit and curves' },
  { seg: '6', attention: 'GPS discontinuity' },
  { seg: '2', attention: 'dense boundaries' },
  { seg: '58', attention: 'uneven track distribution' },
  { seg: '54', attention: 'multi-boundary general' },
];

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function round(x, dp) { return x == null ? null : +x.toFixed(dp); }

function segsCross(a1, a2, b1, b2) {
  const cross = (o, p, q) => (p.east - o.east) * (q.north - o.north) - (p.north - o.north) * (q.east - o.east);
  const d1 = cross(a1, a2, b1), d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1), d4 = cross(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function run(seg) {
  const file = `qlog_f449c_${seg}.bz2`;
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) throw new Error(`missing ${file}`);
  const me = extractModel(full).map((e) => ({ ...e, sourceFile: file }));
  const ge = extractGps(full).map((e) => ({ ...e, sourceFile: file }));
  const r = processRoute(me, ge, { pipelineMode: 'C' });
  const out = SLM.buildPointAccumulatedFragments(
    r.frames, r.frames.map((x, i) => ({ index: i, logMonoTime: x.logMonoTime })),
    { east: 0, north: 0, headingDeg: 0 }, 0, 0, r.routeChunks, {},
  );
  const points = out.pointAccumulated?.points || [];
  const cf = CF.buildConstructedFragments(points);
  const frags = cf.fragments;
  const D = CF.DEFAULTS;

  // ---- generic invariants ----
  // boundary consistency
  let mixed = 0;
  const byFrag = new Map();
  for (const f of frags) {
    const ids = new Set(f.points.map((p) => `${p.chunkId}:${p.passId}:${p.groupTrackId}`));
    if (ids.size !== 1) mixed++;
    byFrag.set(f.fragmentId, ids.values().next().value);
  }
  // crossings
  let crossings = 0;
  for (let i = 0; i < frags.length; i++) {
    for (let j = i + 1; j < frags.length; j++) {
      if (byFrag.get(frags[i].fragmentId) === byFrag.get(frags[j].fragmentId)) continue;
      const A = frags[i].points, B = frags[j].points;
      for (let a = 0; a < A.length - 1; a++) {
        for (let b = 0; b < B.length - 1; b++) {
          if (segsCross(A[a], A[a + 1], B[b], B[b + 1])) crossings++;
        }
      }
    }
  }
  // s reversal + interior sharp turns
  let reversals = 0, interiorTurns = 0;
  const half = Math.floor(D.smoothingWindow / 2);
  const degOf = (a, b, c) => {
    const ab = [b.east - a.east, b.north - a.north], bc = [c.east - b.east, c.north - b.north];
    const la = Math.hypot(...ab) || 1e-9, lb = Math.hypot(...bc) || 1e-9;
    return Math.acos(Math.max(-1, Math.min(1, (ab[0] * bc[0] + ab[1] * bc[1]) / (la * lb)))) * 180 / Math.PI;
  };
  for (const f of frags) {
    const n = f.points.length;
    for (let i = 1; i < n; i++) if (f.points[i].s < f.points[i - 1].s - 1e-6) reversals++;
    for (let i = 2; i < n; i++) {
      const span = Math.abs(f.points[i].s - f.points[i - 2].s);
      if (span < D.minDirectionSpanM) continue;
      if (i <= half + 1 || i >= n - half - 1) continue; // boundary zone
      if (degOf(f.points[i - 2], f.points[i - 1], f.points[i]) > D.maxDirectionChangeDeg) interiorTurns++;
    }
  }
  // gaps vs maxJoinGap
  let gapOver = 0;
  for (const f of frags) for (let i = 1; i < f.points.length; i++) if (Math.abs(f.points[i].s - f.points[i - 1].s) > D.maxJoinGapM) gapOver++;
  // smoothing shift cap
  const groups = CF.groupObservations(points);
  let shiftOver = 0, shiftMax = 0;
  for (const f of frags) {
    const raw = CF.orderAndDedupe(groups.get(f.groupKey));
    if (!raw) continue;
    const run = raw.filter((p) => p.s >= f.points[0].s - 1e-6 && p.s <= f.points[f.points.length - 1].s + 1e-6);
    if (run.length !== f.sourceObservations) continue;
    const sm = CF.smoothPoints(run, D);
    for (let i = 0; i < sm.length; i++) {
      const s = Math.hypot((sm[i].localEast ?? sm[i].east) - (run[i].localEast ?? run[i].east),
        (sm[i].localNorth ?? sm[i].north) - (run[i].localNorth ?? run[i].north));
      shiftMax = Math.max(shiftMax, s);
      if (s > D.maxSmoothShiftM + 1e-9) shiftOver++;
    }
  }

  // ---- segment-specific attention checks ----
  const attention = {};

  // Seg 99: spatial revisit and curves. Look for (a) revisit rejections
  // (temporalRevisit / spatialRevisit) and (b) curve handling: fragments must
  // not cross and interior turns must be 0 (curves split at apex, not zigzag).
  if (seg === '99') {
    attention.revisits = {
      temporalRevisit: (cf.rejectedConnections.filter((rc) => rc.reason === 'temporalRevisit')).length,
      spatialRevisit: (cf.rejectedConnections.filter((rc) => rc.reason === 'spatialRevisit')).length,
    };
    attention.curveHandling = {
      fragmentCount: frags.length,
      interiorSharpTurns: interiorTurns,
      crossingsBetweenBoundaries: crossings,
      maxLengthM: frags.length ? round(Math.max(...frags.map((f) => f.lengthM)), 1) : null,
      medianLengthM: frags.length ? round(median(frags.map((f) => f.lengthM)), 1) : null,
    };
  }

  // Seg 6: GPS discontinuity — sparse/few points; verify the layer degrades
  // gracefully (few fragments, no phantom bridging across discontinuity).
  if (seg === '6') {
    const sGaps = [];
    const sorted = [...points].sort((a, b) => a.s - b.s);
    for (let i = 1; i < sorted.length; i++) sGaps.push(sorted[i].s - sorted[i - 1].s);
    attention.discontinuity = {
      inputPoints: points.length,
      sGapMaxM: sGaps.length ? round(Math.max(...sGaps), 1) : null,
      fragmentCount: frags.length,
      gapOverMaxJoin: gapOver,
      // no fragment may span a gap > maxJoinGapM internally
      longFragments: frags.filter((f) => f.lengthM > D.maxJoinGapM * 3).length,
    };
  }

  // Seg 2: dense boundaries — many points, many boundaries; verify separation
  // is preserved (no crossing, no mixed boundary).
  if (seg === '2') {
    attention.dense = {
      inputPoints: points.length,
      boundaries: new Set(frags.map((f) => `${f.laneIndex}/${f.side}/track${f.groupTrackId}`)).size,
      fragmentCount: frags.length,
      mixedBoundaryFragments: mixed,
      crossingsBetweenBoundaries: crossings,
    };
  }

  // Seg 58: uneven track distribution — one track may dominate; verify no
  // fragment mixes tracks and the layer still separates all present tracks.
  if (seg === '58') {
    const perTrack = {};
    for (const f of frags) perTrack[f.groupTrackId] = (perTrack[f.groupTrackId] || 0) + 1;
    attention.uneven = {
      fragmentsPerTrack: perTrack,
      mixedBoundaryFragments: mixed,
      crossingsBetweenBoundaries: crossings,
    };
  }

  // Seg 54: multi-boundary general (4 boundaries)
  if (seg === '54') {
    attention.multi = {
      boundaries: new Set(frags.map((f) => `${f.laneIndex}/${f.side}/track${f.groupTrackId}`)).size,
      fragmentCount: frags.length,
      mixedBoundaryFragments: mixed,
      crossingsBetweenBoundaries: crossings,
    };
  }

  return {
    seg, file,
    inputPoints: points.length,
    usablePoints: points.filter((p) => (p.supportFrameCount ?? 1) >= D.minSupportCount).length,
    fragments: frags.length,
    rejectedConnections: cf.rejectedConnections.length,
    rejectedReasons: cf.rejectedConnections.reduce((a, rc) => { a[rc.reason] = (a[rc.reason] || 0) + 1; return a; }, {}),
    invariants: {
      mixedBoundaryFragments: mixed,
      crossingsBetweenBoundaries: crossings,
      sReversals: reversals,
      interiorSharpTurns: interiorTurns,
      internalGapOverMaxJoin: gapOver,
      smoothingShiftMaxM: round(shiftMax, 3),
      smoothingShiftOverCap: shiftOver,
      belowMinObservations: frags.filter((f) => f.sourceObservations < D.minObservations).length,
    },
    attention,
  };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const { seg, attention: label } of REGRESSION) {
    try {
      const r = run(seg);
      r.attentionLabel = label;
      results.push(r);
      console.log(`seg ${seg} (${label}) done`);
    } catch (e) {
      results.push({ seg, attentionLabel: label, error: e.message });
      console.log(`seg ${seg} ERROR ${e.message}`);
    }
  }
  const outPath = path.join(OUT, 'regression_2_6_54_58_99.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('\nREGRESSION SUMMARY (segments 2, 6, 54, 58, 99)');
  console.log('='.repeat(70));
  for (const r of results) {
    if (r.error) { console.log(`\nseg ${r.seg}: ERROR ${r.error}`); continue; }
    console.log(`\nseg ${r.seg} [${r.attentionLabel}]`);
    console.log(`  points=${r.inputPoints} usable=${r.usablePoints} frags=${r.fragments} rejected=${r.rejectedConnections}`);
    console.log(`  reasons: ${JSON.stringify(r.rejectedReasons)}`);
    console.log(`  invariants: mixed=${r.invariants.mixedBoundaryFragments} crossings=${r.invariants.crossingsBetweenBoundaries} sRev=${r.invariants.sReversals} interiorTurns=${r.invariants.interiorSharpTurns} gapOver=${r.invariants.internalGapOverMaxJoin} shiftMax=${r.invariants.smoothingShiftMaxM} shiftOver=${r.invariants.smoothingShiftOverCap} belowMin=${r.invariants.belowMinObservations}`);
    for (const [k, v] of Object.entries(r.attention)) console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
  console.log('\nWrote:', outPath);
}

main();
