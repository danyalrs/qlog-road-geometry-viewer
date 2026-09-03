'use strict';

/**
 * Evidence-supported boundary bridges for consecutive multi-qlog combined routes.
 * Display-only geometry; does not modify processing or qlogs.
 */

const { dist2d, timeGapSec } = require('./chunking');

const CONTINUITY_MAX_STEP_M = 12;
const MIN_BRIDGE_GAP_M = 0.75;
const MAX_BRIDGE_GAP_M = 120;
const SPEED_TIME_REL_TOL = 0.45;
const SPEED_TIME_ABS_TOL_M = 8;
const MAX_HEADING_DIFF_DEG = 50;
const DEFAULT_HALF_WIDTH_M = 7.5;
const BRIDGE_STEP_M = 4;

function parseSegmentId(filename) {
  const m = String(filename || '').match(/_(\d+)\.bz2$/i);
  return m ? parseInt(m[1], 10) : null;
}

function routeSourceFiles(processedData) {
  const chunk = processedData?.routeChunks?.[0];
  if (chunk?.files?.length) return [...chunk.files];
  const fromFrames = [...new Set((processedData?.frames || []).map((f) => f.sourceFile).filter(Boolean))];
  return fromFrames;
}

function isConsecutiveRoutePair(fromFile, toFile, routeFiles) {
  const fromId = parseSegmentId(fromFile);
  const toId = parseSegmentId(toFile);
  if (!Number.isFinite(fromId) || !Number.isFinite(toId) || toId !== fromId + 1) return false;
  const idxFrom = routeFiles.indexOf(fromFile);
  const idxTo = routeFiles.indexOf(toFile);
  return idxFrom >= 0 && idxTo === idxFrom + 1;
}

function headingUnitVector(headingDeg) {
  const r = (Number(headingDeg) * Math.PI) / 180;
  return { east: Math.sin(r), north: Math.cos(r) };
}

function tangentFromTrajectory(points, index) {
  if (points.length < 2) return headingUnitVector(points[0]?.poseHeadingDeg ?? 90);
  if (index <= 0) {
    const a = points[0];
    const b = points[1];
    const len = Math.hypot(b.east - a.east, b.north - a.north) || 1;
    return { east: (b.east - a.east) / len, north: (b.north - a.north) / len };
  }
  if (index >= points.length - 1) {
    const a = points[points.length - 2];
    const b = points[points.length - 1];
    const len = Math.hypot(b.east - a.east, b.north - a.north) || 1;
    return { east: (b.east - a.east) / len, north: (b.north - a.north) / len };
  }
  const a = points[index - 1];
  const b = points[index + 1];
  const len = Math.hypot(b.east - a.east, b.north - a.north) || 1;
  return { east: (b.east - a.east) / len, north: (b.north - a.north) / len };
}

function interpolateLogMonoTime(t0, t1, u) {
  try {
    const a = BigInt(t0);
    const b = BigInt(t1);
    const dt = b - a;
    const scaled = dt * BigInt(Math.round(u * 1e6)) / 1000000n;
    return String(a + scaled);
  } catch (_) {
    return String(t0);
  }
}

function cubicHermitePoint(p0, p1, m0, m1, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return {
    east: h00 * p0.east + h10 * m0.east + h01 * p1.east + h11 * m1.east,
    north: h00 * p0.north + h10 * m0.north + h01 * p1.north + h11 * m1.north,
  };
}

function maxConsecutiveTrajectoryGapM(trajectory) {
  let max = 0;
  let at = null;
  for (let i = 1; i < (trajectory || []).length; i++) {
    const d = dist2d(trajectory[i - 1], trajectory[i]);
    if (d > max) {
      max = d;
      at = i;
    }
  }
  return { maxGapM: max, index: at };
}

function leftNormal(tx, ty) {
  return { nx: -ty, ny: tx };
}

function buildBridgeRibbonRing(centerline, halfWidthM) {
  if (centerline.length < 2) return null;
  const left = [];
  const right = [];
  for (let i = 0; i < centerline.length; i++) {
    const t = tangentFromTrajectory(centerline, i);
    const n = leftNormal(t.east, t.north);
    const p = centerline[i];
    left.push({ east: p.east + n.nx * halfWidthM, north: p.north + n.ny * halfWidthM });
    right.push({ east: p.east - n.nx * halfWidthM, north: p.north - n.ny * halfWidthM });
  }
  return [...right.reverse(), ...left];
}

function ringSelfIntersects(ring) {
  const segCross = (a1, a2, b1, b2) => {
    const cross = (p, q, r) => (q.east - p.east) * (r.north - p.north) - (q.north - p.north) * (r.east - p.east);
    const d1 = cross(a1, a2, b1);
    const d2 = cross(a1, a2, b2);
    const d3 = cross(b1, b2, a1);
    const d4 = cross(b1, b2, a2);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const n = ring.length;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (segCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

function centerlineSelfIntersects(points) {
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      const a1 = points[i];
      const a2 = points[i + 1];
      const b1 = points[j];
      const b2 = points[j + 1];
      const cross = (p, q, r) => (q.east - p.east) * (r.north - p.north) - (q.north - p.north) * (r.east - p.east);
      const d1 = cross(a1, a2, b1);
      const d2 = cross(a1, a2, b2);
      const d3 = cross(b1, b2, a1);
      const d4 = cross(b1, b2, a2);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
  }
  return false;
}

function frameAtTimelineIndex(frames, timelineIndex) {
  return frames?.[timelineIndex] ?? null;
}

function diagnoseBoundaryGap(prevPt, nextPt, prevFrame, nextFrame, referencePose) {
  const endpointDistanceM = dist2d(prevPt, nextPt);
  const timeGapS = timeGapSec(
    { logMonoTime: prevPt.logMonoTime },
    { logMonoTime: nextPt.logMonoTime },
  );
  const prevSpeed = prevFrame?.pose?.speed ?? prevPt.speed ?? 0;
  const nextSpeed = nextFrame?.pose?.speed ?? nextPt.speed ?? 0;
  const avgSpeed = (Number(prevSpeed) + Number(nextSpeed)) / 2;
  const expectedTravelDistanceM = timeGapS * avgSpeed;
  const speedDistanceDeltaM = Math.abs(endpointDistanceM - expectedTravelDistanceM);
  const speedAgreement = expectedTravelDistanceM > 0
    ? speedDistanceDeltaM <= Math.max(SPEED_TIME_ABS_TOL_M, expectedTravelDistanceM * SPEED_TIME_REL_TOL)
    : endpointDistanceM <= MIN_BRIDGE_GAP_M;
  const headingDifferenceDeg = Math.abs(
    ((nextFrame?.pose?.headingDeg ?? nextPt.poseHeadingDeg ?? 0)
      - (prevFrame?.pose?.headingDeg ?? prevPt.poseHeadingDeg ?? 0) + 540) % 360 - 180,
  );
  const globalPrev = prevFrame?.pose ?? null;
  const globalNext = nextFrame?.pose ?? null;
  const globalDistanceM = globalPrev && globalNext ? dist2d(globalPrev, globalNext) : null;

  let failureClass = 'unknown';
  if (endpointDistanceM <= MIN_BRIDGE_GAP_M) failureClass = 'continuous';
  else if (globalDistanceM != null && Math.abs(globalDistanceM - endpointDistanceM) < 0.01) {
    failureClass = speedAgreement ? 'B_realSamplingGap' : 'A_incorrectSourcePlacement';
  } else if (speedAgreement) failureClass = 'B_realSamplingGap';
  else failureClass = 'A_incorrectSourcePlacement';

  return {
    fromSourceFile: prevPt.sourceFile,
    toSourceFile: nextPt.sourceFile,
    lastTrajectoryPoint: { east: prevPt.east, north: prevPt.north, timelineIndex: prevPt.timelineIndex },
    firstTrajectoryPoint: { east: nextPt.east, north: nextPt.north, timelineIndex: nextPt.timelineIndex },
    endpointDistanceM,
    timeGapS,
    endpointSpeedPrevMps: prevSpeed,
    endpointSpeedNextMps: nextSpeed,
    expectedTravelDistanceM,
    speedDistanceDeltaM,
    headingDifferenceDeg,
    gpsPrev: globalPrev ? {
      east: globalPrev.east,
      north: globalPrev.north,
      latitude: globalPrev.latitude,
      longitude: globalPrev.longitude,
    } : null,
    gpsNext: globalNext ? {
      east: globalNext.east,
      north: globalNext.north,
      latitude: globalNext.latitude,
      longitude: globalNext.longitude,
    } : null,
    sourceLocalPrev: { east: prevPt.east, north: prevPt.north },
    sourceLocalNext: { east: nextPt.east, north: nextPt.north },
    referencePose: referencePose ? {
      east: referencePose.east,
      north: referencePose.north,
      headingDeg: referencePose.headingDeg,
      frameIndex: referencePose.frameIndex,
    } : null,
    startFrame: prevFrame?.frameId ?? null,
    endFrame: nextFrame?.frameId ?? null,
    samplesMissingAtBoundary: true,
    failureClass,
    speedAgreement,
    headingCompatible: headingDifferenceDeg <= MAX_HEADING_DIFF_DEG,
  };
}

function buildHermiteBridgeSection(prevPt, nextPt, prevFrame, nextFrame, options = {}) {
  const stepM = options.stepM ?? BRIDGE_STEP_M;
  const dist = dist2d(prevPt, nextPt);
  const steps = Math.max(2, Math.ceil(dist / stepM));
  const chord = dist / 3;
  const t0 = tangentFromTrajectory([prevPt, nextPt], 0);
  const t1 = tangentFromTrajectory([prevPt, nextPt], 1);
  const m0 = { east: t0.east * chord, north: t0.north * chord };
  const m1 = { east: t1.east * chord, north: t1.north * chord };
  const points = [];
  for (let i = 1; i < steps; i++) {
    const u = i / steps;
    const p = cubicHermitePoint(prevPt, nextPt, m0, m1, u);
    points.push({
      ...p,
      logMonoTime: interpolateLogMonoTime(prevPt.logMonoTime, nextPt.logMonoTime, u),
      timelineIndex: null,
      frameId: null,
      poseHeadingDeg: prevFrame?.pose?.headingDeg ?? prevPt.poseHeadingDeg ?? null,
      sourceFile: null,
      bridgeSection: true,
      bridgeFromSourceFile: prevPt.sourceFile,
      bridgeToSourceFile: nextPt.sourceFile,
    });
  }
  return points;
}

function estimateBridgeHalfWidth(map, prevPt, nextPt) {
  const polys = map?.roadSurfacePolygons || [];
  let best = DEFAULT_HALF_WIDTH_M;
  for (const poly of polys) {
    const w = poly?.stats?.separationM ?? poly?.localStats?.maxWidth;
    if (Number.isFinite(w) && w > 2 && w < 30) best = w / 2;
  }
  const edgeFrags = map?.edgeFragments || [];
  if (edgeFrags.length) return Math.max(3, Math.min(15, best));
  return DEFAULT_HALF_WIDTH_M;
}

function boundaryCrossingsAreBridged(trajectory, maxStepM = CONTINUITY_MAX_STEP_M) {
  for (let i = 0; i < (trajectory || []).length - 1; i++) {
    const a = trajectory[i];
    const b = trajectory[i + 1];
    if (a?.sourceFile && b?.sourceFile && a.sourceFile !== b.sourceFile) {
      if (dist2d(a, b) > maxStepM) return false;
    }
    if (a?.bridgeSection || b?.bridgeSection) {
      if (dist2d(a, b) > maxStepM) return false;
    }
  }
  return true;
}

function buildBoundaryGapDiagnosis(map, processedData) {
  const frames = processedData?.frames || [];
  const trajectory = map?.trajectory || [];
  const routeFiles = routeSourceFiles(processedData);
  const boundaries = [];
  for (let i = 0; i < trajectory.length - 1; i++) {
    const prev = trajectory[i];
    const next = trajectory[i + 1];
    if (!prev?.sourceFile || prev.sourceFile === next?.sourceFile) continue;
    const prevFrame = frameAtTimelineIndex(frames, prev.timelineIndex);
    const nextFrame = frameAtTimelineIndex(frames, next.timelineIndex);
    boundaries.push(diagnoseBoundaryGap(prev, next, prevFrame, nextFrame, map?.referencePose));
  }
  return {
    routeFiles,
    boundaries,
    maxConsecutiveGapM: maxConsecutiveTrajectoryGapM(trajectory),
    continuityContract: {
      trajectoryMaxStepM: CONTINUITY_MAX_STEP_M,
      greyRoadMustCoverCenterline: true,
      dashedConnectorDoesNotCount: true,
    },
  };
}

function applyCombinedRouteBoundaryBridges(map, processedData, options = {}) {
  if (!map?.trajectory?.length) return map;
  const routeFiles = routeSourceFiles(processedData);
  const frames = processedData?.frames || [];
  const trajectory = map.trajectory.map((p) => ({ ...p }));
  const bridges = [];
  const newTrajectory = [];
  const newPolygons = (map.roadSurfacePolygons || []).map((poly) => ({
    ...poly,
    ring: (poly.ring || []).map((pt) => ({ ...pt })),
  }));

  for (let i = 0; i < trajectory.length; i++) {
    const prev = trajectory[i];
    newTrajectory.push(prev);
    const next = trajectory[i + 1];
    if (!next || prev.sourceFile === next.sourceFile) continue;

    const diagnosis = diagnoseBoundaryGap(
      prev,
      next,
      frameAtTimelineIndex(frames, prev.timelineIndex),
      frameAtTimelineIndex(frames, next.timelineIndex),
      map.referencePose,
    );

    const eligible = diagnosis.endpointDistanceM >= MIN_BRIDGE_GAP_M
      && diagnosis.endpointDistanceM <= MAX_BRIDGE_GAP_M
      && isConsecutiveRoutePair(prev.sourceFile, next.sourceFile, routeFiles)
      && diagnosis.speedAgreement
      && diagnosis.headingCompatible
      && BigInt(next.logMonoTime) >= BigInt(prev.logMonoTime);

    if (!eligible) {
      bridges.push({
        ...diagnosis,
        bridgeClassification: diagnosis.failureClass,
        supportStatus: 'rejected',
        reason: 'bridgeEligibilityFailed',
      });
      continue;
    }

    const centerline = [prev, ...buildHermiteBridgeSection(prev, next, frameAtTimelineIndex(frames, prev.timelineIndex), frameAtTimelineIndex(frames, next.timelineIndex), options), next];
    if (centerlineSelfIntersects(centerline)) {
      bridges.push({ ...diagnosis, supportStatus: 'rejected', reason: 'centerlineSelfIntersection' });
      continue;
    }

    const bridgePoints = buildHermiteBridgeSection(
      prev,
      next,
      frameAtTimelineIndex(frames, prev.timelineIndex),
      frameAtTimelineIndex(frames, next.timelineIndex),
      options,
    );
    newTrajectory.push(...bridgePoints);

    const halfWidthM = estimateBridgeHalfWidth(map, prev, next);
    const ring = buildBridgeRibbonRing([prev, ...bridgePoints, next], halfWidthM);
    if (!ring || ring.length < 4 || ringSelfIntersects(ring)) {
      bridges.push({ ...diagnosis, supportStatus: 'rejected', reason: 'ribbonInvalid' });
      newTrajectory.splice(newTrajectory.length - bridgePoints.length, bridgePoints.length);
      continue;
    }

    const provenance = {
      fromSourceFile: prev.sourceFile,
      toSourceFile: next.sourceFile,
      startFrame: diagnosis.startFrame,
      endFrame: diagnosis.endFrame,
      timeGapS: diagnosis.timeGapS,
      endpointDistanceM: diagnosis.endpointDistanceM,
      expectedTravelDistanceM: diagnosis.expectedTravelDistanceM,
      headingDifferenceDeg: diagnosis.headingDifferenceDeg,
      bridgeClassification: diagnosis.failureClass,
      supportStatus: 'accepted',
      centerlinePointCount: bridgePoints.length,
      halfWidthM,
    };

    newPolygons.push({
      ring,
      surfaceType: 'egoLaneCorridor',
      fragmentKind: 'combinedRouteBoundaryBridge',
      passId: map.passId ?? 0,
      fragmentIndex: newPolygons.length,
      syntheticForSurface: false,
      bridgeProvenance: provenance,
      stats: {
        separationM: halfWidthM * 2,
        bridgeSection: true,
      },
    });

    bridges.push(provenance);
  }

  const out = {
    ...map,
    trajectory: newTrajectory,
    roadSurfacePolygons: newPolygons,
    boundaryBridges: bridges,
    combinedRouteContinuity: {
      maxConsecutiveGapM: maxConsecutiveTrajectoryGapM(newTrajectory),
      bridgeCount: bridges.filter((b) => b.supportStatus === 'accepted').length,
    },
  };
  return out;
}

module.exports = {
  CONTINUITY_MAX_STEP_M,
  MIN_BRIDGE_GAP_M,
  MAX_BRIDGE_GAP_M,
  BRIDGE_STEP_M,
  parseSegmentId,
  routeSourceFiles,
  isConsecutiveRoutePair,
  maxConsecutiveTrajectoryGapM,
  diagnoseBoundaryGap,
  buildBoundaryGapDiagnosis,
  applyCombinedRouteBoundaryBridges,
  boundaryCrossingsAreBridged,
  buildHermiteBridgeSection,
  buildBridgeRibbonRing,
  ringSelfIntersects,
};
