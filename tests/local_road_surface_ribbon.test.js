'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const LRR = require('../lib/local_road_surface_ribbon');
const LTO = require('../lib/local_trajectory_overlay');
const SLM = require('../lib/segment_local_map');
const { loadSegment, buildCtx } = require('../lib/lane_continuity_stage4');
const {
  LOCAL_GEOMETRY_VISIBLE_MODES,
  localGeometryDropdownOptions,
} = require('../lib/local_geometry_ui');

const RENDER_JS = path.join(__dirname, '..', 'public', 'render.js');
const APP_JS = path.join(__dirname, '..', 'public', 'app.js');
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');
const EXPECTED = {
  laneChecksum: 'ff6d115e',
  coordinateChecksum: '6838c279',
  roadSurfaceChecksum: '70457ea',
};

function buildModeMap(data, geometrySource) {
  return SLM.buildSegmentLocalMap(data, { geometrySource, timelineIndex: 0 });
}

function identityWorldToScreen(east, north) {
  return { x: east, y: -north };
}

function mockFillCtx() {
  const calls = { fill: 0, fillStyle: null, paths: [] };
  let currentPath = null;
  return {
    calls,
    fillStyle: null,
    beginPath() { currentPath = []; },
    moveTo(x, y) { currentPath?.push({ x, y, op: 'move' }); },
    lineTo(x, y) { currentPath?.push({ x, y, op: 'line' }); },
    closePath() { if (currentPath) calls.paths.push(currentPath); },
    fill() { calls.fill += 1; },
  };
}

describe('Local road surface ribbon — Segment 2 continuity', () => {
  let data;
  let fusedMap;
  let ribbonResult;

  it('setup: load Segment 2 fused local map', () => {
    data = loadSegment();
    fusedMap = buildModeMap(data, 'fused');
    assert.equal(fusedMap.trajectory.length, 30);
    ribbonResult = LRR.buildTrajectoryRoadSurfaceRibbons(
      fusedMap.trajectory,
      fusedMap.edgeFragments,
    );
  });

  it('1. valid trajectory section produces a continuous filled ribbon', () => {
    assert.equal(ribbonResult.stats.sectionCount, 1);
    assert.equal(ribbonResult.stats.ribbonCount, 1);
    assert.ok(ribbonResult.ribbons[0].parts.length >= ribbonResult.ribbons[0].segmentCount);
    const ctx = mockFillCtx();
    const drawn = LRR.drawRoadSurfaceRibbon(
      ctx,
      ribbonResult.ribbons[0],
      identityWorldToScreen,
      'rgba(100,116,139,0.42)',
    );
    assert.equal(drawn, true);
    assert.ok(ctx.calls.fill >= 29, 'each segment quad should fill');
  });

  it('2. Segment 2 30-point trajectory does not produce scattered surface patches', () => {
    const ribbon = ribbonResult.ribbons[0];
    assert.equal(ribbon.segmentCount, 29);
    assert.equal(ribbon.pointCount, 30);
    assert.ok(ribbon.parts.length >= 29);
    assert.equal(ribbon.selfIntersecting, false);
  });

  it('3. every consecutive valid trajectory pair contributes to the same section ribbon', () => {
    const ribbon = ribbonResult.ribbons[0];
    assert.equal(ribbon.segmentCount, fusedMap.trajectory.length - 1);
    const quads = ribbon.parts.filter((ring) => ring.length === 4);
    assert.equal(quads.length, ribbon.segmentCount);
  });

  it('4. separate trajectory sections produce separate surface ribbons', () => {
    const trajectory = [
      { east: 0, north: 0, logMonoTime: '100' },
      { east: 20, north: 0, logMonoTime: '200' },
      { east: 300, north: 0, logMonoTime: '300' },
      { east: 320, north: 0, logMonoTime: '400' },
    ];
    const result = LRR.buildTrajectoryRoadSurfaceRibbons(trajectory, []);
    assert.equal(result.sections.length, 2);
    assert.equal(result.ribbons.length, 2);
  });

  it('5. gaps above 150 m remain disconnected', () => {
    const trajectory = [
      { east: 0, north: 0, logMonoTime: '100' },
      { east: 10, north: 0, logMonoTime: '200' },
      { east: 200, north: 0, logMonoTime: '300' },
      { east: 210, north: 0, logMonoTime: '400' },
    ];
    const sections = LRR.splitTrajectorySections(trajectory);
    assert.equal(sections.length, 2);
  });

  it('6. timestamp reversals remain disconnected', () => {
    const trajectory = [
      { east: 0, north: 0, logMonoTime: '100' },
      { east: 10, north: 0, logMonoTime: '200' },
      { east: 20, north: 0, logMonoTime: '150' },
      { east: 30, north: 0, logMonoTime: '300' },
      { east: 40, north: 0, logMonoTime: '400' },
    ];
    const sections = LRR.splitTrajectorySections(trajectory);
    assert.equal(sections.length, 2);
    const result = LRR.buildTrajectoryRoadSurfaceRibbons(trajectory, []);
    assert.equal(result.ribbons.length, 2);
  });

  it('7. curves do not create large spikes or self-intersections', () => {
    const curve = [];
    for (let i = 0; i <= 20; i++) {
      const t = (i / 20) * Math.PI;
      curve.push({ east: Math.cos(t) * 30, north: Math.sin(t) * 30, logMonoTime: String(100 + i) });
    }
    const result = LRR.buildTrajectoryRoadSurfaceRibbons(curve, []);
    assert.equal(result.ribbons.length, 1);
    assert.equal(result.ribbons[0].selfIntersecting, false);
  });

  it('8. width stays within configured limits', () => {
    assert.ok(ribbonResult.stats.widthMin >= LRR.LOCAL_ROAD_SURFACE_RIBBON_MIN_HALF_WIDTH_M);
    assert.ok(ribbonResult.stats.widthMax <= LRR.LOCAL_ROAD_SURFACE_RIBBON_MAX_HALF_WIDTH_M);
    for (const ribbon of ribbonResult.ribbons) {
      for (const w of ribbon.halfWidths) {
        assert.ok(w >= LRR.LOCAL_ROAD_SURFACE_RIBBON_MIN_HALF_WIDTH_M);
        assert.ok(w <= LRR.LOCAL_ROAD_SURFACE_RIBBON_MAX_HALF_WIDTH_M);
      }
    }
  });

  it('9. fallback half-width is used when edge evidence is unavailable', () => {
    const trajectory = [
      { east: 0, north: 0, logMonoTime: '1' },
      { east: 40, north: 0, logMonoTime: '2' },
    ];
    const result = LRR.buildTrajectoryRoadSurfaceRibbons(trajectory, [], {
      fallbackHalfWidthM: 7.5,
    });
    assert.equal(result.stats.fallbackHalfWidthM, 7.5);
    assert.equal(result.ribbons[0].widthSource, 'fallback');
    assert.ok(result.ribbons[0].halfWidths.every((w) => Math.abs(w - 7.5) < 0.01));
  });

  it('10. reliable edge evidence can control local width', () => {
    const trajectory = [{ east: 0, north: 0 }, { east: 20, north: 0 }];
    const edgeFragments = [{
      points: [
        { east: 5, north: 4, side: 'left' },
        { east: 15, north: 4, side: 'left' },
        { east: 5, north: -3, side: 'right' },
        { east: 15, north: -3, side: 'right' },
      ],
    }];
    const result = LRR.buildTrajectoryRoadSurfaceRibbons(trajectory, edgeFragments);
    assert.equal(result.ribbons[0].widthSource, 'edgeEvidence');
    assert.ok(result.ribbons[0].halfWidths[0] < 7.5);
    assert.ok(result.ribbons[0].halfWidths[0] >= LRR.LOCAL_ROAD_SURFACE_RIBBON_MIN_HALF_WIDTH_M);
  });
});

describe('Local road surface ribbon — grey path and render order', () => {
  const renderSrc = fs.readFileSync(RENDER_JS, 'utf8');
  const overlaySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'local_trajectory_overlay.js'), 'utf8');
  let data;

  it('setup', () => {
    data = loadSegment();
  });

  it('11. grey-path coordinates remain byte-for-byte unchanged', () => {
    const before = buildModeMap(data, 'fused');
    const trajJson = JSON.stringify(before.trajectory);
    const after = buildModeMap(data, 'fused');
    assert.equal(JSON.stringify(after.trajectory), trajJson);
    const ribbonBlock = renderSrc.slice(
      renderSrc.indexOf('buildTrajectoryRoadSurfaceRibbons'),
      renderSrc.indexOf('if (this.layers.edges)'),
    );
    assert.doesNotMatch(ribbonBlock, /map\.trajectory\s*=|map\.trajectory\.push|trajectory\.splice/);
  });

  it('12. grey-path colour, width and dash pattern remain unchanged', () => {
    assert.match(overlaySrc, /#94a3b8/);
    assert.match(overlaySrc, /width:\s*1\.5/);
    assert.match(overlaySrc, /\[8,\s*6\]/);
    const overlayStart = renderSrc.indexOf('_drawLocalVehiclePathOverlay(map) {');
    const overlayBlock = renderSrc.slice(
      overlayStart,
      renderSrc.indexOf('_drawGeometryDiagnosticOverlays(map)', overlayStart),
    );
    assert.match(overlayBlock, /drawTrajectoryOverlay/);
    assert.doesNotMatch(overlayBlock, /localRoadSurfaceRibbon|buildTrajectoryRoadSurfaceRibbons/);
  });

  it('13. grey route renders above the surface ribbon', () => {
    const methodSlice = renderSrc.slice(
      renderSrc.indexOf('_drawStationaryLocalMap(d, elapsedIdx)'),
      renderSrc.indexOf('_drawStationaryLocalMap(d, elapsedIdx)') + 20000,
    );
    const surfaceIdx = methodSlice.indexOf('if (this.layers.roadSurface)');
    const pathIdx = methodSlice.indexOf('this._drawLocalVehiclePathOverlay(map);', surfaceIdx);
    assert.ok(surfaceIdx >= 0 && pathIdx > surfaceIdx);
  });

  it('14. blue arrow renders above the grey route', () => {
    const methodSlice = renderSrc.slice(
      renderSrc.indexOf('_drawStationaryLocalMap(d, elapsedIdx)'),
      renderSrc.indexOf('_drawStationaryLocalMap(d, elapsedIdx)') + 20000,
    );
    const pathIdx = methodSlice.indexOf('this._drawLocalVehiclePathOverlay(map);');
    const arrowIdx = methodSlice.lastIndexOf('this._drawLocalPlaybackArrow(null, this.playbackPose)');
    assert.ok(arrowIdx > pathIdx);
  });

  it('renderer uses trajectory ribbon as default surface display source', () => {
    // Ribbon remains the default surface source. Stationary local polygons are
    // a fallback only when no trajectory ribbon can be built (fully stationary
    // segment), so the trajectoryRibbon literal must still be the default branch.
    assert.match(renderSrc, /surfaceDisplaySource:.*'trajectoryRibbon'/);
    assert.match(renderSrc, /buildTrajectoryRoadSurfaceRibbons/);
    assert.match(renderSrc, /localRoadSurfaceRibbonFallbackHalfWidthM\s*=\s*7\.5/);
    assert.match(renderSrc, /localRoadSurfaceRibbonMinHalfWidthM\s*=\s*3/);
    assert.match(renderSrc, /localRoadSurfaceRibbonMaxHalfWidthM\s*=\s*15/);
    assert.match(renderSrc, /storedPolygonDiagnostics/);
    assert.match(renderSrc, /this\._polygonDebug \|\| this\._fusionBinDebug/);
  });

  it('stored polygon rings are not modified by ribbon builder', () => {
    const fused = buildModeMap(data, 'fused');
    const before = JSON.stringify(fused.roadSurfacePolygons);
    LRR.buildTrajectoryRoadSurfaceRibbons(fused.trajectory, fused.edgeFragments);
    const after = buildModeMap(data, 'fused');
    assert.equal(JSON.stringify(after.roadSurfacePolygons), before);
  });
});

describe('Local road surface ribbon — modes and checksums', () => {
  const appSrc = fs.readFileSync(APP_JS, 'utf8');
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  let data;

  it('setup', () => {
    data = loadSegment();
  });

  it('15. Raw and Fused modes show the same surface ribbon trajectory', () => {
    const obs = buildModeMap(data, 'observations');
    const fused = buildModeMap(data, 'fused');
    assert.deepEqual(obs.trajectory, fused.trajectory);
    const obsRibbon = LRR.buildTrajectoryRoadSurfaceRibbons(obs.trajectory, obs.edgeFragments);
    const fusedRibbon = LRR.buildTrajectoryRoadSurfaceRibbons(fused.trajectory, fused.edgeFragments);
    assert.equal(obsRibbon.stats.ribbonCount, fusedRibbon.stats.ribbonCount);
    assert.equal(obsRibbon.stats.sectionCount, fusedRibbon.stats.sectionCount);
    assert.equal(obsRibbon.ribbons[0].segmentCount, fusedRibbon.ribbons[0].segmentCount);
  });

  it('16. switching modes preserves video, arrow, timeline and viewport hooks', () => {
    const switchFn = appSrc.match(/function switchLocalGeometryLayer[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(switchFn, /preserveViewport:\s*true/);
    assert.doesNotMatch(switchFn, /refreshLocalPlaybackVideo/);
    assert.doesNotMatch(switchFn, /currentTime\s*=\s*0/);
    assert.match(appSrc, /updateLocalPlayback/);
  });

  it('17. stored geometry and checksums remain unchanged', () => {
    const ctx = buildCtx(data);
    const fused = buildModeMap(data, 'fused');
    const obs = buildModeMap(data, 'observations');
    const chunkRoad = SLM.computeRoadPolygonChecksum(ctx.chunk.roadSurfacePolygons || []);
    assert.equal(ctx.mode5.laneChecksum, EXPECTED.laneChecksum);
    assert.equal(chunkRoad, EXPECTED.roadSurfaceChecksum);
    assert.equal(JSON.stringify(fused.roadSurfacePolygons), JSON.stringify(obs.roadSurfacePolygons));
    LRR.buildTrajectoryRoadSurfaceRibbons(fused.trajectory, fused.edgeFragments);
    const fusedAgain = buildModeMap(data, 'fused');
    assert.equal(fusedAgain.laneChecksum, fused.laneChecksum);
    assert.equal(fusedAgain.roadSurfaceChecksum, fused.roadSurfaceChecksum);
  });

  it('dropdown contains all visible Local geometry modes', () => {
    assert.deepEqual(LOCAL_GEOMETRY_VISIBLE_MODES, ['observations', 'fused', 'pointAccumulated']);
    assert.equal(localGeometryDropdownOptions().length, 3);
  });

  it('index.html loads ribbon module before render.js', () => {
    const ribbonIdx = html.indexOf('local_road_surface_ribbon.js');
    const renderIdx = html.indexOf('render.js');
    assert.ok(ribbonIdx >= 0);
    assert.ok(ribbonIdx < renderIdx);
  });

  it('path filter module remains available for diagnostics', () => {
    assert.match(html, /local_road_surface_path_filter\.js/);
    assert.match(renderSrcSafe(), /_selectStationaryRoadSurfaceDrawables/);
  });
});

function renderSrcSafe() {
  return fs.readFileSync(RENDER_JS, 'utf8');
}

describe('Local road surface ribbon — width reporting Segment 2', () => {
  it('reports edge-informed width range on Segment 2', () => {
    const data = loadSegment();
    const map = buildModeMap(data, 'fused');
    const result = LRR.buildTrajectoryRoadSurfaceRibbons(map.trajectory, map.edgeFragments);
    assert.equal(result.stats.fallbackHalfWidthM, 7.5);
    assert.ok(result.stats.widthMin != null);
    assert.ok(result.stats.widthMax != null);
    assert.ok(result.stats.widthMedian != null);
    assert.ok(result.stats.widthMin >= 3);
    assert.ok(result.stats.widthMax <= 15);
    assert.equal(result.ribbons[0].widthSource, 'edgeEvidence');
  });
});
