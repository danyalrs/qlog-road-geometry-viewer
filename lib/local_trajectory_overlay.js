'use strict';

/** Matches buildSegmentTrajectory MAX_TRAJECTORY_JUMP_M — not the lane polyline 15 m threshold. */
const TRAJECTORY_OVERLAY_MAX_GAP_M = 150;
const TRAJECTORY_OVERLAY_STYLE = Object.freeze({
  color: '#94a3b8',
  width: 1.5,
  dash: Object.freeze([8, 6]),
});
const LANE_POLYLINE_DEFAULT_MAX_GAP_M = 15;

function consecutiveDistances(points) {
  const dists = [];
  if (!points?.length) return dists;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    dists.push(Math.hypot(curr.east - prev.east, curr.north - prev.north));
  }
  return dists;
}

function distanceStats(points) {
  const dists = consecutiveDistances(points);
  if (!dists.length) {
    return { min: null, median: null, max: null, count: 0 };
  }
  const sorted = [...dists].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
    count: dists.length,
  };
}

function splitPolylineRuns(points, maxGapM) {
  if (!points?.length) return [];
  const runs = [];
  let run = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const jump = Math.hypot(curr.east - prev.east, curr.north - prev.north);
    if (jump > maxGapM) {
      runs.push(run);
      run = [curr];
    } else {
      run.push(curr);
    }
  }
  runs.push(run);
  return runs;
}

function splitTrajectoryOverlayRuns(points, options = {}) {
  const maxGapM = options.maxGapM ?? TRAJECTORY_OVERLAY_MAX_GAP_M;
  if (!points?.length) return [];
  const runs = [];
  let run = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const jump = Math.hypot(curr.east - prev.east, curr.north - prev.north);
    const prevTime = Number(prev.logMonoTime);
    const currTime = Number(curr.logMonoTime);
    const timeReversal = Number.isFinite(prevTime) && Number.isFinite(currTime) && currTime < prevTime;
    if (jump > maxGapM || timeReversal) {
      runs.push(run);
      run = [curr];
    } else {
      run.push(curr);
    }
  }
  runs.push(run);
  return runs;
}

function countDrawableRuns(runs) {
  return (runs || []).filter((run) => run.length >= 2).length;
}

function analyzeTrajectoryDrawRuns(points, maxGapM) {
  const runs = splitPolylineRuns(points, maxGapM);
  const dists = consecutiveDistances(points);
  return {
    pointCount: points?.length ?? 0,
    distanceStats: distanceStats(points),
    gapsOverThreshold: dists.filter((d) => d > maxGapM).length,
    totalRuns: runs.length,
    drawableRuns: countDrawableRuns(runs),
    runLengths: runs.map((run) => run.length),
  };
}

function simulateTrajectoryOverlayStrokes(points, options = {}) {
  const runs = splitTrajectoryOverlayRuns(points, options);
  let strokeCount = 0;
  let lineToCount = 0;
  let moveToCount = 0;
  for (const run of runs) {
    if (run.length < 2) continue;
    strokeCount += 1;
    moveToCount += 1;
    lineToCount += run.length - 1;
  }
  return {
    runs,
    drawableRuns: countDrawableRuns(runs),
    strokeCount,
    moveToCount,
    lineToCount,
    dashPattern: [...TRAJECTORY_OVERLAY_STYLE.dash],
  };
}

function drawTrajectoryOverlay(ctx, points, worldToScreen, options = {}) {
  const style = options.style ?? TRAJECTORY_OVERLAY_STYLE;
  const runs = splitTrajectoryOverlayRuns(points, options);
  const calls = { moveTo: 0, lineTo: 0, stroke: 0, setLineDash: [] };
  if (!ctx || !points?.length || !worldToScreen) {
    return { runs, drawableRuns: 0, calls };
  }
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  if (ctx.setLineDash) {
    ctx.setLineDash(style.dash);
    calls.setLineDash.push([...style.dash]);
  }
  for (const run of runs) {
    if (run.length < 2) continue;
    ctx.beginPath?.();
    const p0 = worldToScreen(run[0].east, run[0].north);
    ctx.moveTo(p0.x, p0.y);
    calls.moveTo += 1;
    for (let i = 1; i < run.length; i++) {
      const p = worldToScreen(run[i].east, run[i].north);
      ctx.lineTo(p.x, p.y);
      calls.lineTo += 1;
    }
    ctx.stroke();
    calls.stroke += 1;
  }
  ctx.setLineDash?.([]);
  return {
    runs,
    drawableRuns: countDrawableRuns(runs),
    calls,
  };
}

module.exports = {
  TRAJECTORY_OVERLAY_MAX_GAP_M,
  TRAJECTORY_OVERLAY_STYLE,
  LANE_POLYLINE_DEFAULT_MAX_GAP_M,
  consecutiveDistances,
  distanceStats,
  splitPolylineRuns,
  splitTrajectoryOverlayRuns,
  countDrawableRuns,
  analyzeTrajectoryDrawRuns,
  simulateTrajectoryOverlayStrokes,
  drawTrajectoryOverlay,
};
