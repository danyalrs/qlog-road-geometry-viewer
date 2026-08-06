'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const LP = require('../lib/local_playback');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { resolveScreenPathTangent, projectPathPoints } = require('../lib/playback_arrow_screen');

const ROOT = path.join(__dirname, '..');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const APP_JS = path.join(ROOT, 'public/app.js');
const SEG1 = path.join(ROOT, 'qlog_f449c_1.bz2');
const SEG2 = path.join(ROOT, 'qlog_f449c_2.bz2');

function loadSegment(fileName) {
  const segPath = path.join(ROOT, fileName);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

describe('local playback current-frame geometry', () => {
  it('resolveLocalGeometryFrame selects frames[elapsedIdx] not anchor frame', () => {
    if (!fs.existsSync(SEG1)) return;
    const data = loadSegment('qlog_f449c_1.bz2');
    const anchorIdx = LP.resolveAnchorFrameIndex(data.frames, data.timeline);
    const elapsedIdx = 14;
    const resolved = LP.resolveLocalGeometryFrame(data.frames, data.timeline, elapsedIdx);
    assert.equal(resolved.geometryState, 'current');
    assert.equal(resolved.geometrySourceIndex, elapsedIdx);
    assert.equal(resolved.frame?.frameId, data.frames[elapsedIdx]?.frameId);
    assert.notEqual(resolved.geometrySourceIndex, anchorIdx);
  });

  it('changing elapsedIdx changes resolved geometry frame', () => {
    if (!fs.existsSync(SEG1)) return;
    const data = loadSegment('qlog_f449c_1.bz2');
    const a = LP.resolveLocalGeometryFrame(data.frames, data.timeline, 9);
    const b = LP.resolveLocalGeometryFrame(data.frames, data.timeline, 14);
    assert.notEqual(a.frame?.frameId, b.frame?.frameId);
    assert.equal(a.geometrySourceIndex, 9);
    assert.equal(b.geometrySourceIndex, 14);
  });

  it('missing lanes retain last valid observation as stale', () => {
    const frames = [
      { frameId: 1, lanes: [{ laneIndex: 0, prob: 1, points: [{ modelX: 0, modelY: 0, east: 0, north: 0 }] }], path: { points: [{ east: 0, north: 0 }, { east: 10, north: 0 }] } },
      { frameId: 2, lanes: [], edges: [], path: { points: [{ east: 0, north: 0 }] } },
    ];
    const timeline = [{ index: 0, frameId: 1, logMonoTime: '1000' }, { index: 1, frameId: 2, logMonoTime: '2000' }];
    const first = LP.resolveLocalGeometryFrame(frames, timeline, 0);
    const second = LP.resolveLocalGeometryFrame(frames, timeline, 1, first);
    assert.equal(second.geometryState, 'retained');
    assert.equal(second.retainedFromElapsedIdx, 0);
    assert.equal(second.frame?.frameId, 1);
  });

  it('unavailable geometry does not fabricate lanes', () => {
    const frames = [{ frameId: 1, lanes: [], edges: [], path: { points: [{ east: 0, north: 0 }] } }];
    const timeline = [{ index: 0, frameId: 1, logMonoTime: '1000' }];
    const resolved = LP.resolveLocalGeometryFrame(frames, timeline, 0);
    assert.equal(resolved.geometryState, 'unavailable');
    assert.equal(resolved.frame, null);
  });

  it('resolveArrowForCurrentFrame uses current frame pose heading on segment 2 curve', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const idx0 = LP.resolveArrowForCurrentFrame({
      frames: data.frames,
      timeline: data.timeline,
      vehiclePath: data.vehiclePath,
      frameIndex: 0,
      options: { minHeadingSpeedMps: 2 },
    });
    const idx16 = LP.resolveArrowForCurrentFrame({
      frames: data.frames,
      timeline: data.timeline,
      vehiclePath: data.vehiclePath,
      frameIndex: 16,
      options: { minHeadingSpeedMps: 2 },
    });
    const delta = Math.abs(((idx16.headingDeg - idx0.headingDeg + 540) % 360) - 180);
    assert.ok(delta > 30, `expected heading change through curve, got ${idx0.headingDeg} -> ${idx16.headingDeg}`);
    assert.equal(idx16.headingSource, data.frames[16]?.pose?.headingSource ?? 'framePose');
  });

  it('degenerate path bracket at idx 0 does not reverse heading 180°', () => {
    const timedPoints = [
      { east: 0, north: 0, logMonoTime: '1000', pathIndex: 0 },
      { east: 0.01, north: 0, logMonoTime: '1100', pathIndex: 1 },
      { east: 10, north: 0, logMonoTime: '2000', pathIndex: 2 },
    ];
    const pair = LP.findHeadingPair(timedPoints, 0, { minHeadingDisplacementM: 0.15 });
    assert.ok(pair);
    assert.ok(pair.dist >= 0.15);
    const heading = LP.headingDegForVehicleIcon(pair.dx, pair.dy);
    assert.ok(heading > 45 && heading < 135, `heading should be east-ish, got ${heading}`);
  });

  it('applyLaneRelativeArrowOffset is optional and rejects invalid corridor', () => {
    const pose = { east: 0, north: 0, headingDeg: 0 };
    const without = LP.applyLaneRelativeArrowOffset(pose, { lanes: [] });
    assert.equal(without.laneRelativeApplied, false);
    const frame = {
      lanes: [
        { laneIndex: 1, prob: 1, points: [{ modelX: 10, modelY: -1.5, east: 10, north: 1.5 }] },
        { laneIndex: 2, prob: 1, points: [{ modelX: 10, modelY: 1.5, east: 10, north: -1.5 }] },
      ],
    };
    const withOffset = LP.applyLaneRelativeArrowOffset(pose, frame);
    assert.equal(withOffset.laneRelativeApplied, true);
    assert.ok(Math.abs(withOffset.laneRelativeOffsetM) < 0.01);
  });

  it('render.js uses current elapsedIdx geometry not anchor frame', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /resolveLocalGeometryFrame/);
    assert.match(src, /localElapsedIdx/);
    assert.doesNotMatch(src, /d\.frames\?\.\[anchorIdx\]/);
  });

  it('app.js resolves arrow via resolveArrowForCurrentFrame', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    assert.match(src, /resolveArrowForCurrentFrame/);
    assert.match(src, /resolveLocalGeometryFrame/);
    assert.match(src, /localGeometryMode/);
  });

  it('laneRelativeArrow remains disabled by default in app', () => {
    const renderSrc = fs.readFileSync(RENDER_JS, 'utf8');
    const appSrc = fs.readFileSync(APP_JS, 'utf8');
    assert.match(renderSrc, /laneRelativeArrow.*=== '1'/);
    assert.match(appSrc, /applyLaneRelativeArrowOffset/);
    assert.match(appSrc, /flags\.laneRelativeArrow/);
  });

  it('segment 2 lane dropout interval marks retained or unavailable without fabrication', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    let lastValid = null;
    for (let i = 6; i <= 9; i++) {
      const resolved = LP.resolveLocalGeometryFrame(data.frames, data.timeline, i, lastValid);
      if (resolved.geometryState === 'current') {
        lastValid = resolved;
        assert.ok((resolved.frame.lanes || []).length >= 0);
      } else if (resolved.geometryState === 'retained') {
        assert.ok(resolved.retainedFromElapsedIdx < i);
      } else {
        assert.equal(resolved.frame, null);
      }
    }
  });
});

describe('segment 2 heading vs anchor path', () => {
  it('current-frame arrow heading diverges from anchor-frame dash path heading mid-curve', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const anchorIdx = LP.resolveAnchorFrameIndex(data.frames, data.timeline);
    const anchor = data.frames[anchorIdx];
    const idx = 16;
    const current = LP.resolveArrowForCurrentFrame({
      frames: data.frames,
      timeline: data.timeline,
      vehiclePath: data.vehiclePath,
      frameIndex: idx,
      options: { minHeadingSpeedMps: 2 },
    });
    const anchorPose = LP.resolveArrowOnDashPath({
      anchorFrame: anchor,
      frames: data.frames,
      timeline: data.timeline,
      vehiclePath: data.vehiclePath,
      frameIndex: idx,
      options: { minHeadingSpeedMps: 2 },
    });
    const delta = Math.abs(((current.headingDeg - anchorPose.headingDeg + 540) % 360) - 180);
    assert.ok(delta > 20, `expected divergence at idx ${idx}, current=${current.headingDeg} anchor=${anchorPose.headingDeg}`);
  });
});
