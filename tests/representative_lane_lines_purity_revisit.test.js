'use strict';
// Focused purityRevisit-candidate fixtures (representativeMethod=purityRevisit).
// Synthetic cases 1-6 + real-data gates for Seg0/1/2/99. The default path and
// the purity path are asserted unchanged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CAD_SRC = fs.readFileSync(path.join(ROOT, 'public/connected_accumulated_display.js'), 'utf8');
const RENDER = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');

function loadCAD() {
  const sandbox = { console, module: { exports: {} }, exports: {} };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(CAD_SRC, sandbox, { filename: 'connected_accumulated_display.js' });
  return sandbox.ConnectedAccumulatedDisplay || sandbox.module.exports;
}

let seq = 0;
function mkCurve({ gt, pass = 0, chunk = 0, frameId = 1, frameIndex = 1, points }) {
  seq += 1;
  return {
    groupId: `rev:${gt}:${pass}:${frameId}:${seq}`,
    chunkId: chunk,
    passId: pass,
    groupTrackId: gt,
    laneIndex: 0,
    side: 'right',
    frameId,
    frameIndex,
    points,
    pointCount: points.length,
  };
}
function mkPoints(s0, s1, n, dFn, frameId, frameIndex) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const s = s0 + ((s1 - s0) * i) / (n - 1);
    const d = dFn(s, i);
    pts.push({
      localEast: s, localNorth: d, s, d, modelX: 10,
      chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, side: 'right',
      frameId, frameIndex, prob: 0.9,
    });
  }
  return pts;
}
function coilCurves({ gt, frameIds, frameIndexes, cx = 0, cy = 0, r = 3, a0 = 0, a1 = 340, n = 36 }) {
  const curves = [];
  for (let k = 0; k < frameIds.length; k++) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (a0 + ((a1 - a0) * i) / (n - 1)) * (Math.PI / 180);
      const e = cx + r * Math.cos(a);
      const nn = cy + r * Math.sin(a);
      const s = r * a;
      pts.push({
        localEast: e, localNorth: nn, s, d: nn, modelX: 10,
        chunkId: 0, passId: 0, groupTrackId: gt, laneIndex: 0, side: 'right',
        frameId: frameIds[k], frameIndex: frameIndexes[k], prob: 0.9,
      });
    }
    curves.push(mkCurve({ gt, frameId: frameIds[k], frameIndex: frameIndexes[k], points: pts }));
  }
  return curves;
}
function overlapPairs(lines, dtol = 3.0) {
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const A = lines[i];
      const B = lines[j];
      if (A.chunkId !== B.chunkId || A.passId !== B.passId) continue;
      if ((A.groupTrackId ?? 'x') !== (B.groupTrackId ?? 'x')) continue;
      const sa = A.points.map((p) => p.s);
      const sb = B.points.map((p) => p.s);
      const o = Math.min(Math.max(...sa), Math.max(...sb)) - Math.max(Math.min(...sa), Math.min(...sb));
      if (!(o > 0)) continue;
      const med = (arr) => {
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      if (Math.abs(med(A.points.map((p) => p.d)) - med(B.points.map((p) => p.d))) > dtol) n++;
    }
  }
  return n;
}
function foldedLineCount(lines) {
  return lines.filter((pl) => (pl.purityFlags?.maxTurnWindowDeg ?? 0) > 270
    && (pl.purityFlags?.chordPathRatio ?? 1) < 0.6).length;
}

test('revisit-1: two temporally separated revisit branches never become one folded line', () => {
  const CAD = loadCAD();
  // Two visits (frames 1-3 and 100-102) of a tight coil; the fitted union folds.
  const curves = coilCurves({ gt: 20, frameIds: [1, 2, 3, 100, 101, 102], frameIndexes: [0, 1, 2, 10, 11, 12] });
  const built = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(curves);
  assert.equal(built.stats.method, 'purityRevisit');
  assert.equal(foldedLineCount(built.polylines), 0, 'no folded line may survive');
  assert.ok((built.stats.purityRejectedSelfFold ?? 0) >= 1, 'fold is rejected or split');
  for (const pl of built.polylines) {
    assert.equal(CAD.analyzeRepresentativeSelfFold(pl.points).trigger, false);
  }
});

test('revisit-2: a large frame gap alone does not split compatible repeats', () => {
  const CAD = loadCAD();
  // Two visits, huge temporal gap, but the same straight physical line.
  const curves = [];
  for (const [f, fi] of [[1, 0], [2, 1], [3, 2], [100, 10], [101, 11], [102, 12]]) {
    curves.push(mkCurve({ gt: 21, frameId: f, frameIndex: fi, points: mkPoints(0, 60, 30, () => 0, f, fi) }));
  }
  const built = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(curves);
  assert.ok(built.polylines.length >= 1, 'compatible repeats must survive');
  const long = built.polylines.filter((pl) => (pl.coverageM ?? 0) >= 50);
  assert.ok(long.length >= 1, 'the compatible line is kept as one long line');
  assert.equal(foldedLineCount(built.polylines), 0);
  assert.equal(built.stats.purityRejectedSelfFold ?? 0, 0);
});

test('revisit-3: a legitimate smooth loop with contiguous provenance remains', () => {
  const CAD = loadCAD();
  // A single-visit 150-degree arc: large curvature but not a self-fold.
  const curves = [];
  for (const [f, fi] of [[1, 0], [2, 1], [3, 2], [4, 3], [5, 4]]) {
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const a = (150 * i / 39) * (Math.PI / 180);
      const e = 20 * Math.cos(a);
      const nn = 20 * Math.sin(a);
      pts.push({
        localEast: e, localNorth: nn, s: 20 * a, d: nn, modelX: 10,
        chunkId: 0, passId: 0, groupTrackId: 22, laneIndex: 0, side: 'right',
        frameId: f, frameIndex: fi, prob: 0.9,
      });
    }
    curves.push(mkCurve({ gt: 22, frameId: f, frameIndex: fi, points: pts }));
  }
  const built = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(curves);
  assert.ok(built.polylines.length >= 1, 'the loop is retained');
  assert.equal(foldedLineCount(built.polylines), 0);
  assert.equal(built.stats.purityRejectedSelfFold ?? 0, 0);
});

test('revisit-4: a detected local fold splits at the supported visit boundary', () => {
  const CAD = loadCAD();
  // Build a folded polyline whose points carry two temporal visit groups; the
  // splitter must divide it at the visit boundary into two valid pieces.
  const pts = [];
  for (let i = 0; i < 40; i++) {
    const a = (340 * i / 39) * (Math.PI / 180);
    const e = 3 * Math.cos(a);
    const nn = 3 * Math.sin(a);
    const fid = i < 20 ? 1 : 100;
    pts.push({
      localEast: e, localNorth: nn, s: 3 * a, d: nn,
      binMeta: { sourceFrameIds: [fid], distinctFrameCount: 2, lateralMadM: 0.2 },
    });
  }
  const pl = { points: pts, groupId: 'g', chunkId: 0, passId: 0, groupTrackId: 5, laneIndex: 0, side: 'right', logicalLaneId: 'g' };
  const pieces = CAD.splitRepresentativeAtVisitBoundary(pl);
  assert.equal(pieces.length, 2, 'split into two visit pieces');
  for (const piece of pieces) {
    assert.ok(piece.points.length >= 3);
    assert.equal(CAD.analyzeRepresentativeSelfFold(piece.points).trigger, false);
  }
});

test('revisit-5: no crossing between chunks or passes', () => {
  const CAD = loadCAD();
  const curves = [];
  for (const [pass, f, fi] of [[0, 1, 0], [0, 2, 1], [1, 3, 2], [1, 4, 3]]) {
    curves.push(mkCurve({ gt: 23, pass, frameId: f, frameIndex: fi, points: mkPoints(0, 60, 30, () => 0, f, fi) }));
  }
  const built = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(curves);
  const passes = new Set(built.polylines.map((pl) => String(pl.passId)));
  assert.ok(passes.size >= 2, 'separate passes must not merge');
  for (const pl of built.polylines) {
    assert.equal(new Set(pl.points.map((p) => p.passId)).size, 1);
    assert.equal(new Set(pl.points.map((p) => p.chunkId)).size, 1);
  }
});

test('revisit-6: deterministic rebuild output', () => {
  const CAD = loadCAD();
  const curves = coilCurves({ gt: 24, frameIds: [1, 2, 3, 100, 101, 102], frameIndexes: [0, 1, 2, 10, 11, 12] });
  const a = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(curves);
  const b = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(curves);
  assert.equal(a.polylines.length, b.polylines.length);
  assert.equal(a.stats.representativeLineCount, b.stats.representativeLineCount);
  assert.deepEqual(a.polylines.map((p) => p.points.map((q) => [q.localEast, q.localNorth])),
    b.polylines.map((p) => p.points.map((q) => [q.localEast, q.localNorth])));
});

test('revisit-9: method wiring is opt-in and prior methods remain', () => {
  const CAD = loadCAD();
  assert.equal(typeof CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame, 'function');
  assert.equal(typeof CAD.buildRepresentativeLaneLinesPurityFromPerFrame, 'function');
  assert.equal(typeof CAD.buildRepresentativeLaneLinesFromPerFrame, 'function');
  assert.match(RENDER, /representativeMethod=purityRevisit/);
  assert.match(RENDER, /buildRepresentativeLaneLinesPurityRevisitFromPerFrame/);
  assert.match(RENDER, /representativeMethod=purity/);
  const straight = [];
  for (const [f, fi] of [[1, 0], [2, 1], [3, 2]]) {
    straight.push(mkCurve({ gt: 25, frameId: f, frameIndex: fi, points: mkPoints(0, 40, 20, () => 1, f, fi) }));
  }
  assert.equal(CAD.buildRepresentativeLaneLinesFromPerFrame(straight).stats.method, 'curveAssociation');
  assert.equal(CAD.buildRepresentativeLaneLinesPurityFromPerFrame(straight).stats.method, 'purity');
});

test('revisit-13: default representative method is purityRevisit; overrides preserved', () => {
  const sandbox = { console, window: {}, document: {}, navigator: {} };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(RENDER, sandbox, { filename: 'render.js' });
  const R = sandbox.RoadRenderer;
  assert.equal(typeof R.resolveRepresentativeMethod, 'function');
  assert.equal(R.resolveRepresentativeMethod(''), 'purityRevisit');
  assert.equal(R.resolveRepresentativeMethod('?local=1&fit=1'), 'purityRevisit');
  assert.equal(R.resolveRepresentativeMethod('?representativeMethod=purityRevisit'), 'purityRevisit');
  assert.equal(R.resolveRepresentativeMethod('?representativeMethod=purity'), 'purity');
  assert.equal(R.resolveRepresentativeMethod('?representativeMethod=curveAssociation'), 'curveAssociation');
  assert.equal(R.resolveRepresentativeMethod('?representativeMethod=legacy'), 'legacy');
  assert.equal(R.resolveRepresentativeMethod('?representativeMethod=bogus'), 'purityRevisit');
  assert.equal(R.resolveRepresentativeMethod('?representativeMethod=purityRevisit&x=1'), 'purityRevisit');
});

function loadSegMap(name) {
  const VMB = require('../lib/viewer_map_build');
  const SLM = require('../lib/segment_local_map');
  const files = [`qlog_f449c_${name}.bz2`];
  const loaded = require('../lib/qlog_data').loadSegmentsData(ROOT, files, VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require('../lib/process_route');
  const { qualifySegments } = require('../lib/segment_qualify');
  const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
  const sq = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS,
    segmentQualifications: sq,
    fileAudits: loaded.audits,
  });
  const pd = {
    ...result,
    timeline: enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath),
    fileAudits: loaded.audits,
  };
  return SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: false });
}

test('revisit-7: Seg99 red line #7 no longer forms one folded output', () => {
  const CAD = loadCAD();
  const map = loadSegMap('99');
  const perFrame = CAD.buildPerFrameConnectedPolylines(map.pointAccumulated.points || []);
  const built = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(perFrame.polylines);
  assert.equal(foldedLineCount(built.polylines), 0, 'no folded survivor');
  assert.ok((built.stats.purityRejectedSelfFold ?? 0) >= 1, 'the red fold is removed by selfFold');
  // The former 21-point s272-292 fold fragment is gone.
  const foldFrag = built.polylines.filter((pl) => {
    const ss = pl.points.map((p) => p.s);
    return pl.points.length <= 30 && Math.min(...ss) >= 270 && Math.max(...ss) <= 295;
  });
  assert.equal(foldFrag.length, 0);
  assert.equal(overlapPairs(built.polylines), 0);
});

test('revisit-8: Seg99 blue line #3 remains unless independently proven invalid', () => {
  const CAD = loadCAD();
  const map = loadSegMap('99');
  const perFrame = CAD.buildPerFrameConnectedPolylines(map.pointAccumulated.points || []);
  const built = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(perFrame.polylines);
  // The smooth long loop (268-pt, s99-366) must survive: no fold trigger.
  const loop = built.polylines.find((pl) => (pl.coverageM ?? 0) >= 250);
  assert.ok(loop, 'the long supported loop survives');
  assert.equal(CAD.analyzeRepresentativeSelfFold(loop.points).trigger, false);
  assert.ok((built.stats.representativeLineCount ?? 0) >= 12);
});

test('revisit-10: Seg1 retains four logical lanes', () => {
  const CAD = loadCAD();
  const map = loadSegMap('1');
  const perFrame = CAD.buildPerFrameConnectedPolylines(map.pointAccumulated.points || []);
  const built = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(perFrame.polylines);
  assert.equal(built.stats.logicalLaneCount, 4);
  assert.equal(overlapPairs(built.polylines), 0);
  assert.equal(foldedLineCount(built.polylines), 0);
});

test('revisit-11: Seg0 remains aligned and free of the new failure', () => {
  const CAD = loadCAD();
  const map = loadSegMap('0');
  const perFrame = CAD.buildPerFrameConnectedPolylines(map.pointAccumulated.points || []);
  const built = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(perFrame.polylines);
  assert.equal(built.stats.logicalLaneCount, 4);
  assert.equal(overlapPairs(built.polylines), 0);
  assert.equal(foldedLineCount(built.polylines), 0);
  for (const pl of built.polylines) {
    for (const p of pl.points) {
      assert.ok(Number.isFinite(p.localEast) && Number.isFinite(p.localNorth));
      assert.ok(Number.isFinite(p.s) && Number.isFinite(p.d));
    }
  }
});

test('revisit-12: Seg2 keeps its previous cleanup (no V, no detached folds)', () => {
  const CAD = loadCAD();
  const map = loadSegMap('2');
  const perFrame = CAD.buildPerFrameConnectedPolylines(map.pointAccumulated.points || []);
  const built = CAD.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(perFrame.polylines);
  assert.ok(built.polylines.length <= 4, `no fragment storm (got ${built.polylines.length})`);
  assert.equal(overlapPairs(built.polylines), 0);
  assert.equal(foldedLineCount(built.polylines), 0);
  for (const pl of built.polylines) {
    const ds = pl.points.map((p) => p.d);
    assert.ok(Math.max(...ds) - Math.min(...ds) < 15, 'no corridor-scale sweep');
  }
});
