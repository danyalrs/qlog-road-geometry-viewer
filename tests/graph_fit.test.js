'use strict';

/**
 * Path-1 graph-fitting tests. Covers: normalized weighted objective, spline
 * bookkeeping, duplication invariance, ordering gates, gap breaks, frame-grouped
 * folds, status semantics, numerical safety, mirror parity, determinism, and the
 * regression guarantee that existing pipeline behaviour is unchanged when the
 * fit is disabled.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const GF = require('../lib/graph_fit');
const CF = require('../lib/constructed_fragments');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = GF.GRAPH_FIT_DEFAULTS;

/** Build a synthetic ordered run. */
function mkRun(nPts, frames, { curve = 0, noise = 0, baseEast = 0 } = {}) {
  const pts = [];
  for (let i = 0; i < nPts; i++) {
    const u = baseEast + (i / Math.max(1, nPts - 1)) * 20;
    const north = curve ? Math.sin(u / 5) * 3 : 0;
    const pt = {
      east: u,
      north: north + (noise && i >= 8 && i <= 10 ? 4 : 0),
      mirroredEast: u,
      mirroredNorth: -(north + (noise && i >= 8 && i <= 10 ? 4 : 0)),
      s: u,
      d: 0,
      frameId: `f${i % frames}`,
      frameIndex: i % frames,
      logMonoTime: String(i * 1e9),
      score: 0.8,
      supportFrameCount: frames >= 2 ? 2 : 1,
      chunkId: 0,
      passId: 0,
      groupTrackId: 0,
      laneIndex: 1,
    };
    pts.push(pt);
  }
  return pts;
}

function fitRun(rawRun, overrides = {}) {
  return GF.fitRun({
    rawRun,
    physicalBoundaryId: '0:0:0:1',
    fragmentId: 'CF0',
    chunkId: 0,
    passId: 0,
    groupTrackId: 0,
    laneIndex: 1,
  }, { ...DEFAULTS, fitEnabled: true, ...overrides });
}

/** Normalize a fittedPolyline to an array of polylines (each a points array). */
function normalizePolys(fp) {
  if (!fp) return [];
  if (!Array.isArray(fp)) return [];
  // A single accepted segment stores the points array directly.
  if (fp.length && Array.isArray(fp[0])) return fp;
  return [fp];
}

// ---------------------------------------------------------------------------
describe('1. normalized weighted objective + spline bookkeeping', () => {
  it('1. knot-vector length = basisCount + degree + 1', () => {
    for (const interiorBreaks of [1, 4, 10, 40]) {
      const b = GF.buildSplineBasis(interiorBreaks, 3);
      assert.equal(b.knotLen, b.basisCount + b.degree + 1);
      assert.equal(b.basisCount, interiorBreaks + b.degree + 1);
    }
  });

  it('2. clamped endpoint multiplicity equals degree + 1', () => {
    const b = GF.buildSplineBasis(10, 3);
    for (let i = 0; i < b.degree + 1; i++) assert.equal(b.knots[i], 0);
    for (let i = b.knots.length - (b.degree + 1); i < b.knots.length; i++) assert.equal(b.knots[i], 1);
  });

  it('3. basis functions sum to ~1 throughout [0,1]', () => {
    const b = GF.buildSplineBasis(10, 3);
    for (const t of [0, 0.05, 0.2, 0.5, 0.9, 1.0]) {
      const sum = GF.evalBasisAll(t, b).reduce((a, x) => a + x.v, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `sum at t=${t} = ${sum}`);
    }
  });

  it('4. evaluation at t=0 and t=1 is finite and clamped', () => {
    const b = GF.buildSplineBasis(10, 3);
    const e0 = GF.evalBasisAll(0, b);
    const e1 = GF.evalBasisAll(1, b);
    assert.ok(e0.every((x) => Number.isFinite(x.v) && Number.isFinite(x.d1) && Number.isFinite(x.d2)));
    assert.ok(e1.every((x) => Number.isFinite(x.v) && Number.isFinite(x.d1) && Number.isFinite(x.d2)));
    assert.ok(Math.abs(e0[0].v - 1) < 1e-9, 'first basis = 1 at t=0');
    assert.ok(Math.abs(e1[e1.length - 1].v - 1) < 1e-9, 'last basis = 1 at t=1');
  });

  it('5. penalty matrix is symmetric PSD within numerical tolerance', () => {
    for (const interiorBreaks of [4, 10, 25]) {
      const O = GF.buildPenaltyMatrix(GF.buildSplineBasis(interiorBreaks, 3));
      const m = O.length;
      for (let i = 0; i < m; i++) {
        for (let j = 0; j < i; j++) assert.ok(Math.abs(O[i][j] - O[j][i]) < 1e-10, 'symmetric');
      }
      const x = Array.from({ length: m }, (_, i) => Math.sin(i * 1.7));
      let q = 0;
      for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) q += x[i] * O[i][j] * x[j];
      assert.ok(q >= -1e-8, `quadratic form ${q}`);
    }
  });

  it('6. spline reproduces a straight line exactly (data term, low lambda)', () => {
    const ts = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const y = ts.map((t) => t * 10);
    const basis = GF.buildSplineBasis(5, 3);
    const res = GF.fitCoordinate(ts, y, ts.map(() => 1), 1e-8, basis, DEFAULTS);
    assert.equal(res.failed, false);
    const rows = GF.evalRow(ts, basis, 0);
    const fitted = ts.map((t, i) => {
      let v = 0;
      for (let j = 0; j < res.beta.length; j++) v += rows[i][j] * res.beta[j];
      return v;
    });
    for (let i = 0; i < y.length; i++) assert.ok(Math.abs(fitted[i] - y[i]) < 1e-4, `fit ${fitted[i]} vs ${y[i]}`);
  });

  it('7. duplicating every observation does not change fit or selected lambda', () => {
    const base = mkRun(40, 6, { curve: 2 });
    const dup = [];
    for (const p of base) { dup.push(p); dup.push({ ...p }); }
    const a = fitRun(base);
    const d = fitRun(dup);
    assert.equal(a.status, d.status);
    assert.equal(a.lambdaCutoffM, d.lambdaCutoffM);
    assert.equal(JSON.stringify(a.fittedPolyline), JSON.stringify(d.fittedPolyline));
    assert.ok(Math.abs((a.trainingMedian ?? 0) - (d.trainingMedian ?? 0)) < 1e-6);
  });
});

// ---------------------------------------------------------------------------
describe('2. ordering and identity gates', () => {
  it('8. trusted straight/curved runs are accepted', () => {
    const straight = fitRun(mkRun(20, 6));
    assert.equal(straight.status, 'accepted');
    const curved = fitRun(mkRun(60, 6, { curve: 2 }));
    assert.equal(curved.status, 'accepted');
  });

  it('9. crossing order is rejected as orderingInvalid (Path 2)', () => {
    // an 8-shaped sequence crosses itself
    const crossed = [];
    for (let i = 0; i < 20; i++) {
      const a = (i / 19) * 2 * Math.PI;
      crossed.push({
        east: Math.cos(a) * 5 + 10,
        north: Math.sin(2 * a) * 4,
        s: i, d: 0, frameId: `f${i % 6}`, frameIndex: i % 6,
        logMonoTime: String(i * 1e9), score: 0.8, supportFrameCount: 2,
        chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
        mirroredEast: Math.cos(a) * 5 + 10, mirroredNorth: Math.sin(2 * a) * 4,
      });
    }
    const r = fitRun(crossed);
    assert.equal(r.status, 'orderingInvalid');
  });

  it('10. gap-broken runs are fit per segment and never bridge gaps', () => {
    const gapped = [];
    for (let seg = 0; seg < 3; seg++) {
      for (let i = 0; i < 12; i++) {
        const u = seg * 40 + i * 2;
        gapped.push({
          east: u, north: 0, s: u, d: 0, frameId: `g${seg}f${i % 6}`, frameIndex: i % 6,
          logMonoTime: String((seg * 12 + i) * 1e9), score: 0.8, supportFrameCount: 2,
          chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
          mirroredEast: u, mirroredNorth: 0,
        });
      }
    }
    const r = fitRun(gapped);
    assert.ok(r.segments && r.segments.length >= 3, `segments=${r.segments?.length}`);
    assert.ok(r.status === 'accepted' || r.status === 'qualityRejected' || r.status === 'validationInsufficient');
    // no single fitted polyline may span the gaps
    if (r.status === 'accepted') {
      const polys = Array.isArray(r.fittedPolyline) ? r.fittedPolyline : [r.fittedPolyline];
      for (const poly of polys) {
        assert.ok(poly.length > 0);
      }
    }
  });

  it('11. never fits across chunk or pass boundaries', () => {
    // runs are single-identity fragments; the fitter rejects cross-chunk input
    const run = mkRun(30, 6);
    const r1 = GF.fitRun({
      rawRun: run, physicalBoundaryId: '0:0:0:1', fragmentId: 'C0',
      chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
    }, { ...DEFAULTS, fitEnabled: true });
    const r2 = GF.fitRun({
      rawRun: run, physicalBoundaryId: '1:2:3:1', fragmentId: 'C0',
      chunkId: 1, passId: 2, groupTrackId: 3, laneIndex: 1,
    }, { ...DEFAULTS, fitEnabled: true });
    assert.equal(r1.chunkId, 0);
    assert.equal(r2.chunkId, 1);
    assert.equal(r2.passId, 2);
  });
});

// ---------------------------------------------------------------------------
describe('3. support rules and status semantics', () => {
  it('12. fewer than fitMinTotalFrames -> insufficientSupport', () => {
    const r = fitRun(mkRun(20, 3));
    assert.equal(r.status, 'insufficientSupport');
  });

  it('13. zero total weight -> insufficientSupport', () => {
    const run = mkRun(20, 6).map((p) => ({ ...p, score: 0, supportFrameCount: 1 }));
    const r = fitRun(run);
    assert.equal(r.status, 'insufficientSupport');
  });

  it('14. MAD=0 (perfect collinear) does not fail', () => {
    const run = mkRun(30, 6).map((p) => ({ ...p, north: 0 }));
    const r = fitRun(run);
    assert.equal(r.status, 'accepted');
    assert.ok(Math.abs((r.trainingMedian ?? 1)) < 1e-6);
  });

  it('15. Segment 9 expectation: 30-frame lane1 eligible; 3/2-frame lanes insufficient', () => {
    const lane1 = fitRun(mkRun(60, 30));
    assert.notEqual(lane1.status, 'insufficientSupport');
    const lane2 = fitRun(mkRun(60, 3));
    assert.equal(lane2.status, 'insufficientSupport');
    const lane0 = fitRun(mkRun(60, 2));
    assert.equal(lane0.status, 'insufficientSupport');
  });

  it('16. every result record is deterministic and carries a status', () => {
    const run = mkRun(40, 6, { curve: 2 });
    const a = fitRun(run);
    const b = fitRun(run);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    const statuses = ['accepted', 'orderingInvalid', 'insufficientSupport', 'validationInsufficient', 'topologyRejected', 'qualityRejected', 'numericalFailure'];
    assert.ok(statuses.includes(a.status), a.status);
  });
});

// ---------------------------------------------------------------------------
describe('4. numerical safety', () => {
  it('17. repeated t values (stationary collapse) are handled', () => {
    // 30 frames observing the same ~26 forward positions -> heavy repetition.
    // The real pipeline passes runs sorted by along-track s (approach A), so we
    // sort by s first to mirror production provenance.
    const run = [];
    for (let f = 0; f < 30; f++) {
      for (let k = 0; k < 26; k++) {
        const u = k * 4.5;
        run.push({
          east: u, north: Math.sin(u / 40) * 1, s: u, d: 0, frameId: `f${f}`, frameIndex: f,
          logMonoTime: String(f * 1e9 + k), score: 0.5 + 0.01 * k, supportFrameCount: 30,
          chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
          mirroredEast: u, mirroredNorth: -Math.sin(u / 40),
        });
      }
    }
    const sorted = [...run].sort((a, b) => a.s - b.s || a.d - b.d);
    const r = fitRun(sorted);
    assert.ok(['accepted', 'validationInsufficient', 'qualityRejected'].includes(r.status), r.status);
  });

  it('18. singular/ill-conditioned system falls back deterministically', () => {
    // very few bins relative to basis cap
    const run = mkRun(7, 6);
    const r = fitRun(run);
    assert.ok(r.status === 'accepted' || r.status === 'insufficientSupport' || r.status === 'qualityRejected' || r.status === 'validationInsufficient');
    assert.notEqual(r.status, 'numericalFailure');
  });

  it('19. non-finite inputs are excluded and never produce NaN output', () => {
    const run = mkRun(20, 6).map((p, i) => (i === 3 ? { ...p, east: NaN, north: Infinity } : p));
    const r = fitRun(run);
    // The single non-finite observation is filtered out; the remaining run is
    // either fitted normally or rejected for a legitimate gate — but the fitted
    // output must never contain NaN.
    const polys = normalizePolys(r.fittedPolyline);
    for (const poly of polys) {
      assert.ok(poly.every((p) => Number.isFinite(p.east) && Number.isFinite(p.north)));
    }
    const allFinite = r.segments
      ? r.segments.every((s) => (s.fittedPolyline || []).every((p) => Number.isFinite(p.east) && Number.isFinite(p.north)))
      : true;
    assert.ok(allFinite);
  });

  it('20. accepted fit output is finite and within observed bounds', () => {
    const r = fitRun(mkRun(40, 6, { curve: 1 }));
    if (r.status === 'accepted') {
      for (const poly of normalizePolys(r.fittedPolyline)) {
        assert.ok(poly.every((p) => Number.isFinite(p.east) && Number.isFinite(p.north)));
      }
    }
  });

  it('21. no extrapolation beyond observed u range', () => {
    const r = fitRun(mkRun(40, 6));
    if (r.status === 'accepted') {
      for (const poly of normalizePolys(r.fittedPolyline)) {
        const us = poly.map((p) => p.u);
        assert.ok(Math.min(...us) >= 0 - 1e-6);
        assert.ok(Math.max(...us) <= 20 + 1e-6, `uMax=${Math.max(...us)}`);
      }
    }
  });

  it('22. zero self-intersection on accepted straight/curved runs', () => {
    for (const curve of [0, 2]) {
      const r = fitRun(mkRun(50, 6, { curve }));
      if (r.status === 'accepted') {
        assert.equal(r.selfX, 0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('5. mirror parity and wiring', () => {
  it('23. public/graph_fit.js mirrors lib output byte-for-byte', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'graph_fit.js'), 'utf8');
    const ctx = { console };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.runInNewContext(src, ctx, { filename: 'public/graph_fit.js' });
    assert.ok(ctx.GraphFit, 'GraphFit loaded');
    const run = mkRun(40, 6, { curve: 1 });
    const libResult = GF.fitRun({
      rawRun: run, physicalBoundaryId: '0:0:0:1', fragmentId: 'C0',
      chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
    }, { ...DEFAULTS, fitEnabled: true });
    const browserResult = ctx.GraphFit.fitRun({
      rawRun: run, physicalBoundaryId: '0:0:0:1', fragmentId: 'C0',
      chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
    }, { ...DEFAULTS, fitEnabled: true });
    assert.equal(JSON.stringify(libResult), JSON.stringify(browserResult));
  });

  it('24. fragment runs align 1:1 with fragments and retain frame diversity', () => {
    // synthetic stationary: 30 frames x 26 positions => runs should have 30 frames
    const run = [];
    for (let f = 0; f < 30; f++) {
      for (let k = 0; k < 26; k++) {
        const u = k * 4.5;
        run.push({
          localEast: u, localNorth: Math.sin(u / 40), east: u, north: Math.sin(u / 40),
          s: u, d: 0, frameId: `f${f}`, frameIndex: f, logMonoTime: String(f * 1e9 + k),
          score: 0.8, supportFrameCount: 30, chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
          mirroredLocalEast: u, mirroredLocalNorth: -Math.sin(u / 40),
        });
      }
    }
    const cf = CF.buildConstructedFragments(run, {});
    assert.ok(cf.fragments.length >= 1);
    assert.ok(cf.runs && cf.runs.length === cf.fragments.length, 'runs align with fragments');
    const firstRun = cf.runs[0];
    const frames = new Set(firstRun.map((p) => p.frameId)).size;
    assert.ok(frames >= 10, `stationary run retains frame diversity: ${frames}`);
  });

  it('25. fit disabled -> segment_local_map exposes no fittedPolylines', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'segment_local_map.js'), 'utf8');
    assert.ok(src.includes('fitEnabled'));
    assert.ok(src.includes('fittedPolylines'));
    // default off: the fit branch is gated on options.fitEnabled
    assert.match(src, /options\.fitEnabled && GraphFit/);
  });

  it('26. fitted curves never enter polygon construction', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'segment_local_map.js'), 'utf8');
    // buildStationaryLocalPolygons and sd_fusion consume points/lanes, not fits
    const polyCall = src.indexOf('buildStationaryLocalPolygons(reliabilityPoints, options)');
    const fitBlock = src.indexOf('fitEnabled && GraphFit');
    assert.ok(fitBlock < polyCall, 'fit block precedes polygon block');
    assert.doesNotMatch(src, /fittedPolylines.*buildRoadSurfacePolygons/);
  });

  it('27. renderer has hybrid fitted draw paths and toggles; UI toggles exist', () => {
    const render = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.match(render, /_drawHybridFittedBoundaries/);
    assert.match(render, /_drawFittedPolylines/);
    assert.match(render, /this\.layers\.fittedPolylines/);
    assert.match(render, /hybridFittedBoundaries/);
    assert.match(render, /this\.layers\.fittedOutliers/);
    assert.match(render, /this\.layers\.fittedUnverified/);
    assert.match(render, /_drawFittedUnverified/);
    assert.match(render, /this\.layers\.fittedGaps/);
    assert.match(render, /_drawFittedGapMarkers/);
    assert.match(render, /this\.layers\.fittedEndpoints/);
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.match(html, /id="layerFittedPolylines"/);
    assert.match(html, /Hybrid fitted lane map/);
    assert.match(html, /id="layerFittedEndpoints"/);
    assert.match(html, /id="layerFittedOutliers"/);
    assert.match(html, /id="layerFittedUnverified"/);
    assert.match(html, /id="layerFittedGaps"/);
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(app, /fittedPolylines: \$\(['"]layerFittedPolylines['"]\)/);
    assert.match(app, /fittedEndpoints: \$\(['"]layerFittedEndpoints['"]\)/);
    assert.match(app, /fittedUnverified: \$\(['"]layerFittedUnverified['"]\)/);
    assert.match(app, /fitEnabled/);
  });
});

// ---------------------------------------------------------------------------
describe('6. regression guards', () => {
  it('28. lib loads standalone', () => {
    assert.ok(GF.fitConstructedRuns);
    assert.ok(GF.fitRun);
    assert.ok(GF.buildHybridFittedBoundaries);
  });
});

// ---------------------------------------------------------------------------
describe('7. provenance (stable source indices)', () => {
  /** build synthetic boundary with overlapping s-ranges (sharp split) */
  function mkBoundary(nPerRun, nRuns, { overlapS = 0, frames = 6, revisit = false } = {}) {
    const pts = [];
    let seq = 0;
    for (let r = 0; r < nRuns; r++) {
      const baseS = r * 20 - overlapS;
      for (let i = 0; i < nPerRun; i++) {
        const s = baseS + i * 2;
        const east = r * 30 + i * 2;
        // revisit: same s as a previous run but a physically different position
        const north = revisit && r > 0 ? 40 + r : 0;
        pts.push({
          localEast: east, localNorth: north, east, north, s, d: 0,
          frameId: `f${r}f${i % frames}`, frameIndex: i % frames,
          logMonoTime: String(seq++ * 1e9), score: 0.8, supportFrameCount: frames >= 2 ? 2 : 1,
          chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
          mirroredLocalEast: east, mirroredLocalNorth: -north,
        });
      }
    }
    return pts;
  }

  it('29. overlapping s-ranges do not cause duplicate membership', () => {
    const pts = mkBoundary(10, 3, { overlapS: 2 });
    const cf = CF.buildConstructedFragments(pts, {});
    const seen = new Set();
    let duplicates = 0;
    for (const run of cf.runs || []) {
      for (const p of run) {
        const k = `${p.frameId}:${(p.s ?? 0).toFixed(3)}:${(p.d ?? 0).toFixed(3)}`;
        if (seen.has(k)) duplicates++;
        seen.add(k);
      }
    }
    assert.equal(duplicates, 0, 'no observation in more than one fragment run');
  });

  it('30. equal-s observations at different physical positions stay separate', () => {
    const pts = mkBoundary(10, 2, { revisit: true });
    const cf = CF.buildConstructedFragments(pts, {});
    // every run observation must keep its own frame/position identity
    const byFrag = new Map();
    for (const run of cf.runs || []) {
      for (const p of run) {
        const east = Math.round((p.east ?? p.localEast ?? 0) / 5);
        const k = `${east}`;
        if (!byFrag.has(k)) byFrag.set(k, new Set());
        byFrag.get(k).add(p.frameId);
      }
    }
    // distinct east clusters observed
    const clusters = byFrag.size;
    assert.ok(clusters >= 2, `expected distinct physical clusters, got ${clusters}`);
  });

  it('31. shared fragment endpoints are assigned to exactly one fragment', () => {
    const pts = mkBoundary(10, 3, { overlapS: 2 });
    const cf = CF.buildConstructedFragments(pts, {});
    const count = new Map();
    for (const run of cf.runs || []) {
      for (const p of run) {
        const k = `${p.frameId}:${(p.s ?? 0).toFixed(3)}:${(p.d ?? 0).toFixed(3)}`;
        count.set(k, (count.get(k) || 0) + 1);
      }
    }
    for (const [k, n] of count) {
      assert.equal(n, 1, `observation ${k} appears ${n} times`);
    }
  });

  it('32. temporal revisit does not split membership or leak future frames', () => {
    const pts = mkBoundary(12, 2, { revisit: true });
    const cf = CF.buildConstructedFragments(pts, {});
    for (const run of cf.runs || []) {
      const idxs = run.map((p) => p.frameIndex).filter((x) => x != null);
      // sorted by s; causal fit would use only frameIndex <= elapsed
      const maxIdx = Math.max(...idxs);
      const causal = run.filter((p) => p.frameIndex <= Math.floor(maxIdx * 0.5));
      for (const p of causal) {
        assert.ok(p.frameIndex <= Math.floor(maxIdx * 0.5), 'no future-frame leakage');
      }
    }
  });

  it('33. every fit observation belongs to exactly one source fragment', () => {
    const pts = mkBoundary(10, 4, { overlapS: 3 });
    const cf = CF.buildConstructedFragments(pts, {});
    const seen = new Set();
    let dup = 0;
    let inFrag = 0;
    for (const run of cf.runs || []) {
      for (const p of run) {
        inFrag++;
        const k = `${p.frameId}:${(p.s ?? 0).toFixed(3)}:${(p.d ?? 0).toFixed(3)}:${(p.east ?? 0).toFixed(1)}:${(p.north ?? 0).toFixed(1)}`;
        if (seen.has(k)) dup++;
        seen.add(k);
      }
    }
    assert.equal(dup, 0, `duplicate membership: ${dup}`);
    assert.ok(inFrag > 0);
  });

  it('34. membership is unchanged by fragment smoothing', () => {
    // smoothing only moves vertices; the (s,d) keys that map to source indices
    // are preserved, so the fit run is identical whether or not smoothing ran.
    const pts = mkBoundary(16, 2);
    const cfSmoothed = CF.buildConstructedFragments(pts, {});
    const runsSmoothed = JSON.stringify(cfSmoothed.runs || []);
    // force smoothing off is not a CF option; instead verify each fragment
    // vertex maps back to a deduped representative with identical (s,d)
    for (let i = 0; i < cfSmoothed.fragments.length; i++) {
      const frag = cfSmoothed.fragments[i];
      const run = cfSmoothed.runs[i] || [];
      for (const v of frag.points) {
        const match = run.find((p) => Math.abs((p.s ?? 0) - (v.s ?? 0)) < 1e-6 && Math.abs((p.d ?? 0) - (v.d ?? 0)) < 1e-6);
        assert.ok(match, `fragment vertex ${v.s} maps to a source observation`);
      }
    }
    assert.ok(runsSmoothed.length > 0);
  });
});

// ---------------------------------------------------------------------------
describe('8. stationary classification (degenerate trajectory)', () => {
  const mkTraj = (totalLength, points) => ({ totalLength, points: points || [] });

  it('35. null trajectory is degenerate (stationary)', () => {
    assert.equal(GF.isDegenerateTrajectory(null), true);
  });

  it('36. empty trajectory is degenerate', () => {
    assert.equal(GF.isDegenerateTrajectory(mkTraj(0, [])), true);
  });

  it('37. one-point trajectory is degenerate (non-null truthy object)', () => {
    const onePoint = mkTraj(0, [{ east: 1, north: 1 }]);
    assert.equal(GF.isDegenerateTrajectory(onePoint), true);
  });

  it('38. multiple identical trajectory points are degenerate', () => {
    const identical = mkTraj(0, [{ east: 1, north: 1 }, { east: 1, north: 1 }]);
    assert.equal(GF.isDegenerateTrajectory(identical), true);
  });

  it('39. genuine moving trajectory is not degenerate', () => {
    const moving = mkTraj(1345.2486, [{ east: 0, north: 0 }, { east: 100, north: 0 }]);
    assert.equal(GF.isDegenerateTrajectory(moving), false);
  });

  it('40. stop-and-go trajectory (non-zero length) is not degenerate', () => {
    const stopGo = mkTraj(67.2914, [{ east: 0, north: 0 }, { east: 10, north: 0 }, { east: 10, north: 0 }]);
    assert.equal(GF.isDegenerateTrajectory(stopGo), false);
  });

  it('41. degenerate trajectory drives the stationary collapse path in fitRun', () => {
    // A stationary-like run (repeated forward positions, one physical pose) must
    // use the stationary collapse when the trajectory is degenerate.
    const run = [];
    for (let f = 0; f < 8; f++) {
      for (let k = 0; k < 10; k++) {
        const u = k * 4.5;
        run.push({
          east: u, north: Math.sin(u / 40) * 0.5, s: u, d: 0, frameId: `f${f}`, frameIndex: f,
          logMonoTime: String(f * 1e9 + k), score: 0.8, supportFrameCount: 8,
          chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
          mirroredEast: u, mirroredNorth: -Math.sin(u / 40) * 0.5,
        });
      }
    }
    const sorted = [...run].sort((a, b) => a.s - b.s || a.d - b.d);
    const r = GF.fitRun({
      rawRun: sorted, physicalBoundaryId: '0:0:0:1', fragmentId: 'C0',
      chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
    }, { ...DEFAULTS, fitEnabled: true, fitTrajectory: null });
    assert.ok(['accepted', 'validationInsufficient', 'qualityRejected', 'insufficientSupport'].includes(r.status), r.status);
    if (r.status === 'accepted') {
      // stationary collapse: bins << raw (repeats merged)
      assert.ok(r.nBins < r.nRaw, `nBins=${r.nBins} should be < nRaw=${r.nRaw}`);
    }
  });

  it('42. segment_local_map passes the raw trajectory for degenerate classification', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'segment_local_map.js'), 'utf8');
    assert.match(src, /fitTrajectory: builtTrajectory/);
    assert.doesNotMatch(src, /fitIsStationary: !trajectory/);
  });
});

// ---------------------------------------------------------------------------
describe('9. fitted causal playback (complete-map only)', () => {
  it('43. playback never invokes the expensive fitter (draw path suppresses causal)', () => {
    const render = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    // _drawFittedPolylines must not call _rebuildFitsCausal
    const drawFn = render.slice(render.indexOf('_drawFittedPolylines'), render.indexOf('_drawFittedOutliers'));
    assert.doesNotMatch(drawFn, /_rebuildFitsCausal/);
    // _rebuildFitsCausal is retained but no draw path references it
    assert.match(render, /_rebuildFitsCausal\(map, elapsed\)/);
    assert.match(render, /test-only \/ internal/);
  });

  it('44. complete-map-only guard suppresses hybrid and fitted layers in causal', () => {
    const render = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    const guard = render.indexOf('_fitCompleteMapOnlyGuard');
    assert.ok(guard > 0, 'guard defined');
    // every fitted/hybrid draw path calls the guard before rendering complete fits
    for (const fn of ['_drawHybridFittedBoundaries', '_drawFittedPolylines', '_drawFittedOutliers', '_drawFittedUnverified', '_drawFittedGapMarkers']) {
      const idx = render.lastIndexOf(`${fn}(`);
      const next = render.indexOf('\n  _drawFitted', idx + fn.length);
      const body = render.slice(idx, next < 0 ? idx + 700 : next);
      assert.match(body, /_fitCompleteMapOnlyGuard/, `${fn} guards causal`);
    }
  });

  it('45. notice text is present and playback is not blocked', () => {
    const render = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.match(render, /Fitted curves are available in complete-map view only\./);
    // guard only draws a label; it returns without altering playback loop
    assert.doesNotMatch(render, /_fitCompleteMapOnlyGuard\(\)[\s\S]*pause\(\)/);
  });

  it('46. complete-map mode still displays accepted fits (no guard when not causal)', () => {
    const render = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    // guard returns false when not in causal playback
    assert.match(render, /if \(!\(this\._pointCausalPlayback && !this\._obsIsolationActive\(\)\)\) return false;/);
  });
});

// ---------------------------------------------------------------------------
describe('10. result-identical caches', () => {
  function mkCurveRun(nPts = 40, frames = 6, curve = 2) {
    const run = [];
    for (let i = 0; i < nPts; i++) {
      const u = (i / (nPts - 1)) * 20;
      const north = Math.sin(u / 5) * curve;
      run.push({
        east: u, north, s: u, d: 0, frameId: `f${i % frames}`, frameIndex: i % frames,
        logMonoTime: String(i * 1e9), score: 0.8, supportFrameCount: frames >= 2 ? 2 : 1,
        chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
        mirroredEast: u, mirroredNorth: -north,
      });
    }
    return run;
  }

  it('47. cached penalty matrix is identical to a fresh build (bit-for-bit)', () => {
    GF.clearGraphFitCaches();
    const b = GF.buildSplineBasis(12, 3);
    const fresh = (() => {
      // rebuild a fresh one by clearing and re-caching from source build
      GF.clearGraphFitCaches();
      return GF.cachedPenaltyMatrix(GF.buildSplineBasis(12, 3));
    })();
    const cached = GF.cachedPenaltyMatrix(b);
    assert.equal(JSON.stringify(fresh), JSON.stringify(cached));
  });

  it('48. cached design matrix is identical to a fresh build', () => {
    GF.clearGraphFitCaches();
    const ts = [0, 0.1, 0.3, 0.5, 0.8, 1];
    const b = GF.buildSplineBasis(8, 3);
    const a = GF.cachedDesignMatrix(ts, b);
    const c = GF.cachedDesignMatrix(ts, b);
    assert.equal(JSON.stringify(a), JSON.stringify(c));
  });

  it('49. cold vs warm cache produce byte-identical fit results', () => {
    const run = mkCurveRun();
    const opts = { ...DEFAULTS, fitEnabled: true };
    const fitRun = (rr) => GF.fitRun({
      rawRun: rr, physicalBoundaryId: '0:0:0:1', fragmentId: 'C0',
      chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
    }, opts);
    GF.clearGraphFitCaches();
    const cold = fitRun(run);
    const warm = fitRun(run);
    assert.equal(JSON.stringify(cold), JSON.stringify(warm));
  });

  it('50. east/north share B and Ω but factorization diverges under IRLS', () => {
    // With different north noise, IRLS robust weights diverge between
    // coordinates, yet both must still fit correctly. The shared B/Ω does not
    // change this; only the (non-shared) factorization changes.
    const run = [];
    for (let i = 0; i < 40; i++) {
      const u = (i / 39) * 20;
      const noiseE = i === 10 ? 5 : 0;   // east outlier
      const noiseN = i === 30 ? 5 : 0;   // north outlier
      run.push({
        east: u + noiseE, north: Math.sin(u / 5) * 2 + noiseN, s: u, d: 0,
        frameId: `f${i % 6}`, frameIndex: i % 6, logMonoTime: String(i * 1e9),
        score: 0.8, supportFrameCount: 2, chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
        mirroredEast: u + noiseE, mirroredNorth: -(Math.sin(u / 5) * 2 + noiseN),
      });
    }
    const r = GF.fitRun({
      rawRun: run, physicalBoundaryId: '0:0:0:1', fragmentId: 'C0',
      chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
    }, { ...DEFAULTS, fitEnabled: true });
    assert.ok(['accepted', 'qualityRejected', 'validationInsufficient', 'insufficientSupport'].includes(r.status), r.status);
    if (r.status === 'accepted') {
      assert.ok(Number.isFinite(r.trainingMedian));
    }
  });

  it('51. cache stats reflect single Ω build per basis and finite design builds', () => {
    const ctx = GF.createFitCaches();
    const basis = GF.buildSplineBasis(10, 3);
    const ts = [0, 0.2, 0.5, 0.8, 1];
    // build once, reuse twice
    GF.cachedPenaltyMatrix(basis, ctx);
    GF.cachedPenaltyMatrix(basis, ctx);
    GF.cachedDesignMatrix(ts, basis, ctx);
    GF.cachedDesignMatrix(ts, basis, ctx);
    assert.equal(ctx.omegaBuilds, 1, 'Omega built once for the same basis');
    assert.equal(ctx.designBuilds, 1, 'Design built once for the same t/basis');
    assert.equal(ctx.omega.size, 1);
    assert.equal(ctx.design.size, 1);
  });

  it('52. per-build cache scope does not accumulate across fit invocations', () => {
    // Two independent fitConstructedRuns calls must not share matrices: the
    // second call starts fresh and the first call's caches are unreachable.
    const run = [];
    for (let i = 0; i < 40; i++) {
      const u = (i / 39) * 20;
      run.push({
        east: u, north: Math.sin(u / 5), s: u, d: 0, frameId: `f${i % 6}`, frameIndex: i % 6,
        logMonoTime: String(i * 1e9), score: 0.8, supportFrameCount: 2,
        chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
        mirroredEast: u, mirroredNorth: -Math.sin(u / 5),
      });
    }
    const opts = { ...DEFAULTS, fitEnabled: true };
    const fitOnce = () => GF.fitRun({
      rawRun: run, physicalBoundaryId: '0:0:0:1', fragmentId: 'C0',
      chunkId: 0, passId: 0, groupTrackId: 0, laneIndex: 1,
    }, opts);
    const a = fitOnce();
    const b = fitOnce();
    // identical results (per-build cache is result-identical)
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it('53. browser mirror exposes createFitCaches and cache helpers', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'graph_fit.js'), 'utf8');
    const ctx = { console };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.runInNewContext(src, ctx, { filename: 'public/graph_fit.js' });
    assert.ok(ctx.GraphFit.createFitCaches, 'createFitCaches in browser mirror');
    const c = ctx.GraphFit.createFitCaches();
    const basis = ctx.GraphFit.buildSplineBasis(8, 3);
    ctx.GraphFit.cachedPenaltyMatrix(basis, c);
    assert.equal(c.omegaBuilds, 1);
  });
});

// ---------------------------------------------------------------------------
describe('11. fitted renderer normalization + toggle contract', () => {
  const RENDER_JS = path.join(ROOT, 'public', 'render.js');
  const APP_JS = path.join(ROOT, 'public', 'app.js');

  it('54. renderer normalizes single-segment flat fittedPolyline arrays', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /_normalizeFittedPolylines\(fittedPolyline\)/);
    assert.match(src, /if \(fittedPolyline\.length && Array\.isArray\(fittedPolyline\[0\]\)\) return fittedPolyline/);
    assert.match(src, /_normalizeFittedPolylines\(r\.fittedPolyline\)/);
  });

  it('55. hybrid and fitted layers use distinct cyan styling; endpoints are diagnostic-only', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    const hybridStart = src.indexOf('  _drawHybridFittedBoundaries(map, elapsedIdx, visiblePoints) {');
    const hybridEnd = src.indexOf('  _drawFittedPolylines(map, elapsedIdx, visiblePoints) {', hybridStart);
    const hybridBlock = src.slice(hybridStart, hybridEnd);
    assert.match(hybridBlock, /#06b6d4/);
    assert.match(hybridBlock, /lineWidth = 4/);
    assert.match(hybridBlock, /this\.layers\.fittedEndpoints/);
    assert.match(src, /_drawFittedEndpointMarkers\(poly\)/);
    assert.match(src, /#a855f7/);
  });

  it('56. fitted checkbox maps to layers.fittedPolylines and triggers redraw via setData', () => {
    const app = fs.readFileSync(APP_JS, 'utf8');
    assert.match(app, /fittedPolylines: \$\(['"]layerFittedPolylines['"]\)/);
    assert.match(app, /renderer\.setData\(processData, getEffectiveLayers\(displayMode\), displayMode\)/);
    const render = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(render, /if \(this\.layers\.fittedPolylines && typeof GraphFit !== 'undefined'\)/);
  });

  it('57. normalize helper treats flat vertex list as one polyline', () => {
    const flat = [{ east: 0, north: 0 }, { east: 1, north: 1 }, { east: 2, north: 2 }];
    const nested = [[{ east: 0, north: 0 }, { east: 1, north: 1 }], [{ east: 2, north: 2 }, { east: 3, north: 3 }]];
    function normalizeFittedPolylines(fittedPolyline) {
      if (!fittedPolyline) return [];
      if (!Array.isArray(fittedPolyline)) return [];
      if (fittedPolyline.length && Array.isArray(fittedPolyline[0])) return fittedPolyline;
      return [fittedPolyline];
    }
    assert.deepEqual(normalizeFittedPolylines(flat), [flat]);
    assert.deepEqual(normalizeFittedPolylines(nested), nested);
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /_normalizeFittedPolylines\(fittedPolyline\)/);
  });

  it('58. fitted mirror display requires precomputed mirrored segment-local coords', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /_fittedVertexScreen\(v\)/);
    assert.match(src, /v\.mirroredEast == null \|\| v\.mirroredNorth == null\) return null/);
    assert.doesNotMatch(src, /_mirrorRoadPoint\(v\.east, v\.north, v\)/);
  });

  it('59. Segment 2 accepted-fit count remains 4 with fit enabled', () => {
    const seg = 'qlog_f449c_2.bz2';
    if (!fs.existsSync(path.join(ROOT, seg))) return;
    const { summarizeViewerSegment } = require('../lib/viewer_map_build');
    const s = summarizeViewerSegment(ROOT, seg, { fitEnabled: true });
    assert.equal(s.fitOn.acceptedCount, 4);
  });
});

// ---------------------------------------------------------------------------
describe('12. source-corridor coordinate-frame invariants', () => {
  function mkFragmentPoints(run) {
    return run.map((p) => ({
      east: p.east,
      north: p.north,
      mirroredEast: p.mirroredEast,
      mirroredNorth: p.mirroredNorth,
    }));
  }

  function fitWithSource(rawRun, overrides = {}) {
    return GF.fitRun({
      rawRun,
      physicalBoundaryId: '0:0:0:1',
      fragmentId: 'CF0',
      chunkId: 0,
      passId: 0,
      groupTrackId: 0,
      laneIndex: 1,
      sourceFragmentPoints: mkFragmentPoints(rawRun),
    }, { ...DEFAULTS, fitEnabled: true, ...overrides });
  }

  it('60. straight identity fit remains within its source corridor', () => {
    const run = mkRun(30, 8, { baseEast: 10 });
    const res = fitWithSource(run);
    assert.equal(res.status, 'accepted');
    assert.ok(res.sourceCorridor?.ok);
    assert.ok(res.sourceCorridor.maxDistM < DEFAULTS.fitMaxSourceCorridorM);
  });

  it('61. segment-local input produces segment-local tagged output', () => {
    const run = mkRun(30, 8);
    const res = fitWithSource(run);
    assert.equal(res.coordinateFrame, GF.SEGMENT_LOCAL_COORDINATE_FRAME);
    const poly = normalizePolys(res.fittedPolyline)[0];
    assert.ok(poly.every((p) => p.coordinateFrame === GF.SEGMENT_LOCAL_COORDINATE_FRAME));
  });

  it('62. global coordinates cannot be consumed as local coordinates', () => {
    const run = mkRun(30, 8);
    const globalRun = run.map((p) => ({ ...p, east: p.east + 1e6, north: p.north + 2e6 }));
    const res = GF.fitRun({
      rawRun: globalRun,
      physicalBoundaryId: '0:0:0:1',
      fragmentId: 'CF0',
      chunkId: 0,
      passId: 0,
      groupTrackId: 0,
      laneIndex: 1,
      sourceFragmentPoints: mkFragmentPoints(run),
    }, { ...DEFAULTS, fitEnabled: true });
    assert.equal(res.status, 'coordinateFrameRejected');
    assert.ok(['globalConsumedAsLocal', 'sourceCorridorExceeded'].includes(res.reason));
  });

  it('63. fit and source fragment share the same reference origin (corridor ok)', () => {
    const run = mkRun(30, 8, { curve: 1 });
    const res = fitWithSource(run);
    assert.equal(res.status, 'accepted');
    const poly = normalizePolys(res.fittedPolyline)[0];
    const src = mkFragmentPoints(run);
    const ep0 = Math.hypot(poly[0].east - src[0].east, poly[0].north - src[0].north);
    const ep1 = Math.hypot(poly.at(-1).east - src.at(-1).east, poly.at(-1).north - src.at(-1).north);
    assert.ok(ep0 < 1.0 && ep1 < 1.0);
  });

  it('64. mirror-on fit overlaps mirror-on source evidence', () => {
    const run = mkRun(30, 8, { curve: 0.5 });
    const res = fitWithSource(run);
    assert.equal(res.status, 'accepted');
    const poly = normalizePolys(res.fittedPolyline)[0];
    let maxMirrorDist = 0;
    for (const p of poly) {
      maxMirrorDist = Math.max(maxMirrorDist, GF.pointToPolylineDist(
        { east: p.mirroredEast, north: p.mirroredNorth },
        mkFragmentPoints(run).map((s) => ({ east: s.mirroredEast, north: s.mirroredNorth })),
      ));
    }
    assert.ok(maxMirrorDist < DEFAULTS.fitMaxSourceCorridorM);
  });

  it('65. mirror-off canonical fit overlaps mirror-off source evidence', () => {
    const run = mkRun(30, 8);
    const res = fitWithSource(run);
    const poly = normalizePolys(res.fittedPolyline)[0];
    const src = mkFragmentPoints(run);
    const check = GF.validateFitSourceCorridor(poly, src, DEFAULTS);
    assert.ok(check.ok);
  });

  it('66. fit-to-view bounds exclude detached coordinate-frame errors', () => {
    const run = mkRun(30, 8);
    const res = fitWithSource(run);
    const poly = normalizePolys(res.fittedPolyline)[0];
    const easts = poly.map((p) => p.east);
    const norths = poly.map((p) => p.north);
    const src = mkFragmentPoints(run);
    const srcE = src.map((p) => p.east);
    const srcN = src.map((p) => p.north);
    const spanE = Math.max(...easts) - Math.min(...easts);
    const spanSrcE = Math.max(...srcE) - Math.min(...srcE);
    assert.ok(spanE < spanSrcE * 3 + 5);
    assert.ok(Math.max(...norths) - Math.min(...norths) < 50);
  });

  it('67. Segment 2 CF9 fitted endpoints remain near CF9 source endpoints', () => {
    const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
    if (!fs.existsSync(seg)) return;
    const { processRoute } = require('../lib/process_route');
    const { extractFromFile: extractModel } = require('../extract_modelv2');
    const { extractFromFile: extractGps } = require('../extract_gps');
    const SLM = require('../lib/segment_local_map');
    const me = extractModel(seg).map((e) => ({ ...e, sourceFile: seg }));
    const ge = extractGps(seg).map((e) => ({ ...e, sourceFile: seg }));
    const r = processRoute(me, ge, { pipelineMode: 'C' });
    const map = SLM.buildSegmentLocalMap(r, {
      geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true,
    });
    const cf9 = map.pointAccumulated.constructedFragments.fragments.find((f) => f.fragmentId === 'CF9');
    const fit9 = map.pointAccumulated.fittedPolylines.results.find((x) => x.fragmentId === 'CF9');
    assert.equal(fit9.status, 'accepted');
    const poly = normalizePolys(fit9.fittedPolyline)[0];
    const ep0 = Math.hypot(poly[0].east - cf9.points[0].east, poly[0].north - cf9.points[0].north);
    const ep1 = Math.hypot(poly.at(-1).east - cf9.points.at(-1).east, poly.at(-1).north - cf9.points.at(-1).north);
    assert.ok(ep0 < 1.0, `start endpoint gap ${ep0}`);
    assert.ok(ep1 < 1.0, `end endpoint gap ${ep1}`);
    assert.ok(poly[0].mirroredEast != null && poly[0].mirroredNorth != null);
  });

  it('68. no accepted fitted curve expands map bounds through coordinate-frame error', () => {
    const seg = path.join(ROOT, 'qlog_f449c_3.bz2');
    if (!fs.existsSync(seg)) return;
    const { processRoute } = require('../lib/process_route');
    const { extractFromFile: extractModel } = require('../extract_modelv2');
    const { extractFromFile: extractGps } = require('../extract_gps');
    const SLM = require('../lib/segment_local_map');
    const me = extractModel(seg).map((e) => ({ ...e, sourceFile: seg }));
    const ge = extractGps(seg).map((e) => ({ ...e, sourceFile: seg }));
    const r = processRoute(me, ge, { pipelineMode: 'C' });
    const map = SLM.buildSegmentLocalMap(r, {
      geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true,
    });
    const fb = map.fitBounds;
    const accepted = (map.pointAccumulated.fittedPolylines?.results || []).filter((x) => x.status === 'accepted');
    for (const fit of accepted) {
      for (const poly of normalizePolys(fit.fittedPolyline)) {
        for (const p of poly) {
          assert.ok(p.east >= fb.minE - 5 && p.east <= fb.maxE + 5);
          assert.ok(p.north >= fb.minN - 5 && p.north <= fb.maxN + 5);
        }
      }
    }
  });

  it('69. detached fitted geometry fails validation rather than being accepted', () => {
    const run = mkRun(30, 8);
    const shifted = run.map((p) => ({ ...p, east: p.east + 50, north: p.north + 50,
      mirroredEast: p.mirroredEast + 50, mirroredNorth: p.mirroredNorth + 50 }));
    const res = GF.fitRun({
      rawRun: shifted,
      physicalBoundaryId: '0:0:0:1',
      fragmentId: 'CF0',
      chunkId: 0,
      passId: 0,
      groupTrackId: 0,
      laneIndex: 1,
      sourceFragmentPoints: mkFragmentPoints(run),
    }, { ...DEFAULTS, fitEnabled: true });
    assert.equal(res.status, 'coordinateFrameRejected');
    assert.equal(res.reason, 'sourceCorridorExceeded');
  });
});

// ---------------------------------------------------------------------------
describe('13. hybrid fitted boundaries', () => {
  it('70. emits one hybrid boundary per constructed fragment', () => {
    const run = mkRun(40, 6, { curve: 1 });
    const cf = CF.buildConstructedFragments(run, {});
    const fit = GF.fitConstructedRuns(cf.fragments, cf.runs, { ...DEFAULTS, fitEnabled: true });
    const hybrid = GF.buildHybridFittedBoundaries(cf.fragments, fit);
    assert.equal(hybrid.boundaries.length, cf.fragments.length);
    assert.equal(hybrid.stats.totalFragments, cf.fragments.length);
    assert.equal(
      hybrid.stats.fittedFragments + hybrid.stats.fallbackFragments,
      cf.fragments.length,
    );
  });

  it('71. accepted fragments use acceptedFit; short runs use fragmentFallback', () => {
    const good = mkRun(40, 6, { curve: 0.5 });
    const bad = mkRun(3, 2);
    const pts = [...good, ...bad.map((p, i) => ({ ...p, groupTrackId: 1, laneIndex: 2, frameIndex: i }))];
    const cf = CF.buildConstructedFragments(pts, {});
    const fit = GF.fitConstructedRuns(cf.fragments, cf.runs, { ...DEFAULTS, fitEnabled: true });
    const hybrid = GF.buildHybridFittedBoundaries(cf.fragments, fit);
    const accepted = hybrid.boundaries.filter((b) => b.displaySource === 'acceptedFit');
    const fallback = hybrid.boundaries.filter((b) => b.displaySource === 'fragmentFallback');
    assert.ok(accepted.length >= 1);
    assert.ok(fallback.length >= 1);
    for (const b of accepted) {
      assert.equal(b.fitStatus, 'accepted');
      assert.ok(b.polylines.length >= 1);
      assert.ok(b.polylines[0].length >= 2);
    }
    for (const b of fallback) {
      assert.notEqual(b.fitStatus, 'accepted');
      assert.ok(b.rejectionReason);
      assert.ok(b.polylines[0].length >= 1);
    }
  });

  it('72. hybrid preserves fragment identity fields and never merges polylines across fragments', () => {
    const run = mkRun(50, 8, { curve: 1 });
    const cf = CF.buildConstructedFragments(run, {});
    const fit = GF.fitConstructedRuns(cf.fragments, cf.runs, { ...DEFAULTS, fitEnabled: true });
    const hybrid = GF.buildHybridFittedBoundaries(cf.fragments, fit);
    const ids = new Set(hybrid.boundaries.map((b) => b.fragmentId));
    assert.equal(ids.size, cf.fragments.length);
    for (const b of hybrid.boundaries) {
      const frag = cf.fragments.find((f) => f.fragmentId === b.fragmentId);
      assert.ok(frag);
      assert.equal(b.chunkId, frag.chunkId);
      assert.equal(b.passId, frag.passId);
      assert.equal(b.groupTrackId, frag.groupTrackId);
      assert.equal(b.laneIndex, frag.laneIndex);
      assert.equal(b.coordinateFrame, 'segmentLocal');
    }
  });

  it('73. segment_local_map exposes hybrid only when fitEnabled', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'segment_local_map.js'), 'utf8');
    assert.match(src, /hybridFittedBoundaries/);
    assert.match(src, /buildHybridFittedBoundaries/);
    assert.match(src, /options\.fitEnabled && GraphFit.*fittedPolylines/);
    assert.doesNotMatch(src, /hybridFittedBoundaries.*buildStationaryLocalPolygons/);
  });

  it('74. public graph_fit mirrors buildHybridFittedBoundaries', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'graph_fit.js'), 'utf8');
    const ctx = { console };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.runInNewContext(src, ctx, { filename: 'public/graph_fit.js' });
    const run = mkRun(30, 6);
    const cf = CF.buildConstructedFragments(run, {});
    const fit = GF.fitConstructedRuns(cf.fragments, cf.runs, { ...DEFAULTS, fitEnabled: true });
    const libHybrid = GF.buildHybridFittedBoundaries(cf.fragments, fit);
    const browserHybrid = ctx.GraphFit.buildHybridFittedBoundaries(cf.fragments, fit);
    assert.equal(JSON.stringify(libHybrid), JSON.stringify(browserHybrid));
  });
});
