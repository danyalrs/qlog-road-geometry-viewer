'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  TRAJECTORY_OVERLAY_MAX_GAP_M,
  TRAJECTORY_OVERLAY_STYLE,
  LANE_POLYLINE_DEFAULT_MAX_GAP_M,
  analyzeTrajectoryDrawRuns,
  splitPolylineRuns,
  splitTrajectoryOverlayRuns,
  drawTrajectoryOverlay,
  simulateTrajectoryOverlayStrokes,
} = require('../lib/local_trajectory_overlay');
const SLM = require('../lib/segment_local_map');
const { loadSegment, buildCtx } = require('../lib/lane_continuity_stage4');

const RENDER_JS = path.join(__dirname, '..', 'public', 'render.js');
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

function mockCanvasContext() {
  const calls = { moveTo: [], lineTo: [], stroke: 0, setLineDash: [], strokeStyle: null, lineWidth: null };
  return {
    calls,
    strokeStyle: null,
    lineWidth: null,
    beginPath() {},
    moveTo(x, y) { calls.moveTo.push({ x, y }); },
    lineTo(x, y) { calls.lineTo.push({ x, y }); },
    stroke() { calls.stroke += 1; },
    setLineDash(dash) { calls.setLineDash.push([...dash]); },
  };
}

describe('Local trajectory overlay — Segment 2 diagnosis', () => {
  let trajectory;

  it('setup: load Segment 2 fused local map trajectory', () => {
    const data = loadSegment();
    const map = buildModeMap(data, 'fused');
    trajectory = map.trajectory;
    assert.equal(trajectory.length, 30);
  });

  it('reports consecutive-distance statistics', () => {
    const before = analyzeTrajectoryDrawRuns(trajectory, LANE_POLYLINE_DEFAULT_MAX_GAP_M);
    assert.equal(before.pointCount, 30);
    assert.ok(before.distanceStats.min > 6.9 && before.distanceStats.min < 7.0);
    assert.ok(before.distanceStats.median > 23 && before.distanceStats.median < 24);
    assert.ok(before.distanceStats.max > 35 && before.distanceStats.max < 36);
    assert.equal(before.gapsOverThreshold, 26);
  });

  it('15 m lane threshold leaves only one short drawable run', () => {
    const before = analyzeTrajectoryDrawRuns(trajectory, LANE_POLYLINE_DEFAULT_MAX_GAP_M);
    assert.equal(before.totalRuns, 27);
    assert.equal(before.drawableRuns, 1);
    assert.deepEqual(before.runLengths.filter((n) => n >= 2), [4]);
  });

  it('explains why the grey path was effectively invisible', () => {
    const before = analyzeTrajectoryDrawRuns(trajectory, LANE_POLYLINE_DEFAULT_MAX_GAP_M);
    const overlay = simulateTrajectoryOverlayStrokes(trajectory);
    assert.equal(before.drawableRuns, 1, 'only a 4-point tail stroke rendered under 15 m rule');
    assert.equal(overlay.drawableRuns, 1);
    assert.equal(overlay.strokeCount, 1);
    assert.equal(overlay.lineToCount, 29, 'overlay rule strokes the full 30-point route');
    assert.ok(
      before.gapsOverThreshold >= 26,
      'normal ~7–35 m pose spacing exceeds the lane 15 m break threshold',
    );
  });
});

describe('Local trajectory overlay — rendering behaviour', () => {
  let data;
  let trajectory;

  it('setup', () => {
    data = loadSegment();
    trajectory = buildModeMap(data, 'fused').trajectory;
  });

  it('Segment 2 produces at least one stroked run with two or more points', () => {
    const sim = simulateTrajectoryOverlayStrokes(trajectory);
    assert.ok(sim.drawableRuns >= 1);
    assert.ok(sim.strokeCount >= 1);
    assert.ok(sim.lineToCount >= trajectory.length - 1);
  });

  it('normal vehicle-pose spacing above 15 m does not erase the overlay', () => {
    const laneRuns = splitPolylineRuns(trajectory, LANE_POLYLINE_DEFAULT_MAX_GAP_M);
    const overlayRuns = splitTrajectoryOverlayRuns(trajectory);
    assert.equal(laneRuns.filter((r) => r.length >= 2).length, 1);
    assert.equal(overlayRuns.length, 1);
    assert.equal(overlayRuns[0].length, trajectory.length);
  });

  it('actual trajectory-section boundaries remain disconnected', () => {
    const sectionA = [
      { east: 0, north: 0, logMonoTime: '100' },
      { east: 20, north: 0, logMonoTime: '200' },
      { east: 40, north: 0, logMonoTime: '300' },
    ];
    const sectionB = [
      { east: 300, north: 0, logMonoTime: '400' },
      { east: 320, north: 0, logMonoTime: '500' },
    ];
    const combined = [...sectionA, ...sectionB];
    const runs = splitTrajectoryOverlayRuns(combined);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].length, 3);
    assert.equal(runs[1].length, 2);
    assert.equal(simulateTrajectoryOverlayStrokes(combined).strokeCount, 2);
  });

  it('time reversals break overlay runs', () => {
    const points = [
      { east: 0, north: 0, logMonoTime: '300' },
      { east: 10, north: 0, logMonoTime: '200' },
      { east: 20, north: 0, logMonoTime: '400' },
    ];
    const runs = splitTrajectoryOverlayRuns(points);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].length, 1);
    assert.equal(runs[1].length, 2);
  });

  it('canvas receives moveTo, lineTo and stroke with dash [8, 6]', () => {
    const ctx = mockCanvasContext();
    const result = drawTrajectoryOverlay(ctx, trajectory, identityWorldToScreen);
    assert.equal(result.drawableRuns, 1);
    assert.equal(result.calls.stroke, 1);
    assert.equal(result.calls.moveTo, 1);
    assert.equal(result.calls.lineTo, 29);
    assert.deepEqual(result.calls.setLineDash[0], [8, 6]);
    assert.equal(ctx.strokeStyle, TRAJECTORY_OVERLAY_STYLE.color);
    assert.equal(ctx.lineWidth, TRAJECTORY_OVERLAY_STYLE.width);
  });

  it('overlay appears in Raw mapped observations mode', () => {
    const map = buildModeMap(data, 'observations');
    const sim = simulateTrajectoryOverlayStrokes(map.trajectory);
    assert.equal(sim.strokeCount, 1);
    assert.equal(sim.lineToCount, map.trajectory.length - 1);
  });

  it('overlay appears in Fused lane lines mode', () => {
    const map = buildModeMap(data, 'fused');
    const sim = simulateTrajectoryOverlayStrokes(map.trajectory);
    assert.equal(sim.strokeCount, 1);
    assert.equal(sim.lineToCount, map.trajectory.length - 1);
  });

  it('survives switching between modes with identical trajectory data', () => {
    const obs = buildModeMap(data, 'observations');
    const fused = buildModeMap(data, 'fused');
    assert.deepEqual(obs.trajectory, fused.trajectory);
    assert.equal(
      simulateTrajectoryOverlayStrokes(obs.trajectory).strokeCount,
      simulateTrajectoryOverlayStrokes(fused.trajectory).strokeCount,
    );
  });

  it('lane renderer retains the existing 15 m break threshold', () => {
    const renderSrc = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(renderSrc, /_drawPolyline\(points, color, width, dashed, maxGapM = 15\)/);
    const overlayStart = renderSrc.indexOf('_drawLocalVehiclePathOverlay(map) {');
    const overlayBlock = renderSrc.slice(
      overlayStart,
      renderSrc.indexOf('_drawGeometryDiagnosticOverlays(map)', overlayStart),
    );
    assert.doesNotMatch(overlayBlock, /_drawPolyline\(map\.trajectory/);
    assert.match(overlayBlock, /drawTrajectoryOverlay/);
  });

  it('arrow renders after dashed path in stationary local map', () => {
    const renderSrc = fs.readFileSync(RENDER_JS, 'utf8');
    const methodSlice = renderSrc.slice(
      renderSrc.indexOf('_drawStationaryLocalMap(d, elapsedIdx) {'),
      renderSrc.indexOf('_drawStationaryLocalMap(d, elapsedIdx) {') + 12000,
    );
    // The arrow is drawn in the early-return block that also draws the vehicle
    // path overlay; it must appear AFTER the path overlay in the method body.
    const pathIdx = methodSlice.indexOf('this._drawLocalVehiclePathOverlay(map);');
    const arrowIdx = methodSlice.indexOf('this._drawLocalPlaybackArrow(null, this.playbackPose)');
    assert.ok(pathIdx >= 0 && arrowIdx > pathIdx);
  });

  it('geometry checksums remain unchanged', () => {
    const ctx = buildCtx(data);
    const fused = buildModeMap(data, 'fused');
    const obs = buildModeMap(data, 'observations');
    assert.equal(ctx.mode5.laneChecksum, EXPECTED.laneChecksum);
    assert.notEqual(fused.laneChecksum, obs.laneChecksum);
    const fusedAgain = buildModeMap(data, 'fused');
    assert.equal(fusedAgain.laneChecksum, fused.laneChecksum);
    assert.equal(fusedAgain.trajectoryPointCount, 30);
  });

  it('uses trajectory-specific 150 m gap aligned with buildSegmentTrajectory', () => {
    assert.equal(TRAJECTORY_OVERLAY_MAX_GAP_M, 150);
    assert.notEqual(TRAJECTORY_OVERLAY_MAX_GAP_M, LANE_POLYLINE_DEFAULT_MAX_GAP_M);
  });
});
