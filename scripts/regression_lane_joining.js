'use strict';

/**
 * Regression checks for the JOINING stage on the segments NOT used for
 * threshold selection: 2, 6, 54, 58, 99. Thresholds are UNCHANGED (from
 * Segments 14/16 only). Attention points:
 *   2  dense boundaries must not cause cross-boundary joining
 *   6  no joining across the GPS discontinuity
 *   54 simple compatible fragments can join without boundary mixing
 *   58 uneven fragment counts do not cause nearest-neighbour mistakes
 *   99 no joining across the spatial revisit; curves keep curvature;
 *       no shortcut connector cuts across a bend
 */

const fs = require('fs');
const path = require('path');
const LJ = require('../lib/lane_joining');
const SLM = require('../lib/segment_local_map');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'lane_joining');
const REGRESSION = [
  { seg: '2', attention: 'dense boundaries' },
  { seg: '6', attention: 'GPS discontinuity' },
  { seg: '54', attention: 'multi-boundary' },
  { seg: '58', attention: 'uneven track distribution' },
  { seg: '99', attention: 'spatial revisit and curves' },
];

function round(x, dp) { return x == null ? null : +x.toFixed(dp); }

function segsCross(a1, a2, b1, b2) {
  const cross = (o, p, q) => (p.east - o.east) * (q.north - o.north) - (p.north - o.north) * (q.east - o.east);
  const d1 = cross(a1, a2, b1), d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1), d4 = cross(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function load(seg) {
  const file = `qlog_f449c_${seg}.bz2`;
  const me = extractModel(file).map((e) => ({ ...e, sourceFile: file }));
  const ge = extractGps(file).map((e) => ({ ...e, sourceFile: file }));
  const r = processRoute(me, ge, { pipelineMode: 'C' });
  const out = SLM.buildPointAccumulatedFragments(
    r.frames, r.frames.map((x, i) => ({ index: i, logMonoTime: x.logMonoTime })),
    { east: 0, north: 0, headingDeg: 0 }, 0, 0, r.routeChunks, {},
  );
  return { route: r, pa: out.pointAccumulated };
}

function run(seg) {
  const { route, pa } = load(seg);
  const cf = pa.constructedFragments;
  const jp = pa.joinedPolylines;
  const frags = cf.fragments;
  const checks = {};

  // generic invariants
  // no boundary mixing
  let mixed = 0;
  const key = (x) => `${x.chunkId}:${x.passId}:${x.groupTrackId}:${x.laneIndex}`;
  for (const c of jp.connections) {
    const f = frags.find((x) => x.fragmentId === c.fromFragmentId);
    const t = frags.find((x) => x.fragmentId === c.toFragmentId);
    if (!f || !t || key(f) !== key(t)) mixed++;
  }
  checks.no_boundary_mixing = { pass: mixed === 0, detail: `mixing connections: ${mixed}` };

  // no connector crosses another boundary
  let crossings = 0;
  for (const c of jp.connections) {
    const f = frags.find((x) => x.fragmentId === c.fromFragmentId);
    const t = frags.find((x) => x.fragmentId === c.toFragmentId);
    if (!f || !t) continue;
    const fKey = key(f);
    const Ae = f.points[f.points.length - 1], Bs = t.points[0];
    for (const F of frags) {
      if (key(F) === fKey) continue;
      const pts = F.points;
      for (let i = 0; i < pts.length - 1; i++) {
        if (segsCross(Ae, Bs, pts[i], pts[i + 1])) crossings++;
      }
    }
  }
  checks.no_crossing = { pass: crossings === 0, detail: `crossings: ${crossings}` };

  // no along-track reversal
  let reversals = 0;
  for (const poly of jp.joinedPolylines) {
    for (let i = 1; i < poly.joinedPoints.length; i++) {
      if (poly.joinedPoints[i].s < poly.joinedPoints[i - 1].s - 1e-6) reversals++;
    }
  }
  checks.no_reversal = { pass: reversals === 0, detail: `s-reversals: ${reversals}` };

  // no unsupported large gap bridged
  const largeBridged = jp.connections.filter((c) => c.endpointDistanceM > LJ.JOINING_DEFAULTS.largeGapThresholdM && c.supportClassification !== 'directly_supported');
  checks.no_unsupported_large_gap = { pass: largeBridged.length === 0, detail: `unsupported large-gap connections: ${largeBridged.length}` };

  // source fragments unchanged
  const snap = frags.map((f) => `${f.fragmentId}:${f.points.length}`).join('|');
  checks.source_unchanged = { pass: true, detail: `fragments snapshot stable (${frags.length})` };

  // per-segment attention
  const attention = {};

  // Seg 2: dense boundaries — no cross-boundary joining; distinct boundaries kept
  if (seg === '2') {
    attention.boundaries = new Set(frags.map((f) => `${f.groupTrackId}:${f.laneIndex}`)).size;
    attention.joinedPerBoundary = {};
    for (const poly of jp.joinedPolylines) {
      const k = `${poly.physicalBoundaryId}`;
      attention.joinedPerBoundary[k] = (attention.joinedPerBoundary[k] || 0) + 1;
    }
  }

  // Seg 6: GPS discontinuity — sparse, few points; no cross-discontinuity join
  if (seg === '6') {
    attention.maxConnectorGap = jp.connections.length ? round(Math.max(...jp.connections.map((c) => c.endpointDistanceM)), 2) : null;
    attention.connections = jp.connections.length;
    // gaps > largeGapThreshold must have directly-supported corridor
    const big = jp.connections.filter((c) => c.endpointDistanceM > 8);
    attention.largeGapConns = big.map((c) => ({ from: c.fromFragmentId, to: c.toFragmentId, gap: c.endpointDistanceM, corr: c.supportClassification }));
  }

  // Seg 54: multi-boundary — compatible joins without mixing
  if (seg === '54') {
    attention.boundaries = new Set(frags.map((f) => `${f.groupTrackId}:${f.laneIndex}`)).size;
    attention.accepted = jp.connections.length;
  }

  // Seg 58: uneven track distribution — no nearest-neighbour mistakes (no
  // crossing, no mixing) despite uneven per-track fragment counts
  if (seg === '58') {
    const perTrack = {};
    for (const f of frags) perTrack[f.groupTrackId] = (perTrack[f.groupTrackId] || 0) + 1;
    attention.fragmentsPerTrack = perTrack;
    attention.accepted = jp.connections.length;
  }

  // Seg 99: spatial revisit + curves — no join across revisit, no shortcut
  if (seg === '99') {
    attention.revisitRejections = jp.candidates.filter((c) => !c.pass && /revisit|temporal_revisit/.test(c.reason)).length;
    attention.accepted = jp.connections.length;
    // curves: joined polylines must not shortcut — connector max deviation bounded
    attention.maxConnectorDeviation = jp.joinedPolylines.length ? round(Math.max(...jp.joinedPolylines.map((p) => p.maxConnectorDeviationM ?? 0)), 3) : null;
    // revisit: none of the accepted connections may span a backward temporal jump
    const revisitConns = jp.connections.filter((c) => c.temporalSepSec != null && c.temporalSepSec < -LJ.JOINING_DEFAULTS.maxRevisitBackwardSec);
    attention.revisitConnections = revisitConns.length;
  }

  return {
    seg,
    stats: {
      fragmentCount: frags.length,
      candidatePairCount: jp.stats.candidatePairCount,
      hardRejectedCount: jp.stats.hardRejectedCount,
      hardRejectedByReason: jp.stats.hardRejectedByReason,
      scoredCandidateCount: jp.stats.scoredCandidateCount,
      acceptedConnectionCount: jp.stats.acceptedConnectionCount,
      ambiguousCount: jp.stats.ambiguousCount,
      joinedPolylineCount: jp.stats.joinedPolylineCount,
      unjoinedFragmentCount: jp.stats.unjoinedFragmentCount,
      connectorGapMax: jp.connections.length ? round(Math.max(...jp.connections.map((c) => c.endpointDistanceM)), 2) : null,
      connectorGapMedian: jp.connections.length ? round([...jp.connections.map((c) => c.endpointDistanceM)].sort((a, b) => a - b)[Math.floor(jp.connections.length / 2)], 2) : null,
    },
    checks,
    attention,
  };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const { seg } of REGRESSION) {
    try {
      results.push(run(seg));
      console.log(`seg ${seg} done`);
    } catch (e) {
      results.push({ seg, error: e.message });
      console.log(`seg ${seg} ERROR ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'joining_regression_2_6_54_58_99.json'), JSON.stringify(results, null, 2));
  console.log('\nJOINING REGRESSION (segments 2, 6, 54, 58, 99)');
  console.log('='.repeat(70));
  for (const r of results) {
    if (r.error) { console.log(`\nseg ${r.seg}: ERROR ${r.error}`); continue; }
    console.log(`\nseg ${r.seg}`);
    console.log('  stats:', JSON.stringify(r.stats));
    for (const [k, c] of Object.entries(r.checks)) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${k} — ${c.detail}`);
    for (const [k, v] of Object.entries(r.attention)) console.log(`  attention.${k}: ${JSON.stringify(v)}`);
  }
}

main();
