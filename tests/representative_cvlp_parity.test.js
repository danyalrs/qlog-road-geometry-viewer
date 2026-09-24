'use strict';

// Focused tests: representative points must project through the SAME combined
// visible-lane projection (CVLP) as their source point-accumulated dots.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
function load(src) {
  const sb = { console, module: { exports: {} }, exports: {} };
  sb.global = sb; sb.window = sb;
  vm.runInNewContext(src, sb, { filename: 'm.js' });
  return sb.CombinedVisibleLaneProjection || sb.module.exports;
}
const CVLP = load(fs.readFileSync(path.join(ROOT, 'public/combined_visible_lane_projection.js'), 'utf8'));

function eligibleMap() {
  return {
    boundaryAnchoredOrientationActive: true,
    isMultiSource: true,
    sourceTransformByFile: { 'segA.bz2': { displayCorrection: true } },
    baselineTrajectory: [{ s: 0, sourceFile: 'segA.bz2', east: 0, north: 0 }, { s: 100, sourceFile: 'segA.bz2', east: 100, north: 0 }],
    trajectory: [{ s: 0, sourceFile: 'segA.bz2', placedEast: 0, placedNorth: 5 }, { s: 100, sourceFile: 'segA.bz2', placedEast: 100, placedNorth: 5 }],
  };
}
function dot(placedEast, placedNorth) {
  return { sourceFile: 'segA.bz2', groupTrackId: 0, laneIndex: 0, side: 'right', chunkId: 0, passId: 0, s: 30, frameId: 10, coordinateFrame: 'combinedPlaced', placedEast, placedNorth, localEast: placedEast + 100, localNorth: placedNorth + 100 };
}
const OPTS = { mirrorChecked: true, search: '', useVisibleLaneProjection: true };

test('1. representativeLaneLines is an approved CVLP kind (enters CVLP)', () => {
  const r = CVLP.projectCombinedSourceLanePoint(dot(1, 2), eligibleMap(), 'representativeLaneLines', OPTS);
  assert.ok(r && Number.isFinite(r.east) && Number.isFinite(r.north), 'non-null projection');
});

test('2. dots and representative points project identically (same source point, both kinds)', () => {
  const map = eligibleMap();
  const p = dot(3, 4);
  const asDot = CVLP.projectCombinedSourceLanePoint(p, map, 'pointAccumulated', OPTS);
  const asRep = CVLP.projectCombinedSourceLanePoint(p, map, 'representativeLaneLines', OPTS);
  assert.equal(asRep.east, asDot.east);
  assert.equal(asRep.north, asDot.north);
  assert.equal(asRep.reason, asDot.reason);
});

test('3/4. parity holds for mirror=0 and mirror=1', () => {
  for (const mirror of [false, true]) {
    const map = eligibleMap();
    const p = dot(7, -2);
    const o = { mirrorChecked: mirror, search: '', useVisibleLaneProjection: true };
    const a = CVLP.projectCombinedSourceLanePoint(p, map, 'pointAccumulated', o);
    const b = CVLP.projectCombinedSourceLanePoint(p, map, 'representativeLaneLines', o);
    if (a == null || b == null) { assert.equal(a, b, `mirror=${mirror}: both fall back identically`); continue; }
    assert.equal(b.east, a.east, `mirror=${mirror}`);
    assert.equal(b.north, a.north, `mirror=${mirror}`);
  }
});

test('5. combinedPlaced display-correction source returns placed coords for both kinds', () => {
  const map = eligibleMap();
  const p = dot(11, 22);
  const a = CVLP.projectCombinedSourceLanePoint(p, map, 'pointAccumulated', OPTS);
  const b = CVLP.projectCombinedSourceLanePoint(p, map, 'representativeLaneLines', OPTS);
  assert.equal(a.east, 11); assert.equal(a.north, 22);
  assert.equal(b.east, 11); assert.equal(b.north, 22);
  assert.equal(b.reason, 'placedExactCorrection');
});

test('6. standalone (non-combined) map: CVLP not eligible -> caller falls back (returns null)', () => {
  const map = { boundaryAnchoredOrientationActive: false, isMultiSource: false, sourceTransformByFile: {} };
  const r = CVLP.projectCombinedSourceLanePoint(dot(1, 2), map, 'representativeLaneLines', OPTS);
  assert.equal(r, null);
});

test('10. missing sourceFile uses a safe fallback (placed coords) with a recorded reason', () => {
  const map = eligibleMap();
  const p = { ...dot(5, 6), sourceFile: null, s: null, frameId: null, frameIndex: null };
  const r = CVLP.projectCombinedSourceLanePoint(p, map, 'representativeLaneLines', OPTS);
  assert.ok(r, 'returns a value');
  assert.equal(r.corrected, false);
  assert.ok(/missing/.test(r.reason || ''), `reason=${r.reason}`);
  assert.equal(r.east, 5);
  assert.equal(r.north, 6);
});

test('11. no input mutation', () => {
  const map = eligibleMap();
  const p = dot(1, 2);
  const before = JSON.stringify({ p, map });
  CVLP.projectCombinedSourceLanePoint(p, map, 'representativeLaneLines', OPTS);
  assert.equal(JSON.stringify({ p, map }), before);
});

test('17. deterministic repeated projection', () => {
  const map = eligibleMap();
  const p = dot(9, -3);
  const a = CVLP.projectCombinedSourceLanePoint(p, map, 'representativeLaneLines', OPTS);
  const b = CVLP.projectCombinedSourceLanePoint(p, map, 'representativeLaneLines', OPTS);
  assert.deepEqual(a, b);
});

// --- canonical provenance ---
const CAD2 = (() => { const fs2 = require('fs'); const p2 = require('path'); const vm2 = require('vm'); const ROOT2 = p2.join(__dirname, '..'); const src = fs2.readFileSync(p2.join(ROOT2, 'public/connected_accumulated_display.js'), 'utf8'); const sb = { console, module: { exports: {} }, exports: {} }; sb.global = sb; sb.window = sb; vm2.runInNewContext(src, sb, { filename: 'cad.js' }); return sb.ConnectedAccumulatedDisplay; })();

function mapNoDisplayCorrection() {
  return {
    boundaryAnchoredOrientationActive: true, isMultiSource: true,
    sourceTransformByFile: { 'segA.bz2': {} },
    baselineTrajectory: [{ s: 30, frameId: 10, sourceFile: 'segA.bz2', east: 100, north: 0 }],
    trajectory: [{ s: 30, frameId: 10, sourceFile: 'segA.bz2', placedEast: 100, placedNorth: 5 }],
    referencePose: { north: 0 },
  };
}
test('C1. canonical point resolves (reason is not missingCanonical)', () => {
  const map = mapNoDisplayCorrection();
  const p = { sourceFile: 'segA.bz2', s: 30, frameId: 10, coordinateFrame: 'combinedPlaced', placedEast: 100, placedNorth: 5, sourceCanonicalLocalEast: 100, sourceCanonicalLocalNorth: 0, localEast: 100, localNorth: 0 };
  const r = CVLP.projectCombinedSourceLanePoint(p, map, 'representativeLaneLines', OPTS);
  assert.ok(r, 'non-null');
  assert.notEqual(r.reason, 'missingCanonical');
});
test('C2. point without canonical rejects with missingCanonical', () => {
  const map = mapNoDisplayCorrection();
  const p = { sourceFile: 'segA.bz2', s: 30, frameId: 10, coordinateFrame: 'combinedPlaced', placedEast: 100, placedNorth: 5, localEast: 100, localNorth: 0 };
  const r = CVLP.projectCombinedSourceLanePoint(p, map, 'representativeLaneLines', OPTS);
  assert.ok(r, 'non-null (safe fallback)');
  assert.equal(r.reason, 'missingCanonical');
  assert.equal(r.corrected, false);
});
test('C3. representative points carry a matched canonical+placed pair (offline synthetic combined map)', () => {
  const VMB = require(path.join(__dirname, '..', 'lib/viewer_map_build'));
  const SLM = require(path.join(__dirname, '..', 'lib/segment_local_map'));
  const ROOT3 = path.join(__dirname, '..');
  const loaded = require(path.join(ROOT3, 'lib/qlog_data')).loadSegmentsData(ROOT3, ['qlog_f449c_14.bz2'], VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require(path.join(ROOT3, 'lib/process_route'));
  const { qualifySegments } = require(path.join(ROOT3, 'lib/segment_qualify'));
  const { enrichTimelineWithMovement } = require(path.join(ROOT3, 'lib/vehicle_movement_display'));
  const sq = qualifySegments(loaded.audits);
  const r = processRoute(loaded.modelEvents, loaded.gpsEvents, { ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS, segmentQualifications: sq, fileAudits: loaded.audits });
  const pd = { ...r, timeline: enrichTimelineWithMovement(buildTimeline(r.frames), r.vehiclePath), fileAudits: loaded.audits };
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true });
  const pts = (map.pointAccumulated.points || []).map((p) => ({ ...p, placedEast: p.localEast, placedNorth: p.localNorth, sourceCanonicalLocalEast: p.localEast, sourceCanonicalLocalNorth: p.localNorth, sourceMirroredLocalEast: -p.localEast, sourceMirroredLocalNorth: p.localNorth, coordinateFrame: 'combinedPlaced' }));
  const pf = CAD2.buildPerFrameConnectedPolylines(pts);
  const on = CAD2.buildRepresentativeLaneLinesPurityRevisitFromPerFrame(pf.polylines, { representativeStationSupportCandidate: true });
  let both = 0; let canonOnly = 0; let total = 0;
  for (const pl of on.polylines) for (const p of pl.points) { total += 1; const c = Number.isFinite(p.sourceCanonicalLocalEast) && Number.isFinite(p.sourceCanonicalLocalNorth); const q = Number.isFinite(p.placedEast) && Number.isFinite(p.placedNorth); if (c && q) both += 1; else if (c) canonOnly += 1; }
  assert.ok(total > 0);
  assert.equal(both, total, 'every representative point has a matched canonical+placed pair');
  assert.equal(canonOnly, 0);
});
test('C4. groupTrackId unchanged by provenance propagation', () => {
  const p = { sourceFile: 'segA.bz2', groupTrackId: 7, laneIndex: 2, side: 'left', s: 30, frameId: 10, coordinateFrame: 'combinedPlaced', placedEast: 1, placedNorth: 2, sourceCanonicalLocalEast: 3, sourceCanonicalLocalNorth: 4 };
  const r = CVLP.projectCombinedSourceLanePoint(p, mapNoDisplayCorrection(), 'representativeLaneLines', OPTS);
  assert.equal(p.groupTrackId, 7);
  assert.ok(r);
});
