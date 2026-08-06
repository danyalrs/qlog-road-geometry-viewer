'use strict';

/**
 * Display-only local playback helpers.
 * Reuses vehicle-relative frame.path grey-dash coordinates for arrow motion.
 * Playback clock: timeline logMonoTime (nanoseconds).
 */

const NEAREST_TIME_TOLERANCE_NS = 2_000_000_000n;
const MIN_HEADING_DISPLACEMENT_M = 0.15;
const DEFAULT_HEADING_SEARCH_STEPS = 4;
const DEFAULT_HEADING_SMOOTH_ALPHA = 0.35;
// _drawVehicleIcon tip is at (0, -10): zero rotation points canvas-up (−Y), not +X.
const ARROW_CANVAS_ZERO_RAD = -Math.PI / 2;

function shortestAngleDegDelta(fromDeg, toDeg) {
  if (!Number.isFinite(fromDeg) || !Number.isFinite(toDeg)) return 0;
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function smoothHeadingDeg(previousDeg, nextDeg, alpha = DEFAULT_HEADING_SMOOTH_ALPHA) {
  if (!Number.isFinite(nextDeg)) return previousDeg;
  if (!Number.isFinite(previousDeg)) return (nextDeg % 360 + 360) % 360;
  const blended = previousDeg + shortestAngleDegDelta(previousDeg, nextDeg) * alpha;
  return (blended % 360 + 360) % 360;
}

/**
 * Convert chronological path delta (east, north) to _drawVehicleIcon bearing degrees.
 * Path direction uses atan2(dy, dx); icon bearing uses atan2(dx, dy) because the
 * arrow polygon points to canvas −Y at zero rotation and render applies rotate(−bearing).
 */
function headingDegForVehicleIcon(dx, dy, minDist = MIN_HEADING_DISPLACEMENT_M) {
  const dist = Math.hypot(dx, dy);
  if (!Number.isFinite(dist) || dist < minDist) return null;
  const bearingDeg = Math.atan2(dx, dy) * 180 / Math.PI;
  return Number.isFinite(bearingDeg) ? (bearingDeg % 360 + 360) % 360 : null;
}

function findHeadingPair(timedPoints, pathIndex, options = {}) {
  if (!timedPoints?.length || timedPoints.length < 2) return null;
  const minDist = options.minHeadingDisplacementM ?? MIN_HEADING_DISPLACEMENT_M;
  const anchor = Math.max(0, Math.min(timedPoints.length - 1, pathIndex));
  const candidates = [];

  for (let i = 0; i < timedPoints.length - 1; i++) {
    const dx = timedPoints[i + 1].east - timedPoints[i].east;
    const dy = timedPoints[i + 1].north - timedPoints[i].north;
    const dist = Math.hypot(dx, dy);
    if (dist < minDist) continue;
    const centerDist = Math.abs((i + 0.5) - anchor);
    candidates.push({ bracketA: i, bracketB: i + 1, dx, dy, dist, centerDist });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.centerDist - b.centerDist || b.dist - a.dist);
  const best = candidates[0];
  if (best.dist < minDist * 3 && candidates.length > 1) {
    const longer = candidates.filter((c) => c.dist >= minDist * 3);
    if (longer.length) {
      longer.sort((a, b) => a.centerDist - b.centerDist || b.dist - a.dist);
      return longer[0];
    }
  }
  return best;
}

function resolvePathHeadingDeg(timedPoints, pathIndex, lastHeading = null, options = {}) {
  const pair = findHeadingPair(timedPoints, pathIndex, options);
  if (!pair) return Number.isFinite(lastHeading) ? lastHeading : 0;
  const heading = headingDegForVehicleIcon(
    pair.dx,
    pair.dy,
    options.minHeadingDisplacementM ?? MIN_HEADING_DISPLACEMENT_M,
  );
  if (heading == null) return Number.isFinite(lastHeading) ? lastHeading : 0;
  if (options.smoothHeading && Number.isFinite(lastHeading)) {
    return smoothHeadingDeg(lastHeading, heading, options.headingSmoothAlpha ?? DEFAULT_HEADING_SMOOTH_ALPHA);
  }
  return heading;
}

function absBigInt(a, b) {
  return a > b ? a - b : b - a;
}

function matchVehiclePathPoint(vehiclePath, timelineEntry, options = {}) {
  if (!vehiclePath?.length || !timelineEntry) return null;
  const tolerance = options.nearestTimeToleranceNs ?? NEAREST_TIME_TOLERANCE_NS;

  if (timelineEntry.frameId != null) {
    const byFrame = vehiclePath.find((p) => p.frameId === timelineEntry.frameId);
    if (byFrame) return { point: byFrame, matchMethod: 'frameId' };
  }

  if (timelineEntry.logMonoTime == null) return null;
  const target = String(timelineEntry.logMonoTime);
  const exact = vehiclePath.find((p) => String(p.logMonoTime) === target);
  if (exact) return { point: exact, matchMethod: 'logMonoTime' };

  const tb = BigInt(target);
  let best = null;
  let bestDiff = null;
  for (const p of vehiclePath) {
    if (p.logMonoTime == null) continue;
    const pt = BigInt(String(p.logMonoTime));
    const diff = absBigInt(pt, tb);
    if (bestDiff == null || diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  if (best && bestDiff != null && bestDiff <= tolerance) {
    return { point: best, matchMethod: 'nearestTime' };
  }
  return null;
}

function findFrame(frames, timelineEntry, options = {}) {
  if (!frames?.length || !timelineEntry) return null;
  const tolerance = options.nearestTimeToleranceNs ?? NEAREST_TIME_TOLERANCE_NS;

  if (timelineEntry.frameId != null) {
    const byId = frames.find((f) => f.frameId === timelineEntry.frameId);
    if (byId) return { frame: byId, matchMethod: 'frameId' };
  }

  if (timelineEntry.logMonoTime != null) {
    const target = String(timelineEntry.logMonoTime);
    const exact = frames.find((f) => String(f.logMonoTime) === target);
    if (exact) return { frame: exact, matchMethod: 'logMonoTime' };

    const tb = BigInt(target);
    let best = null;
    let bestDiff = null;
    for (const f of frames) {
      if (f.logMonoTime == null) continue;
      const ft = BigInt(String(f.logMonoTime));
      const diff = absBigInt(ft, tb);
      if (bestDiff == null || diff < bestDiff) {
        bestDiff = diff;
        best = f;
      }
    }
    if (best && bestDiff != null && bestDiff <= tolerance) {
      return { frame: best, matchMethod: 'nearestTime' };
    }
  }

  if (Number.isInteger(timelineEntry.index) && frames[timelineEntry.index]) {
    return { frame: frames[timelineEntry.index], matchMethod: 'index' };
  }
  return null;
}

function headingFromSegment(p0, p1, options = {}) {
  if (!p0 || !p1) return null;
  const dx = p1.east - p0.east;
  const dy = p1.north - p0.north;
  return headingDegForVehicleIcon(dx, dy, options.minHeadingDisplacementM ?? MIN_HEADING_DISPLACEMENT_M);
}

function computeArcLengths(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(
      points[i].east - points[i - 1].east,
      points[i].north - points[i - 1].north,
    ));
  }
  return lengths;
}

function buildTimedPathPoints(pathPoints, tStartNs, tEndNs) {
  if (!pathPoints?.length) return [];
  const arc = computeArcLengths(pathPoints);
  const total = arc[arc.length - 1] || 1;
  const span = tEndNs - tStartNs;
  return pathPoints.map((p, i) => ({
    east: p.east,
    north: p.north,
    logMonoTime: String(tStartNs + (span * BigInt(Math.round((arc[i] / total) * 1_000_000)) / 1_000_000n)),
    pathIndex: i,
    arcLength: arc[i],
  }));
}

function isReliableMovingState(timelineEntry, pathPoint, minHeadingSpeedMps) {
  const state = timelineEntry?.movementState ?? pathPoint?.movementState;
  const speed = Number.isFinite(timelineEntry?.speed) ? timelineEntry.speed : pathPoint?.speed;
  return state === 'moving' || state === 'creeping'
    || (Number.isFinite(speed) && speed >= minHeadingSpeedMps);
}

function resolveTimingWindow(timeline, vehiclePath, options = {}) {
  if (!timeline?.length) return null;
  const tStart = BigInt(String(timeline[0].logMonoTime));

  let firstStationaryIdx = -1;
  for (let i = 0; i < timeline.length; i++) {
    const vp = matchVehiclePathPoint(vehiclePath, timeline[i], options);
    const state = timeline[i].movementState ?? vp?.point?.movementState ?? null;
    if (state === 'stationary') {
      firstStationaryIdx = i;
      break;
    }
  }

  const freezeIdx = firstStationaryIdx >= 0
    ? Math.max(0, firstStationaryIdx - 1)
    : timeline.length - 1;

  let lastReliableIdx = 0;
  for (let i = 0; i <= freezeIdx; i++) {
    const vp = matchVehiclePathPoint(vehiclePath, timeline[i], options);
    if (isReliableMovingState(timeline[i], vp?.point, options.minHeadingSpeedMps ?? 2.0)) {
      lastReliableIdx = i;
    }
  }

  return {
    tStart,
    tEnd: BigInt(String(timeline[timeline.length - 1].logMonoTime)),
    tFreeze: BigInt(String(timeline[freezeIdx].logMonoTime)),
    tFirstStationary: firstStationaryIdx >= 0
      ? BigInt(String(timeline[firstStationaryIdx].logMonoTime))
      : null,
    freezeIdx,
    lastReliableIdx,
    firstStationaryIdx,
    timelineCount: timeline.length,
  };
}

function interpolateTimedPath(timedPoints, timeNs, lastHeading = null, options = {}) {
  if (!timedPoints?.length) {
    return { east: 0, north: 0, headingDeg: lastHeading ?? 0, pathIndex: 0, alpha: 0 };
  }

  const t = typeof timeNs === 'bigint' ? timeNs : BigInt(String(timeNs));
  const tFirst = BigInt(String(timedPoints[0].logMonoTime));
  const tLast = BigInt(String(timedPoints[timedPoints.length - 1].logMonoTime));

  if (t <= tFirst) {
    const pathIndex = 0;
    const heading = resolvePathHeadingDeg(timedPoints, pathIndex, lastHeading, options);
    return {
      east: timedPoints[0].east,
      north: timedPoints[0].north,
      headingDeg: heading,
      pathIndex,
      segmentIndex: 0,
      alpha: 0,
      bracketA: 0,
      bracketB: Math.min(1, timedPoints.length - 1),
    };
  }

  if (t >= tLast) {
    const n = timedPoints.length - 1;
    const heading = resolvePathHeadingDeg(timedPoints, n, lastHeading, options);
    return {
      east: timedPoints[n].east,
      north: timedPoints[n].north,
      headingDeg: heading,
      pathIndex: n,
      segmentIndex: Math.max(0, n - 1),
      alpha: 1,
      bracketA: Math.max(0, n - 1),
      bracketB: n,
    };
  }

  for (let i = 0; i < timedPoints.length - 1; i++) {
    const tA = BigInt(String(timedPoints[i].logMonoTime));
    const tB = BigInt(String(timedPoints[i + 1].logMonoTime));
    if (t < tA) continue;
    if (t > tB) continue;

    const denom = tB - tA;
    const alpha = denom > 0n ? Number(t - tA) / Number(denom) : 0;
    const clamped = Math.max(0, Math.min(1, alpha));
    const east = timedPoints[i].east + clamped * (timedPoints[i + 1].east - timedPoints[i].east);
    const north = timedPoints[i].north + clamped * (timedPoints[i + 1].north - timedPoints[i].north);
    const pathIndex = i + clamped;
    const heading = resolvePathHeadingDeg(timedPoints, pathIndex, lastHeading, options);
    return {
      east,
      north,
      headingDeg: heading,
      pathIndex,
      segmentIndex: i,
      alpha: clamped,
      bracketA: i,
      bracketB: i + 1,
    };
  }

  const n = timedPoints.length - 1;
  return {
    east: timedPoints[n].east,
    north: timedPoints[n].north,
    headingDeg: resolvePathHeadingDeg(timedPoints, n, lastHeading, options),
    pathIndex: n,
    segmentIndex: Math.max(0, n - 1),
    alpha: 1,
    bracketA: Math.max(0, n - 1),
    bracketB: n,
  };
}

function lerpPose(a, b, alpha) {
  const t = Math.max(0, Math.min(1, alpha));
  if (!a) return b;
  if (!b) return a;
  let heading = a.headingDeg ?? 0;
  if (Number.isFinite(b.headingDeg)) {
    let diff = ((b.headingDeg - heading + 540) % 360) - 180;
    heading = heading + diff * t;
    heading = (heading + 360) % 360;
  }
  return {
    east: a.east + t * ((b.east ?? a.east) - a.east),
    north: a.north + t * ((b.north ?? a.north) - a.north),
    headingDeg: heading,
    frozen: t >= 1 ? b.frozen : a.frozen,
    movementState: t >= 1 ? b.movementState : a.movementState,
    speed: t >= 1 ? b.speed : a.speed,
    pathIndex: a.pathIndex + t * ((b.pathIndex ?? a.pathIndex) - (a.pathIndex ?? 0)),
    timelineIndex: t >= 1 ? b.timelineIndex : a.timelineIndex,
  };
}

function resolveAnchorFrameIndex(frames, timeline) {
  if (!frames?.length) return 0;
  for (let i = 0; i < (timeline?.length || frames.length); i++) {
    const matched = findFrame(frames, { ...(timeline?.[i] || {}), index: i });
    if (matched?.frame?.path?.points?.length >= 2) return i;
    if (frames[i]?.path?.points?.length >= 2) return i;
  }
  return 0;
}

function buildPlaybackContext({ anchorFrame, timeline, vehiclePath, options = {} }) {
  const pathPoints = anchorFrame?.path?.points || [];
  const timing = resolveTimingWindow(timeline, vehiclePath, options);
  if (!timing || !pathPoints.length) return null;

  const timedPath = buildTimedPathPoints(pathPoints, timing.tStart, timing.tFreeze);
  const freezeInterp = interpolateTimedPath(timedPath, timing.tFreeze);
  return {
    pathPoints,
    timing,
    timedPath,
    freezeHeadingDeg: freezeInterp.headingDeg,
  };
}

function resolveArrowAtLogMonoTime(context, logMonoTime, timelineEntry, options = {}) {
  if (!context?.timedPath?.length) {
    return { east: 0, north: 0, headingDeg: 0, frozen: false, pathIndex: 0 };
  }

  const { timing, timedPath } = context;
  const t = BigInt(String(logMonoTime));
  const vpMatch = timelineEntry ? matchVehiclePathPoint(options.vehiclePath || [], timelineEntry, options) : null;
  const state = timelineEntry?.movementState ?? vpMatch?.point?.movementState ?? null;
  const speed = Number.isFinite(timelineEntry?.speed) ? timelineEntry.speed : vpMatch?.point?.speed;

  const frozen = timing.tFirstStationary != null && t >= timing.tFirstStationary;
  const sampleTime = frozen ? timing.tFreeze : t;
  const interp = interpolateTimedPath(
    timedPath,
    sampleTime,
    options.lastHeadingDeg ?? null,
    { ...options, smoothHeading: !frozen && options.smoothHeading },
  );
  const headingDeg = frozen
    ? (context.freezeHeadingDeg ?? interp.headingDeg ?? 0)
    : (interp.headingDeg ?? 0);

  return {
    east: interp.east,
    north: interp.north,
    headingDeg,
    pathIndex: interp.pathIndex,
    segmentIndex: interp.segmentIndex,
    bracketA: interp.bracketA,
    bracketB: interp.bracketB,
    alpha: interp.alpha,
    frozen,
    movementState: state,
    speed,
    logMonoTime: String(logMonoTime),
    sampleLogMonoTime: String(sampleTime),
    matchMethod: 'logMonoTimeInterpolation',
  };
}

function frameHasDrawableGeometry(frame) {
  if (!frame) return false;
  const laneCount = (frame.lanes || []).length;
  const edgeCount = (frame.edges || []).length;
  const pathCount = frame.path?.points?.length ?? 0;
  return laneCount > 0 || edgeCount > 0 || pathCount >= 2;
}

function interpolateLaneAtForwardX(lane, forwardM) {
  const pts = (lane.points || []).filter((p) => Number.isFinite(p.modelX));
  if (!pts.length) return null;
  if (forwardM < pts[0].modelX - 0.5 || forwardM > pts[pts.length - 1].modelX + 0.5) return null;
  for (let i = 1; i < pts.length; i++) {
    if (forwardM <= pts[i].modelX) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = (forwardM - a.modelX) / (b.modelX - a.modelX || 1);
      return {
        modelX: forwardM,
        modelY: (a.modelY ?? 0) + t * ((b.modelY ?? 0) - (a.modelY ?? 0)),
      };
    }
  }
  return pts[pts.length - 1];
}

function computeCorridorOffsetFromFrame(frame, forwardM = 10, minProb = 0.5) {
  const lanes = (frame?.lanes || []).filter((l) => (l.prob ?? 1) >= minProb);
  const samples = lanes.map((l) => {
    const pt = interpolateLaneAtForwardX(l, forwardM);
    return pt ? { laneIndex: l.laneIndex, modelY: pt.modelY, prob: l.prob } : null;
  }).filter(Boolean);
  if (!samples.length) return { valid: false, reason: 'noLanes' };
  samples.sort((a, b) => b.modelY - a.modelY);
  const right = samples.filter((l) => l.modelY <= 0).sort((a, b) => b.modelY - a.modelY)[0];
  const left = samples.filter((l) => l.modelY >= 0).sort((a, b) => a.modelY - b.modelY)[0];
  if (!right || !left) {
    return { valid: false, reason: 'noSurroundingPair', laneCount: samples.length };
  }
  const corridorCenter = (right.modelY + left.modelY) / 2;
  return {
    valid: true,
    forwardM,
    surroundingLaneIndices: [right.laneIndex, left.laneIndex],
    vehicleOffsetFromCorridorCenterM: -corridorCenter,
    laneWidthM: left.modelY - right.modelY,
  };
}

function globalToVehicleDisplay(east, north, pose) {
  const ve = pose?.east ?? 0;
  const vn = pose?.north ?? 0;
  const theta = (pose?.headingDeg ?? 0) * Math.PI / 180;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const u = east - ve;
  const v = north - vn;
  const modelX = u * sinT + v * cosT;
  const modelY = v * sinT - u * cosT;
  return { east: modelX, north: -modelY, modelX, modelY };
}

function transformPolylineToVehicleDisplay(points, pose) {
  if (!points?.length || !pose) return [];
  return points.map((p) => {
    const rel = globalToVehicleDisplay(p.east, p.north, pose);
    return { ...p, east: rel.east, north: rel.north, modelX: rel.modelX, modelY: rel.modelY };
  });
}

function resolveLocalGeometryFrame(frames, timeline, frameIndex, lastValidState = null) {
  if (!frames?.length) {
    return { frame: null, geometryState: 'unavailable', geometrySourceIndex: null };
  }
  const maxIdx = Math.max(0, (timeline?.length || frames.length) - 1);
  const idx = Math.min(Math.max(0, frameIndex), maxIdx);
  const entry = timeline?.[idx] ?? { index: idx };
  const matched = findFrame(frames, { ...entry, index: idx });
  const frame = matched?.frame ?? frames[idx] ?? null;

  if (frame && frameHasDrawableGeometry(frame)) {
    return {
      frame,
      geometryState: 'current',
      geometrySourceIndex: idx,
      matchMethod: matched?.matchMethod ?? 'index',
    };
  }

  if (lastValidState?.frame && frameHasDrawableGeometry(lastValidState.frame)) {
    return {
      frame: lastValidState.frame,
      geometryState: 'retained',
      geometrySourceIndex: lastValidState.geometrySourceIndex,
      retainedFromElapsedIdx: lastValidState.geometrySourceIndex,
      matchMethod: 'retained',
    };
  }

  return {
    frame: null,
    geometryState: 'unavailable',
    geometrySourceIndex: null,
    matchMethod: null,
  };
}

function buildPlaybackContextForFrame({ frame, timeline, vehiclePath, options = {} }) {
  const pathPoints = frame?.path?.points || [];
  const timing = resolveTimingWindow(timeline, vehiclePath, options);
  if (!timing || pathPoints.length < 2) return null;
  const timedPath = buildTimedPathPoints(pathPoints, timing.tStart, timing.tFreeze);
  const freezeInterp = interpolateTimedPath(timedPath, timing.tFreeze, null, options);
  return {
    pathPoints,
    timing,
    timedPath,
    freezeHeadingDeg: freezeInterp.headingDeg,
  };
}

function resolveArrowForCurrentFrame({
  frames,
  timeline,
  vehiclePath,
  frameIndex,
  options = {},
}) {
  if (!timeline?.length || frameIndex < 0) {
    return {
      east: 0, north: 0, headingDeg: 0, frozen: false, pathIndex: 0,
      headingSource: 'none', timelineIndex: 0, geometryFrameIndex: 0,
    };
  }

  const target = Math.min(frameIndex, timeline.length - 1);
  const entry = timeline[target];
  const currentFrame = frames[target];
  const poseHeading = currentFrame?.pose?.headingDeg ?? entry?.bearingDeg ?? null;
  const headingSourceBase = currentFrame?.pose?.headingSource ?? entry?.headingSource ?? 'framePose';
  const context = buildPlaybackContextForFrame({
    frame: currentFrame,
    timeline,
    vehiclePath,
    options,
  });

  if (context) {
    const pose = resolveArrowAtLogMonoTime(
      context,
      entry.logMonoTime,
      entry,
      { ...options, vehiclePath, smoothHeading: false },
    );
    if (Number.isFinite(poseHeading)) {
      pose.headingDeg = poseHeading;
      pose.headingSource = headingSourceBase;
    } else {
      pose.headingSource = 'currentPathTangent';
    }
    return {
      ...pose,
      timelineIndex: target,
      geometryFrameIndex: target,
    };
  }

  const vp = matchVehiclePathPoint(vehiclePath, entry, options);
  return {
    east: 0,
    north: 0,
    headingDeg: poseHeading ?? vp?.point?.headingDeg ?? 0,
    headingSource: Number.isFinite(poseHeading) ? headingSourceBase : 'vehiclePath',
    frozen: false,
    pathIndex: 0,
    timelineIndex: target,
    geometryFrameIndex: target,
    movementState: entry?.movementState ?? vp?.point?.movementState ?? null,
    speed: entry?.speed ?? vp?.point?.speed ?? null,
    logMonoTime: String(entry.logMonoTime),
  };
}

function applyLaneRelativeArrowOffset(pose, frame) {
  const corridor = computeCorridorOffsetFromFrame(frame);
  if (!corridor.valid || !Number.isFinite(corridor.vehicleOffsetFromCorridorCenterM)) {
    return { ...pose, laneRelativeOffsetM: null, laneRelativeApplied: false };
  }
  const offsetM = corridor.vehicleOffsetFromCorridorCenterM;
  const headingRad = (pose.headingDeg ?? 0) * Math.PI / 180;
  const leftEast = -Math.cos(headingRad);
  const leftNorth = Math.sin(headingRad);
  return {
    ...pose,
    east: pose.east + leftEast * offsetM,
    north: pose.north + leftNorth * offsetM,
    laneRelativeOffsetM: offsetM,
    laneRelativeApplied: true,
    corridorOffset: corridor,
  };
}

function resolveArrowOnDashPath({
  anchorFrame,
  frames,
  timeline,
  vehiclePath,
  frameIndex,
  options = {},
}) {
  if (!timeline?.length || frameIndex < 0) {
    return { east: 0, north: 0, headingDeg: 0, frozen: false, pathIndex: 0 };
  }

  const target = Math.min(frameIndex, timeline.length - 1);
  const context = buildPlaybackContext({ anchorFrame, timeline, vehiclePath, options });
  if (!context) {
    return { east: 0, north: 0, headingDeg: 0, frozen: false, pathIndex: 0, timelineIndex: target };
  }

  const entry = timeline[target];
  const pose = resolveArrowAtLogMonoTime(
    context,
    entry.logMonoTime,
    entry,
    { ...options, vehiclePath },
  );
  return { ...pose, timelineIndex: target };
}

function computeVehicleFrameBounds(frame, arrowPose = null) {
  const pts = [];
  const add = (e, n) => {
    if (Number.isFinite(e) && Number.isFinite(n)) pts.push({ east: e, north: n });
  };

  for (const lane of frame?.lanes || []) {
    for (const p of lane.points || []) add(p.east, p.north);
  }
  for (const edge of frame?.edges || []) {
    for (const p of edge.points || []) add(p.east, p.north);
  }
  for (const p of frame?.path?.points || []) add(p.east, p.north);
  add(0, 0);
  if (arrowPose) add(arrowPose.east, arrowPose.north);

  if (!pts.length) return { minE: -30, maxE: 30, minN: -10, maxN: 80 };

  let minE = Infinity; let maxE = -Infinity; let minN = Infinity; let maxN = -Infinity;
  for (const p of pts) {
    minE = Math.min(minE, p.east); maxE = Math.max(maxE, p.east);
    minN = Math.min(minN, p.north); maxN = Math.max(maxN, p.north);
  }
  const padE = Math.max(5, (maxE - minE) * 0.1);
  const padN = Math.max(5, (maxN - minN) * 0.1);
  return { minE: minE - padE, maxE: maxE + padE, minN: minN - padN, maxN: maxN + padN };
}

function nearestPointOnPolyline(points, east, north) {
  if (!points?.length) return null;
  let best = null;
  for (let i = 0; i < points.length; i++) {
    const dist = Math.hypot(points[i].east - east, points[i].north - north);
    if (!best || dist < best.distance) {
      best = { east: points[i].east, north: points[i].north, index: i, distance: dist };
    }
  }
  return best;
}

function dashReferencePoint(frame) {
  const p0 = frame?.path?.points?.[0];
  if (p0 && Number.isFinite(p0.east) && Number.isFinite(p0.north)) {
    return { east: p0.east, north: p0.north, source: 'path[0]' };
  }
  return null;
}

window.LocalPlayback = {
  NEAREST_TIME_TOLERANCE_NS,
  MIN_HEADING_DISPLACEMENT_M,
  DEFAULT_HEADING_SEARCH_STEPS,
  DEFAULT_HEADING_SMOOTH_ALPHA,
  ARROW_CANVAS_ZERO_RAD,
  matchVehiclePathPoint,
  findFrame,
  computeArcLengths,
  buildTimedPathPoints,
  resolveTimingWindow,
  shortestAngleDegDelta,
  smoothHeadingDeg,
  headingDegForVehicleIcon,
  findHeadingPair,
  resolvePathHeadingDeg,
  headingFromSegment,
  interpolateTimedPath,
  lerpPose,
  nearestPointOnPolyline,
  dashReferencePoint,
  resolveAnchorFrameIndex,
  buildPlaybackContext,
  buildPlaybackContextForFrame,
  resolveArrowAtLogMonoTime,
  resolveArrowOnDashPath,
  resolveArrowForCurrentFrame,
  resolveLocalGeometryFrame,
  frameHasDrawableGeometry,
  computeCorridorOffsetFromFrame,
  globalToVehicleDisplay,
  transformPolylineToVehicleDisplay,
  applyLaneRelativeArrowOffset,
  computeVehicleFrameBounds,
};
