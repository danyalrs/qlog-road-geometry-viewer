'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  LOCAL_GEOMETRY_VISIBLE_MODES,
  LOCAL_GEOMETRY_DEFAULT_MODE,
  LOCAL_GEOMETRY_STORAGE_KEY,
  HIDDEN_GEOMETRY_SOURCES,
  isVisibleLocalGeometryMode,
  normalizeLocalGeometrySelection,
  localGeometryDropdownOptions,
} = require('../lib/local_geometry_ui');
const { loadSegment, buildCtx } = require('../lib/lane_continuity_stage4');
const { buildLaneDiagnostics } = require('../lib/geometry_diagnostics');
const SLM = require('../lib/segment_local_map');
const { PROCESSING_VERSION } = require('../lib/version');
const { DEFAULT_PROCESS_OPTIONS, normalizeProcessOptions } = require('../lib/process_defaults');
const { PRE_STAGE7_SEGMENT_OPTS } = require('../lib/lane_continuity_stage6');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'public', 'index.html');
const APP_JS = path.join(ROOT, 'public', 'app.js');
const RENDER_JS = path.join(ROOT, 'public', 'render.js');
const LOCAL_GEOMETRY_UI_JS = path.join(ROOT, 'public', 'local_geometry_ui.js');
const VIDEO_JS = path.join(ROOT, 'public', 'local_playback_video.js');

const EXPECTED = {
  laneChecksum: 'ff6d115e',
  coordinateChecksum: '6838c279',
  roadSurfaceChecksum: '70457ea',
  fusedFragments: 22,
  cleanedRuns: 21,
};

function read(srcPath) {
  return fs.readFileSync(srcPath, 'utf8');
}

function extractFunctionBody(src, name) {
  const sigStart = src.indexOf(`function ${name}`);
  if (sigStart < 0) return '';
  const parenClose = src.indexOf(')', sigStart);
  const bodyStart = src.indexOf('{', parenClose);
  if (bodyStart < 0) return '';
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(sigStart, i + 1);
    }
  }
  return src.slice(sigStart);
}

function buildModeMap(data, geometrySource) {
  return SLM.buildSegmentLocalMap(data, { geometrySource, timelineIndex: 0 });
}

describe('Local geometry UI — two-mode dropdown', () => {
  it('1. Local geometry dropdown remains visible in index.html', () => {
    assert.match(read(INDEX_HTML), /id="localGeometryMode"/);
    assert.match(read(INDEX_HTML), /class="local-only-control"/);
  });

  it('2. dropdown contains exactly two options', () => {
    const opts = localGeometryDropdownOptions();
    assert.equal(opts.length, 2);
    const html = read(INDEX_HTML);
    const optionCount = (html.match(/<option value="(observations|fused)"/g) || []).length;
    assert.equal(optionCount, 2);
  });

  it('3. Raw mapped observations is present and enabled', () => {
    const html = read(INDEX_HTML);
    assert.match(html, /value="observations"[^>]*>Raw mapped observations/);
    assert.ok(isVisibleLocalGeometryMode('observations'));
  });

  it('4. Fused lane lines is present and enabled', () => {
    const html = read(INDEX_HTML);
    assert.match(html, /value="fused"[^>]*>Fused lane lines/);
    assert.ok(isVisibleLocalGeometryMode('fused'));
  });

  it('5. Fused lane lines is the default for new or invalid state', () => {
    assert.equal(LOCAL_GEOMETRY_DEFAULT_MODE, 'fused');
    assert.equal(normalizeLocalGeometrySelection(undefined), 'fused');
    assert.equal(normalizeLocalGeometrySelection(null), 'fused');
    assert.equal(normalizeLocalGeometrySelection(''), 'fused');
    assert.match(read(INDEX_HTML), /value="fused" selected/);
  });

  it('6. Raw and fused remain separate modes', () => {
    assert.deepEqual(LOCAL_GEOMETRY_VISIBLE_MODES, ['observations', 'fused']);
    assert.notEqual(
      localGeometryDropdownOptions()[0].value,
      localGeometryDropdownOptions()[1].value,
    );
  });

  it('21. hidden saved modes fall back to Fused lane lines', () => {
    for (const hidden of HIDDEN_GEOMETRY_SOURCES) {
      assert.equal(normalizeLocalGeometrySelection(hidden), 'fused');
    }
    assert.equal(normalizeLocalGeometrySelection('cleaned'), 'fused');
    assert.equal(normalizeLocalGeometrySelection('bogus'), 'fused');
  });

  it('22. undefined and invalid values do not produce an empty map selection', () => {
    const data = loadSegment();
    for (const bad of [undefined, null, '', 'cleaned', 'diagnostic', 'nope']) {
      const mode = normalizeLocalGeometrySelection(bad);
      const map = buildModeMap(data, mode);
      assert.ok(map.valid, `mode ${String(bad)} -> ${mode} should yield valid map`);
      assert.ok(map.laneFragments.length > 0);
    }
  });
});

describe('Local geometry UI — layer separation', () => {
  let data;

  it('setup: load segment 2', () => {
    data = loadSegment();
    assert.ok(data.routeChunks?.length);
  });

  it('7. Raw mode does not render fused geometry source', () => {
    const raw = buildModeMap(data, 'observations');
    const fused = buildModeMap(data, 'fused');
    assert.ok(raw.laneFragments.length > 0);
    assert.ok(fused.laneFragments.length > 0);
    assert.notEqual(raw.laneChecksum, fused.laneChecksum);
    assert.ok(raw.laneFragments.every((f) => f.fragmentKind !== 'fusedLane' || f.sourceFrameIndex != null));
  });

  it('8. Fused mode does not render raw observation geometry source', () => {
    const raw = buildModeMap(data, 'observations');
    const fused = buildModeMap(data, 'fused');
    assert.notEqual(raw.laneFragmentCount, fused.laneFragmentCount);
    assert.ok(fused.laneFragments.some((f) => f.fragmentKind === 'fusedLane' || f.laneTrackId != null));
  });
});

describe('Local geometry UI — switching implementation', () => {
  const appSrc = read(APP_JS);
  const renderSrc = read(RENDER_JS);
  const switchFn = extractFunctionBody(appSrc, 'switchLocalGeometryLayer');

  it('9. switching raw → fused updates only the geometry layer', () => {
    assert.match(appSrc, /function switchLocalGeometryLayer/);
    assert.match(switchFn, /preserveViewport:\s*true/);
    assert.doesNotMatch(switchFn, /clearProcessState/);
  });

  it('10. switching fused → raw updates only the geometry layer', () => {
    assert.match(appSrc, /switchLocalGeometryLayer/);
    assert.match(appSrc, /localGeometryMode.*addEventListener\('change'/);
    assert.match(switchFn, /updateLocalPlayback/);
  });

  it('23. switching Local geometry does not call qlog reprocessing', () => {
    assert.doesNotMatch(switchFn, /fetch\(\s*['`]\/api\/process/);
    assert.doesNotMatch(switchFn, /\bprocess\(/);
    assert.doesNotMatch(switchFn, /reprocessSelected/);
  });

  it('full playback reinitialization avoided on geometry switch', () => {
    const handler = appSrc.match(/localGeometryMode.*addEventListener\('change'[\s\S]*?\}\);/)?.[0] ?? '';
    assert.match(handler, /switchLocalGeometryLayer/);
    assert.doesNotMatch(handler, /forceMapRebuild:\s*true/);
    assert.doesNotMatch(handler, /forceRefit:\s*true/);
    assert.doesNotMatch(switchFn, /refreshLocalPlaybackVideo/);
    assert.doesNotMatch(switchFn, /clearStationaryMapCache/);
  });

  it('16. arrow renders above geometry and vehicle path', () => {
    const methodStart = renderSrc.indexOf('_drawStationaryLocalMap(d, elapsedIdx)');
    assert.ok(methodStart >= 0);
    const methodSlice = renderSrc.slice(methodStart, methodStart + 12000);
    const roadIdx = methodSlice.indexOf('if (this.layers.roadSurface)');
    const laneIdx = methodSlice.indexOf('if (this.layers.fused)', roadIdx);
    const pathIdx = methodSlice.indexOf('this._drawLocalVehiclePathOverlay(map);', laneIdx);
    const arrowIdx = methodSlice.lastIndexOf('this._drawLocalPlaybackArrow(null, this.playbackPose)');
    const movementIdx = methodSlice.indexOf('this._drawVehicleMovementIndicator(', arrowIdx);
    const diagIdx = methodSlice.indexOf('this._drawGeometryDiagnosticOverlays(map)', movementIdx);
    assert.ok(pathIdx >= 0, 'vehicle path overlay should be present');
    assert.ok(laneIdx < pathIdx, 'vehicle path should follow lane geometry');
    assert.ok(arrowIdx > pathIdx, 'arrow draw should follow vehicle path');
    assert.ok(movementIdx > arrowIdx, 'movement indicator should follow arrow');
    assert.ok(diagIdx > movementIdx, 'diagnostic overlays should follow movement indicator');
  });
});

describe('Local geometry UI — video and playback preservation', () => {
  const appSrc = read(APP_JS);
  const videoSrc = read(VIDEO_JS);
  const switchFn = extractFunctionBody(appSrc, 'switchLocalGeometryLayer');

  it('11. video element remains mounted during switching', () => {
    assert.doesNotMatch(switchFn, /localPlaybackVideo\?\.unload/);
    assert.doesNotMatch(switchFn, /removeChild/);
  });

  it('12. video source remains unchanged during geometry switch', () => {
    assert.doesNotMatch(switchFn, /onSegmentProcessed/);
    assert.doesNotMatch(switchFn, /setAttribute\(\s*['"]src/);
  });

  it('13. current video time is not reset on geometry switch', () => {
    assert.doesNotMatch(switchFn, /currentTime\s*=\s*0/);
    assert.match(videoSrc, /onTimelineScrub/);
  });

  it('14. timeline position remains unchanged on geometry switch', () => {
    assert.doesNotMatch(switchFn, /\$\(['"]timeline['"]\)\.value\s*=/);
  });

  it('15. blue vehicle arrow remains present', () => {
    const updateFn = extractFunctionBody(appSrc, 'updateLocalPlayback');
    assert.match(switchFn, /updateLocalPlayback/);
    assert.match(updateFn, /setPlaybackPose/);
    assert.match(updateFn, /resolveLocalPlaybackPose/);
  });

  it('17. play/pause state survives mode switching', () => {
    assert.doesNotMatch(switchFn, /stopPlayback/);
    assert.doesNotMatch(switchFn, /togglePlayback/);
  });

  it('18. playback can continue after switching', () => {
    assert.doesNotMatch(switchFn, /playStepTimer/);
    assert.match(appSrc, /tickPlaybackAnimation/);
  });

  it('19. zoom and pan survive mode switching', () => {
    assert.match(appSrc, /preserveViewport:\s*true/);
    assert.match(appSrc, /saveLocalPlaybackViewState/);
    assert.match(appSrc, /restoreLocalPlaybackViewState/);
    assert.doesNotMatch(
      appSrc,
      /switchLocalGeometryLayer[\s\S]*?clearLocalViewportBounds/,
    );
  });

  it('20. re-entering Local playback restores a valid previous selection', () => {
    assert.match(appSrc, /lastLocalPlaybackState/);
    assert.match(appSrc, /saveLocalPlaybackViewState/);
    assert.match(appSrc, /initLocalGeometryModeSelect/);
    assert.match(appSrc, /LOCAL_GEOMETRY_STORAGE_KEY|normalizeLocalGeometrySelection/);
  });
});

describe('Local playback — grey dashed vehicle path overlay', () => {
  const renderSrc = read(RENDER_JS);
  const appSrc = read(APP_JS);
  const switchFn = extractFunctionBody(appSrc, 'switchLocalGeometryLayer');
  const {
    analyzeTrajectoryDrawRuns,
    simulateTrajectoryOverlayStrokes,
    drawTrajectoryOverlay,
    LANE_POLYLINE_DEFAULT_MAX_GAP_M,
  } = require('../lib/local_trajectory_overlay');
  let data;

  it('setup: load segment 2', () => {
    data = loadSegment();
    assert.ok(data.routeChunks?.length);
  });

  it('Segment 2 trajectory renders stroked overlay runs, not zero-length lane-threshold runs', () => {
    const map = buildModeMap(data, 'fused');
    const before = analyzeTrajectoryDrawRuns(map.trajectory, LANE_POLYLINE_DEFAULT_MAX_GAP_M);
    const after = simulateTrajectoryOverlayStrokes(map.trajectory);
    assert.equal(before.drawableRuns, 1);
    assert.equal(after.strokeCount, 1);
    assert.equal(after.lineToCount, map.trajectory.length - 1);
  });

  it('canvas draw emits moveTo, lineTo, stroke and dash [8, 6]', () => {
    const map = buildModeMap(data, 'fused');
    const ctx = {
      strokeStyle: null,
      lineWidth: null,
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      setLineDash() {},
    };
    const result = drawTrajectoryOverlay(ctx, map.trajectory, (e, n) => ({ x: e, y: n }));
    assert.equal(result.calls.moveTo, 1);
    assert.equal(result.calls.lineTo, map.trajectory.length - 1);
    assert.equal(result.calls.stroke, 1);
    assert.deepEqual(result.calls.setLineDash[0], [8, 6]);
  });

  it('is a permanent overlay, not a Local geometry dropdown option', () => {
    const opts = localGeometryDropdownOptions();
    assert.equal(opts.length, 2);
    const html = read(INDEX_HTML);
    const selectBlock = html.match(/id="localGeometryMode"[\s\S]*?<\/select>/)?.[0] ?? '';
    assert.doesNotMatch(selectBlock, /value="(vehicle|trajectory|path)"/);
  });

  it('does not use lane _drawPolyline 15 m threshold for trajectory overlay', () => {
    const overlayStart = renderSrc.indexOf('_drawLocalVehiclePathOverlay(map) {');
    const overlayBlock = renderSrc.slice(
      overlayStart,
      renderSrc.indexOf('_drawGeometryDiagnosticOverlays(map)', overlayStart),
    );
    assert.match(overlayBlock, /drawTrajectoryOverlay/);
    assert.doesNotMatch(overlayBlock, /_drawPolyline\(map\.trajectory/);
  });

  it('geometry switching does not recreate video or clear playback state', () => {
    assert.doesNotMatch(switchFn, /refreshLocalPlaybackVideo/);
    assert.doesNotMatch(switchFn, /clearStationaryMapCache/);
    assert.doesNotMatch(switchFn, /clearProcessState/);
    assert.doesNotMatch(switchFn, /currentTime\s*=\s*0/);
  });

  it('geometry checksums remain unchanged after overlay fix', () => {
    const fused = buildModeMap(data, 'fused');
    const obs = buildModeMap(data, 'observations');
    const ctx = buildCtx(data);
    assert.equal(ctx.mode5.laneChecksum, EXPECTED.laneChecksum);
    assert.notEqual(fused.laneChecksum, obs.laneChecksum);
    assert.equal(fused.trajectoryPointCount, 30);
  });
});

describe('Local geometry UI — processing defaults and checksums', () => {
  it('25. Stage 7 is disabled by default', () => {
    const opts = normalizeProcessOptions({});
    assert.equal(opts.positiveBoundaryContinuityBridgeEnabled, false);
    assert.equal(DEFAULT_PROCESS_OPTIONS.positiveBoundaryContinuityBridgeEnabled, false);
  });

  it('26. Stage 8 is disabled by default', () => {
    const opts = normalizeProcessOptions({});
    assert.equal(opts.visibleGapReconstructionEnabled, false);
    assert.equal(DEFAULT_PROCESS_OPTIONS.visibleGapReconstructionEnabled, false);
  });

  it('27. Stage 7 and Stage 8 can still be explicitly enabled', () => {
    const ctx7 = buildCtx(loadSegment({ positiveBoundaryContinuityBridgeEnabled: true }));
    const ctx8 = buildCtx(loadSegment({
      positiveBoundaryContinuityBridgeEnabled: true,
      visibleGapReconstructionEnabled: true,
    }));
    assert.equal(ctx7.mode5.laneChecksum, '10845acd');
    assert.equal(ctx8.mode5.laneChecksum, '10845acd');
    assert.ok((ctx8.cleanup.visibleGapReconstruction?.stats?.totalInsertedPoints ?? 0) > 0);
  });

  it('28–31. Node reproduces pre–Stage-7/8 Segment 2 checksums', () => {
    const data = loadSegment();
    const ctx = buildCtx(data);
    const diag = buildLaneDiagnostics(
      {
        processingVersion: PROCESSING_VERSION,
        routeChunks: [ctx.chunk],
        processingOptions: data.processingOptions,
      },
      ctx.mode5,
      data.processingOptions,
    );
    const chunkRoad = SLM.computeRoadPolygonChecksum(ctx.chunk.roadSurfacePolygons || []);
    assert.equal(ctx.mode5.laneChecksum, EXPECTED.laneChecksum);
    assert.equal(diag.coordinateChecksum, EXPECTED.coordinateChecksum);
    assert.equal(chunkRoad, EXPECTED.roadSurfaceChecksum);
    assert.equal(ctx.chunk.fusedLaneLines.length, EXPECTED.fusedFragments);
    assert.equal(ctx.cleanup.cleaned.length, EXPECTED.cleanedRuns);
    assert.deepEqual(data.processingOptions, normalizeProcessOptions(PRE_STAGE7_SEGMENT_OPTS));
  });

  it('24. switching Local geometry does not alter geometry checksums', () => {
    const data = loadSegment();
    const fused = buildModeMap(data, 'fused');
    const obs = buildModeMap(data, 'observations');
    const ctx = buildCtx(data);
    const apiLane = ctx.mode5.laneChecksum;
    assert.equal(apiLane, EXPECTED.laneChecksum);
    assert.notEqual(fused.laneChecksum, obs.laneChecksum);
    const refused = buildModeMap(data, 'fused');
    assert.equal(refused.laneChecksum, fused.laneChecksum);
  });
});

describe('Local geometry UI — API parity', () => {
  it('28. API produces same pre–Stage-7/8 geometry checksums', async () => {
    const body = JSON.stringify({ segments: ['qlog_f449c_2.bz2'], options: {}, bustCache: true });
    const payload = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port: 3847,
        path: '/api/process',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    const d = payload.laneDiagnostics || {};
    assert.equal(payload.processingVersion, PROCESSING_VERSION);
    assert.equal(d.laneChecksum, EXPECTED.laneChecksum);
    assert.equal(d.coordinateChecksum, EXPECTED.coordinateChecksum);
    assert.equal(d.roadSurfaceChecksum, EXPECTED.roadSurfaceChecksum);
    assert.equal(d.fusedFragmentCount, EXPECTED.fusedFragments);
    assert.equal(d.cleanedRunCount, EXPECTED.cleanedRuns);
    assert.equal(payload.processingOptions.positiveBoundaryContinuityBridgeEnabled, false);
    assert.equal(payload.processingOptions.visibleGapReconstructionEnabled, false);
  });
});

describe('Local geometry UI — browser module parity', () => {
  it('browser local_geometry_ui.js mirrors lib exports', () => {
    const src = read(LOCAL_GEOMETRY_UI_JS);
    assert.match(src, /LOCAL_GEOMETRY_DEFAULT_MODE.*fused/);
    assert.match(src, /normalizeLocalGeometrySelection/);
    assert.match(src, /HIDDEN_GEOMETRY_SOURCES/);
  });

  it('PROCESSING_VERSION bumped for cache invalidation', () => {
    assert.equal(PROCESSING_VERSION, '2026-07-24-fusion-v15');
  });
});
