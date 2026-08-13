'use strict';

/**
 * Tests for the constructed lane-boundary fragments (EXPERIMENTAL, display-only
 * layer). Covers grouping by physical boundary, along-track ordering, dedup,
 * connection checks, splitting, smoothing, residual reporting, and browser
 * mirror wiring.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const CF = require('../lib/constructed_fragments');
const SLM = require('../lib/segment_local_map');

const ROOT = path.join(__dirname, '..');
const SEG14 = path.join(ROOT, 'qlog_f449c_14.bz2');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const INDEX_HTML = path.join(ROOT, 'public/index.html');

/** Build a straight, well-supported boundary observation set (lane 1). */
function mkPts({ n = 30, laneIndex = 1, track = 0, gap = 4, d = -2.0, chunkId = 0, passId = 0 } = {}) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const s = i * gap + 2;
    for (let f = 0; f < 3; f++) {
      pts.push({
        s: s + 0.05 * f,
        d,
        localEast: s,
        localNorth: d,
        east: s + 100,
        north: d - 100,
        laneIndex,
        laneTrackId: track,
        groupTrackId: track,
        chunkId,
        passId,
        frameIndex: i,
        logMonoTime: String(i * 1000 + f),
        prob: 0.9, supportFrameCount: 2,
        supportFrameCount: 3,
      });
    }
  }
  return pts;
}

describe('1-4. grouping, ordering, dedup, connection', () => {
  it('1. groups observations by physical boundary (chunk/pass/track)', () => {
    const pts = [
      ...mkPts({ track: 0, laneIndex: 1 }),
      ...mkPts({ track: 1, laneIndex: 2 }),
      ...mkPts({ track: 0, laneIndex: 1, chunkId: 1 }),
    ];
    const groups = CF.groupObservations(pts);
    assert.strictEqual(groups.size, 3);
  });

  it('2. orders observations by along-track s, not east/north', () => {
    const pts = [
      { s: 30, d: -2, localEast: 30, localNorth: -2, chunkId: 0, passId: 0, groupTrackId: 0, frameIndex: 1, logMonoTime: '1000', prob: 0.9, supportFrameCount: 2 },
      { s: 5, d: -2, localEast: 5, localNorth: -2, chunkId: 0, passId: 0, groupTrackId: 0, frameIndex: 0, logMonoTime: '0', prob: 0.9, supportFrameCount: 2 },
      { s: 18, d: -2, localEast: 18, localNorth: -2, chunkId: 0, passId: 0, groupTrackId: 0, frameIndex: 2, logMonoTime: '2000', prob: 0.9, supportFrameCount: 2 },
    ];
    const ordered = CF.orderAndDedupe(pts);
    assert.deepStrictEqual(ordered.map((p) => p.s), [5, 18, 30]);
  });

  it('3. deduplicates near-identical overlapping observations', () => {
    const pts = [
      { s: 5, d: -2, localEast: 5, localNorth: -2, chunkId: 0, passId: 0, groupTrackId: 0, frameIndex: 0, logMonoTime: '0', prob: 0.5, supportFrameCount: 2 },
      { s: 5.1, d: -2.05, localEast: 5.1, localNorth: -2.05, chunkId: 0, passId: 0, groupTrackId: 0, frameIndex: 0, logMonoTime: '1', prob: 0.95, supportFrameCount: 2 },
      { s: 6, d: -2, localEast: 6, localNorth: -2, chunkId: 0, passId: 0, groupTrackId: 0, frameIndex: 1, logMonoTime: '1000', prob: 0.9, supportFrameCount: 2 },
    ];
    const ordered = CF.orderAndDedupe(pts, { dedupRadiusM: 0.6 });
    assert.strictEqual(ordered.length, 2);
    // higher-confidence duplicate survives
    assert.strictEqual(ordered[0].prob, 0.95);
  });

  it('3b. requires repeated-frame support (dots unaffected, fragments gated)', () => {
    const pts = mkPts({ n: 10 });
    // sprinkle single-observation outliers (huge d, low support)
    pts.push({ s: 3, d: 15, localEast: 3, localNorth: 15, laneIndex: 1, laneTrackId: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 0, logMonoTime: '1', prob: 0.9, supportFrameCount: 1 });
    pts.push({ s: 7, d: -15, localEast: 7, localNorth: -15, laneIndex: 1, laneTrackId: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 0, logMonoTime: '2', prob: 0.9, supportFrameCount: 1 });
    const res = CF.buildConstructedFragments(pts, { minSupportCount: 2 });
    // outliers excluded -> single clean fragment
    assert.strictEqual(res.fragments.length, 1);
    assert.ok(res.fragments[0].points.every((p) => Math.abs(p.d) < 10));
  });

  it('4. connects points that pass all checks into one fragment', () => {
    const pts = mkPts();
    const res = CF.buildConstructedFragments(pts);
    assert.strictEqual(res.groups, 1);
    assert.strictEqual(res.fragments.length, 1);
    const frag = res.fragments[0];
    assert.strictEqual(frag.points.length, 30);
    assert.ok(frag.lengthM > 100);
    assert.strictEqual(frag.laneIndex, 1);
    assert.strictEqual(frag.chunkId, 0);
    assert.strictEqual(frag.passId, 0);
  });
});

describe('5-9. splitting behaviour', () => {
  it('5. never connects different chunks', () => {
    const pts = [
      ...mkPts({ n: 10, chunkId: 0 }),
      ...mkPts({ n: 10, chunkId: 1, gap: 4 }),
    ];
    const res = CF.buildConstructedFragments(pts);
    assert.strictEqual(res.fragments.length, 2);
  });

  it('6. splits on a large along-track spatial gap', () => {
    const pts = mkPts({ n: 8 }); // s = 2..30 (gap 4)
    // far-away continuation (gap ~50m >> maxJoinGapM=12)
    for (let i = 0; i < 5; i++) {
      pts.push({ s: 80 + i * 4, d: -2, localEast: 80 + i * 4, localNorth: -2, laneIndex: 1, laneTrackId: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 40 + i, logMonoTime: String((40 + i) * 1000), prob: 0.9, supportFrameCount: 2 });
    }
    const res = CF.buildConstructedFragments(pts, { maxJoinGapM: 12 });
    assert.strictEqual(res.fragments.length, 2);
  });

  it('7. splits on a large lateral jump', () => {
    const pts = mkPts({ n: 6 }); // s = 2..22
    // continue near same s, then a huge lateral jump
    pts.push({ s: 30, d: -2, localEast: 30, localNorth: -2, laneIndex: 1, laneTrackId: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 30, logMonoTime: '30000', prob: 0.9, supportFrameCount: 2 });
    for (let i = 0; i < 5; i++) {
      pts.push({ s: 34 + i * 4, d: 4, localEast: 34 + i * 4, localNorth: 4, laneIndex: 1, laneTrackId: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 31 + i, logMonoTime: String((31 + i) * 1000), prob: 0.9, supportFrameCount: 2 });
    }
    const res = CF.buildConstructedFragments(pts, { maxLateralStepM: 2 });
    assert.ok(res.fragments.length >= 2, `expected >=2 fragments, got ${res.fragments.length}`);
    assert.ok(res.rejectedConnections.some((r) => r.reason === 'lateralJump'));
  });

  it('8. splits on temporal coverage holes (forward gap)', () => {
    const pts = mkPts({ n: 6 }); // s = 2..22, logMonoTime ~ 0..6000 µs
    // spatially adjacent but temporally far away (> maxTimeGapSec)
    for (let i = 0; i < 5; i++) {
      pts.push({ s: 26 + i * 4, d: -2, localEast: 26 + i * 4, localNorth: -2, laneIndex: 1, laneTrackId: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 100 + i, logMonoTime: String(800000000000 + (100 + i) * 1000), prob: 0.9, supportFrameCount: 2 });
    }
    const res = CF.buildConstructedFragments(pts, { maxTimeGapSec: 6 });
    assert.strictEqual(res.fragments.length, 2);
    assert.ok(res.rejectedConnections.some((r) => r.reason === 'temporalGap'));
  });

  it('9. tolerates overlapping-frame backward interleave (not a revisit)', () => {
    // points that go slightly backward in time while ascending in s
    const pts = [];
    for (let i = 0; i < 20; i++) {
      pts.push({ s: i * 3 + (i % 2) * 1.5, d: -2, localEast: i * 3 + (i % 2) * 1.5, localNorth: -2, laneIndex: 1, laneTrackId: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: i, logMonoTime: String((i * 2 + (i % 2) * 2) * 1000), prob: 0.9, supportFrameCount: 2 });
    }
    const res = CF.buildConstructedFragments(pts, { maxRevisitTimeSec: 8 });
    assert.strictEqual(res.fragments.length, 1);
  });
});

describe('10-13. smoothing, residuals, reliability, metadata', () => {
  it('10. smoothing keeps endpoints and caps shift', () => {
    const run = [];
    for (let i = 0; i < 10; i++) {
      run.push({ localEast: i, localNorth: i % 3, east: i, north: i % 3, s: i, d: 0, prob: 0.9, supportFrameCount: 2, frameIndex: i, logMonoTime: String(i * 1000) });
    }
    const out = CF.smoothPoints(run, { smoothingWindow: 5, maxSmoothShiftM: 0.5 });
    // endpoints unchanged
    assert.deepStrictEqual([out[0].localEast, out[0].localNorth], [0, 0]);
    assert.deepStrictEqual([out[9].localEast, out[9].localNorth], [9, 0]);
    // interior point moved by at most maxSmoothShiftM
    const shift = Math.hypot(out[4].localEast - run[4].localEast, out[4].localNorth - run[4].localNorth);
    assert.ok(shift <= 0.5 + 1e-9);
  });

  it('11. records median/max residual and distinct frames', () => {
    const pts = mkPts();
    const res = CF.buildConstructedFragments(pts);
    const frag = res.fragments[0];
    assert.ok(frag.medianResidualM != null && frag.medianResidualM >= 0);
    assert.ok(frag.maxResidualM != null && frag.maxResidualM >= frag.medianResidualM);
    assert.ok(frag.distinctFrames >= 3);
    assert.ok(frag.sourceObservations >= 30);
    assert.ok(frag.medianProb != null && frag.medianProb >= 0.9 - 1e-9);
    assert.ok(frag.startLogMonoTime && frag.endLogMonoTime);
    assert.strictEqual(frag.splitReason, 'endOfGroup');
  });

  it('12. point observations are never modified', () => {
    const pts = mkPts();
    const before = pts.map((p) => `${p.s},${p.d},${p.localEast},${p.localNorth}`).join('|');
    CF.buildConstructedFragments(pts);
    const after = pts.map((p) => `${p.s},${p.d},${p.localEast},${p.localNorth}`).join('|');
    assert.strictEqual(after, before);
  });

  it('13. fragment points use the segment-local frame (matching the dots)', () => {
    const pts = mkPts();
    const res = CF.buildConstructedFragments(pts);
    const frag = res.fragments[0];
    // mkPts sets localEast==s, and east==s+100; the fragment must use localEast
    assert.ok(frag.points[0].east < 50, 'expected local-frame east');
    assert.strictEqual(frag.points[0].east, frag.points[0].s);
  });
});

describe('14-16. wiring and real-segment smoke test', () => {
  it('14. real segment produces fragments with low residual and no modification', () => {
    if (!fs.existsSync(SEG14)) return;
    const { processRoute } = require('../lib/process_route');
    const { extractFromFile: extractModel } = require('../extract_modelv2');
    const { extractFromFile: extractGps } = require('../extract_gps');
    const me = extractModel(SEG14).map((e) => ({ ...e, sourceFile: SEG14 }));
    const ge = extractGps(SEG14).map((e) => ({ ...e, sourceFile: SEG14 }));
    const r = processRoute(me, ge, { pipelineMode: 'C' });
    const out = SLM.buildPointAccumulatedFragments(
      r.frames,
      r.frames.map((x, i) => ({ index: i, logMonoTime: x.logMonoTime })),
      { east: 0, north: 0, headingDeg: 0 }, 0, 0, r.routeChunks, {},
    );
    const cf = out.pointAccumulated.constructedFragments;
    assert.ok(cf && cf.fragments.length > 0, 'fragments built');
    assert.ok(cf.groups >= 2, 'multiple physical boundaries');
    const resid = cf.fragments.map((f) => f.medianResidualM).filter((x) => x != null);
    assert.ok(resid.length > 0);
    // median fragment residual stays small (smoothing cap ~0.8m)
    const med = [...resid].sort((a, b) => a - b)[Math.floor(resid.length / 2)];
    assert.ok(med <= 0.8, `median residual ${med}`);
  });

  it('15. browser mirror loads and matches lib output', () => {
    const dir = path.join(ROOT, 'public');
    const files = ['point_accumulation.js', 'mapping_reliability.js', 'experimental_boundaries.js', 'constructed_fragments.js', 'playback_arrow_screen.js', 'local_playback.js', 'segment_local_map.js'];
    for (const f of files) assert.ok(fs.existsSync(path.join(dir, f)), `${f} missing`);
    // load in browser order
    const vm = require('node:vm');
    const ctx = { console, BigInt, URLSearchParams, setTimeout, clearTimeout };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      vm.runInNewContext(src, ctx, { filename: f });
    }
    assert.ok(ctx.SegmentLocalMap, 'SegmentLocalMap loaded in browser mirror');
    assert.ok(ctx.ConstructedFragments, 'ConstructedFragments loaded in browser mirror');
    const { buildConstructedFragments } = ctx.ConstructedFragments;
    const pts = mkPts({ n: 20 });
    const res = buildConstructedFragments(pts);
    assert.strictEqual(res.fragments.length, 1);
  });

  it('16. renderer exposes the constructed-fragments draw path', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /_drawConstructedFragments/);
    assert.match(src, /this\.layers\.constructedFragments/);
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /layerConstructedFragments/);
    assert.match(html, /constructed_fragments\.js/);
  });
});

describe('17-22. one-sided endpoint extension', () => {
  /** Build a boundary with a clean supported run plus a low-support route-start run. */
  function mkEndpointPts() {
    // supported interior run s=50..90
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const s = 50 + i * 4;
      for (let f = 0; f < 3; f++) {
        pts.push({
          s: s + 0.05 * f, d: -3, localEast: s, localNorth: -3, east: s, north: -3,
          laneIndex: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: i + 5,
          logMonoTime: String((i + 5) * 1000), prob: 0.9, supportFrameCount: 3,
        });
      }
    }
    // low-support route-start run s=2..40 (single frame, support=1, clean monotonic)
    for (let i = 0; i < 10; i++) {
      const s = 2 + i * 4;
      pts.push({
        s, d: -3, localEast: s, localNorth: -3, east: s, north: -3,
        laneIndex: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 0,
        logMonoTime: String(0 * 1000), prob: 0.9, supportFrameCount: 1,
      });
    }
    return pts;
  }

  it('17. recovers a clean low-support route-start run into the first fragment', () => {
    const pts = mkEndpointPts();
    const res = CF.buildConstructedFragments(pts);
    const first = res.fragments[0];
    assert.ok(first.endpointExtended, 'first fragment extended');
    assert.ok(first.points[0].s < 6, `first point extended to s=${first.points[0].s.toFixed(1)}`);
    // extended points follow exact dots (no extrapolation)
    for (const p of first.points.slice(0, first.endpointExtendedCount)) {
      assert.ok(pts.some((q) => Math.abs(q.s - p.s) < 1e-6 && Math.abs(q.d - p.d) < 1e-6), 'extended point has exact source dot');
    }
  });

  it('18. extension requires several consecutive observations', () => {
    const pts = mkEndpointPts();
    // only 2 low-support points at the start (below minEndpointExtensionObs=3)
    const sparse = pts.filter((p) => p.s >= 50); // drop the start run
    for (let i = 0; i < 2; i++) {
      const s = 2 + i * 4;
      sparse.push({
        s, d: -3, localEast: s, localNorth: -3, east: s, north: -3,
        laneIndex: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 0,
        logMonoTime: '0', prob: 0.9, supportFrameCount: 1,
      });
    }
    const res = CF.buildConstructedFragments(sparse);
    const first = res.fragments[0];
    assert.ok(!first.endpointExtended || (first.endpointExtendedCount || 0) < 3, 'sparse endpoint run not extended');
  });

  it('19. does not extend across a large gap (no bridging)', () => {
    const pts = mkEndpointPts();
    // remove the low-support points between s=18 and s=50 so the start run is
    // separated from the fragment by a big gap
    const gapped = pts.filter((p) => !(p.s >= 18 && p.s < 50));
    const res = CF.buildConstructedFragments(gapped);
    const first = res.fragments[0];
    // extension may still reach s~14 but must not bridge across the 18-50 gap
    assert.ok(first.points[0].s >= 14 || !first.endpointExtended, 'did not bridge the gap');
  });

  it('20. does not extend into a laterally-oscillating tail', () => {
    // supported run s=50..86, then a spatial gap, then an oscillating tail that
    // must NOT be bridged by endpoint extension.
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const s = 50 + i * 4;
      for (let f = 0; f < 3; f++) {
        pts.push({
          s: s + 0.05 * f, d: -3, localEast: s, localNorth: -3, east: s, north: -3,
          laneIndex: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: i + 5,
          logMonoTime: String((i + 5) * 1000), prob: 0.9, supportFrameCount: 3,
        });
      }
    }
    // oscillating tail AFTER a 40m gap (s=130..154) — bridge would be wrong
    for (let i = 0; i < 8; i++) {
      const s = 130 + i * 4;
      const d = i % 2 === 0 ? -3.0 : -1.2;
      pts.push({
        s, d, localEast: s, localNorth: d, east: s, north: d,
        laneIndex: 0, groupTrackId: 0, chunkId: 0, passId: 0, frameIndex: 20 + i,
        logMonoTime: String((20 + i) * 1000), prob: 0.9, supportFrameCount: 2,
      });
    }
    const res = CF.buildConstructedFragments(pts);
    // the last fragment must not be extended across the 40m gap
    const last = res.fragments[res.fragments.length - 1];
    assert.ok(!last.endpointExtended || last.points[last.points.length - 1].s < 130,
      'end not extended across the gap into the oscillating tail');
  });

  it('21. real segment start coverage recovered; end tail stays conservative', () => {
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
    const first = cf.fragments.filter((x) => String(x.groupTrackId) === '0').sort((a, b) => a.points[0].s - b.points[0].s)[0];
    assert.ok(first.endpointExtended, 'seg14 L0 first fragment extended');
    assert.ok(first.points[0].s < 5, `start coverage recovered (first s=${first.points[0].s.toFixed(2)})`);
    // all fragments monotonic (no reversal introduced by extension)
    for (const f of cf.fragments) {
      for (let i = 1; i < f.points.length; i++) {
        assert.ok(f.points[i].s >= f.points[i - 1].s - 1e-6, 'no along-track reversal');
      }
    }
    // mirror pairing preserved on extended points
    const ep = first.points[0];
    assert.ok(ep.mirroredEast != null && ep.mirroredNorth != null, 'extended point carries mirrored coords');
  });

  it('22. browser mirror applies endpoint extension end-to-end', () => {
    const vm = require('node:vm');
    const ctx = { console, BigInt };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    for (const f of ['constructed_fragments.js', 'lane_joining.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx, { filename: f });
    }
    const pts = mkEndpointPts();
    const res = ctx.ConstructedFragments.buildConstructedFragments(pts);
    assert.ok(res.fragments[0].endpointExtended, 'browser mirror extends start');
    assert.ok(res.fragments[0].points[0].s < 6);
  });
});
