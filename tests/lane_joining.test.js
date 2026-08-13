'use strict';

/**
 * Tests for the constructed lane-boundary fragment JOINING stage
 * (EXPERIMENTAL). Covers:
 *   1. hard prohibitions (chunk/pass/boundary/revisit/temporal/unsupported gap)
 *   2. candidate generation (same boundary, forward in s, bounded search)
 *   3. connection checks (tangent, lateral, curvature, temporal, evidence
 *      corridor, boundary separation)
 *   4. mutual-best selection, ambiguity margin, no branching
 *   5. joined geometry (source fragments preserved, connector, chaining)
 *   6. browser mirror + output wiring
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const LJ = require('../lib/lane_joining');
const SLM = require('../lib/segment_local_map');

const ROOT = path.join(__dirname, '..');
const SEG14 = path.join(ROOT, 'qlog_f449c_14.bz2');

/** Straight, well-supported boundary fragments with a small compatible gap. */
function mkFrag({ id, s0, s1, laneIndex = 0, track = 0, chunkId = 0, passId = 0, split = 'sharpDirectionChange' }) {
  const n = 8;
  const points = [];
  for (let i = 0; i < n; i++) {
    const s = s0 + (s1 - s0) * i / (n - 1);
    points.push({ east: s, north: -2 - 0.05 * i, s, d: -2 - 0.05 * i });
  }
  return {
    fragmentId: id, groupTrackId: String(track), laneIndex, chunkId, passId,
    side: 'right', points, sourceObservations: n, distinctFrames: 4,
    startLogMonoTime: String(s0 * 1000), endLogMonoTime: String(s1 * 1000),
    startFrameIndex: Math.round(s0 / 4), endFrameIndex: Math.round(s1 / 4),
    lengthM: +(s1 - s0).toFixed(2), maxInternalGapM: 0.5,
    medianResidualM: 0.05, maxResidualM: 0.1, medianProb: 0.9, splitReason: split,
  };
}

function mkPointsBetween(s0, s1, track = 0, support = 2) {
  const pts = [];
  for (let s = s0 + 1; s < s1; s += 1) {
    pts.push({
      s, d: -2, localEast: s, localNorth: -2, east: s, north: -2,
      laneIndex: 0, groupTrackId: track, chunkId: 0, passId: 0,
      frameIndex: Math.round(s / 4), logMonoTime: String(s * 1000), prob: 0.9,
      supportFrameCount: support,
    });
  }
  return pts;
}

describe('1-4. hard prohibitions and candidate generation', () => {
  it('1. never joins different chunks', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 10 });
    const B = mkFrag({ id: 'B', s0: 12, s1: 20, chunkId: 1 });
    const res = LJ.joinConstructedFragments([A, B], mkPointsBetween(10, 12));
    assert.strictEqual(res.stats.acceptedConnectionCount, 0);
  });

  it('2. never joins different passes', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 10 });
    const B = mkFrag({ id: 'B', s0: 12, s1: 20, passId: 1 });
    const res = LJ.joinConstructedFragments([A, B], mkPointsBetween(10, 12));
    assert.strictEqual(res.stats.acceptedConnectionCount, 0);
  });

  it('3. never joins different physical boundaries (L0 vs L1)', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 10, laneIndex: 0, track: 0 });
    const B = mkFrag({ id: 'B', s0: 12, s1: 20, laneIndex: 1, track: 1 });
    const res = LJ.joinConstructedFragments([A, B], mkPointsBetween(10, 12));
    assert.strictEqual(res.stats.acceptedConnectionCount, 0);
    // different-boundary pairs are excluded at candidate generation
    assert.strictEqual(res.stats.candidatePairCount, 0);
  });

  it('4. rejects spatial revisits (large backward temporal)', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 10, split: 'spatialRevisit' });
    const B = mkFrag({ id: 'B', s0: 12, s1: 20 });
    const res = LJ.joinConstructedFragments([A, B], mkPointsBetween(10, 12));
    assert.strictEqual(res.stats.acceptedConnectionCount, 0);
  });

  it('5. rejects unsupported large gaps (no corridor evidence)', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 10, split: 'largeSpatialGap' });
    const B = mkFrag({ id: 'B', s0: 25, s1: 35, split: 'largeSpatialGap' });
    // 15m gap, no points inside
    const res = LJ.joinConstructedFragments([A, B], []);
    assert.strictEqual(res.stats.acceptedConnectionCount, 0);
    assert.ok(res.stats.hardRejectedByReason.unsupported_gap >= 1 || res.stats.hardRejectedByReason.large_gap_insufficient_evidence >= 1);
  });

  it('6. candidate generation only considers forward-in-s same-boundary', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 10 });
    const B = mkFrag({ id: 'B', s0: 12, s1: 20 });
    const C = mkFrag({ id: 'C', s0: -8, s1: -2 }); // behind A in s
    const res = LJ.joinConstructedFragments([A, B, C], mkPointsBetween(10, 12));
    // A must not have C as a candidate (C is behind A); C may have A/B as forward targets
    const aTargets = res.candidates.filter((c) => c.from.fragmentId === 'A').map((c) => c.to.fragmentId);
    assert.deepStrictEqual(aTargets, ['B']);
    // no candidate points backward in s
    for (const c of res.candidates) {
      const f = [A, B, C].find((x) => x.fragmentId === c.from.fragmentId);
      const t = [A, B, C].find((x) => x.fragmentId === c.to.fragmentId);
      assert.ok(t.points[0].s > f.points[f.points.length - 1].s, `${c.from.fragmentId}->${c.to.fragmentId} not forward`);
    }
  });
});

describe('5-8. connection checks and scoring', () => {
  it('7. joins compatible fragments with directly supported corridor', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 10 });
    const B = mkFrag({ id: 'B', s0: 11.5, s1: 20 });
    const res = LJ.joinConstructedFragments([A, B], mkPointsBetween(10, 11.5));
    assert.strictEqual(res.stats.acceptedConnectionCount, 1);
    const conn = res.connections[0];
    assert.strictEqual(conn.fromFragmentId, 'A');
    assert.strictEqual(conn.toFragmentId, 'B');
    assert.strictEqual(conn.acceptanceReason, 'accepted');
    assert.ok(conn.candidateScore >= LJ.JOINING_DEFAULTS.minAcceptScore);
  });

  it('8. rejects a sharp tangent mismatch (kink)', () => {
    // B is perpendicular to A -> tangent incompatible
    const A = mkFrag({ id: 'A', s0: 0, s1: 10 });
    const B = mkFrag({ id: 'B', s0: 11, s1: 20 });
    // rotate B's points to be perpendicular
    for (const p of B.points) { const t = p.east; p.east = p.north; p.north = t; }
    const res = LJ.joinConstructedFragments([A, B], mkPointsBetween(10, 11));
    assert.strictEqual(res.stats.acceptedConnectionCount, 0);
    const reasons = res.stats.hardRejectedByReason;
    assert.ok(reasons.tangent_incompatible >= 1 || reasons.curvature_kink >= 1 || reasons.opposite_travel_direction >= 1);
  });

  it('9. scoring favours small gaps and strong support; ambiguity leaves A unjoined', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 10 });
    const Bnear = mkFrag({ id: 'B', s0: 10.8, s1: 18 });
    const Cfar = mkFrag({ id: 'C', s0: 20, s1: 28 });
    const res = LJ.joinConstructedFragments([A, Bnear, Cfar], mkPointsBetween(10, 20));
    // A has two similarly-plausible targets (B, C) -> ambiguous -> stays unjoined.
    // B's only forward candidate is C -> B->C is mutually best and unambiguous.
    const connBC = res.connections.find((c) => c.fromFragmentId === 'B' && c.toFragmentId === 'C');
    assert.ok(connBC, 'B->C accepted');
    const connAB = res.connections.find((c) => c.fromFragmentId === 'A' && c.toFragmentId === 'B');
    assert.ok(!connAB, 'A->B not accepted (ambiguous)');
    const connAC = res.connections.find((c) => c.fromFragmentId === 'A' && c.toFragmentId === 'C');
    assert.ok(!connAC, 'A->C not accepted (ambiguous)');
  });

  it('10. ambiguity leaves a fragment unjoined when margin is too small', () => {
    // A has two equally-plausible targets B and C
    const A = mkFrag({ id: 'A', s0: 0, s1: 10 });
    const B = mkFrag({ id: 'B', s0: 11, s1: 18 });
    const C = mkFrag({ id: 'C', s0: 11.2, s1: 18.2 });
    const res = LJ.joinConstructedFragments([A, B, C], mkPointsBetween(10, 11.4));
    assert.strictEqual(res.stats.acceptedConnectionCount, 0, 'ambiguous candidates stay unjoined');
    assert.ok(res.stats.ambiguousCount >= 1);
  });
});

describe('9-11. selection, chaining, joined geometry', () => {
  it('11. no branching: each fragment has at most one pred and one succ', () => {
    // Adjacent gaps are 1m; non-adjacent gaps are 41m (> 40m search radius),
    // so only the immediate successor is a candidate (unambiguous chaining).
    const frags = [0, 1, 2, 3, 4].map((i) => mkFrag({ id: `F${i}`, s0: i * 40 + 10, s1: i * 40 + 19 }));
    const pts = [0, 1, 2, 3].flatMap((i) => mkPointsBetween(i * 40 + 19, (i + 1) * 40 + 10));
    const res = LJ.joinConstructedFragments(frags, pts);
    const asSource = new Set(res.connections.map((c) => c.fromFragmentId));
    const asTarget = new Set(res.connections.map((c) => c.toFragmentId));
    // chained line F0->F1->F2->F3->F4
    assert.strictEqual(res.stats.acceptedConnectionCount, 4);
    assert.strictEqual(res.stats.joinedPolylineCount, 1);
    assert.deepStrictEqual(res.joinedPolylines[0].orderedSourceFragmentIds, ['F0', 'F1', 'F2', 'F3', 'F4']);
    // no fragment has more than one predecessor or successor
    assert.strictEqual(asSource.size, 4);
    assert.strictEqual(asTarget.size, 4);
  });

  it('12. source fragments are preserved byte-for-byte', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 10 });
    const B = mkFrag({ id: 'B', s0: 11.5, s1: 20 });
    const beforeA = JSON.stringify(A.points);
    const beforeB = JSON.stringify(B.points);
    LJ.joinConstructedFragments([A, B], mkPointsBetween(10, 11.5));
    assert.strictEqual(JSON.stringify(A.points), beforeA);
    assert.strictEqual(JSON.stringify(B.points), beforeB);
  });

  it('13. connector generated only across the accepted gap (no smoothing across joins)', () => {
    const frags = [0, 1, 2].map((i) => mkFrag({ id: `F${i}`, s0: i * 40 + 10, s1: i * 40 + 19 }));
    const pts = [0, 1].flatMap((i) => mkPointsBetween(i * 40 + 19, (i + 1) * 40 + 10));
    const res = LJ.joinConstructedFragments(frags, pts);
    const jp = res.joinedPolylines[0];
    assert.strictEqual(jp.connectorCount, 2);
    assert.strictEqual(jp.sourceFragmentCount, 3);
    // joined points = F0.points + connector + F1.points + connector + F2.points
    const expected = frags[0].points.length + frags[1].points.length + frags[2].points.length + 2 * (LJ.JOINING_DEFAULTS.connectorSegments - 1);
    assert.strictEqual(jp.joinedPoints.length, expected);
    assert.ok(jp.maxConnectorDeviationM <= LJ.JOINING_DEFAULTS.maxConnectorDeviationM);
  });

  it('14. real segment produces joined polylines with no boundary mixing', () => {
    if (!fs.existsSync(SEG14)) return;
    const { processRoute } = require('../lib/process_route');
    const { extractFromFile: extractModel } = require('../extract_modelv2');
    const { extractFromFile: extractGps } = require('../extract_gps');
    const me = extractModel(SEG14).map((e) => ({ ...e, sourceFile: SEG14 }));
    const ge = extractGps(SEG14).map((e) => ({ ...e, sourceFile: SEG14 }));
    const r = processRoute(me, ge, { pipelineMode: 'C' });
    const out = SLM.buildPointAccumulatedFragments(
      r.frames, r.frames.map((x, i) => ({ index: i, logMonoTime: x.logMonoTime })),
      { east: 0, north: 0, headingDeg: 0 }, 0, 0, r.routeChunks, {},
    );
    const cf = out.pointAccumulated.constructedFragments;
    const res = LJ.joinConstructedFragments(cf.fragments, out.pointAccumulated.points);
    assert.ok(res.stats.joinedPolylineCount > 0);
    assert.ok(res.stats.acceptedConnectionCount > 0);
    // no boundary mixing within any polyline
    for (const jp of res.joinedPolylines) {
      const keys = new Set(jp.orderedSourceFragmentIds.map((id) => {
        const f = cf.fragments.find((x) => x.fragmentId === id);
        return `${f.chunkId}:${f.passId}:${f.groupTrackId}:${f.laneIndex}`;
      }));
      assert.strictEqual(keys.size, 1, 'polyline mixes boundaries');
    }
    // no duplicate fragment references
    const refs = res.joinedPolylines.flatMap((j) => j.orderedSourceFragmentIds);
    assert.strictEqual(new Set(refs).size, refs.length);
  });
});

describe('15-16. browser mirror and wiring', () => {
  it('15. browser mirror loads and matches lib output', () => {
    const vm = require('node:vm');
    const ctx = { console, BigInt };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    for (const f of ['constructed_fragments.js', 'lane_joining.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx, { filename: f });
    }
    assert.ok(ctx.LaneJoining, 'LaneJoining loaded');
    const A = mkFrag({ id: 'A', s0: 0, s1: 10 });
    const B = mkFrag({ id: 'B', s0: 11.5, s1: 20 });
    const res = ctx.LaneJoining.joinConstructedFragments([A, B], mkPointsBetween(10, 11.5));
    assert.strictEqual(res.stats.acceptedConnectionCount, 1);
  });

  it('16. joined output exposes required fields', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 10 });
    const B = mkFrag({ id: 'B', s0: 11.5, s1: 20 });
    const res = LJ.joinConstructedFragments([A, B], mkPointsBetween(10, 11.5));
    const jp = res.joinedPolylines[0];
    for (const k of ['joinedPolylineId', 'orderedSourceFragmentIds', 'physicalBoundaryId', 'chunkId', 'passId', 'joinedPoints', 'connections', 'totalLengthM', 'sourceFragmentCount', 'connectorCount', 'maxConnectorGapM', 'medianConnectorDeviationM', 'maxConnectorDeviationM', 'confidence', 'unresolvedEndpointReasons']) {
      assert.ok(k in jp, `joined polyline missing ${k}`);
    }
    const conn = jp.connections[0];
    for (const k of ['fromFragmentId', 'toFragmentId', 'endpointDistanceM', 'tangentDiffDeg', 'lateralExtrapolationErrM', 'curvatureChangeDegPerM', 'temporalSepSec', 'supportClassification', 'candidateScore', 'secondBestScore', 'ambiguityMargin', 'acceptanceReason', 'rejectionReason']) {
      assert.ok(k in conn, `connection record missing ${k}`);
    }
  });
});

describe('17-24. joined-output component integrity', () => {
  it('17. every valid constructed fragment appears exactly once (singletons included)', () => {
    // A and C have no accepted connection; B connects to C -> one singleton + one multi
    const A = mkFrag({ id: 'A', s0: 0, s1: 9 });
    const B = mkFrag({ id: 'B', s0: 50, s1: 59 });
    const C = mkFrag({ id: 'C', s0: 61.5, s1: 70 });
    const pts = mkPointsBetween(59, 61.5);
    const res = LJ.joinConstructedFragments([A, B, C], pts);
    const refs = res.joinedPolylines.flatMap((j) => j.orderedSourceFragmentIds);
    assert.strictEqual(refs.length, 3, 'all three fragments represented');
    assert.strictEqual(new Set(refs).size, 3, 'no duplicates');
    const singles = res.joinedPolylines.filter((j) => j.connectorCount === 0);
    const multis = res.joinedPolylines.filter((j) => j.connectorCount > 0);
    assert.ok(singles.some((j) => j.orderedSourceFragmentIds.includes('A')), 'A is a singleton');
    assert.ok(multis.some((j) => j.orderedSourceFragmentIds.join(',') === 'B,C'), 'B-C is a multi polyline');
    assert.strictEqual(res.stats.unjoinedFragmentCount, 0);
  });

  it('18. a chain includes its complete first and last fragments', () => {
    const frags = [0, 1, 2, 3].map((i) => mkFrag({ id: `F${i}`, s0: i * 40 + 10, s1: i * 40 + 19 }));
    const pts = [0, 1, 2].flatMap((i) => mkPointsBetween(i * 40 + 19, (i + 1) * 40 + 10));
    const res = LJ.joinConstructedFragments(frags, pts);
    const jp = res.joinedPolylines[0];
    assert.deepStrictEqual(jp.orderedSourceFragmentIds, ['F0', 'F1', 'F2', 'F3']);
    // first fragment's first point and last fragment's last point preserved
    assert.strictEqual(jp.joinedPoints[0].east, frags[0].points[0].east);
    assert.strictEqual(jp.joinedPoints[jp.joinedPoints.length - 1].east, frags[3].points[frags[3].points.length - 1].east);
  });

  it('19. endpoint-extension points appear in joined geometry', () => {
    const pts = [];
    // low-support route-start run directly abuts the supported run (no gap)
    for (let i = 0; i < 10; i++) {
      const s = 2 + i * 4; // s = 2..38, support=1
      pts.push({ s, d: -3, localEast: s, localNorth: -3, east: s, north: -3, laneIndex: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 0, logMonoTime: '0', prob: 0.9, supportFrameCount: 1 });
    }
    // supported run starting right at s=42 (gap 4m from s=38)
    for (let i = 0; i < 10; i++) {
      const s = 42 + i * 4;
      for (let f = 0; f < 3; f++) {
        pts.push({ s: s + 0.05 * f, d: -3, localEast: s, localNorth: -3, east: s, north: -3, laneIndex: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: i + 5, logMonoTime: String((i + 5) * 1000), prob: 0.9, supportFrameCount: 3 });
      }
    }
    const cf = LJ_CF();
    const built = cf.buildConstructedFragments(pts);
    const res = LJ.joinConstructedFragments(built.fragments, pts);
    const firstFrag = built.fragments.sort((a, b) => a.points[0].s - b.points[0].s)[0];
    assert.ok(firstFrag.endpointExtended, 'first fragment extended');
    const jp = res.joinedPolylines.find((j) => j.orderedSourceFragmentIds.includes(firstFrag.fragmentId));
    assert.ok(jp, 'extended fragment represented');
    assert.ok(jp.joinedPoints[0].s < 6, `extension start present (first joined s=${jp.joinedPoints[0].s.toFixed(1)})`);
  });

  it('20. ambiguous/rejected connectors do not create edges but fragments stay visible', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 9 });
    const B = mkFrag({ id: 'B', s0: 10.8, s1: 18 });
    const C = mkFrag({ id: 'C', s0: 20, s1: 28 });
    const res = LJ.joinConstructedFragments([A, B, C], mkPointsBetween(10, 20));
    // A is ambiguous (two plausible targets) -> not connected, but still visible as singleton
    const refs = res.joinedPolylines.flatMap((j) => j.orderedSourceFragmentIds);
    assert.ok(refs.includes('A'), 'ambiguous A remains visible');
    assert.strictEqual(new Set(refs).size, 3, 'all fragments represented exactly once');
    // no edge from A (ambiguous) -> A is a singleton
    const aPoly = res.joinedPolylines.find((j) => j.orderedSourceFragmentIds.includes('A'));
    assert.strictEqual(aPoly.connectorCount, 0, 'A has no accepted connector');
  });

  it('21. source fragments remain unchanged (byte-identical points)', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 9 });
    const B = mkFrag({ id: 'B', s0: 50, s1: 59 });
    const C = mkFrag({ id: 'C', s0: 61.5, s1: 70 });
    const beforeA = JSON.stringify(A.points);
    const beforeC = JSON.stringify(C.points);
    LJ.joinConstructedFragments([A, B, C], mkPointsBetween(59, 61.5));
    assert.strictEqual(JSON.stringify(A.points), beforeA);
    assert.strictEqual(JSON.stringify(C.points), beforeC);
  });

  it('22. joined polyline carries groupTrackId for colour resolution', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 9 });
    const B = mkFrag({ id: 'B', s0: 11.5, s1: 20 });
    const res = LJ.joinConstructedFragments([A, B], mkPointsBetween(10, 11.5));
    assert.ok('groupTrackId' in res.joinedPolylines[0], 'joined polyline carries groupTrackId');
    assert.strictEqual(res.joinedPolylines[0].groupTrackId, '0');
  });

  it('23. singleton polyline contains the complete fragment geometry and zero connectors', () => {
    const A = mkFrag({ id: 'A', s0: 0, s1: 9 });
    const B = mkFrag({ id: 'B', s0: 50, s1: 59 });
    const res = LJ.joinConstructedFragments([A, B], []);
    const aPoly = res.joinedPolylines.find((j) => j.orderedSourceFragmentIds.includes('A'));
    assert.ok(aPoly, 'A represented');
    assert.strictEqual(aPoly.connectorCount, 0);
    assert.strictEqual(aPoly.joinedPoints.length, A.points.length, 'complete fragment geometry');
    assert.strictEqual(aPoly.sourceFragmentCount, 1);
  });

  it('24. real segment: every constructed fragment appears exactly once, endpoint extensions present', () => {
    if (!fs.existsSync(SEG14)) return;
    const { processRoute } = require('../lib/process_route');
    const { extractFromFile: extractModel } = require('../extract_modelv2');
    const { extractFromFile: extractGps } = require('../extract_gps');
    const me = extractModel(SEG14).map((e) => ({ ...e, sourceFile: SEG14 }));
    const ge = extractGps(SEG14).map((e) => ({ ...e, sourceFile: SEG14 }));
    const r = processRoute(me, ge, { pipelineMode: 'C' });
    const out = SLM.buildPointAccumulatedFragments(
      r.frames, r.frames.map((x, i) => ({ index: i, logMonoTime: x.logMonoTime })),
      { east: 0, north: 0, headingDeg: 0 }, 0, 0, r.routeChunks, {},
    );
    const cf = out.pointAccumulated.constructedFragments;
    const jp = out.pointAccumulated.joinedPolylines;
    const refs = jp.joinedPolylines.flatMap((j) => j.orderedSourceFragmentIds);
    assert.strictEqual(refs.length, cf.fragments.length, 'every fragment represented');
    assert.strictEqual(new Set(refs).size, cf.fragments.length, 'no duplicates');
    assert.strictEqual(jp.stats.unjoinedFragmentCount, 0);
    // first fragment of each boundary appears with endpoint-extension points
    for (const bk of ['0', '1', '2']) {
      const first = cf.fragments.filter((f) => String(f.groupTrackId) === bk).sort((a, b) => a.points[0].s - b.points[0].s)[0];
      const j = jp.joinedPolylines.find((x) => x.orderedSourceFragmentIds.includes(first.fragmentId));
      assert.ok(j, `first fragment of track${bk} represented`);
      assert.ok(j.joinedPoints[0].s <= first.points[0].s + 1e-6, `joined starts at/before fragment start (${j.joinedPoints[0].s.toFixed(2)})`);
    }
  });
});

function LJ_CF() {
  return require('../lib/constructed_fragments');
}
