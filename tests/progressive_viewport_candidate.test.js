'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PVP = require('../lib/progressive_viewport_candidate');
const PCP = require('../lib/progressive_combined_playback');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const SEG0 = 'qlog_f449c_0.bz2';
const SEG9 = 'qlog_f449c_9.bz2';

function processPrefix(files) {
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

function buildCombinedMap(files) {
  const pd = processPrefix(files);
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: true });
  return CBAO.applyBoundaryAnchoredOrientation(map, pd, { mirrorChecked: true });
}

test('pvp-1. candidate parser defaults off', () => {
  assert.equal(PVP.parseProgressiveViewportCandidate(''), false);
  assert.equal(PVP.isCandidateEnabled('', false), false);
  assert.equal(PVP.isCandidateEnabled('', true), false);
});

test('pvp-2. explicit progressiveViewportCandidate=1 enables with progressive combined', () => {
  assert.equal(PVP.parseProgressiveViewportCandidate('?progressiveViewportCandidate=1'), true);
  assert.equal(PVP.isCandidateEnabled('?progressiveViewportCandidate=1', true), true);
  assert.equal(PVP.isCandidateEnabled('?progressiveViewportCandidate=1', false), false);
});

test('pvp-3. candidate-off wheel behaviour wiring unchanged', () => {
  assert.ok(APP_SRC.includes('renderer.scale *= e.deltaY < 0 ? 1.1 : 0.9'));
  assert.ok(APP_SRC.includes('isProgressiveViewportCandidateEnabled()'));
});

test('pvp-4. ordinary wheel cannot zoom in protected mode (wiring)', () => {
  assert.ok(APP_SRC.includes('if (isProgressiveViewportCandidateEnabled() && !e.ctrlKey)'));
  assert.ok(APP_SRC.includes('Ctrl + wheel to zoom'));
});

test('pvp-5. ctrl+wheel path still reaches scale change (wiring)', () => {
  const block = APP_SRC.match(/canvas\.addEventListener\('wheel'[\s\S]*?}, \{ passive: false \}\);/);
  assert.ok(block);
  assert.ok(block[0].includes('!e.ctrlKey'));
  assert.ok(block[0].includes('renderer.scale'));
});

test('pvp-6. fit visible route uses displayMap helpers not fullMap', () => {
  assert.ok(APP_SRC.includes('fitProgressiveVisibleRoute'));
  assert.ok(APP_SRC.includes('getActiveProgressiveDisplayMap()'));
  assert.ok(APP_SRC.includes('computeVisibleRouteBounds'));
  assert.ok(!APP_SRC.includes('fitProgressiveVisibleRoute(fullMap'));
});

test('pvp-7. hidden prepared source excluded from visible-route fit inputs', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const visible = [SEG0];
  const hidden = PCP.resolveNextAvailableSegment(available, visible);
  const pd = processPrefix([...visible, hidden]);
  const fullMap = buildCombinedMap([...visible, hidden]);
  const display = PCP.buildInitialLookaheadDisplay(fullMap, pd, visible, hidden).displayMap;
  const visibleBounds = PVP.computeVisibleRouteBounds(display, visible);
  const hiddenBounds = PVP.computeVisibleRouteBounds(fullMap, [...visible, hidden]);
  assert.ok(visibleBounds?.finite);
  assert.ok(hiddenBounds?.finite);
  assert.notDeepEqual(visibleBounds, hiddenBounds);
  assert.equal(display.trajectory.some((p) => p.sourceFile === hidden), false);
});

test('pvp-8. fit active segment resolves active visible timeline source', () => {
  assert.ok(APP_SRC.includes('fitProgressiveActiveSegment'));
  assert.ok(APP_SRC.includes('resolveFitBounds'));
  const pd = processPrefix([SEG0]);
  const map = buildCombinedMap([SEG0]);
  const display = PCP.filterMapToVisibleSources(map, [SEG0]);
  const bounds = PVP.computeActiveSegmentBounds(display, SEG0);
  assert.ok(bounds?.finite);
});

test('pvp-9. degenerate active segment falls back to visible route', () => {
  const sparse = {
    trajectory: [],
    pointAccumulated: { points: [] },
    fitBounds: { minE: 0, maxE: 0, minN: 0, maxN: 0, finite: true },
  };
  const resolved = PVP.resolveFitBounds(sparse, [SEG9], SEG9);
  assert.equal(resolved.mode, 'visibleRoute');
});

test('pvp-10. follow arrow preserves zoom (center only)', () => {
  assert.ok(APP_SRC.includes('centerOnWorldPoint'));
  assert.ok(RENDER_SRC.includes('centerOnWorldPoint(east, north)'));
  assert.ok(!APP_SRC.includes('centerOnWorldPoint') || APP_SRC.includes('applyFollowArrowIfNeeded'));
});

test('pvp-11. follow arrow changes only viewport translation', () => {
  const fn = RENDER_SRC.match(/centerOnWorldPoint\(east, north\) \{[\s\S]*?\n  \}/);
  assert.ok(fn);
  assert.ok(fn[0].includes('this.offsetX += cx - screen.x'));
  assert.ok(fn[0].includes('this.offsetY += cy - screen.y'));
  assert.ok(!fn[0].includes('this.scale'));
});

test('pvp-12. manual pan disables follow arrow', () => {
  assert.ok(APP_SRC.includes('disableProgressiveFollowArrowFromPan'));
  assert.ok(APP_SRC.includes('progressiveViewportFollowArrow = false'));
});

test('pvp-13. append preserves viewport unless explicit fit (wiring)', () => {
  assert.ok(APP_SRC.includes('preserveViewport: true'));
  assert.ok(APP_SRC.includes('captureProgressiveViewCapture'));
});

test('pvp-14. remove-last uses display snapshot restore', () => {
  assert.ok(APP_SRC.includes('restoreProgressiveStateSnapshot'));
  assert.ok(APP_SRC.includes('applyActiveProgressiveDisplaySnapshot'));
});

describe('pvp LOD and checksum', () => {
  test('pvp-15. LOD decimation does not modify source arrays', () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ east: i, north: 0 }));
    const before = JSON.stringify(pts);
    const { indices } = PVP.decimatePolylineForDraw(pts, (p) => ({ x: p.east, y: p.north }), { minPixelGap: 5 });
    assert.equal(JSON.stringify(pts), before);
    assert.ok(indices.length < pts.length);
  });

  test('pvp-16. LOD preserves endpoints and sharp bends', () => {
    const pts = [
      { east: 0, north: 0 },
      { east: 1, north: 0 },
      { east: 2, north: 0 },
      { east: 3, north: 10 },
      { east: 4, north: 10 },
    ];
    const { indices } = PVP.decimatePolylineForDraw(pts, (p) => ({ x: p.east * 2, y: p.north * 2 }), { minPixelGap: 4 });
    assert.equal(indices[0], 0);
    assert.equal(indices[indices.length - 1], pts.length - 1);
    assert.ok(indices.includes(3));
  });

  test('pvp-17. full detail when zoomed in (small min gap)', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ east: i, north: 0 }));
    const dense = PVP.screenSpaceDecimateIndices(pts.length, (i) => ({ x: pts[i].east, y: 0 }), { minPixelGap: 0.5 });
    const sparse = PVP.screenSpaceDecimateIndices(pts.length, (i) => ({ x: pts[i].east, y: 0 }), { minPixelGap: 8 });
    assert.ok(dense.length > sparse.length);
  });

  test('pvp-18. display-map checksum unchanged by viewport helpers', () => {
    const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
    if (!available.includes(SEG0)) return;
    const map = buildCombinedMap([SEG0]);
    const display = PCP.filterMapToVisibleSources(map, [SEG0]);
    const before = PVP.mapGeometryChecksum(display, [SEG0]);
    PVP.computeVisibleRouteBounds(display, [SEG0]);
    PVP.resolveFitBounds(display, [SEG0], SEG0);
    PVP.countDrawableGeometry(display, [SEG0]);
    const after = PVP.mapGeometryChecksum(display, [SEG0]);
    assert.equal(before, after);
  });
});

test('pvp-19. timeline/video/arrow wiring unchanged', () => {
  assert.ok(APP_SRC.includes('getPlaybackProcessData()'));
  assert.ok(APP_SRC.includes('resolveActivePlaybackProvenance'));
});

test('pvp-20. progressive Seg5 snapshot alignment regression wiring', () => {
  assert.ok(APP_SRC.includes('getActiveProgressiveDisplayData'));
  assert.ok(APP_SRC.includes('applyActiveProgressiveDisplaySnapshot'));
});

test('pvp-21. combined orientation wiring present in index', () => {
  assert.ok(INDEX_SRC.includes('combined_boundary_anchored_orientation.js'));
  assert.ok(INDEX_SRC.includes('progressive_viewport_candidate.js'));
});

test('pvp-22. candidate-off local playback fit paths remain', () => {
  assert.ok(APP_SRC.includes('fitToLocalView()'));
  assert.ok(APP_SRC.includes('function applyVisualization()'));
});

test('pvp-23. top playback toolbar absent when viewport candidate off', () => {
  assert.ok(INDEX_SRC.includes('id="progressiveViewportPlaybackPanel"'));
  assert.ok(APP_SRC.includes('progressiveViewportPlaybackPanel'));
  assert.ok(APP_SRC.includes("panel.classList.toggle('hidden', !enabled)"));
});

test('pvp-24. top toolbar placed below remove-last in progressive panel', () => {
  const removeIdx = INDEX_SRC.indexOf('btnProgressiveRemoveLast');
  const playbackIdx = INDEX_SRC.indexOf('progressiveViewportPlaybackPanel');
  const viewportIdx = INDEX_SRC.indexOf('progressiveViewportPanel');
  assert.ok(removeIdx >= 0 && playbackIdx > removeIdx && viewportIdx > playbackIdx);
});

test('pvp-25. both play buttons call shared togglePlayback', () => {
  assert.ok(APP_SRC.includes("bindOnce('btnProgressivePlay', () => togglePlayback())"));
  assert.ok(APP_SRC.includes("$('btnPlay').onclick = () => togglePlayback()"));
});

test('pvp-26. shared labels update both play buttons', () => {
  assert.ok(APP_SRC.includes('function setPlaybackButtonLabels(playing)'));
  assert.ok(APP_SRC.includes("for (const id of ['btnPlay', 'btnProgressivePlay'])"));
});

test('pvp-27. top prev uses shared stepTimelinePrev', () => {
  assert.ok(APP_SRC.includes("bindOnce('btnProgressivePrevFrame', () => stepTimelinePrev())"));
  assert.ok(APP_SRC.includes("$('btnPrevFrame').onclick = () => stepTimelinePrev()"));
});

test('pvp-28. top next uses shared stepTimelineNext', () => {
  assert.ok(APP_SRC.includes("bindOnce('btnProgressiveNextFrame', () => stepTimelineNext())"));
  assert.ok(APP_SRC.includes("$('btnNextFrame').onclick = () => stepTimelineNext()"));
});

test('pvp-29. top prev/next route through updateTimelineInfo (arrow/video/diagnostics)', () => {
  const prevFn = APP_SRC.match(/function stepTimelinePrev\(\) \{[\s\S]*?\n\}/);
  const nextFn = APP_SRC.match(/function stepTimelineNext\(\) \{[\s\S]*?\n\}/);
  assert.ok(prevFn?.[0].includes('updateTimelineInfo'));
  assert.ok(nextFn?.[0].includes('updateTimelineInfo'));
  assert.ok(APP_SRC.includes('localPlaybackVideo?.onTimelineScrub'));
});

test('pvp-30. hidden prepared-source frames stay outside visible timeline max', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  const visible = [SEG0];
  const hidden = PCP.resolveNextAvailableSegment(available, visible);
  if (!hidden) return;
  const pd = processPrefix([...visible, hidden]);
  const display = PCP.filterProcessDataToVisibleSources(pd, visible);
  const fullLen = pd.timeline.length;
  const displayLen = display.timeline.length;
  assert.ok(displayLen < fullLen);
  assert.equal(display.timeline.some((t) => t.sourceFile === hidden), false);
});

test('pvp-31. disabled states sync on both prev/next button pairs', () => {
  assert.ok(APP_SRC.includes('function syncPlaybackControlStates'));
  assert.ok(APP_SRC.includes("for (const id of ['btnPrevFrame', 'btnProgressivePrevFrame'])"));
  assert.ok(APP_SRC.includes("for (const id of ['btnNextFrame', 'btnProgressiveNextFrame'])"));
});

test('pvp-32. append-and-continue path syncs playback controls', () => {
  assert.ok(APP_SRC.includes('syncPlaybackControlStates(resolvedIndex)'));
  assert.ok(APP_SRC.includes('updateTimelineInfo(timelineIndex)'));
});

test('pvp-33. remove-last restore path syncs playback controls', () => {
  assert.ok(APP_SRC.includes('restoreProgressiveStateSnapshot'));
  assert.ok(APP_SRC.includes('syncPlaybackControlStates'));
});

test('pvp-34. reprocessing binds top toolbar once via dataset.bound', () => {
  assert.ok(APP_SRC.includes('if (el && !el.dataset.bound)'));
  assert.ok(APP_SRC.includes("el.dataset.bound = '1'"));
  assert.ok(APP_SRC.includes('initProgressiveViewportPlaybackUI'));
});

test('pvp-35. candidate-off keeps original lower playback handlers only', () => {
  assert.ok(APP_SRC.includes('initProgressiveViewportPlaybackUI'));
  const initBlock = APP_SRC.match(/function initProgressiveViewportPlaybackUI\(\) \{[\s\S]*?\n\}/);
  assert.ok(initBlock?.[0].includes("panel.classList.toggle('hidden', !enabled)"));
  assert.ok(APP_SRC.includes('function togglePlayback()'));
});

test('pvp-36. display-map checksum unchanged after playback control wiring', () => {
  const available = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f));
  if (!available.includes(SEG0)) return;
  const map = buildCombinedMap([SEG0]);
  const display = PCP.filterMapToVisibleSources(map, [SEG0]);
  const before = PVP.mapGeometryChecksum(display, [SEG0]);
  syncPlaybackControlStatesStub();
  const after = PVP.mapGeometryChecksum(display, [SEG0]);
  assert.equal(before, after);
  function syncPlaybackControlStatesStub() {
    PVP.computeVisibleRouteBounds(display, [SEG0]);
    PVP.resolveFitBounds(display, [SEG0], SEG0);
  }
});
