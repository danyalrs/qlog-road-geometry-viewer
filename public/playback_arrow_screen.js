'use strict';

const MIN_SCREEN_PATH_DIST_PX = 3;
const TIP_LENGTH = 10;
const REAR_LENGTH = 4;
const HALF_WIDTH = 7;

function projectPathPoints(pathPoints, projectFn) {
  if (!pathPoints?.length || typeof projectFn !== 'function') return [];
  return pathPoints.map((p, index) => {
    const screen = projectFn(p.east, p.north);
    return { x: screen.x, y: screen.y, index };
  });
}

function selectScreenPathSegment(screenPoints, pathIndex, options = {}) {
  if (!screenPoints?.length || screenPoints.length < 2) return null;
  const minDist = options.minScreenDistPx ?? MIN_SCREEN_PATH_DIST_PX;
  const anchor = Math.max(0, Math.min(screenPoints.length - 1, Number(pathIndex) || 0));
  const candidates = [];

  for (let i = 0; i < screenPoints.length - 1; i++) {
    const dx = screenPoints[i + 1].x - screenPoints[i].x;
    const dy = screenPoints[i + 1].y - screenPoints[i].y;
    const dist = Math.hypot(dx, dy);
    if (dist < minDist) continue;
    candidates.push({
      previousIndex: i,
      nextIndex: i + 1,
      previous: screenPoints[i],
      next: screenPoints[i + 1],
      dx,
      dy,
      dist,
      centerDist: Math.abs((i + 0.5) - anchor),
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.centerDist - b.centerDist || b.dist - a.dist);
  return candidates[0];
}

function resolveScreenPathTangent(screenPoints, pathIndex, options = {}) {
  const best = selectScreenPathSegment(screenPoints, pathIndex, options);
  if (!best) return options.lastValidDirection || null;

  const length = Math.hypot(best.dx, best.dy);
  if (length < (options.minScreenDistPx ?? MIN_SCREEN_PATH_DIST_PX)) {
    return options.lastValidDirection || null;
  }

  const ux = best.dx / length;
  const uy = best.dy / length;

  return {
    previousIndex: best.previousIndex,
    nextIndex: best.nextIndex,
    previous: best.previous,
    next: best.next,
    dx: best.dx,
    dy: best.dy,
    length,
    ux,
    uy,
  };
}

function buildScreenSpaceArrow(centerX, centerY, ux, uy, dims = {}) {
  const tipLength = dims.tipLength ?? TIP_LENGTH;
  const rearLength = dims.rearLength ?? REAR_LENGTH;
  const halfWidth = dims.halfWidth ?? HALF_WIDTH;

  const tipX = centerX + ux * tipLength;
  const tipY = centerY + uy * tipLength;
  const rearX = centerX - ux * rearLength;
  const rearY = centerY - uy * rearLength;
  const px = -uy;
  const py = ux;
  const leftX = rearX + px * halfWidth;
  const leftY = rearY + py * halfWidth;
  const rightX = rearX - px * halfWidth;
  const rightY = rearY - py * halfWidth;

  return {
    centerX,
    centerY,
    tipX,
    tipY,
    rearX,
    rearY,
    leftX,
    leftY,
    rightX,
    rightY,
  };
}

function renderedTipDot(centerX, centerY, tipX, tipY, ux, uy) {
  const renderedTipX = tipX - centerX;
  const renderedTipY = tipY - centerY;
  const renderedLength = Math.hypot(renderedTipX, renderedTipY) || 1;
  return (renderedTipX / renderedLength) * ux + (renderedTipY / renderedLength) * uy;
}

window.PlaybackArrowScreen = {
  MIN_SCREEN_PATH_DIST_PX,
  TIP_LENGTH,
  REAR_LENGTH,
  HALF_WIDTH,
  projectPathPoints,
  selectScreenPathSegment,
  resolveScreenPathTangent,
  buildScreenSpaceArrow,
  renderedTipDot,
};
