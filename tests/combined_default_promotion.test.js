'use strict';

// Focused tests for the combined-orientation / combined-visible-lane-projection
// default promotion. Selection defaults only; no transform algorithm change.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');
const CVLP = require('../lib/combined_visible_lane_projection');

const ROOT = path.join(__dirname, '..');
const RENDER_SRC = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');

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

function buildCombined(pd) {
  const base = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true });
  return CBAO.applyBoundaryAnchoredOrientation(base, pd, { mirrorChecked: true });
}

test('1-2. combined orientation absent/invalid selects boundaryAnchored', () => {
  assert.equal(CBAO.parseCombinedOrientationCandidate(''), 'boundaryAnchored');
  assert.equal(CBAO.parseCombinedOrientationCandidate('?segments=0,1,2&local=1&fit=1&mirror=1'), 'boundaryAnchored');
  assert.equal(CBAO.parseCombinedOrientationCandidate('?combinedOrientationCandidate=bogus'), 'boundaryAnchored');
});

test('3-4. explicit orientation overrides preserved (candidate + legacy diagnostic)', () => {
  assert.equal(CBAO.parseCombinedOrientationCandidate('?combinedOrientationCandidate=boundaryAnchored'), 'boundaryAnchored');
  assert.equal(
    CBAO.parseCombinedOrientationCandidate('?combinedOrientationCandidate=commonTransformNoSeg0Correction'),
    'commonTransformNoSeg0Correction',
  );
});

test('5-7. CVLP default enabled; explicit 1 enabled; explicit 0 disabled', () => {
  assert.equal(CVLP.parseCombinedVisibleLaneProjectionCandidate(''), true);
  assert.equal(CVLP.parseCombinedVisibleLaneProjectionCandidate('?segments=0,1,2&local=1'), true);
  assert.equal(CVLP.parseCombinedVisibleLaneProjectionCandidate('?combinedVisibleLaneProjectionCandidate=1'), true);
  assert.equal(CVLP.parseCombinedVisibleLaneProjectionCandidate('?combinedVisibleLaneProjectionCandidate=0'), false);
});

test('8. URL override beats the default', () => {
  const dflt = CBAO.parseCombinedOrientationCandidate('');
  const legacy = CBAO.parseCombinedOrientationCandidate('?combinedOrientationCandidate=commonTransformNoSeg0Correction');
  assert.equal(dflt, 'boundaryAnchored');
  assert.notEqual(dflt, legacy);
  assert.equal(CVLP.parseCombinedVisibleLaneProjectionCandidate('?combinedVisibleLaneProjectionCandidate=0'), false);
});

test('9. standalone (single source) is unchanged by the promoted default', () => {
  const pd = processSelection([2]);
  const base = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true });
  const oriented = CBAO.applyBoundaryAnchoredOrientation(base, pd, { mirrorChecked: true });
  assert.equal(oriented.boundaryAnchoredOrientationActive, undefined);
  assert.equal(CVLP.isCandidateEligible(oriented, { mirrorChecked: true }), false);
});

test('10. default combined selection equals explicit candidate selection', () => {
  const pd = processSelection([0, 1, 2]);
  assert.equal(
    CBAO.parseCombinedOrientationCandidate(''),
    CBAO.parseCombinedOrientationCandidate('?combinedOrientationCandidate=boundaryAnchored'),
  );
  const map = buildCombined(pd);
  assert.equal(map.boundaryAnchoredOrientationActive, true);
  assert.equal(map.combinedCoordinateFrame, 'combinedPlaced');
  assert.ok(CVLP.isCandidateEligible(map, { mirrorChecked: true }));
});

test('11. reflection is applied exactly once (idempotent projection)', () => {
  const pd = processSelection([0, 1, 2]);
  const map = buildCombined(pd);
  for (const pl of map.boundaryAnchoredPlacements || []) {
    const rotations = (pl.transformOrder || []).filter((s) => s === 'boundaryAnchoredRotation').length;
    assert.ok(rotations <= 1, `rotation step repeated: ${rotations}`);
  }
  const pt = (map.pointAccumulated?.points || [])[0];
  assert.ok(pt, 'combined map has point-accumulated points');
  const first = CVLP.projectCombinedSourceLanePoint(pt, map, 'pointAccumulated', {
    mirrorChecked: true,
    useVisibleLaneProjection: true,
  });
  assert.ok(first, 'projection result present');
  const second = CVLP.projectCombinedSourceLanePoint(
    { ...pt, visibleLaneProjectionApplied: true, placedEast: first.east, placedNorth: first.north },
    map,
    'pointAccumulated',
    { mirrorChecked: true, useVisibleLaneProjection: true },
  );
  assert.equal(second.reason, 'alreadyApplied');
  assert.equal(second.east, first.east);
  assert.equal(second.north, first.north);
});

test('12. point-accumulated dots use the corrected combined placement', () => {
  const pd = processSelection([0, 1, 2]);
  const map = buildCombined(pd);
  const pt = (map.pointAccumulated?.points || [])[0];
  const proj = CVLP.projectCombinedSourceLanePoint(pt, map, 'pointAccumulated', {
    mirrorChecked: true,
    useVisibleLaneProjection: true,
  });
  assert.equal(proj.corrected, true);
  assert.ok(Number.isFinite(proj.east) && Number.isFinite(proj.north));
});

test('13-14. combined route continuity and bridges remain present', () => {
  const pd = processSelection([0, 1, 2]);
  const map = buildCombined(pd);
  assert.ok(map.combinedRouteContinuity, 'combined route continuity present');
  assert.ok(Number.isFinite(map.combinedRouteContinuity.maxConsecutiveGapM?.maxGapM));
  assert.ok(Array.isArray(map.boundaryBridges));
});

test('15. combined default rebuild is deterministic (cache re-seek parity)', () => {
  const pd = processSelection([0, 1, 2]);
  const m1 = buildCombined(pd);
  const m2 = buildCombined(pd);
  const key = (map) => (map.pointAccumulated?.points || []).map((p) => {
    const e = Number.isFinite(p.placedEast) ? p.placedEast : p.east;
    const n = Number.isFinite(p.placedNorth) ? p.placedNorth : p.north;
    return `${p.sourceFile}|${p.frameId}|${p.s}|${e}|${n}`;
  }).join(';');
  assert.equal(key(m1), key(m2));
  assert.equal(m1.combinedCoordinateFrame, m2.combinedCoordinateFrame);
});

test('render.js enables the combined projection unless explicitly disabled', () => {
  assert.match(RENDER_SRC, /combinedVisibleLaneProjectionCandidate'\)\s*!==\s*'0'/);
});
