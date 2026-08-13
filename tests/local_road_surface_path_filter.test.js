'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const LRSP = require('../lib/local_road_surface_path_filter');
const LTO = require('../lib/local_trajectory_overlay');
const SLM = require('../lib/segment_local_map');
const { loadSegment, buildCtx } = require('../lib/lane_continuity_stage4');
const {
  LOCAL_GEOMETRY_VISIBLE_MODES,
  localGeometryDropdownOptions,
} = require('../lib/local_geometry_ui');

const RENDER_JS = path.join(__dirname, '..', 'public', 'render.js');
const APP_JS = path.join(__dirname, '..', 'public', 'app.js');
const EXPECTED = {
  laneChecksum: 'ff6d115e',
  coordinateChecksum: '6838c279',
  roadSurfaceChecksum: '70457ea',
};

function buildModeMap(data, geometrySource) {
  return SLM.buildSegmentLocalMap(data, { geometrySource, timelineIndex: 0 });
}

function makePoly(east, north, size = 4) {
  return {
    surfaceType: 'egoLaneCorridor',
    ring: [
      { east: east - size, north: north - size },
      { east: east + size, north: north - size },
      { east: east + size, north: north + size },
      { east: east - size, north: north + size },
    ],
  };
}

describe('Local road surface path filter — Segment 2', () => {
  let data;
  let trajectory;
  let baseSelected;

  it('setup', () => {
    data = loadSegment();
    const map = buildModeMap(data, 'fused');
    trajectory = map.trajectory;
    baseSelected = SLM.selectStationaryRoadSurfacePolygons(map.roadSurfacePolygons).selected;
    assert.equal(baseSelected.length, 13);
    assert.equal(trajectory.length, 30);
  });

  it('keeps on-route surface within 15 m corridor', () => {
    const filtered = LRSP.filterRoadSurfacePolygonsForTrajectory(baseSelected, trajectory);
    assert.equal(filtered.stats.radiusM, 15);
    assert.equal(filtered.stats.sectionsProcessed, 1);
    assert.ok(filtered.stats.drawableCount >= 1);
    assert.equal(filtered.stats.offRouteRemoved, 0);
  });

  it('hides isolated surface far from the driven route', () => {
    const offRoute = makePoly(500, 500, 6);
    const filtered = LRSP.filterRoadSurfacePolygonsForTrajectory([...baseSelected, offRoute], trajectory);
    assert.equal(filtered.stats.offRouteRemoved, 1);
    assert.ok(!filtered.drawables.some((d) => d.poly === offRoute));
  });

  it('Raw and Fused modes use the same trajectory corridor rule', () => {
    const obs = buildModeMap(data, 'observations');
    const fused = buildModeMap(data, 'fused');
    assert.deepEqual(obs.trajectory, fused.trajectory);
    const obsBase = SLM.selectStationaryRoadSurfacePolygons(obs.roadSurfacePolygons).selected;
    const fusedBase = SLM.selectStationaryRoadSurfacePolygons(fused.roadSurfacePolygons).selected;
    const obsFiltered = LRSP.filterRoadSurfacePolygonsForTrajectory(obsBase, obs.trajectory);
    const fusedFiltered = LRSP.filterRoadSurfacePolygonsForTrajectory(fusedBase, fused.trajectory);
    assert.equal(obsFiltered.stats.drawableCount, fusedFiltered.stats.drawableCount);
    assert.equal(obsFiltered.stats.sectionsProcessed, fusedFiltered.stats.sectionsProcessed);
  });
});

describe('Local road surface path filter — corridor sections', () => {
  it('does not connect sections across 150 m gaps', () => {
    const trajectory = [
      { east: 0, north: 0, logMonoTime: '100' },
      { east: 20, north: 0, logMonoTime: '200' },
      { east: 300, north: 0, logMonoTime: '300' },
      { east: 320, north: 0, logMonoTime: '400' },
    ];
    const sections = LRSP.buildTrajectoryCorridorSections(trajectory);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].length, 2);
    assert.equal(sections[1].length, 2);
  });

  it('skips trajectory sections with fewer than two points', () => {
    const trajectory = [
      { east: 0, north: 0, logMonoTime: '100' },
      { east: 200, north: 0, logMonoTime: '200' },
      { east: 210, north: 0, logMonoTime: '300' },
    ];
    const sections = LRSP.buildTrajectoryCorridorSections(trajectory);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].length, 2);
  });

  it('clips or removes surface outside corridor while keeping near-path surface', () => {
    const trajectory = [
      { east: 0, north: 0, logMonoTime: '100' },
      { east: 40, north: 0, logMonoTime: '200' },
    ];
    const near = makePoly(20, 0, 3);
    const far = makePoly(20, 80, 3);
    const filtered = LRSP.filterRoadSurfacePolygonsForTrajectory([near, far], trajectory);
    assert.equal(filtered.stats.offRouteRemoved, 1);
    assert.equal(filtered.drawables.length, 1);
    assert.equal(filtered.drawables[0].poly, near);
  });
});

describe('Local road surface path filter — grey path preservation', () => {
  const renderSrc = fs.readFileSync(RENDER_JS, 'utf8');
  const overlaySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local_trajectory_overlay.js'), 'utf8');

  it('does not modify map.trajectory or trajectory overlay module', () => {
    const data = loadSegment();
    const before = buildModeMap(data, 'fused');
    const trajJson = JSON.stringify(before.trajectory);
    assert.match(overlaySrc, /TRAJECTORY_OVERLAY_STYLE|#94a3b8/);
    assert.match(overlaySrc, /width:\s*1\.5/);
    assert.match(overlaySrc, /\[8,\s*6\]/);
    const overlayStart = renderSrc.indexOf('_drawLocalVehiclePathOverlay(map) {');
    const overlayBlock = renderSrc.slice(
      overlayStart,
      renderSrc.indexOf('_drawGeometryDiagnosticOverlays(map)', overlayStart),
    );
    assert.doesNotMatch(overlayBlock, /localRoadSurfacePathRadiusM|filterRoadSurfacePolygonsForTrajectory/);
    const after = buildModeMap(data, 'fused');
    assert.equal(JSON.stringify(after.trajectory), trajJson);
  });

  it('road surface ribbon renders before geometry and grey dashed path', () => {
    const methodSlice = renderSrc.slice(
      renderSrc.indexOf('_drawStationaryLocalMap(d, elapsedIdx)'),
      renderSrc.indexOf('_drawStationaryLocalMap(d, elapsedIdx)') + 20000,
    );
    const surfaceIdx = methodSlice.indexOf('if (this.layers.roadSurface)');
    const laneIdx = methodSlice.indexOf('if (this.layers.fused)', surfaceIdx);
    const pathIdx = methodSlice.indexOf('this._drawLocalVehiclePathOverlay(map);', laneIdx);
    const arrowIdx = methodSlice.lastIndexOf('this._drawLocalPlaybackArrow(null, this.playbackPose)');
    assert.ok(surfaceIdx >= 0 && laneIdx > surfaceIdx);
    assert.ok(pathIdx > laneIdx);
    assert.ok(arrowIdx > pathIdx);
  });

  it('uses stored polygon diagnostics only in debug modes', () => {
    assert.match(renderSrc, /localRoadSurfacePathRadiusM\s*=\s*15/);
    assert.match(renderSrc, /filterRoadSurfacePolygonsForTrajectory/);
    assert.match(renderSrc, /this\._polygonDebug \|\| this\._fusionBinDebug/);
    assert.match(renderSrc, /buildTrajectoryRoadSurfaceRibbons/);
    assert.doesNotMatch(
      renderSrc.slice(renderSrc.indexOf('buildTrajectoryRoadSurfaceRibbons')),
      /roadSurfacePolygons\s*=|\.ring\s*=\s*/,
    );
  });

  it('lane polyline 15 m threshold remains on general renderer', () => {
    assert.match(renderSrc, /_drawPolyline\(points, color, width, dashed, maxGapM = 15\)/);
  });
});

describe('Local road surface path filter — playback and checksums', () => {
  const appSrc = fs.readFileSync(APP_JS, 'utf8');
  let data;

  it('setup', () => {
    data = loadSegment();
  });

  it('invalid polygons are skipped safely', () => {
    const trajectory = [
      { east: 0, north: 0, logMonoTime: '1' },
      { east: 20, north: 0, logMonoTime: '2' },
    ];
    const filtered = LRSP.filterRoadSurfacePolygonsForTrajectory(
      [{ ring: [{ east: 0, north: 0 }] }, makePoly(10, 0, 2)],
      trajectory,
    );
    assert.equal(filtered.skipped.some((s) => s.reason === 'invalidPolygon'), true);
    assert.equal(filtered.drawables.length, 1);
  });

  it('geometry checksums and stored road-surface data remain unchanged', () => {
    const ctx = buildCtx(data);
    const fused = buildModeMap(data, 'fused');
    const obs = buildModeMap(data, 'observations');
    const chunkRoad = SLM.computeRoadPolygonChecksum(ctx.chunk.roadSurfacePolygons || []);
    assert.equal(ctx.mode5.laneChecksum, EXPECTED.laneChecksum);
    assert.equal(chunkRoad, EXPECTED.roadSurfaceChecksum);
    assert.equal(JSON.stringify(fused.roadSurfacePolygons), JSON.stringify(obs.roadSurfacePolygons));
    assert.notEqual(fused.laneChecksum, obs.laneChecksum);
  });

  it('switching geometry does not reprocess qlog or clear playback state', () => {
    assert.doesNotMatch(appSrc, /filterRoadSurfacePolygonsForTrajectory[\s\S]*?fetch\(\s*['`]\/api\/process/);
    assert.doesNotMatch(appSrc.match(/function switchLocalGeometryLayer[\s\S]*?\n\}/)?.[0] ?? '', /refreshLocalPlaybackVideo/);
  });

  it('dropdown contains all visible Local geometry modes', () => {
    assert.deepEqual(LOCAL_GEOMETRY_VISIBLE_MODES, ['observations', 'fused', 'pointAccumulated']);
    assert.equal(localGeometryDropdownOptions().length, 3);
  });
});
