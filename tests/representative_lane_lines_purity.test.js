'use strict';
// Focused purity-candidate fixtures (representativeMethod=purity).
// Fast synthetic cases 1-9 + real-data gates for Seg1/Seg2.
// The default (candidate-off / curveAssociation) path is asserted unchanged.
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

let curveSeq = 0;
function mkCurve({ gt, lane = 0, side = 'right', s0 = 0, s1 = 100, n = 120, frameId = 1, dFn = () => 0, chunk = 0, pass = 0, modelX = 10 }) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const s = s0 + ((s1 - s0) * i) / (n - 1);
    const d = dFn(s, i);
    pts.push({
      localEast: s, localNorth: d, s, d, modelX,
      chunkId: chunk, passId: pass, groupTrackId: gt,
      laneIndex: lane, side, frameId, frameIndex: frameId, prob: 0.9,
    });
  }
  curveSeq += 1;
  return {
    groupId: `syn:${gt}:${frameId}:${curveSeq}`,
    chunkId: chunk, passId: pass, groupTrackId: gt,
    laneIndex: lane, side, frameId, points: pts, pointCount: pts.length,
  };
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

function dRange(pl) {
  const ds = pl.points.map((p) => p.d);
  return Math.max(...ds) - Math.min(...ds);
}

function medianD(pl) {
  const s = pl.points.map((p) => p.d).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

test('purity-1: two corridors sharing one groupTrackId are not averaged', () => {
  const CAD = loadCAD();
  const curves = [];
  // Corridor A has stronger support (3 frames) than corridor B (2 frames), so
  // the same-identity overlap sweep resolves deterministically: A survives,
  // B is rejected with reason, and no line averages both corridors.
  for (let f = 1; f <= 3; f++) {
    curves.push(mkCurve({ gt: 7, s0: 0, s1: 100, n: 120, frameId: f, dFn: (s) => -6 + 0.05 * Math.sin(s) }));
  }
  for (let f = 4; f <= 5; f++) {
    curves.push(mkCurve({ gt: 7, s0: 0, s1: 100, n: 120, frameId: f, dFn: (s) => 6 + 0.05 * Math.sin(s) }));
  }
  const built = CAD.buildRepresentativeLaneLinesPurityFromPerFrame(curves);
  assert.equal(built.stats.method, 'purity');
  assert.equal(overlapPairs(built.polylines), 0);
  for (const pl of built.polylines) {
    assert.ok(dRange(pl) < 8, `no line may span both corridors (dRange ${dRange(pl)})`);
  }
  const survivor = built.polylines.find((pl) => Math.abs(medianD(pl) + 6) < 2);
  assert.ok(survivor, 'the stronger corridor survives as its own line');
});

test('purity-2: genuine single lane across frames merges', () => {
  const CAD = loadCAD();
  const curves = [];
  for (let f = 1; f <= 4; f++) {
    curves.push(mkCurve({ gt: 8, s0: f * 5, s1: 120 + f * 5, frameId: f, dFn: (s) => 2 + 0.1 * Math.sin(s + f) }));
  }
  const built = CAD.buildRepresentativeLaneLinesPurityFromPerFrame(curves);
  assert.equal(built.stats.logicalLaneCount, 1);
  assert.ok(built.polylines.length <= 2, `expected ~1 line, got ${built.polylines.length}`);
});

test('purity-3: crossing (X) modes are rejected, never kept as a middle line', () => {
  const CAD = loadCAD();
  const curves = [
    mkCurve({ gt: 9, s0: 0, s1: 100, frameId: 1, dFn: (s) => (12 * s) / 100 }),
    mkCurve({ gt: 9, s0: 0, s1: 100, frameId: 2, dFn: (s) => (12 * s) / 100 + 0.2 }),
    mkCurve({ gt: 9, s0: 0, s1: 100, frameId: 3, dFn: (s) => 12 - (12 * s) / 100 }),
    mkCurve({ gt: 9, s0: 0, s1: 100, frameId: 4, dFn: (s) => 12 - (12 * s) / 100 + 0.2 }),
  ];
  const built = CAD.buildRepresentativeLaneLinesPurityFromPerFrame(curves);
  for (const pl of built.polylines) {
    assert.ok((pl.purityFlags?.corridorMaxM ?? 0) <= 3.0, 'survivors stay inside corridor');
  }
  assert.ok((built.stats.purityRejectedCorridor ?? 0) >= 1, 'the between-mode median is rejected');
});

test('purity-4: bimodal station support is not averaged', () => {
  const CAD = loadCAD();
  const curves = [
    mkCurve({ gt: 10, s0: 0, s1: 50, frameId: 1, dFn: () => -5 }),
    mkCurve({ gt: 10, s0: 0, s1: 50, frameId: 2, dFn: () => -5.1 }),
    mkCurve({ gt: 10, s0: 0, s1: 50, frameId: 3, dFn: () => 5 }),
    mkCurve({ gt: 10, s0: 0, s1: 50, frameId: 4, dFn: () => 5.1 }),
  ];
  const built = CAD.buildRepresentativeLaneLinesPurityFromPerFrame(curves);
  assert.ok(built.polylines.length >= 1);
  for (const pl of built.polylines) {
    assert.ok(dRange(pl) < 4, `no line averages both modes (dRange ${dRange(pl)})`);
  }
});

test('purity-5: transitive A-B-C cannot merge incompatible A and C', () => {
  const CAD = loadCAD();
  const curves = [
    mkCurve({ gt: 11, s0: 0, s1: 100, frameId: 1, dFn: () => 0 }),
    mkCurve({ gt: 11, s0: 0, s1: 100, frameId: 2, dFn: () => 0.2 }),
    mkCurve({ gt: 11, s0: 0, s1: 100, frameId: 3, dFn: () => 0.1 }),
    // C agrees with A/B early, then drifts 20 m away and persists there
    // (equal 3v3 support, so both modes survive the sweep and the test can
    // verify they never share one output line).
    mkCurve({ gt: 11, s0: 0, s1: 100, frameId: 4, dFn: (s) => (s < 40 ? 0.1 : 0.1 + 20 * Math.min(1, (s - 40) / 40)) }),
    mkCurve({ gt: 11, s0: 0, s1: 100, frameId: 5, dFn: (s) => (s < 40 ? 0 : 0.2 + 20 * Math.min(1, (s - 40) / 40)) }),
    mkCurve({ gt: 11, s0: 0, s1: 100, frameId: 6, dFn: (s) => (s < 40 ? 0.05 : 0.15 + 20 * Math.min(1, (s - 40) / 40)) }),
  ];
  const built = CAD.buildRepresentativeLaneLinesPurityFromPerFrame(curves);
  const cCurve = curves[3];
  const holders = built.polylines.filter((pl) => (pl.distinctCurveIds || []).includes(cCurve.groupId));
  // Equal 3v3 support: both modes survive the sweep, so holders is non-empty
  // and the assertion below genuinely verifies the split.
  assert.ok(holders.length >= 1, 'C mode survives as its own line');
  const aIds = new Set([curves[0].groupId, curves[1].groupId, curves[2].groupId]);
  for (const h of holders) {
    const shared = (h.distinctCurveIds || []).filter((id) => aIds.has(id));
    assert.equal(shared.length, 0, 'no line mixes A-family and C curves');
  }
  assert.ok(built.stats.logicalLaneCount >= 1);
});

test('purity-6: different passes never merge', () => {
  const CAD = loadCAD();
  const curves = [
    mkCurve({ gt: 12, pass: 0, s0: 0, s1: 100, frameId: 1, dFn: () => 1 }),
    mkCurve({ gt: 12, pass: 0, s0: 0, s1: 100, frameId: 2, dFn: () => 1.1 }),
    mkCurve({ gt: 12, pass: 1, s0: 0, s1: 100, frameId: 3, dFn: () => 1 }),
    mkCurve({ gt: 12, pass: 1, s0: 0, s1: 100, frameId: 4, dFn: () => 1.1 }),
  ];
  const built = CAD.buildRepresentativeLaneLinesPurityFromPerFrame(curves);
  const passes = new Set(built.polylines.map((pl) => String(pl.passId)));
  assert.ok(passes.size >= 2, 'separate passes must not merge');
});

test('purity-7: spatial revisits never merge', () => {
  const CAD = loadCAD();
  const curves = [
    mkCurve({ gt: 13, s0: 0, s1: 100, frameId: 1, dFn: () => 2 }),
    mkCurve({ gt: 13, s0: 0, s1: 100, frameId: 2, dFn: () => 2.1 }),
    mkCurve({ gt: 13, s0: 500, s1: 600, frameId: 3, dFn: () => 2 }),
    mkCurve({ gt: 13, s0: 500, s1: 600, frameId: 4, dFn: () => 2.1 }),
  ];
  const built = CAD.buildRepresentativeLaneLinesPurityFromPerFrame(curves);
  assert.ok(built.stats.logicalLaneCount >= 2, 'revisit strands stay separate');
  for (const pl of built.polylines) {
    const ss = pl.points.map((p) => p.s);
    assert.ok(Math.max(...ss) - Math.min(...ss) < 450, 'no bridge across the revisit gap');
  }
});

test('purity-8: provenance survives resampling and fitting', () => {
  const CAD = loadCAD();
  const curves = [];
  for (let f = 1; f <= 4; f++) {
    curves.push(mkCurve({ gt: 14, s0: 0, s1: 120, frameId: f, dFn: (s) => 2 + 0.1 * Math.sin(s + f) }));
  }
  const built = CAD.buildRepresentativeLaneLinesPurityFromPerFrame(curves);
  assert.ok(built.polylines.length >= 1);
  for (const pl of built.polylines) {
    for (const p of pl.points) {
      assert.ok((p.binMeta?.sourceCurveIds || []).length >= 1, 'station keeps curve ids');
      assert.ok((p.binMeta?.sourceFrameIds || []).length >= 1, 'station keeps frame ids');
    }
    assert.equal(pl.supportCurveCount, 4);
    assert.equal(pl.supportFrameCount, 4);
    assert.equal(pl.verificationState, 'verified');
  }
});

test('purity-9: candidate-off output and method wiring unchanged', () => {
  const CAD = loadCAD();
  assert.equal(typeof CAD.buildRepresentativeLaneLinesLegacyFromPerFrame, 'function');
  assert.equal(typeof CAD.buildRepresentativeLaneLinesFromPerFrame, 'function');
  assert.equal(typeof CAD.buildRepresentativeLaneLinesPurityFromPerFrame, 'function');
  // Purity is opt-in only; the default stays the corrected association method.
  assert.match(RENDER, /representativeMethod=purity/);
  assert.match(RENDER, /buildRepresentativeLaneLinesPurityFromPerFrame/);
  assert.match(RENDER, /representativeMethod=legacy/);
  // Default builder behaviour on a clean fixture is untouched.
  const curves = [];
  for (let f = 1; f <= 4; f++) {
    curves.push(mkCurve({ gt: 15, s0: 0, s1: 120, frameId: f, dFn: (s) => -2 + 0.1 * Math.sin(s) }));
  }
  const base = CAD.buildRepresentativeLaneLinesFromPerFrame(curves);
  assert.equal(base.stats.method, 'curveAssociation');
  assert.equal(base.stats.logicalLaneCount, 1);
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

test('purity-R1: Seg2 purity removes artifacts, keeps the long road-hugging tracks', () => {
  const CAD = loadCAD();
  const map = loadSegMap('2');
  const perFrame = CAD.buildPerFrameConnectedPolylines(map.pointAccumulated.points || []);
  const built = CAD.buildRepresentativeLaneLinesPurityFromPerFrame(perFrame.polylines);
  assert.equal(overlapPairs(built.polylines), 0);
  for (const pl of built.polylines) {
    assert.ok(dRange(pl) < 15, `no corridor-scale sweep survives (got ${dRange(pl)})`);
  }
  const longTracks = built.polylines.filter((pl) => (pl.coverageM ?? 0) >= 500);
  assert.ok(longTracks.length >= 2, `long road-hugging tracks survive (got ${longTracks.length})`);
  assert.ok((built.stats.purityRejectedLines || []).length >= 1, 'artifact rejections are recorded');
});

test('purity-R2: Seg1 purity preserves the four logical lanes with many-to-few', () => {
  const CAD = loadCAD();
  const map = loadSegMap('1');
  const perFrame = CAD.buildPerFrameConnectedPolylines(map.pointAccumulated.points || []);
  const built = CAD.buildRepresentativeLaneLinesPurityFromPerFrame(perFrame.polylines);
  assert.equal(built.stats.logicalLaneCount, 4);
  assert.equal(overlapPairs(built.polylines), 0);
  assert.ok(built.stats.representativeLineCount <= 20, `no fragment storm (got ${built.stats.representativeLineCount})`);
  assert.ok((built.stats.reductionRatio ?? 0) >= 3, `many-to-few kept (got ${built.stats.reductionRatio})`);
});
