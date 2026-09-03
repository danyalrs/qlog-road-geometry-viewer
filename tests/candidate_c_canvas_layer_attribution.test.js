'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const CLA = require('../lib/canvas_layer_attribution');
const CST = require('../lib/combined_source_transform');
const CBAO = require('../lib/combined_boundary_anchored_orientation');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');

const ROOT = path.join(__dirname, '..');
const RENDER_SRC = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const LAYER_IDS = [
  'axes',
  'roadRibbon',
  'roadEdges',
  'stationaryMapLanes',
  'trajectory',
  'arrow',
  'pointAccumulatedLanes',
  'connectedAccumulated',
  'experimentalBoundaries',
  'constructedFragments',
  'joinCandidates',
  'joinedPolylines',
  'hybridBoundaries',
  'fittedPolylines',
  'fittedOutliers',
  'fittedUnverified',
  'fittedGaps',
];

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

function candidateMap(segments) {
  const pd = processSelection(segments);
  const idx = pd.timeline.findIndex((t) => t.sourceFile === 'qlog_f449c_2.bz2');
  const base = SLM.buildSegmentLocalMap(pd, {
    geometrySource: 'pointAccumulated',
    timelineIndex: idx >= 0 ? idx : 0,
    fitEnabled: true,
  });
  return {
    pd,
    map: CBAO.applyBoundaryAnchoredOrientation(base, pd, { mirrorChecked: true }),
  };
}

describe('candidate C canvas layer attribution', () => {
  it('1. major draw passes expose stable diagnostic layer IDs in render.js', () => {
    for (const id of LAYER_IDS) {
      assert.match(RENDER_SRC, new RegExp(`_attrPass\\('${id}'`));
    }
  });

  it('2-3. diagnostic attribution inactive by default and does not change draw order contract', () => {
    assert.equal(CLA.parseLayerAttributionFlag(''), false);
    assert.equal(CLA.parseLayerAttributionFlag('?debugLayerAttribution=0'), false);
    assert.equal(CLA.parseLayerAttributionFlag('?debugLayerAttribution=1'), true);
    assert.match(RENDER_SRC, /if \(!this\._layerAttributionEnabled\) return true;/);
    assert.doesNotMatch(RENDER_SRC, /if \(this\._layerAttributionEnabled\) return;/);
  });

  it('4-6. owner pass metadata and disable/solo hooks exist', () => {
    assert.match(RENDER_SRC, /debugLayerSolo/);
    assert.match(RENDER_SRC, /debugLayerDisable/);
    assert.match(RENDER_SRC, /getLayerAttributionExport/);
    assert.match(RENDER_SRC, /getLayerAttributionPassPng/);
  });

  it('7-11. owner geometry retains provenance and single placement contract', () => {
    const { map } = candidateMap([0, 1, 2]);
    const pts = map.pointAccumulated?.points || [];
    assert.ok(pts.length > 0);
    assert.ok(pts.every((p) => p.sourceFile));
    assert.ok(pts.every((p) => p.coordinateFrame === 'combinedPlaced'));
    assert.ok(pts.every((p) => Number.isFinite(p.placedEast) && Number.isFinite(p.placedNorth)));
    const seg0 = pts.filter((p) => p.sourceFile === 'qlog_f449c_0.bz2').slice(0, 5);
    for (const p of seg0) {
      const again = CST.transformMapPoint(p, map.sourceTransformByFile, map.timeline);
      assert.equal(again.coordinateFrame, 'combinedPlaced');
      assert.equal(again.placedEast, p.placedEast);
    }
  });

  it('12. candidate activation applies orientation on cache-hit helper path', () => {
    assert.match(APP_SRC, /applyOrientationCandidateIfNeeded/);
    assert.match(APP_SRC, /persistent-hit-orientation-applied/);
  });

  it('13. render uses placedEast when projecting combinedPlaced geometry', () => {
    assert.match(RENDER_SRC, /point\?\.placedEast/);
    assert.match(RENDER_SRC, /roadGeometryToScreen\([^\)]*,\s*v\)/);
  });

  it('14-17. road bridge continuity and segment 2 direction remain in anchoring tests scope', () => {
    const { map, pd } = candidateMap([0, 1, 2]);
    const traj = map.trajectory || [];
    assert.ok(map.boundaryAnchoredOrientationActive);
    assert.ok(traj.length > 10);
    const seg2 = traj.filter((p) => p.sourceFile === 'qlog_f449c_2.bz2');
    assert.ok(seg2.length > 5);
    const mid = seg2[Math.floor(seg2.length / 2)];
    const end = seg2[seg2.length - 1];
    const lateralDelta = end.north - mid.north;
    assert.ok(Math.abs(lateralDelta) > 1, 'segment 2 should curve laterally');
  });

  it('18-20. standalone maps unaffected by attribution-only wiring', () => {
    const pd0 = processSelection([0]);
    const solo0 = SLM.buildSegmentLocalMap(pd0, { geometrySource: 'pointAccumulated', timelineIndex: 0 });
    assert.equal(solo0.boundaryAnchoredOrientationActive, undefined);
    const pd2 = processSelection([2]);
    const solo2 = SLM.buildSegmentLocalMap(pd2, { geometrySource: 'pointAccumulated', timelineIndex: 0 });
    assert.equal(solo2.boundaryAnchoredOrientationActive, undefined);
    const pd99 = processSelection([99]);
    const solo99 = SLM.buildSegmentLocalMap(pd99, { geometrySource: 'pointAccumulated', timelineIndex: 0 });
    assert.ok(solo99.valid !== false);
  });

  it('21-25. defaults and guards', () => {
    assert.match(INDEX_SRC, /canvas_layer_attribution\.js/);
    assert.doesNotMatch(RENDER_SRC, /segmentId === 0/);
    assert.doesNotMatch(RENDER_SRC, /segmentNumber === 0/);
    assert.doesNotMatch(APP_SRC, /segmentId === 0/);
    assert.match(CST.finalizePlacedPoint({ east: 1, north: 2 }, { east: 3, north: 4 }).coordinateFrame, /combinedPlaced/);
  });

  it('26-28. layer visibility and fit metadata hooks', () => {
    assert.match(RENDER_SRC, /rendererStateField/);
    assert.match(RENDER_SRC, /uiControl/);
    assert.match(RENDER_SRC, /_layerAttributionShouldDraw/);
  });
});
