'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const LGUI = require('../lib/local_geometry_ui');
const PALP = require('../lib/point_accumulated_lane_polylines');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');
const CVLP = require('../lib/combined_visible_lane_projection');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const RENDER = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

function processSelection(segments) {
  const files = segments.map((s) => `qlog_f449c_${s}.bz2`);
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
  return {
    ...result,
    timeline: enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath),
    fileAudits: loaded.audits,
  };
}

function displayPointsFromMap(map) {
  return (map.pointAccumulated?.points || []).map((p) => {
    const r = CVLP.projectCombinedSourceLanePoint(p, map, 'pointAccumulated', {
      mirrorChecked: true,
      useVisibleLaneProjection: true,
    });
    const east = r?.corrected ? r.east : (p.placedEast ?? p.localEast);
    const north = r?.corrected ? r.north : (p.placedNorth ?? p.localNorth);
    return { ...p, east, north, placedEast: east, placedNorth: north };
  }).filter((p) => Number.isFinite(p.east) && Number.isFinite(p.north) && Number.isFinite(p.s));
}

test('1. default UI modes are local + pointAccumulated', () => {
  assert.equal(LGUI.LOCAL_GEOMETRY_DEFAULT_MODE, 'pointAccumulated');
  assert.equal(LGUI.VIZ_MODE_DEFAULT, 'local');
  assert.match(INDEX, /value="local" selected/);
  assert.match(INDEX, /value="pointAccumulated" selected/);
  assert.doesNotMatch(INDEX, /value="fused" selected/);
});

test('2. URL overrides still win over defaults and session', () => {
  assert.equal(LGUI.resolveInitialVizMode('?viz=global', 'local', 'local'), 'global');
  assert.equal(LGUI.resolveInitialVizMode('?local=1', 'global', 'global'), 'local');
  assert.equal(LGUI.resolveInitialLocalGeometryMode('?geometry=fused', 'pointAccumulated', 'pointAccumulated'), 'fused');
  assert.equal(LGUI.resolveInitialLocalGeometryMode('', 'observations', 'pointAccumulated'), 'observations');
  assert.equal(LGUI.resolveInitialLocalGeometryMode('', null, null), 'pointAccumulated');
  assert.equal(LGUI.resolveInitialVizMode('', null, null), 'local');
});

test('3. stable point grouping by chunk/pass/groupTrackId not colour', () => {
  const pts = [
    { east: 0, north: 0, s: 0, d: 1, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 1, supportFrameCount: 2 },
    { east: 1, north: 0, s: 1, d: 1, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 1, supportFrameCount: 2 },
    { east: 0, north: 2, s: 0, d: -1, chunkId: 0, passId: 0, groupTrackId: 2, laneIndex: 2, supportFrameCount: 2 },
  ];
  const groups = PALP.groupPoints(pts);
  assert.equal(groups.size, 2);
  assert.ok(groups.has('0:0:1:L1'));
  assert.ok(groups.has('0:0:2:L2'));
});

test('4. stable along-track ordering', () => {
  const ordered = PALP.orderAndDedupe([
    { s: 5, d: 0, east: 5, north: 0, prob: 1 },
    { s: 1, d: 0, east: 1, north: 0, prob: 1 },
    { s: 3, d: 0, east: 3, north: 0, prob: 1 },
  ]);
  assert.deepEqual(ordered.map((p) => p.s), [1, 3, 5]);
});

test('5. gap splitting', () => {
  const built = PALP.buildPointAccumulatedLanePolylines([
    { east: 0, north: 0, s: 0, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 3, prob: 1 },
    { east: 2, north: 0, s: 2, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 3, prob: 1 },
    { east: 4, north: 0, s: 4, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 3, prob: 1 },
    // large gap
    { east: 40, north: 0, s: 40, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 3, prob: 1 },
    { east: 42, north: 0, s: 42, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 3, prob: 1 },
    { east: 44, north: 0, s: 44, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 3, prob: 1 },
  ], { maxGapS: 12, maxStepM: 16, minPoints: 3 });
  assert.equal(built.polylines.length, 2);
  assert.ok((built.diagnostics.splitReasonCounts.largeAlongTrackGap || 0) >= 1
    || (built.diagnostics.splitReasonCounts.largeSpatialGap || 0) >= 1);
});

test('6. pass/chunk separation', () => {
  const built = PALP.buildPointAccumulatedLanePolylines([
    { east: 0, north: 0, s: 0, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
    { east: 1, north: 0, s: 1, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
    { east: 2, north: 0, s: 2, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
    { east: 3, north: 0, s: 3, d: 0, chunkId: 0, passId: 1, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
    { east: 4, north: 0, s: 4, d: 0, chunkId: 0, passId: 1, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
    { east: 5, north: 0, s: 5, d: 0, chunkId: 0, passId: 1, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
  ]);
  assert.equal(built.polylines.length, 2);
  assert.notEqual(built.polylines[0].passId, built.polylines[1].passId);
});

test('7. no cross-lane connection', () => {
  const built = PALP.buildPointAccumulatedLanePolylines([
    { east: 0, north: 1, s: 0, d: 1, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 1, supportFrameCount: 2, prob: 1 },
    { east: 1, north: 1, s: 1, d: 1, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 1, supportFrameCount: 2, prob: 1 },
    { east: 2, north: 1, s: 2, d: 1, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 1, supportFrameCount: 2, prob: 1 },
    { east: 0, north: -1, s: 0, d: -1, chunkId: 0, passId: 0, groupTrackId: 2, laneIndex: 2, supportFrameCount: 2, prob: 1 },
    { east: 1, north: -1, s: 1, d: -1, chunkId: 0, passId: 0, groupTrackId: 2, laneIndex: 2, supportFrameCount: 2, prob: 1 },
    { east: 2, north: -1, s: 2, d: -1, chunkId: 0, passId: 0, groupTrackId: 2, laneIndex: 2, supportFrameCount: 2, prob: 1 },
  ]);
  assert.equal(built.polylines.length, 2);
  for (const poly of built.polylines) {
    const ids = new Set(poly.points.map((p) => p.groupTrackId));
    assert.equal(ids.size, 1);
  }
});

test('8. Seg99-style revisit does not bridge backward along-track', () => {
  const built = PALP.buildPointAccumulatedLanePolylines([
    { east: 0, north: 0, s: 10, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
    { east: 1, north: 0, s: 11, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
    { east: 2, north: 0, s: 12, d: 0, chunkId: 0, passId: 0, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
    // revisit / backward s after ordering would be sorted; simulate two passes instead
    { east: 0, north: 0, s: 10, d: 0, chunkId: 0, passId: 1, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
    { east: 1, north: 0, s: 11, d: 0, chunkId: 0, passId: 1, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
    { east: 2, north: 0, s: 12, d: 0, chunkId: 0, passId: 1, groupTrackId: 1, laneIndex: 0, supportFrameCount: 2, prob: 1 },
  ]);
  assert.equal(built.polylines.length, 2);
  const audit = PALP.auditPolylineSet(built.polylines);
  assert.equal(audit.crossPassCount, 0);
  assert.equal(audit.backwardOrderingCount, 0);
});

test('9. candidate disabled means helper inactive by default', () => {
  assert.equal(PALP.parsePointAccumulatedLanePolylineCandidate(''), false);
  assert.equal(PALP.parsePointAccumulatedLanePolylineCandidate('?pointAccumulatedLanePolylineCandidate=0'), false);
  assert.equal(PALP.parsePointAccumulatedLanePolylineCandidate('?pointAccumulatedLanePolylineCandidate=1'), true);
  assert.match(RENDER, /pointAccumulatedLanePolylineCandidate/);
  assert.match(RENDER, /_drawPointAccumulatedLanePolylines/);
  assert.match(APP, /initVizModeSelect/);
});

test('10. real Seg1 map yields polylines without cross-lane joins', () => {
  const pd = processSelection([0, 1, 2]);
  const map = CBAO.applyBoundaryAnchoredOrientation(
    SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true }),
    pd,
    { mirrorChecked: true },
  );
  const display = displayPointsFromMap(map);
  const a = PALP.buildPointAccumulatedLanePolylines(display);
  const b = PALP.buildPointAccumulatedLanePolylines(display);
  assert.equal(a.polylines.length, b.polylines.length);
  assert.ok(a.polylines.length > 0);
  const audit = PALP.auditPolylineSet(a.polylines);
  assert.equal(audit.identityChangeCount, 0);
  assert.equal(audit.crossPassCount, 0);
  assert.equal(audit.crossChunkCount, 0);
  assert.equal(audit.nonFiniteCount, 0);
});

test('11. same polyline output after rebuild and alternate timeline index (cache/re-seek)', () => {
  const pd = processSelection([1]);
  const mapA = SLM.buildSegmentLocalMap(pd, {
    geometrySource: 'pointAccumulated',
    timelineIndex: 0,
    fitEnabled: true,
  });
  const mapB = SLM.buildSegmentLocalMap(pd, {
    geometrySource: 'pointAccumulated',
    timelineIndex: Math.min(50, (pd.timeline?.length || 1) - 1),
    fitEnabled: true,
  });
  const fingerprint = (built) => JSON.stringify(built.polylines.map((p) => ({
    identityKey: p.identityKey,
    pointCount: p.pointCount,
    first: p.points[0],
    last: p.points[p.points.length - 1],
  })));
  const a1 = PALP.buildPointAccumulatedLanePolylines(displayPointsFromMap(mapA));
  const a2 = PALP.buildPointAccumulatedLanePolylines(displayPointsFromMap(mapA));
  assert.equal(fingerprint(a1), fingerprint(a2));
  // Stationary PA points are map-owned; rebuild at another seek index must not mutate source points.
  const ptsA = mapA.pointAccumulated?.points || [];
  const ptsB = mapB.pointAccumulated?.points || [];
  assert.equal(ptsA.length, ptsB.length);
  const b1 = PALP.buildPointAccumulatedLanePolylines(displayPointsFromMap(mapB));
  assert.equal(a1.polylines.length, b1.polylines.length);
  assert.equal(fingerprint(a1), fingerprint(b1));
});
