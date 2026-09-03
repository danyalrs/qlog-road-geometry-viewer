'use strict';
(function (global) {
const QUERY_PARAM = 'boundaryBridgePlaybackCandidate';
const MAX_BRIDGE_DURATION_S = 120;
const MIN_BRIDGE_DURATION_S = 0.05;
const ACCEPTED_CLASSIFICATION = 'B_realSamplingGap';

function parseBoundaryBridgePlaybackCandidate(search) {
  const raw = typeof search === 'string'
    ? new URLSearchParams(search).get(QUERY_PARAM)
    : search?.get?.(QUERY_PARAM);
  return raw === '1';
}

function isAcceptedBridge(bridge) {
  return !!bridge
    && bridge.supportStatus === 'accepted'
    && bridge.bridgeClassification === ACCEPTED_CLASSIFICATION;
}

function extractBridgeCenterlineFromTrajectory(trajectory, fromSourceFile, toSourceFile) {
  const traj = trajectory || [];
  if (!fromSourceFile || !toSourceFile || traj.length < 2) {
    return { ok: false, diagnostic: 'missingTrajectory' };
  }
  for (let i = 0; i < traj.length - 1; i++) {
    const prev = traj[i];
    const next = traj[i + 1];
    if (prev?.sourceFile !== fromSourceFile) continue;
    if (next?.sourceFile === fromSourceFile) continue;
    const centerline = [prev];
    let j = i + 1;
    while (j < traj.length && traj[j]?.sourceFile !== toSourceFile) {
      centerline.push(traj[j]);
      j++;
    }
    if (j >= traj.length || traj[j]?.sourceFile !== toSourceFile) {
      return { ok: false, diagnostic: 'missingBridgeSection' };
    }
    centerline.push(traj[j]);
    return {
      ok: true,
      centerlinePoints: centerline,
      startTrajectoryIndex: i,
      endTrajectoryIndex: j,
    };
  }
  return { ok: false, diagnostic: 'boundaryNotFound' };
}

function findAcceptedBridge(map, fromSourceFile, toSourceFile) {
  const bridges = map?.boundaryBridges || [];
  const bridge = bridges.find((b) => (
    isAcceptedBridge(b)
    && b.fromSourceFile === fromSourceFile
    && b.toSourceFile === toSourceFile
  ));
  if (!bridge) return { ok: false, diagnostic: 'noAcceptedBridge' };
  const extracted = extractBridgeCenterlineFromTrajectory(
    map?.trajectory,
    fromSourceFile,
    toSourceFile,
  );
  if (!extracted.ok) return extracted;
  return {
    ok: true,
    bridge,
    centerlinePoints: extracted.centerlinePoints,
    startTrajectoryIndex: extracted.startTrajectoryIndex,
    endTrajectoryIndex: extracted.endTrajectoryIndex,
  };
}

function buildBridgeArcLengthTable(points) {
  const pts = points || [];
  if (!pts.length) {
    return { cumulativeDistances: [0], totalLengthM: 0, segmentLengths: [] };
  }
  const cumulativeDistances = [0];
  const segmentLengths = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = Math.hypot(
      (b?.east ?? 0) - (a?.east ?? 0),
      (b?.north ?? 0) - (a?.north ?? 0),
    );
    segmentLengths.push(seg);
    cumulativeDistances.push(cumulativeDistances[i - 1] + seg);
  }
  return {
    cumulativeDistances,
    totalLengthM: cumulativeDistances[cumulativeDistances.length - 1],
    segmentLengths,
  };
}

function sampleBridgeAtDistance(points, cumulativeDistances, distanceM) {
  const pts = points || [];
  if (!pts.length) return null;
  const total = cumulativeDistances[cumulativeDistances.length - 1] ?? 0;
  if (total <= 0) return { ...pts[0] };
  const target = Math.max(0, Math.min(total, distanceM));
  if (target <= 0) return { ...pts[0] };
  if (target >= total) return { ...pts[pts.length - 1] };
  let seg = 0;
  while (seg < cumulativeDistances.length - 2 && cumulativeDistances[seg + 1] < target) {
    seg++;
  }
  const a = pts[seg];
  const b = pts[seg + 1];
  const segStart = cumulativeDistances[seg];
  const segEnd = cumulativeDistances[seg + 1];
  const segLen = segEnd - segStart;
  const t = segLen > 0 ? (target - segStart) / segLen : 0;
  const east = (a?.east ?? 0) + ((b?.east ?? 0) - (a?.east ?? 0)) * t;
  const north = (a?.north ?? 0) + ((b?.north ?? 0) - (a?.north ?? 0)) * t;
  const placedEast = Number.isFinite(a?.placedEast) || Number.isFinite(b?.placedEast)
    ? (a?.placedEast ?? a?.east ?? 0) + ((b?.placedEast ?? b?.east ?? 0) - (a?.placedEast ?? a?.east ?? 0)) * t
    : east;
  const placedNorth = Number.isFinite(a?.placedNorth) || Number.isFinite(b?.placedNorth)
    ? (a?.placedNorth ?? a?.north ?? 0) + ((b?.placedNorth ?? b?.north ?? 0) - (a?.placedNorth ?? a?.north ?? 0)) * t
    : north;
  return {
    east,
    north,
    placedEast,
    placedNorth,
    segmentIndex: seg,
    alongSegmentT: t,
  };
}

function headingDegFromDelta(de, dn) {
  if (!Number.isFinite(de) || !Number.isFinite(dn) || (de === 0 && dn === 0)) return 0;
  return ((Math.atan2(dn, de) * 180) / Math.PI + 360) % 360;
}

function bridgeTangentHeadingDeg(points, cumulativeDistances, distanceM) {
  const pts = points || [];
  if (pts.length < 2) return 0;
  const total = cumulativeDistances[cumulativeDistances.length - 1] ?? 0;
  const target = Math.max(0, Math.min(total, distanceM));
  let seg = 0;
  while (seg < cumulativeDistances.length - 2 && cumulativeDistances[seg + 1] < target) seg++;
  const a = pts[seg];
  const b = pts[Math.min(seg + 1, pts.length - 1)];
  return headingDegFromDelta((b?.east ?? 0) - (a?.east ?? 0), (b?.north ?? 0) - (a?.north ?? 0));
}

function resolveBridgeDuration(bridge, arcLengthM) {
  const timeGapS = Number(bridge?.timeGapS);
  if (!Number.isFinite(timeGapS) || timeGapS <= MIN_BRIDGE_DURATION_S || timeGapS > MAX_BRIDGE_DURATION_S) {
    return { ok: false, diagnostic: 'invalidTimeGapS', timeGapS };
  }
  const prevSpeed = Number(bridge?.endpointSpeedPrevMps);
  const nextSpeed = Number(bridge?.endpointSpeedNextMps);
  const avgSpeed = (Number.isFinite(prevSpeed) && Number.isFinite(nextSpeed) && (prevSpeed + nextSpeed) > 0)
    ? (prevSpeed + nextSpeed) / 2
    : null;
  const lengthM = Number.isFinite(arcLengthM) ? arcLengthM : Number(bridge?.endpointDistanceM);
  const expectedDurationS = avgSpeed > 0 && Number.isFinite(lengthM)
    ? lengthM / avgSpeed
    : null;
  return {
    ok: true,
    bridgeDurationS: timeGapS,
    expectedDurationS,
    durationDeltaS: expectedDurationS != null ? timeGapS - expectedDurationS : null,
    averageBoundarySpeedMps: avgSpeed,
    bridgeLengthM: lengthM,
  };
}

function computeBridgeProgress({
  timestampMs,
  bridgeStartTimestampMs,
  bridgePausedDurationMs = 0,
  bridgeDurationS,
}) {
  const durationMs = Number(bridgeDurationS) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const start = Number(bridgeStartTimestampMs);
  const ts = Number(timestampMs);
  if (!Number.isFinite(start) || !Number.isFinite(ts)) return 0;
  const elapsedMs = Math.max(0, ts - start - (Number(bridgePausedDurationMs) || 0));
  return Math.min(1, elapsedMs / durationMs);
}

function sampleBridgePose(centerlinePoints, progress, bridgeMeta = {}) {
  const arc = buildBridgeArcLengthTable(centerlinePoints);
  if (!arc.totalLengthM || !centerlinePoints?.length) {
    return { ok: false, diagnostic: 'emptyCenterline' };
  }
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const distanceM = p * arc.totalLengthM;
  const sampled = sampleBridgeAtDistance(centerlinePoints, arc.cumulativeDistances, distanceM);
  if (!sampled) return { ok: false, diagnostic: 'sampleFailed' };
  const durationS = Number(bridgeMeta.bridgeDurationS) || Number(bridgeMeta.timeGapS) || 1;
  const speedMps = arc.totalLengthM / durationS;
  const headingDeg = bridgeTangentHeadingDeg(centerlinePoints, arc.cumulativeDistances, distanceM);
  const east = sampled.placedEast ?? sampled.east;
  const north = sampled.placedNorth ?? sampled.north;
  return {
    ok: true,
    pose: {
      east,
      north,
      placedEast: east,
      placedNorth: north,
      coordinateFrame: 'combinedPlaced',
      isBoundaryBridgePose: true,
      bridgeProgress: p,
      bridgeFromSourceFile: bridgeMeta.fromSourceFile ?? null,
      bridgeToSourceFile: bridgeMeta.toSourceFile ?? null,
      speedMps,
      headingDeg,
      headingSource: 'boundaryBridgeTangent',
      frozen: false,
      pathIndex: sampled.segmentIndex,
    },
    arc,
    distanceM,
  };
}

function shouldHoldAtBridgeEnd({ bridgeProgress, nextVideoReady }) {
  return bridgeProgress >= 1 && !nextVideoReady;
}

function canCommitBridgeTransition({ bridgeProgress, nextVideoReady, missingVideo = false }) {
  if (bridgeProgress < 1) return false;
  if (missingVideo) return true;
  return !!nextVideoReady;
}

const api = {
  QUERY_PARAM,
  MAX_BRIDGE_DURATION_S,
  MIN_BRIDGE_DURATION_S,
  ACCEPTED_CLASSIFICATION,
  parseBoundaryBridgePlaybackCandidate,
  isAcceptedBridge,
  extractBridgeCenterlineFromTrajectory,
  findAcceptedBridge,
  buildBridgeArcLengthTable,
  sampleBridgeAtDistance,
  bridgeTangentHeadingDeg,
  resolveBridgeDuration,
  computeBridgeProgress,
  sampleBridgePose,
  shouldHoldAtBridgeEnd,
  canCommitBridgeTransition,
};

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.BoundaryBridgePlayback = api;
})(typeof window !== 'undefined' ? window : global);
