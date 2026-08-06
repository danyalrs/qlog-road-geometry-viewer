'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const {
  resolveAnchorFrameIndex,
  resolveArrowOnDashPath,
  computeVehicleFrameBounds,
} = require('../lib/local_playback');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const {
  resolveScreenPathTangent,
  projectPathPoints,
  buildScreenSpaceArrow,
  renderedTipDot,
  TIP_LENGTH,
} = require('../lib/playback_arrow_screen');

const ROOT = path.join(__dirname, '..');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const SEG54 = path.join(ROOT, 'qlog_f449c_54.bz2');

function expectTipMatchesDirection(dx, dy, label) {
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const centerX = 100;
  const centerY = 200;
  const arrow = buildScreenSpaceArrow(centerX, centerY, ux, uy);
  const dot = renderedTipDot(centerX, centerY, arrow.tipX, arrow.tipY, ux, uy);
  assert.ok(dot > 0.99, `${label}: dot=${dot.toFixed(3)} tip=(${arrow.tipX},${arrow.tipY})`);
  assert.ok(arrow.tipX > centerX === ux > 0 || Math.abs(ux) < 1e-9, `${label}: tipX vs ux`);
  assert.ok(arrow.tipY > centerY === uy > 0 || Math.abs(uy) < 1e-9, `${label}: tipY vs uy`);
}

function expectTipAlongPath(screenPoints, pathIndex, label) {
  const tangent = resolveScreenPathTangent(screenPoints, pathIndex);
  assert.ok(tangent, `${label}: expected tangent`);
  const centerX = 50;
  const centerY = 75;
  const arrow = buildScreenSpaceArrow(centerX, centerY, tangent.ux, tangent.uy);
  const dot = renderedTipDot(centerX, centerY, arrow.tipX, arrow.tipY, tangent.ux, tangent.uy);
  assert.ok(dot > 0.99, `${label}: dot=${dot.toFixed(3)}`);
}

function loadSegment54PlaybackData() {
  const modelEvents = extractModel(SEG54).map((e) => ({ ...e, sourceFile: 'qlog_f449c_54.bz2' }));
  const gpsEvents = extractGps(SEG54).map((e) => ({ ...e, sourceFile: 'qlog_f449c_54.bz2' }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { timeline, vehiclePath: result.vehiclePath, frames: result.frames };
}

function segment54ArrowAtFrame(frameIdx) {
  const data = loadSegment54PlaybackData();
  const anchorIdx = resolveAnchorFrameIndex(data.frames, data.timeline);
  const anchor = data.frames[anchorIdx];
  const pose = resolveArrowOnDashPath({
    anchorFrame: anchor,
    frames: data.frames,
    timeline: data.timeline,
    vehiclePath: data.vehiclePath,
    frameIndex: frameIdx,
    options: { minHeadingSpeedMps: 2 },
  });
  const w = 1200;
  const h = 800;
  const bounds = computeVehicleFrameBounds(anchor, pose);
  const pad = 40;
  const rangeE = bounds.maxE - bounds.minE || 1;
  const rangeN = bounds.maxN - bounds.minN || 1;
  const scale = Math.min((w - pad * 2) / rangeE, (h - pad * 2) / rangeN);
  const midE = (bounds.minE + bounds.maxE) / 2;
  const midN = (bounds.minN + bounds.maxN) / 2;
  const offsetX = -midE * scale;
  const offsetY = midN * scale;
  const worldToScreen = (east, north) => {
    const cx = w / 2 + offsetX;
    const cy = h / 2 + offsetY;
    return { x: cx + east * scale, y: cy - north * scale };
  };
  const screen = worldToScreen(pose.east, pose.north);
  const screenPoints = projectPathPoints(anchor.path.points, worldToScreen);
  const tangent = resolveScreenPathTangent(screenPoints, pose.pathIndex);
  const arrow = buildScreenSpaceArrow(screen.x, screen.y, tangent.ux, tangent.uy);
  const dot = renderedTipDot(screen.x, screen.y, arrow.tipX, arrow.tipY, tangent.ux, tangent.uy);
  return { pose, screen, tangent, arrow, dot };
}

describe('playback arrow screen tangent', () => {
  it('screen path right: dx=1, dy=0 points tip right', () => {
    expectTipMatchesDirection(1, 0, 'unit right');
  });

  it('screen path left: dx=-1, dy=0 points tip left', () => {
    expectTipMatchesDirection(-1, 0, 'unit left');
  });

  it('screen path down: dx=0, dy=1 points tip down', () => {
    expectTipMatchesDirection(0, 1, 'unit down');
  });

  it('screen path up: dx=0, dy=-1 points tip up', () => {
    expectTipMatchesDirection(0, -1, 'unit up');
  });

  it('diagonal path matches normalized dx,dy direction', () => {
    expectTipMatchesDirection(3, 4, 'diagonal');
    expectTipMatchesDirection(-5, 2, 'diagonal negative x');
  });

  it('tip is exactly center + unit vector * TIP_LENGTH', () => {
    const ux = 0.6;
    const uy = 0.8;
    const centerX = 12;
    const centerY = 34;
    const arrow = buildScreenSpaceArrow(centerX, centerY, ux, uy);
    assert.equal(arrow.tipX, centerX + ux * TIP_LENGTH);
    assert.equal(arrow.tipY, centerY + uy * TIP_LENGTH);
  });

  it('points right on a horizontal path toward the right', () => {
    const pts = [{ x: 0, y: 0, index: 0 }, { x: 40, y: 0, index: 1 }];
    expectTipAlongPath(pts, 0.5, 'right');
  });

  it('points left on a horizontal path toward the left', () => {
    const pts = [{ x: 40, y: 0, index: 0 }, { x: 0, y: 0, index: 1 }];
    expectTipAlongPath(pts, 0.5, 'left');
  });

  it('points upward on screen for a vertical path toward smaller y', () => {
    const pts = [{ x: 10, y: 40, index: 0 }, { x: 10, y: 0, index: 1 }];
    expectTipAlongPath(pts, 0.5, 'up');
  });

  it('points downward on screen for a vertical path toward larger y', () => {
    const pts = [{ x: 10, y: 0, index: 0 }, { x: 10, y: 40, index: 1 }];
    expectTipAlongPath(pts, 0.5, 'down');
  });

  it('follows a curved path tangent', () => {
    const pts = [
      { x: 0, y: 0, index: 0 },
      { x: 20, y: 0, index: 1 },
      { x: 20, y: 20, index: 2 },
    ];
    expectTipAlongPath(pts, 0.5, 'curve east');
    expectTipAlongPath(pts, 1.5, 'curve south');
  });

  it('skips zero-length pairs and searches for a reliable segment', () => {
    const pts = [
      { x: 0, y: 0, index: 0 },
      { x: 0, y: 0, index: 1 },
      { x: 10, y: 0, index: 2 },
    ];
    const tangent = resolveScreenPathTangent(pts, 0);
    assert.ok(tangent);
    assert.equal(tangent.previousIndex, 1);
    assert.equal(tangent.nextIndex, 2);
    expectTipAlongPath(pts, 0, 'after duplicate');
  });

  it('reuses last valid direction when segment length is too small', () => {
    const lastValidDirection = {
      previous: { x: 0, y: 0, index: 0 },
      next: { x: 10, y: 0, index: 1 },
      dx: 10,
      dy: 0,
      length: 10,
      ux: 1,
      uy: 0,
      previousIndex: 0,
      nextIndex: 1,
    };
    const pts = [{ x: 0, y: 0, index: 0 }, { x: 0.5, y: 0, index: 1 }];
    const tangent = resolveScreenPathTangent(pts, 0, {
      minScreenDistPx: 3,
      lastValidDirection,
    });
    assert.equal(tangent, lastValidDirection);
  });

  it('projectPathPoints uses the supplied projector', () => {
    const projected = projectPathPoints(
      [{ east: 2, north: 3 }],
      (e, n) => ({ x: e * 10, y: n * -10 }),
    );
    assert.deepEqual(projected, [{ x: 20, y: -30, index: 0 }]);
  });
});

describe('segment 54 direct screen arrow', () => {
  it('idx 3 tip points upper-left along grey-dash tangent', () => {
    if (!fs.existsSync(SEG54)) return;
    const { screen, tangent, arrow, dot } = segment54ArrowAtFrame(3);
    assert.ok(tangent.ux < 0, `ux=${tangent.ux}`);
    assert.ok(tangent.uy < 0, `uy=${tangent.uy}`);
    assert.ok(arrow.tipX < screen.x, `tipX=${arrow.tipX} centerX=${screen.x}`);
    assert.ok(arrow.tipY < screen.y, `tipY=${arrow.tipY} centerY=${screen.y}`);
    assert.ok(dot > 0.99, `dot=${dot}`);
  });

  it('idx 17 tip points upper-left along grey-dash tangent', () => {
    if (!fs.existsSync(SEG54)) return;
    const { screen, tangent, arrow, dot } = segment54ArrowAtFrame(17);
    assert.ok(tangent.ux < 0, `ux=${tangent.ux}`);
    assert.ok(tangent.uy < 0, `uy=${tangent.uy}`);
    assert.ok(arrow.tipX < screen.x, `tipX=${arrow.tipX} centerX=${screen.x}`);
    assert.ok(arrow.tipY < screen.y, `tipY=${arrow.tipY} centerY=${screen.y}`);
    assert.ok(dot > 0.99, `dot=${dot}`);
  });
});

describe('local playback render integration', () => {
  it('render.js draws direct screen-space arrow without ctx.rotate in local playback', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    const localArrowBlock = src.slice(src.indexOf('_drawLocalPlaybackArrow'), src.indexOf('_drawVehicleIcon'));
    assert.match(src, /useScreenPathHeading:\s*true/);
    assert.match(src, /_drawLocalPlaybackArrow/);
    assert.match(src, /buildScreenSpaceArrow/);
    assert.match(src, /resolveScreenPathTangent/);
    assert.match(src, /resolveLocalGeometryFrame/);
    assert.match(src, /localElapsedIdx/);
    assert.doesNotMatch(localArrowBlock, /ctx\.rotate\(/);
    assert.doesNotMatch(localArrowBlock, /pathAngle/);
    assert.doesNotMatch(localArrowBlock, /renderedAngle/);
    assert.doesNotMatch(localArrowBlock, /graphicRotation/);
    assert.doesNotMatch(localArrowBlock, /_drawArrowShapeAtOrigin/);
    assert.match(src, /centerX \+ ux \* 30/);
  });
});
