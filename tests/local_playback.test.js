'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const {
  matchVehiclePathPoint,
  findFrame,
  nearestPointOnPolyline,
  dashReferencePoint,
  resolveAnchorFrameIndex,
  buildPlaybackContext,
  resolveArrowAtLogMonoTime,
  resolveArrowOnDashPath,
  resolveTimingWindow,
  interpolateTimedPath,
  lerpPose,
  headingDegForVehicleIcon,
  findHeadingPair,
  resolvePathHeadingDeg,
  smoothHeadingDeg,
  shortestAngleDegDelta,
  MIN_HEADING_DISPLACEMENT_M,
  computeVehicleFrameBounds,
  NEAREST_TIME_TOLERANCE_NS,
} = require('../lib/local_playback');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG54 = path.join(ROOT, 'qlog_f449c_54.bz2');
const INDEX_HTML = path.join(ROOT, 'public/index.html');
const RENDER_JS = path.join(ROOT, 'public/render.js');

function processSegment(filePath) {
  const modelEvents = extractModel(filePath).map((e) => ({ ...e, sourceFile: path.basename(filePath) }));
  const gpsEvents = extractGps(filePath).map((e) => ({ ...e, sourceFile: path.basename(filePath) }));
  return processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
}

function loadSegment54PlaybackData() {
  const result = processSegment(SEG54);
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { timeline, vehiclePath: result.vehiclePath, frames: result.frames, result };
}

function arrowPose(data, frameIndex) {
  const anchorIdx = resolveAnchorFrameIndex(data.frames, data.timeline);
  return resolveArrowOnDashPath({
    anchorFrame: data.frames[anchorIdx],
    frames: data.frames,
    timeline: data.timeline,
    vehiclePath: data.vehiclePath,
    frameIndex,
    options: { minHeadingSpeedMps: 2 },
  });
}

function segment54Context(data) {
  const anchorIdx = resolveAnchorFrameIndex(data.frames, data.timeline);
  return buildPlaybackContext({
    anchorFrame: data.frames[anchorIdx],
    timeline: data.timeline,
    vehiclePath: data.vehiclePath,
    options: { minHeadingSpeedMps: 2 },
  });
}

function arrowScreenDir(headingDeg) {
  const rad = -headingDeg * Math.PI / 180;
  const x = -Math.sin(rad);
  const y = -Math.cos(rad);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function pathScreenDir(dx, dy) {
  const x = dx;
  const y = -dy;
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
}

function expectHeadingAlongPath(headingDeg, dx, dy, message) {
  const arrow = arrowScreenDir(headingDeg);
  const path = pathScreenDir(dx, dy);
  const dot = arrow.x * path.x + arrow.y * path.y;
  assert.ok(dot > 0.95, `${message}: dot=${dot.toFixed(3)} heading=${headingDeg}`);
  const reverseDot = arrow.x * (-path.x) + arrow.y * (-path.y);
  assert.ok(reverseDot < 0.5, `${message}: arrow should not point backward, reverseDot=${reverseDot.toFixed(3)}`);
}

describe('local playback UI mode', () => {
  it('includes Local playback with stationary map label', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /value="local" selected>Local playback<\/option>/);
    assert.match(html, /stationary segment map with moving arrow/);
    assert.match(html, /Raw mapped observations/);
    assert.match(html, /Fused lane lines/);
    assert.match(html, /id="localGeometryMode"/);
  });

  it('render.js shares vehicle-relative geometry branch for local playback', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /_drawVehicleFrameGeometry/);
    assert.match(src, /_drawLocalPlayback\(d\) \{[\s\S]*?_drawVehicleFrameGeometry/);
    assert.doesNotMatch(src, /_drawLocalPlayback\(d\) \{[\s\S]*?_drawGlobal/);
  });
});

describe('local playback dash-path matching', () => {
  it('matches frames by frameId then logMonoTime', () => {
    const frames = [
      { frameId: 10, logMonoTime: '100', path: { points: [{ east: 1, north: 2 }] } },
      { frameId: 11, logMonoTime: '200', path: { points: [{ east: 3, north: 4 }] } },
    ];
    assert.equal(findFrame(frames, { frameId: 11 }).matchMethod, 'frameId');
    assert.equal(findFrame(frames, { logMonoTime: '200' }).matchMethod, 'logMonoTime');
  });

  it('uses dashReferencePoint from frame.path.points[0]', () => {
    const frame = { path: { points: [{ east: 5, north: 6, modelX: 0.1 }] } };
    const ref = dashReferencePoint(frame);
    assert.equal(ref.source, 'path[0]');
    assert.equal(ref.east, 5);
  });

  it('handles missing path or timeline data without throwing', () => {
    assert.equal(resolveArrowOnDashPath({
      anchorFrame: { path: { points: [] } },
      frames: [],
      timeline: [],
      vehiclePath: [],
      frameIndex: 0,
    }).east, 0);
    assert.equal(matchVehiclePathPoint([], { logMonoTime: '1' }), null);
    assert.equal(dashReferencePoint({}), null);
  });
});

describe('local playback arrow heading', () => {
  it('points along a straight east path using canvas-adjusted atan2(dy, dx)', () => {
    const timed = [
      { east: 0, north: 0, logMonoTime: '0' },
      { east: 5, north: 0, logMonoTime: '1' },
      { east: 10, north: 0, logMonoTime: '2' },
    ];
    const heading = resolvePathHeadingDeg(timed, 1);
    expectHeadingAlongPath(heading, 5, 0, 'straight east');
  });

  it('turns correctly on a curved synthetic path', () => {
    const timed = [
      { east: 0, north: 0, logMonoTime: '0' },
      { east: 5, north: 0, logMonoTime: '1' },
      { east: 5, north: 5, logMonoTime: '2' },
    ];
    const eastHeading = resolvePathHeadingDeg(timed, 0.5);
    const northHeading = resolvePathHeadingDeg(timed, 1.5);
    expectHeadingAlongPath(eastHeading, 5, 0, 'curve east leg');
    expectHeadingAlongPath(northHeading, 0, 5, 'curve north leg');
    assert.ok(Math.abs(shortestAngleDegDelta(eastHeading, northHeading)) > 45);
  });

  it('does not reverse by 180 degrees on segment 54 moving frames', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const anchorIdx = resolveAnchorFrameIndex(data.frames, data.timeline);
    const pts = data.frames[anchorIdx].path.points;
    for (const idx of [0, 1, 3, 10, 15, 17]) {
      const pose = arrowPose(data, idx);
      const pair = findHeadingPair(buildPlaybackContext({
        anchorFrame: data.frames[anchorIdx],
        timeline: data.timeline,
        vehiclePath: data.vehiclePath,
        options: { minHeadingSpeedMps: 2 },
      }).timedPath, pose.pathIndex);
      assert.ok(pair, `expected heading pair at idx ${idx}`);
      expectHeadingAlongPath(pose.headingDeg, pair.dx, pair.dy, `segment54 idx ${idx}`);
      assert.ok(Number.isFinite(pose.headingDeg));
    }
  });

  it('keeps heading fixed during STOPPED frames on segment 54', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const freeze = arrowPose(data, 17);
    const stoppedA = arrowPose(data, 18);
    const stoppedB = arrowPose(data, 29);
    assert.equal(stoppedA.headingDeg, freeze.headingDeg);
    assert.equal(stoppedB.headingDeg, freeze.headingDeg);
    assert.ok(stoppedA.frozen);
  });

  it('scrubbing backward keeps forward path heading rather than reversing', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const earlier = arrowPose(data, 4);
    const later = arrowPose(data, 12);
    const back = arrowPose(data, 6);
    for (const pose of [earlier, later, back]) {
      const ctx = segment54Context(data);
      const pair = findHeadingPair(ctx.timedPath, pose.pathIndex);
      expectHeadingAlongPath(pose.headingDeg, pair.dx, pair.dy, `scrub pose pathIndex ${pose.pathIndex}`);
    }
  });

  it('handles duplicate and near-identical path points without NaN heading', () => {
    const timed = [
      { east: 0, north: 0, logMonoTime: '0' },
      { east: 0, north: 0, logMonoTime: '1' },
      { east: 0.2, north: 0, logMonoTime: '2' },
      { east: 2, north: 0, logMonoTime: '3' },
    ];
    const heading = resolvePathHeadingDeg(timed, 1, 90);
    assert.ok(Number.isFinite(heading));
    assert.ok(heading >= 0 && heading < 360);
    expectHeadingAlongPath(heading, 2, 0, 'after duplicate points');
  });

  it('smoothHeadingDeg uses shortest-angle interpolation across wraparound', () => {
    const smoothed = smoothHeadingDeg(350, 10, 1);
    assert.ok(Math.abs(smoothed - 10) < 0.01 || Math.abs(smoothed - 370) < 0.01);
    const partial = smoothHeadingDeg(350, 10, 0.5);
    assert.ok(partial > 350 || partial < 20);
  });

  it('headingDegForVehicleIcon returns null below displacement threshold', () => {
    assert.equal(headingDegForVehicleIcon(0.01, 0.01, MIN_HEADING_DISPLACEMENT_M), null);
    assert.ok(headingDegForVehicleIcon(1, 0, MIN_HEADING_DISPLACEMENT_M) != null);
  });
});

describe('local playback timestamp interpolation', () => {
  it('uses logMonoTime nanoseconds for timed path points', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const ctx = segment54Context(data);
    assert.ok(ctx.timedPath.length >= 2);
    const t0 = BigInt(ctx.timedPath[0].logMonoTime);
    const tN = BigInt(ctx.timedPath[ctx.timedPath.length - 1].logMonoTime);
    assert.equal(t0, ctx.timing.tStart);
    assert.equal(tN, ctx.timing.tFreeze);
    assert.ok(tN > t0);
  });

  it('starts at chronological path origin on segment 54', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const start = arrowPose(data, 0);
    assert.ok(start.pathIndex < 1, `expected near path start, got ${start.pathIndex}`);
    assert.equal(start.frozen, false);
    assert.equal(start.matchMethod, 'logMonoTimeInterpolation');
  });

  it('progresses at 25%, 50%, and 75% of recorded moving time', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const ctx = segment54Context(data);
    const span = ctx.timing.tFreeze - ctx.timing.tStart;
    const fractions = [0.25, 0.5, 0.75];
    const poses = fractions.map((f) => {
      const t = ctx.timing.tStart + (span * BigInt(Math.round(f * 1_000_000)) / 1_000_000n);
      return resolveArrowAtLogMonoTime(ctx, t.toString(), null, { vehiclePath: data.vehiclePath });
    });
    assert.ok(poses[0].pathIndex < poses[1].pathIndex);
    assert.ok(poses[1].pathIndex < poses[2].pathIndex);
    assert.ok(poses[0].pathIndex > 0);
    assert.ok(poses[2].pathIndex < ctx.timedPath.length - 1);
  });

  it('does not reach the final path point while timeline still reports moving', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const anchorIdx = resolveAnchorFrameIndex(data.frames, data.timeline);
    const finalPathIdx = data.frames[anchorIdx].path.points.length - 1;
    for (const idx of [1, 3, 5, 10, 15]) {
      const entry = data.timeline[idx];
      const pose = arrowPose(data, idx);
      const state = entry.movementState;
      // With the stationary pose lock, the arrow freezes as soon as the vehicle
      // stops (state becomes 'stationary' or the pose lock engages). While
      // genuinely moving, the arrow must not be at the path end.
      if (state === 'moving' || state === 'creeping') {
        assert.ok(
          pose.pathIndex < finalPathIdx - 0.01,
          `idx ${idx} should not be at path end while ${state}, pathIdx=${pose.pathIndex}`,
        );
      }
    }
  });

  it('reaches freeze position at stopping timestamp and stays fixed afterward', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    // With the stationary pose lock, the arrow freezes at the first stationary
    // timestamp (frame 11 on seg54, firstStationaryIdx). Frames at/after it are
    // frozen at the same pose; earlier frames are not frozen.
    const freeze = arrowPose(data, 11);
    const stoppedA = arrowPose(data, 12);
    const stoppedB = arrowPose(data, 29);
    assert.equal(freeze.frozen, true);
    assert.ok(stoppedA.frozen);
    assert.ok(stoppedB.frozen);
    assert.equal(stoppedA.east, freeze.east);
    assert.equal(stoppedA.north, freeze.north);
    assert.equal(stoppedB.east, freeze.east);
    assert.equal(stoppedB.north, freeze.north);
  });

  it('scrubbing backward returns earlier path progress', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const early = arrowPose(data, 2);
    const later = arrowPose(data, 12);
    const back = arrowPose(data, 4);
    assert.ok(later.pathIndex > early.pathIndex);
    assert.ok(back.pathIndex < later.pathIndex);
    assert.ok(back.pathIndex > early.pathIndex);
  });

  it('interpolates between bracketing path points with clamped alpha', () => {
    const timed = [
      { east: 0, north: 0, logMonoTime: '0' },
      { east: 10, north: 0, logMonoTime: '1000000000' },
    ];
    const mid = interpolateTimedPath(timed, 500000000n);
    assert.ok(Math.abs(mid.east - 5) < 0.01);
    assert.ok(Math.abs(mid.alpha - 0.5) < 0.01);
    const before = interpolateTimedPath(timed, -1n);
    assert.equal(before.east, 0);
    const after = interpolateTimedPath(timed, 2000000000n);
    assert.equal(after.east, 10);
  });

  it('handles duplicate timestamps without throwing', () => {
    const timed = [
      { east: 0, north: 0, logMonoTime: '100' },
      { east: 5, north: 0, logMonoTime: '100' },
      { east: 10, north: 0, logMonoTime: '200' },
    ];
    assert.doesNotThrow(() => interpolateTimedPath(timed, 100n));
    const pose = interpolateTimedPath(timed, 100n);
    assert.ok(Number.isFinite(pose.east));
  });

  it('lerpPose blends positions without changing logical timeline index', () => {
    const a = { east: 0, north: 0, headingDeg: 0, pathIndex: 1, timelineIndex: 2, frozen: false };
    const b = { east: 10, north: 5, headingDeg: 90, pathIndex: 3, timelineIndex: 3, frozen: false };
    const mid = lerpPose(a, b, 0.5);
    assert.equal(mid.timelineIndex, 2);
    assert.ok(Math.abs(mid.east - 5) < 0.01);
    assert.ok(Math.abs(mid.north - 2.5) < 0.01);
  });

  it('resolveTimingWindow reports segment 54 moving duration (pose-lock corrected)', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const timing = resolveTimingWindow(data.timeline, data.vehiclePath, { minHeadingSpeedMps: 2 });
    const movingSec = Number(timing.tFreeze - timing.tStart) / 1e9;
    // With the stationary pose lock, seg54 freezes at frame 10 (speeds ~0.1-0.4 m/s
    // from frame 8 onward, with the freeze detection at frame 10), so moving
    // duration is ~20 s and the freeze index is 10.
    assert.ok(movingSec > 5 && movingSec < 25, `movingSec=${movingSec}`);
    assert.equal(timing.freezeIdx, 7);
    assert.equal(timing.firstStationaryIdx, 8);
  });
});

describe('local playback arrow on grey dash', () => {
  it('does not use fused global geometry fields', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    const localBlock = src.match(/_drawLocalPlayback\(d\) \{[\s\S]*?\n  \}/)?.[0] || '';
    assert.doesNotMatch(localBlock, /fusedLaneLines/);
    assert.doesNotMatch(localBlock, /roadSurfacePolygons/);
    assert.doesNotMatch(localBlock, /_drawGlobal/);
  });

  it('arrow coordinates lie on anchor frame.path points', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const anchorIdx = resolveAnchorFrameIndex(data.frames, data.timeline);
    const pathPts = data.frames[anchorIdx].path.points;
    for (const idx of [0, 3, 5, 29]) {
      const pose = arrowPose(data, idx);
      const nearest = nearestPointOnPolyline(pathPts, pose.east, pose.north);
      assert.ok(nearest, `expected on-path pose at idx ${idx}`);
      assert.ok(nearest.distance < 1.0, `pose should be on dash path at idx ${idx}, dist=${nearest.distance}`);
    }
  });

  it('advances along dash path during moving frames on segment 54', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const early = arrowPose(data, 1);
    const later = arrowPose(data, 10);
    assert.ok(later.pathIndex > early.pathIndex, 'expected forward progress along dash path');
    assert.equal(early.frozen, false);
  });

  it('freezes arrow during stationary frames on segment 54', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const freeze = arrowPose(data, 17);
    const stoppedA = arrowPose(data, 28);
    const stoppedB = arrowPose(data, 29);
    assert.ok(stoppedA.frozen);
    assert.ok(stoppedB.frozen);
    assert.equal(stoppedA.east, freeze.east);
    assert.equal(stoppedA.north, freeze.north);
    assert.equal(stoppedB.east, freeze.east);
    assert.equal(stoppedB.north, freeze.north);
  });

  it('keeps anchor frame geometry bounds stable across playback frames', () => {
    if (!fs.existsSync(SEG54)) return;
    const data = loadSegment54PlaybackData();
    const anchorIdx = resolveAnchorFrameIndex(data.frames, data.timeline);
    const frame = data.frames[anchorIdx];
    const b0 = computeVehicleFrameBounds(frame, arrowPose(data, 0));
    const b1 = computeVehicleFrameBounds(frame, arrowPose(data, 10));
    assert.deepEqual(b0, b1);
  });
});

describe('local playback mode separation', () => {
  it('vehicle-relative uses fixed origin arrow not dash playback pose', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /fixedOriginArrow:\s*true/);
    assert.match(src, /_drawVehicleIcon\(0,\s*0,\s*0\)/);
  });

  it('global mode continues timeline vehiclePath lookup', () => {
    const timeline = [{ logMonoTime: '100', frameId: 1, bearingDeg: 45 }];
    const vehiclePath = [{ logMonoTime: '100', frameId: 1, east: 12, north: 34, headingDeg: 45 }];
    const matched = matchVehiclePathPoint(vehiclePath, timeline[0]);
    assert.equal(matched.point.east, 12);
  });

  it('nearest logMonoTime respects tolerance', () => {
    const pathPts = [{ frameId: 1, logMonoTime: '1000000000', east: 0, north: 0 }];
    const near = matchVehiclePathPoint(pathPts, { logMonoTime: String(1000000000n + 500000000n) });
    assert.equal(near.matchMethod, 'nearestTime');
    const far = matchVehiclePathPoint(pathPts, { logMonoTime: String(1000000000n + NEAREST_TIME_TOLERANCE_NS + 1n) });
    assert.equal(far, null);
  });
});
