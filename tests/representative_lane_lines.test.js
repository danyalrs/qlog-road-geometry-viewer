'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const LGUI = require('../lib/local_geometry_ui');

const ROOT = path.join(__dirname, '..');
const CAD_SRC = fs.readFileSync(path.join(ROOT, 'public/connected_accumulated_display.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const RENDER = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');

function loadCAD() {
  const sandbox = { console, module: { exports: {} }, exports: {} };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(CAD_SRC, sandbox, { filename: 'connected_accumulated_display.js' });
  return sandbox.ConnectedAccumulatedDisplay || sandbox.module.exports;
}

function synthPerFrameCurves() {
  // Two lanes × 4 frames of overlapping curves along +east
  const curves = [];
  for (const lane of [0, 1]) {
    for (let f = 0; f < 4; f++) {
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const s = i * 2 + f * 0.2;
        const jitter = ((f * 0.03) + (i * 0.01)) * (lane === 0 ? 1 : -1);
        pts.push({
          localEast: s,
          localNorth: (lane === 0 ? -3.5 : 3.5) + jitter,
          s,
          d: lane === 0 ? -3.5 : 3.5,
          chunkId: 0,
          passId: 0,
          groupTrackId: lane + 1,
          laneIndex: lane,
          side: lane === 0 ? 'right' : 'left',
          frameId: 100 + f,
          frameIndex: f,
          logMonoTime: String(1_000_000_000n * BigInt(f)),
          prob: 0.9,
        });
      }
      curves.push({
        groupId: `0:0:${lane + 1}:${lane}:${lane === 0 ? 'right' : 'left'}:fid:${100 + f}`,
        chunkId: 0,
        passId: 0,
        groupTrackId: lane + 1,
        laneIndex: lane,
        side: lane === 0 ? 'right' : 'left',
        frameId: 100 + f,
        points: pts,
        pointCount: pts.length,
      });
    }
  }
  return curves;
}

test('1. defaults: local + pointAccumulated + connected enabled + perFrame', () => {
  assert.equal(LGUI.LOCAL_GEOMETRY_DEFAULT_MODE, 'pointAccumulated');
  assert.equal(LGUI.VIZ_MODE_DEFAULT, 'local');
  assert.equal(LGUI.CONNECTED_ACCUMULATED_DEFAULT_ENABLED, true);
  assert.equal(LGUI.CONNECTED_ACCUMULATED_DEFAULT_MODE, 'perFrame');
  assert.match(INDEX, /id="layerConnectedAccumulated"[^>]*checked/);
  assert.match(INDEX, /option value="perFrame" selected/);
  assert.match(INDEX, /id="layerRepresentativeLaneLines"/);
});

test('2. URL overrides for connected defaults', () => {
  assert.equal(LGUI.resolveInitialConnectedAccumulatedEnabled('?connected=0', '1', true), false);
  assert.equal(LGUI.resolveInitialConnectedAccumulatedMode('?connectedMode=currentFrame', 'perFrame', 'perFrame'), 'currentFrame');
  assert.equal(LGUI.resolveInitialConnectedAccumulatedMode('', 'currentFrame', 'perFrame'), 'currentFrame');
  assert.equal(LGUI.resolveInitialConnectedAccumulatedEnabled('', null, true), true);
});

test('3. representative builder associates curves into few logical lanes', () => {
  const CAD = loadCAD();
  assert.equal(typeof CAD.buildRepresentativeLaneLinesFromPerFrame, 'function');
  assert.equal(typeof CAD.buildRobustConnectedPolylines, 'function');
  const curves = synthPerFrameCurves();
  const built = CAD.buildRepresentativeLaneLinesFromPerFrame(curves);
  assert.equal(built.stats.mode, 'representativeFromPerFrame');
  assert.equal(built.stats.reusedStage, 'curveAssociationStationFit');
  assert.equal(built.stats.sourceCurveCount, curves.length);
  // 8 source curves (2 lanes x 4 frames) collapse to ~2 logical lanes.
  assert.ok(built.stats.logicalLaneCount <= 3, `logicalLaneCount ${built.stats.logicalLaneCount}`);
  assert.ok(built.stats.logicalLaneCount >= 1);
  assert.ok(built.stats.representativeLineCount >= 1);
  assert.ok(built.polylines.length >= 1);
  // No cross-lane identity inside a polyline
  for (const pl of built.polylines) {
    const ids = new Set((pl.points || []).map((p) => p.groupTrackId));
    assert.equal(ids.size, 1);
  }
});

test('3b. repeated overlapping curves produce many-to-few representative lines', () => {
  const CAD = loadCAD();
  // 2 physical lanes x 6 frames = 12 overlapping source curves.
  const curves = [];
  for (const lane of [0, 1]) {
    for (let f = 0; f < 6; f++) {
      const pts = [];
      for (let i = 0; i < 12; i++) {
        const s = i * 2 + f * 0.4;
        const jitter = ((f * 0.02) + (i * 0.005)) * (lane === 0 ? 1 : -1);
        pts.push({
          localEast: s,
          localNorth: (lane === 0 ? -3.5 : 3.5) + jitter,
          s,
          d: (lane === 0 ? -3.5 : 3.5) + jitter,
          modelX: s,
          chunkId: 0,
          passId: 0,
          groupTrackId: lane + 1,
          laneIndex: lane,
          side: lane === 0 ? 'right' : 'left',
          frameId: 200 + f,
          frameIndex: f,
          prob: 0.9,
        });
      }
      curves.push({
        groupId: `0:0:${lane + 1}:${lane}:${lane === 0 ? 'right' : 'left'}:fid:${200 + f}`,
        chunkId: 0,
        passId: 0,
        groupTrackId: lane + 1,
        laneIndex: lane,
        side: lane === 0 ? 'right' : 'left',
        frameId: 200 + f,
        points: pts,
        pointCount: pts.length,
      });
    }
  }
  const built = CAD.buildRepresentativeLaneLinesFromPerFrame(curves);
  assert.equal(built.stats.sourceCurveCount, 12);
  // Source-to-representative reduction must be substantial.
  assert.ok(built.stats.representativeLineCount < 6,
    `expected many-to-few, got ${built.stats.representativeLineCount}`);
  assert.ok((built.stats.reductionRatio ?? 1) >= 2);
  // Representative must have multi-frame support.
  assert.ok((built.stats.medianSupportFrames ?? 0) >= 2);
});

test('4. weak curves rejected; pass separation preserved', () => {
  const CAD = loadCAD();
  const weak = [{
    groupId: 'weak',
    chunkId: 0,
    passId: 0,
    groupTrackId: 9,
    points: [
      { localEast: 0, localNorth: 0, s: 0, d: 0, chunkId: 0, passId: 0, groupTrackId: 9, frameId: 1, prob: 1 },
      { localEast: 0.5, localNorth: 0, s: 0.5, d: 0, chunkId: 0, passId: 0, groupTrackId: 9, frameId: 1, prob: 1 },
    ],
  }];
  const a = CAD.buildRepresentativeLaneLinesFromPerFrame(weak);
  assert.equal(a.stats.rejectedCurveCount, 1);
  assert.equal(a.stats.representativeLineCount, 0);

  const passCurves = synthPerFrameCurves();
  for (const c of passCurves.slice(0, 4)) {
    c.passId = 1;
    for (const p of c.points) p.passId = 1;
  }
  const b = CAD.buildRepresentativeLaneLinesFromPerFrame(passCurves);
  const passes = new Set(b.polylines.map((pl) => String(pl.passId)));
  assert.ok(passes.size >= 2, 'separate passes must not merge');
});

test('5. render/app wire dual controls and thicker representative stroke', () => {
  assert.match(RENDER, /_drawRepresentativeLaneLines/);
  assert.match(RENDER, /buildRepresentativeLaneLinesFromPerFrame/);
  assert.match(RENDER, /representativeLaneLines/);
  assert.match(APP, /layerRepresentativeLaneLines/);
  assert.match(APP, /initConnectedAccumulatedControls/);
  assert.match(APP, /resolveInitialConnectedAccumulatedMode/);
  assert.match(APP, /representativeLaneLinesCandidate/);
});

test('6. real Seg1 map: per-frame → representative is deterministic and identity-safe', () => {
  const VMB = require('../lib/viewer_map_build');
  const SLM = require('../lib/segment_local_map');
  const CAD = loadCAD();
  const files = ['qlog_f449c_1.bz2'];
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
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: false });
  const pts = map.pointAccumulated?.points || [];
  assert.ok(pts.length > 100);
  const perFrame = CAD.buildPerFrameConnectedPolylines(pts);
  assert.ok(perFrame.polylines.length > 10);
  const a = CAD.buildRepresentativeLaneLinesFromPerFrame(perFrame.polylines);
  const b = CAD.buildRepresentativeLaneLinesFromPerFrame(perFrame.polylines);
  assert.equal(a.polylines.length, b.polylines.length);
  assert.equal(a.stats.representativeLineCount, b.stats.representativeLineCount);
  for (const pl of a.polylines) {
    const chunks = new Set((pl.points || []).map((p) => String(p.chunkId)));
    const passes = new Set((pl.points || []).map((p) => String(p.passId)));
    assert.equal(chunks.size, 1);
    assert.equal(passes.size, 1);
  }
});

test('7. real Seg1 map: many-to-few association, no cross-frame fragment storm', () => {
  const VMB = require('../lib/viewer_map_build');
  const SLM = require('../lib/segment_local_map');
  const CAD = loadCAD();
  const files = ['qlog_f449c_1.bz2'];
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
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: false });
  const pts = map.pointAccumulated?.points || [];
  const perFrame = CAD.buildPerFrameConnectedPolylines(pts);
  const sourceCurves = perFrame.polylines;
  const sourceFrames = new Set(sourceCurves.map((c) => c.frameId ?? c.frameIndex)).size;
  assert.ok(sourceFrames >= 20, 'Seg1 has >= 20 source frames');
  const built = CAD.buildRepresentativeLaneLinesFromPerFrame(sourceCurves);
  const s = built.stats;
  // The old bug produced ~1 output per source curve (91 -> 89). We now require
  // a substantial reduction and a handful of logical lane clusters.
  assert.ok(s.sourceCurveCount === sourceCurves.length);
  assert.ok(s.representativeLineCount <= Math.max(4, Math.ceil(s.sourceCurveCount / 5)),
    `many-to-few expected <= ~${Math.max(4, Math.ceil(s.sourceCurveCount / 5))}, got ${s.representativeLineCount}`);
  assert.ok(s.logicalLaneCount >= 3 && s.logicalLaneCount <= 8,
    `logical lane count in range 3..8, got ${s.logicalLaneCount}`);
  assert.ok((s.reductionRatio ?? 0) >= 3, `reduction ratio >= 3, got ${s.reductionRatio}`);
  // Representative lines must have real multi-frame support.
  const supports = built.polylines.map((pl) => pl.supportCount).filter(Number.isFinite);
  assert.ok(supports.length === built.polylines.length);
  assert.ok(supports.every((x) => x >= 2), 'every representative line has >= 2 supporting frames');
  // No non-finite geometry.
  for (const pl of built.polylines) {
    for (const p of pl.points || []) {
      assert.ok(Number.isFinite(p.localEast) && Number.isFinite(p.localNorth));
      assert.ok(Number.isFinite(p.s) && Number.isFinite(p.d));
    }
  }
  // Long main tracks: the well-supported lanes should each cover a large span.
  const longSpans = built.polylines.map((pl) => pl.coverageM ?? 0).filter((x) => x >= 300);
  assert.ok(longSpans.length >= 2, `at least 2 representative lines span >= 300 m (got ${longSpans.length})`);
});
