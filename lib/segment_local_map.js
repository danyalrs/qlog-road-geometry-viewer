'use strict';

/**
 * Stationary segment-local map for Local playback.
 * All geometry is transformed once into a fixed reference pose frame.
 */

const LP = typeof require !== 'undefined'
  ? require('./local_playback')
  : (typeof window !== 'undefined' ? window.LocalPlayback : null);
const LMC = typeof require !== 'undefined'
  ? require('./lane_map_cleanup')
  : (typeof window !== 'undefined' ? window.LaneMapCleanup : null);
const SD = typeof require !== 'undefined'
  ? require('./sd_fusion')
  : (typeof window !== 'undefined' ? window.SdFusion : null);
const { buildReferenceTrajectory } = typeof require !== 'undefined'
  ? require('./trajectory')
  : { buildReferenceTrajectory: (path) => (window.Trajectory?.buildReferenceTrajectory?.(path) ?? null) };
const { resolveCleanupOptions } = typeof require !== 'undefined'
  ? require('./process_defaults')
  : { resolveCleanupOptions: (d) => d?.processingOptions || {} };
const interpolateTimedPath = (...args) => LP.interpolateTimedPath(...args);
const headingDegForVehicleIcon = (...args) => LP.headingDegForVehicleIcon(...args);
const MIN_HEADING_DISPLACEMENT_M = LP.MIN_HEADING_DISPLACEMENT_M;

const GEOMETRY_SOURCES = new Set([
  'observations',
  'tracked',
  'fused',
  'rejected',
  'cleaned',
  'cleanedWithSurface',
  'cleanedWithStage1Surface',
  'cleanedDebug',
  'diagnostic',
]);

function normalizeGeometrySource(source) {
  if (GEOMETRY_SOURCES.has(source)) return source;
  return 'observations';
}

const TRAJECTORY_DEDUP_M = 0.05;
const MAX_TRAJECTORY_JUMP_M = 150;
const ROUND_TRIP_TOLERANCE_M = 1e-6;
const OUTLIER_TRAJECTORY_DIST_M = 25;
const OUTLIER_LENGTH_FACTOR = 3;
const OUTLIER_ABSOLUTE_LENGTH_M = 150;

function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < (points?.length || 0); i++) {
    len += Math.hypot(points[i].east - points[i - 1].east, points[i].north - points[i - 1].north);
  }
  return len;
}

function fragmentMidpoint(points) {
  if (!points?.length) return null;
  return points[Math.floor(points.length / 2)];
}

function distPointToTrajectory(point, trajectory) {
  if (!point || !trajectory?.length) return Infinity;
  let best = Infinity;
  for (const t of trajectory) {
    best = Math.min(best, Math.hypot(point.east - t.east, point.north - t.north));
  }
  return best;
}

/**
 * Fixed segment-local frame for stationary playback.
 * east = forward along reference heading, north = left (canvas north-up).
 * Do not reuse globalToVehicleDisplay here — that helper flips north for
 * per-frame vehicle-relative overlays (north = -modelY).
 */
function globalToSegmentLocal(east, north, referencePose) {
  const ve = referencePose?.east ?? 0;
  const vn = referencePose?.north ?? 0;
  const theta = (referencePose?.headingDeg ?? 0) * Math.PI / 180;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const u = east - ve;
  const v = north - vn;
  const modelX = u * sinT + v * cosT;
  const modelY = v * sinT - u * cosT;
  return { east: modelX, north: modelY, modelX, modelY };
}

function segmentLocalToGlobal(localEast, localNorth, referencePose) {
  const modelX = localEast;
  const modelY = localNorth;
  const theta = (referencePose?.headingDeg ?? 0) * Math.PI / 180;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  return {
    east: (referencePose?.east ?? 0) + modelX * sinT - modelY * cosT,
    north: (referencePose?.north ?? 0) + modelX * cosT + modelY * sinT,
    modelX,
    modelY,
  };
}

function signedGpsHeadingDeltaDeg(frames, fromIdx, toIdx) {
  const h0 = frames[fromIdx]?.pose?.headingDeg;
  const h1 = frames[toIdx]?.pose?.headingDeg;
  if (!Number.isFinite(h0) || !Number.isFinite(h1)) return null;
  return ((h1 - h0 + 540) % 360) - 180;
}

function signedTrajectoryTurnCross(trajectory, fromIdx, toIdx) {
  const p0 = trajectory.find((t) => t.timelineIndex === fromIdx)
    || trajectory.find((t) => t.timelineIndex >= fromIdx);
  const p1 = trajectory.find((t) => t.timelineIndex === toIdx)
    || [...trajectory].reverse().find((t) => t.timelineIndex <= toIdx);
  const midIdx = Math.floor((fromIdx + toIdx) / 2);
  const pm = trajectory.find((t) => t.timelineIndex === midIdx)
    || trajectory.find((t) => t.timelineIndex >= midIdx);
  if (!p0 || !pm || !p1) return null;
  const v1x = pm.east - p0.east;
  const v1y = pm.north - p0.north;
  const v2x = p1.east - pm.east;
  const v2y = p1.north - pm.north;
  return v1x * v2y - v1y * v2x;
}

function turnDirectionsAgree(frames, trajectory, fromIdx, toIdx) {
  const gpsDelta = signedGpsHeadingDeltaDeg(frames, fromIdx, toIdx);
  const cross = signedTrajectoryTurnCross(trajectory, fromIdx, toIdx);
  if (!Number.isFinite(gpsDelta) || !Number.isFinite(cross) || Math.abs(gpsDelta) < 5) {
    return { agrees: true, gpsDelta, cross, reason: 'insufficientTurn' };
  }
  const agrees = Math.sign(gpsDelta) === -Math.sign(cross);
  return { agrees, gpsDelta, cross };
}

function transformPolylineToSegmentLocal(points, referencePose) {
  if (!points?.length || !referencePose) return [];
  return points.map((p) => {
    const rel = globalToSegmentLocal(p.east, p.north, referencePose);
    return { ...p, east: rel.east, north: rel.north, modelX: rel.modelX, modelY: rel.modelY };
  });
}

function isValidPose(pose) {
  return pose
    && Number.isFinite(pose.east)
    && Number.isFinite(pose.north)
    && Number.isFinite(pose.headingDeg);
}

function framePassId(frame) {
  return frame?.passId ?? frame?.temporalPassId ?? 0;
}

function frameMatchesChunkPass(frame, chunkId, passId) {
  if (!frame) return false;
  if (frame.chunkId != null && frame.chunkId !== chunkId) return false;
  if (passId != null && framePassId(frame) !== passId) return false;
  return true;
}

function isMovingFrame(frame, timelineEntry, options = {}) {
  const state = timelineEntry?.movementState;
  const speed = frame?.pose?.speed ?? timelineEntry?.speed;
  if (state === 'stationary') return false;
  if (state === 'moving' || state === 'creeping') return true;
  const minSpeed = options.minHeadingSpeedMps ?? 2.0;
  return Number.isFinite(speed) && speed >= minSpeed;
}

function resolveSegmentReferencePose({
  frames,
  timeline,
  chunkId,
  passId,
  options = {},
}) {
  const tryFrame = (i, requireMoving) => {
    const frame = frames[i];
    const entry = timeline?.[i];
    if (!frameMatchesChunkPass(frame, chunkId, passId)) return null;
    if (!isValidPose(frame.pose)) return null;
    if (requireMoving && !isMovingFrame(frame, entry, options)) return null;
    return {
      frameIndex: i,
      east: frame.pose.east,
      north: frame.pose.north,
      headingDeg: frame.pose.headingDeg,
      logMonoTime: frame.logMonoTime ?? entry?.logMonoTime ?? null,
      chunkId,
      passId: framePassId(frame),
    };
  };

  for (let i = 0; i < (timeline?.length || frames.length); i++) {
    const ref = tryFrame(i, true);
    if (ref) return ref;
  }
  for (let i = 0; i < frames.length; i++) {
    const ref = tryFrame(i, false);
    if (ref) return ref;
  }
  return null;
}

function resolveActiveChunkPass(processedData, timelineIndex) {
  const frames = processedData?.frames || [];
  const timeline = processedData?.timeline || [];
  const idx = Math.min(Math.max(0, timelineIndex), Math.max(0, timeline.length - 1));
  const entry = timeline[idx];
  const frame = frames[idx];
  return {
    chunkId: entry?.chunkId ?? frame?.chunkId ?? 0,
    passId: framePassId(frame),
  };
}

function buildObservationFragments(frames, timeline, referencePose, chunkId, passId) {
  const laneFragments = [];
  const edgeFragments = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frameMatchesChunkPass(frame, chunkId, passId)) continue;
    for (const lane of frame.lanes || []) {
      if (!lane.points?.length) continue;
      laneFragments.push({
        points: transformPolylineToSegmentLocal(lane.points, referencePose),
        sourceFrameIndex: i,
        frameId: frame.frameId,
        laneIndex: lane.laneIndex,
        laneTrackId: lane.laneTrackId,
        prob: lane.prob,
        fragmentKind: 'observationLane',
      });
    }
    for (const edge of frame.edges || []) {
      if (!edge.points?.length) continue;
      edgeFragments.push({
        points: transformPolylineToSegmentLocal(edge.points, referencePose),
        sourceFrameIndex: i,
        frameId: frame.frameId,
        edgeIndex: edge.edgeIndex,
        fragmentKind: 'observationEdge',
      });
    }
  }
  return { laneFragments, edgeFragments };
}

function buildFusedFragments(routeChunks, referencePose, chunkId, passId) {
  const chunk = routeChunks?.find((c) => c.chunkId === chunkId) ?? routeChunks?.[0];
  const laneFragments = (chunk?.fusedLaneLines || [])
    .filter((lane) => passId == null || lane.passId == null || lane.passId === passId)
    .map((lane, i) => ({
      points: transformPolylineToSegmentLocal(lane.points, referencePose),
      fusedIndex: i,
      laneIndex: lane.laneIndex,
      laneTrackId: lane.laneTrackId,
      fragmentKind: 'fusedLane',
      supportStatus: 'fused',
      colorByTrack: true,
    }));
  const edgeFragments = (chunk?.fusedRoadEdges || []).map((edge, i) => ({
    points: transformPolylineToSegmentLocal(edge.points, referencePose),
    fusedIndex: i,
    edgeIndex: edge.edgeIndex,
    fragmentKind: 'fusedEdge',
  }));
  return { laneFragments, edgeFragments };
}

function buildTrackedFragments(frames, timeline, referencePose, chunkId, passId, routeChunks) {
  if (!LMC?.buildTrackedPolylines) {
    return { laneFragments: [], edgeFragments: [] };
  }
  const chunk = routeChunks?.find((c) => c.chunkId === chunkId) ?? routeChunks?.[0];
  const tracked = LMC.buildTrackedPolylines(
    frames,
    chunk?.laneTracks || [],
    chunkId,
    passId,
    referencePose,
    (p) => transformPolylineToSegmentLocal([p], referencePose)[0],
  );
  return {
    laneFragments: tracked,
    edgeFragments: [],
  };
}

function loadD12ClassGaps() {
  if (typeof window !== 'undefined' && window.Segment2BrowserAuditData?.classDGaps) {
    return window.Segment2BrowserAuditData.classDGaps.filter((g) => g.primaryMechanism === 'D12');
  }
  if (typeof require === 'undefined') return null;
  try {
    const fs = require('fs');
    const path = require('path');
    const auditPath = path.join(__dirname, '..', 'audit_segment2_class_d_fusion_gaps.json');
    if (!fs.existsSync(auditPath)) return null;
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    return (audit.gaps || []).filter((g) => g.primaryMechanism === 'D12');
  } catch (_) {
    return null;
  }
}

function loadAllClassDGaps() {
  if (typeof window !== 'undefined' && window.Segment2BrowserAuditData?.classDGaps) {
    return window.Segment2BrowserAuditData.classDGaps;
  }
  if (typeof require === 'undefined') return [];
  try {
    const fs = require('fs');
    const path = require('path');
    const auditPath = path.join(__dirname, '..', 'audit_segment2_class_d_fusion_gaps.json');
    if (!fs.existsSync(auditPath)) return [];
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    return audit.gaps || [];
  } catch (_) {
    return [];
  }
}

function loadSegment2Separations() {
  if (typeof window !== 'undefined' && window.Segment2BrowserAuditData?.separations) {
    return window.Segment2BrowserAuditData.separations;
  }
  if (typeof require === 'undefined') return [];
  try {
    const fs = require('fs');
    const path = require('path');
    const auditPath = path.join(__dirname, '..', 'audit_segment2_cleaned_runs.json');
    if (!fs.existsSync(auditPath)) return [];
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    return audit.separations || [];
  } catch (_) {
    return [];
  }
}

function buildCleanupFragments(processedData, referencePose, chunkId, passId, { rejected = false, debug = false } = {}) {
  if (!LMC?.buildCleanedLaneMap) {
    return { laneFragments: [], edgeFragments: [], laneCleanup: null };
  }
  const chunk = processedData.routeChunks?.find((c) => c.chunkId === chunkId)
    ?? processedData.routeChunks?.[0];
  const classDGaps = loadD12ClassGaps();
  const vehiclePath = chunk?.vehiclePath;
  const trajectory = vehiclePath?.length >= 2 ? buildReferenceTrajectory(vehiclePath) : null;
  const frames = processedData.frames || [];
  const laneObservations = SD?.collectLaneObservations
    ? SD.collectLaneObservations(frames, trajectory, {})
    : null;
  const cleanupOpts = resolveCleanupOptions(processedData);
  const laneCleanup = LMC.buildCleanedLaneMap({
    frames,
    fusedLanes: chunk?.fusedLaneLines || [],
    tracks: chunk?.laneTracks || [],
    chunkId,
    passId,
    vehiclePath,
    trajectory,
    classDGaps,
    enableD12Preservation: true,
    laneObservations,
    options: cleanupOpts,
  });
  const sourceList = rejected ? laneCleanup.rejected : laneCleanup.cleaned;
  const laneFragments = sourceList.map((frag, i) => ({
    ...frag,
    points: transformPolylineToSegmentLocal(frag.points, referencePose),
    fragmentIndex: i,
    colorByTrack: frag.laneTrackId != null,
    colorByPhysicalBoundary: frag.colorByPhysicalBoundary ?? true,
    physicalBoundaryId: frag.physicalBoundaryId,
    sMin: frag.sMin,
    sMax: frag.sMax,
    fragmentKind: frag.fragmentKind || 'cleanedLane',
  }));

  const debugFragments = [];
  if (debug && laneCleanup.preservedGeometry?.length) {
    for (const interval of laneCleanup.preservedGeometry) {
      debugFragments.push({
        points: transformPolylineToSegmentLocal(interval.points, referencePose),
        fragmentKind: 'preservedSourcePolyline',
        supportStatus: 'preserved',
        provenanceType: interval.provenanceType,
        gapId: interval.gapId,
        physicalBoundaryId: interval.physicalBoundaryGroup,
        laneTrackId: interval.trackId,
        sourceFrameId: interval.sourceFrameId,
        sourcePolylineId: interval.sourcePolylineId,
        sMin: interval.startS,
        sMax: interval.endS,
        fullCoverage: interval.fullCoverage,
        colorByPhysicalBoundary: false,
      });
    }
  }

  return {
    laneFragments: debug ? [...laneFragments, ...debugFragments] : laneFragments,
    edgeFragments: [],
    laneCleanup,
    preservedDebugFragments: debugFragments,
  };
}

function buildLaneFragmentsForSource(processedData, {
  geometrySource,
  frames,
  timeline,
  referencePose,
  chunkId,
  passId,
}) {
  switch (geometrySource) {
    case 'tracked':
      return buildTrackedFragments(frames, timeline, referencePose, chunkId, passId, processedData.routeChunks);
    case 'fused':
      return buildFusedFragments(processedData.routeChunks, referencePose, chunkId, passId);
    case 'rejected': {
      const rejected = buildCleanupFragments(processedData, referencePose, chunkId, passId, { rejected: true });
      return rejected;
    }
    case 'cleaned':
    case 'cleanedWithSurface':
    case 'cleanedWithStage1Surface': {
      const cleaned = buildCleanupFragments(processedData, referencePose, chunkId, passId, { rejected: false });
      return cleaned;
    }
    case 'cleanedDebug': {
      const cleaned = buildCleanupFragments(processedData, referencePose, chunkId, passId, { rejected: false, debug: true });
      return cleaned;
    }
    case 'observations':
    default:
      return buildObservationFragments(frames, timeline, referencePose, chunkId, passId);
  }
}

function buildRoadSurfacePolygons(routeChunks, referencePose, chunkId, passId) {
  const chunk = routeChunks?.find((c) => c.chunkId === chunkId) ?? routeChunks?.[0];
  return (chunk?.roadSurfacePolygons || [])
    .filter((poly) => passId == null || poly.passId === passId)
    .map((poly, i) => ({
      ring: transformPolylineToSegmentLocal(poly.ring, referencePose),
      passId: poly.passId,
      fragmentIndex: poly.fragmentIndex ?? i,
      stats: poly.stats,
      fragmentKind: 'roadSurface',
      surfaceType: poly.surfaceType ?? 'egoLaneCorridor',
      sourceLeftTrackId: poly.sourceLeftTrackId,
      sourceRightTrackId: poly.sourceRightTrackId,
      bridgeProvenance: poly.bridgeProvenance,
      syntheticForSurface: (poly.stats?.syntheticSampleCount ?? 0) > 0,
    }))
    .filter((poly) => poly.ring?.length >= 3);
}

function annotateFragmentOutliers(laneFragments, edgeFragments, trajectory) {
  const lengths = [...laneFragments, ...edgeFragments]
    .map((f) => polylineLength(f.points))
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const medianLen = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 50;
  const lengthThreshold = Math.max(OUTLIER_ABSOLUTE_LENGTH_M, medianLen * OUTLIER_LENGTH_FACTOR);

  const flag = (frag) => {
    const len = polylineLength(frag.points);
    const mid = fragmentMidpoint(frag.points);
    const trajDist = distPointToTrajectory(mid, trajectory);
    const reasons = [];
    if (len > lengthThreshold) reasons.push('excessiveLength');
    if (trajDist > OUTLIER_TRAJECTORY_DIST_M) reasons.push('farFromTrajectory');
    frag.lengthM = len;
    frag.distToTrajectoryM = Number.isFinite(trajDist) ? trajDist : null;
    frag.outlier = reasons.length > 0;
    frag.outlierReasons = reasons;
    return frag;
  };

  laneFragments.forEach(flag);
  edgeFragments.forEach(flag);
  return { medianFragmentLengthM: medianLen, lengthThresholdM: lengthThreshold };
}

function buildSegmentTrajectory(frames, timeline, referencePose, chunkId, passId) {
  const points = [];
  let lastLocal = null;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frameMatchesChunkPass(frame, chunkId, passId)) continue;
    if (!isValidPose(frame.pose)) continue;
    const local = globalToSegmentLocal(frame.pose.east, frame.pose.north, referencePose);
    if (lastLocal) {
      const dist = Math.hypot(local.east - lastLocal.east, local.north - lastLocal.north);
      if (dist < TRAJECTORY_DEDUP_M) continue;
      if (dist > MAX_TRAJECTORY_JUMP_M) continue;
    }
    points.push({
      east: local.east,
      north: local.north,
      logMonoTime: String(frame.logMonoTime ?? timeline[i]?.logMonoTime ?? '0'),
      timelineIndex: i,
      frameId: frame.frameId,
      poseHeadingDeg: frame.pose.headingDeg,
    });
    lastLocal = local;
  }
  return points;
}

function computeMapBounds(laneFragments, edgeFragments, trajectory, roadSurfacePolygons = [], options = {}) {
  const pts = [];
  const add = (e, n) => {
    if (Number.isFinite(e) && Number.isFinite(n)) pts.push({ east: e, north: n });
  };
  const includeFragment = (frag) => !options.excludeOutliers || !frag.outlier;
  for (const frag of laneFragments) {
    if (!includeFragment(frag)) continue;
    for (const p of frag.points || []) add(p.east, p.north);
  }
  for (const frag of edgeFragments) {
    if (!includeFragment(frag)) continue;
    for (const p of frag.points || []) add(p.east, p.north);
  }
  for (const poly of roadSurfacePolygons) {
    for (const p of poly.ring || []) add(p.east, p.north);
  }
  for (const p of trajectory || []) add(p.east, p.north);
  add(0, 0);
  if (!pts.length) return { minE: -30, maxE: 30, minN: -10, maxN: 80 };
  let minE = Infinity; let maxE = -Infinity; let minN = Infinity; let maxN = -Infinity;
  for (const p of pts) {
    minE = Math.min(minE, p.east); maxE = Math.max(maxE, p.east);
    minN = Math.min(minN, p.north); maxN = Math.max(maxN, p.north);
  }
  const padE = Math.max(5, (maxE - minE) * 0.08);
  const padN = Math.max(5, (maxN - minN) * 0.08);
  return { minE: minE - padE, maxE: maxE + padE, minN: minN - padN, maxN: maxN + padN };
}

function computeMapChecksum(laneFragments, edgeFragments, trajectory) {
  let h = 2166136261;
  const mix = (n) => {
    h ^= n;
    h = Math.imul(h, 16777619);
  };
  const addPt = (p) => {
    if (!p) return;
    mix(Math.round((p.east ?? 0) * 1000));
    mix(Math.round((p.north ?? 0) * 1000));
  };
  for (const frag of laneFragments) {
    mix(frag.sourceFrameIndex ?? frag.fusedIndex ?? 0);
    if (frag.points?.length) {
      addPt(frag.points[0]);
      addPt(frag.points[frag.points.length - 1]);
    }
  }
  for (const frag of edgeFragments) {
    mix(frag.sourceFrameIndex ?? frag.fusedIndex ?? 0);
    if (frag.points?.[0]) addPt(frag.points[0]);
  }
  for (const p of trajectory || []) addPt(p);
  return (h >>> 0).toString(16);
}

function hashMixStart() {
  return 2166136261;
}

function hashMix(h, n) {
  h ^= n;
  return Math.imul(h, 16777619);
}

function hashFinish(h) {
  return (h >>> 0).toString(16);
}

function maxConsecutiveRingJump(ring) {
  let max = 0;
  for (let i = 1; i < (ring?.length || 0); i++) {
    max = Math.max(
      max,
      Math.hypot(ring[i].east - ring[i - 1].east, ring[i].north - ring[i - 1].north),
    );
  }
  return max;
}

function ringWidthM(ring) {
  if (!ring?.length) return 0;
  let minE = Infinity; let maxE = -Infinity; let minN = Infinity; let maxN = -Infinity;
  for (const p of ring) {
    if (!Number.isFinite(p.east) || !Number.isFinite(p.north)) continue;
    minE = Math.min(minE, p.east); maxE = Math.max(maxE, p.east);
    minN = Math.min(minN, p.north); maxN = Math.max(maxN, p.north);
  }
  if (!Number.isFinite(minE)) return 0;
  return Math.max(maxE - minE, maxN - minN);
}

function ringHasFiniteCoords(ring) {
  return (ring || []).every((p) => Number.isFinite(p.east) && Number.isFinite(p.north));
}

function computeRoadPolygonChecksum(polygons) {
  let h = hashMixStart();
  for (const poly of polygons || []) {
    h = hashMix(h, poly.fragmentIndex ?? 0);
    h = hashMix(h, poly.passId ?? 0);
    for (const p of poly.ring || []) {
      h = hashMix(h, Math.round((p.east ?? 0) * 1000));
      h = hashMix(h, Math.round((p.north ?? 0) * 1000));
    }
  }
  return hashFinish(h);
}

function computeRoadPolygonMetaChecksum(polygons) {
  let h = hashMixStart();
  for (const poly of polygons || []) {
    h = hashMix(h, poly.fragmentIndex ?? 0);
    h = hashMix(h, poly.passId ?? 0);
    h = hashMix(h, poly.ring?.length ?? 0);
    const surfaceType = poly.surfaceType ?? 'egoLaneCorridor';
    for (let i = 0; i < surfaceType.length; i++) h = hashMix(h, surfaceType.charCodeAt(i));
    h = hashMix(h, poly.sourceLeftTrackId ?? -1);
    h = hashMix(h, poly.sourceRightTrackId ?? -1);
    h = hashMix(h, poly.syntheticForSurface ? 1 : 0);
  }
  return hashFinish(h);
}

function computeRoadPolygonBounds(polygons) {
  let minE = Infinity; let maxE = -Infinity; let minN = Infinity; let maxN = -Infinity;
  let finite = true;
  for (const poly of polygons || []) {
    for (const p of poly.ring || []) {
      if (!Number.isFinite(p.east) || !Number.isFinite(p.north)) {
        finite = false;
        continue;
      }
      minE = Math.min(minE, p.east); maxE = Math.max(maxE, p.east);
      minN = Math.min(minN, p.north); maxN = Math.max(maxN, p.north);
    }
  }
  if (!Number.isFinite(minE)) {
    return { minE: 0, maxE: 0, minN: 0, maxN: 0, finite: false };
  }
  return { minE, maxE, minN, maxN, finite };
}

function computeRoadPolygonBoundsChecksum(bounds) {
  if (!bounds) return null;
  let h = hashMixStart();
  for (const key of ['minE', 'maxE', 'minN', 'maxN']) {
    h = hashMix(h, Math.round((bounds[key] ?? 0) * 1000));
  }
  h = hashMix(h, bounds.finite ? 1 : 0);
  return hashFinish(h);
}

function enrichRoadSurfacePolygonLocalStats(poly) {
  const ring = poly.ring || [];
  return {
    ...poly,
    localStats: {
      maxVertexJump: maxConsecutiveRingJump(ring),
      maxWidth: ringWidthM(ring),
      finite: ringHasFiniteCoords(ring),
    },
  };
}

function cloneMapPoint(p) {
  return {
    ...p,
    east: p.east,
    north: p.north,
  };
}

function freezeStationaryMapGeometry(map) {
  if (!map) return map;
  const roadSurfacePolygons = (map.roadSurfacePolygons || []).map((poly) => (
    enrichRoadSurfacePolygonLocalStats({
      ...poly,
      ring: (poly.ring || []).map(cloneMapPoint),
    })
  ));
  const roadSurfaceBounds = computeRoadPolygonBounds(roadSurfacePolygons);
  return {
    ...map,
    laneFragments: (map.laneFragments || []).map((frag) => ({
      ...frag,
      points: (frag.points || []).map(cloneMapPoint),
    })),
    edgeFragments: (map.edgeFragments || []).map((frag) => ({
      ...frag,
      points: (frag.points || []).map(cloneMapPoint),
    })),
    trajectory: (map.trajectory || []).map((pt) => ({ ...pt })),
    roadSurfacePolygons,
    roadSurfaceChecksum: computeRoadPolygonChecksum(roadSurfacePolygons),
    roadSurfaceMetaChecksum: computeRoadPolygonMetaChecksum(roadSurfacePolygons),
    roadSurfaceBounds,
    roadSurfaceBoundsChecksum: computeRoadPolygonBoundsChecksum(roadSurfaceBounds),
  };
}

const STATIONARY_ROAD_SURFACE_MAX_VERTEX_JUMP_M = 15;
const STATIONARY_ROAD_SURFACE_MAX_WIDTH_M = 30;

function shouldSkipStationaryRoadPolygon(poly, options = {}) {
  const ring = poly?.ring;
  if (!ring || ring.length < 3) {
    return { skip: true, reason: 'insufficientVertices' };
  }
  if (!ringHasFiniteCoords(ring)) {
    return { skip: true, reason: 'nonFiniteCoordinates' };
  }
  const surfaceType = poly.surfaceType ?? 'egoLaneCorridor';
  if (surfaceType !== 'egoLaneCorridor' && surfaceType !== 'multiLaneCorridor' && surfaceType !== 'fullRoadSurface') {
    return { skip: true, reason: 'unsupportedSurfaceType' };
  }
  if (options.polygonDebug || options.fusionBinDebug) {
    return { skip: false, reason: null };
  }
  const localJump = poly.localStats?.maxVertexJump ?? maxConsecutiveRingJump(ring);
  if (localJump > STATIONARY_ROAD_SURFACE_MAX_VERTEX_JUMP_M) {
    return { skip: true, reason: 'localMaxVertexJump' };
  }
  const fusionJump = poly.stats?.maxVertexJump;
  const fusionWidth = poly.stats?.maxWidth;
  if (Number.isFinite(fusionJump) && fusionJump > STATIONARY_ROAD_SURFACE_MAX_VERTEX_JUMP_M) {
    return { skip: true, reason: 'fusionMaxVertexJump' };
  }
  if (Number.isFinite(fusionWidth) && fusionWidth > STATIONARY_ROAD_SURFACE_MAX_WIDTH_M) {
    return { skip: true, reason: 'fusionMaxWidth' };
  }
  return { skip: false, reason: null };
}

function selectStationaryRoadSurfacePolygons(polygons, options = {}) {
  const selected = [];
  const skipped = [];
  for (let i = 0; i < (polygons || []).length; i++) {
    const poly = polygons[i];
    const decision = shouldSkipStationaryRoadPolygon(poly, options);
    if (decision.skip) {
      skipped.push({
        index: i,
        fragmentIndex: poly.fragmentIndex ?? i,
        surfaceType: poly.surfaceType ?? 'egoLaneCorridor',
        reason: decision.reason,
      });
    } else {
      selected.push(poly);
    }
  }
  return { selected, skipped, selectedCount: selected.length, skippedCount: skipped.length };
}

function buildSegmentLocalMap(processedData, options = {}) {
  const geometrySource = normalizeGeometrySource(options.geometrySource);
  const frames = processedData?.frames || [];
  const timeline = processedData?.timeline || [];
  const timelineIndex = options.timelineIndex ?? 0;
  const active = options.chunkId != null
    ? { chunkId: options.chunkId, passId: options.passId ?? 0 }
    : resolveActiveChunkPass(processedData, timelineIndex);
  const { chunkId, passId } = active;

  const referencePose = resolveSegmentReferencePose({
    frames,
    timeline,
    chunkId,
    passId,
    options,
  });

  if (!referencePose) {
    return {
      valid: false,
      reason: 'noReferencePose',
      geometrySource,
      chunkId,
      passId,
      referencePose: null,
      laneFragments: [],
      edgeFragments: [],
      trajectory: [],
      bounds: null,
      checksum: null,
      laneFragmentCount: 0,
      edgeFragmentCount: 0,
      trajectoryPointCount: 0,
    };
  }

  const fragmentBuild = buildLaneFragmentsForSource(processedData, {
    geometrySource,
    frames,
    timeline,
    referencePose,
    chunkId,
    passId,
  });
  const { laneFragments, edgeFragments } = fragmentBuild;
  const laneCleanup = fragmentBuild.laneCleanup ?? null;

  let roadSurfacePolygons = buildRoadSurfacePolygons(
    processedData.routeChunks,
    referencePose,
    chunkId,
    passId,
  );
  if (geometrySource === 'cleanedWithSurface' && LMC?.filterRoadSurfaceForCleanedLanes && laneCleanup) {
    roadSurfacePolygons = LMC.filterRoadSurfaceForCleanedLanes(
      roadSurfacePolygons,
      laneCleanup.cleaned,
      laneCleanup.physicalBoundaryGroups,
    );
  } else if (geometrySource === 'cleanedWithStage1Surface' && laneCleanup?.cleaned) {
    const RSS = typeof require !== 'undefined'
      ? require('./road_surface_stage1')
      : (typeof window !== 'undefined' ? window.RoadSurfaceStage1 : null);
    if (RSS?.runStage1RoadSurface) {
      const stage1 = RSS.runStage1RoadSurface(laneCleanup.cleaned, laneCleanup, {
        classDGaps: loadAllClassDGaps(),
        separations: loadSegment2Separations(),
      });
      roadSurfacePolygons = stage1.polygons.map((poly, i) => ({
        ring: transformPolylineToSegmentLocal(poly.ring, referencePose),
        passId,
        fragmentIndex: i,
        polygonId: poly.polygonId,
        boundaryPairId: poly.boundaryPairId,
        sourceLeftTrackId: poly.leftTrackIds?.[0] ?? null,
        sourceRightTrackId: poly.rightTrackIds?.[0] ?? null,
        routeSStart: poly.routeSStart,
        routeSEnd: poly.routeSEnd,
        stats: poly.widthStats,
        fragmentKind: 'roadSurfaceStage1',
        surfaceType: poly.surfaceType,
        areaM2: poly.areaM2,
        bridgeProvenance: null,
        syntheticForSurface: false,
      })).filter((poly) => poly.ring?.length >= 3);
    } else {
      roadSurfacePolygons = [];
    }
  } else if (geometrySource === 'cleaned' || geometrySource === 'cleanedDebug' || geometrySource === 'rejected'
    || geometrySource === 'tracked') {
    roadSurfacePolygons = [];
  }
  roadSurfacePolygons = roadSurfacePolygons.map(enrichRoadSurfacePolygonLocalStats);
  const trajectory = buildSegmentTrajectory(frames, timeline, referencePose, chunkId, passId);
  const outlierMeta = annotateFragmentOutliers(laneFragments, edgeFragments, trajectory);
  const bounds = computeMapBounds(laneFragments, edgeFragments, trajectory, roadSurfacePolygons);
  const fitBounds = computeMapBounds(
    laneFragments,
    edgeFragments,
    trajectory,
    roadSurfacePolygons,
    { excludeOutliers: true },
  );
  const checksum = computeMapChecksum(laneFragments, edgeFragments, trajectory);
  const laneChecksum = LMC?.computeLaneChecksum
    ? LMC.computeLaneChecksum(laneFragments)
    : checksum;
  const roadSurfaceBounds = computeRoadPolygonBounds(roadSurfacePolygons);

  const outlierFragments = [
    ...laneFragments.filter((f) => f.outlier),
    ...edgeFragments.filter((f) => f.outlier),
  ];

  return {
    valid: (laneFragments.length + edgeFragments.length > 0)
      || roadSurfacePolygons.length > 0
      || trajectory.length >= 2,
    reason: (laneFragments.length + edgeFragments.length > 0)
      || roadSurfacePolygons.length > 0
      || trajectory.length >= 2
      ? null
      : 'noGeometry',
    geometrySource,
    referencePose,
    chunkId,
    passId,
    laneFragments,
    edgeFragments,
    roadSurfacePolygons,
    trajectory,
    bounds,
    fitBounds,
    checksum,
    laneChecksum,
    laneCleanup,
    roadSurfaceChecksum: computeRoadPolygonChecksum(roadSurfacePolygons),
    roadSurfaceMetaChecksum: computeRoadPolygonMetaChecksum(roadSurfacePolygons),
    roadSurfaceBounds,
    roadSurfaceBoundsChecksum: computeRoadPolygonBoundsChecksum(roadSurfaceBounds),
    laneFragmentCount: laneFragments.length,
    edgeFragmentCount: edgeFragments.length,
    roadSurfacePolygonCount: roadSurfacePolygons.length,
    trajectoryPointCount: trajectory.length,
    observationFrameCount: new Set(laneFragments.map((f) => f.sourceFrameIndex).filter((x) => x != null)).size,
    outlierFragmentCount: outlierFragments.length,
    outlierFragments,
    outlierMeta,
  };
}

function resolveArrowOnSegmentMap(localMap, timeline, frameIndex, options = {}) {
  if (!localMap?.trajectory?.length || !timeline?.length || frameIndex < 0) {
    return {
      east: 0,
      north: 0,
      headingDeg: 0,
      frozen: false,
      pathIndex: 0,
      headingSource: 'none',
      timelineIndex: frameIndex,
    };
  }

  const target = Math.min(frameIndex, timeline.length - 1);
  const entry = timeline[target];
  const interp = interpolateTimedPath(
    localMap.trajectory,
    entry.logMonoTime,
    options.lastHeadingDeg ?? null,
    {
      ...options,
      minHeadingDisplacementM: options.minHeadingDisplacementM ?? MIN_HEADING_DISPLACEMENT_M,
      smoothHeading: false,
    },
  );

  return {
    east: interp.east,
    north: interp.north,
    headingDeg: interp.headingDeg ?? 0,
    pathIndex: interp.pathIndex,
    segmentIndex: interp.segmentIndex,
    bracketA: interp.bracketA,
    bracketB: interp.bracketB,
    alpha: interp.alpha,
    frozen: false,
    headingSource: 'segmentTrajectory',
    timelineIndex: target,
    logMonoTime: String(entry.logMonoTime),
    matchMethod: 'segmentTrajectoryInterpolation',
  };
}

function listChunkPassGroups(processedData) {
  const groups = new Map();
  for (let i = 0; i < (processedData?.frames || []).length; i++) {
    const frame = processedData.frames[i];
    const chunkId = frame?.chunkId ?? 0;
    const passId = framePassId(frame);
    const key = `${chunkId}:${passId}`;
    if (!groups.has(key)) {
      groups.set(key, { chunkId, passId, frameIndices: [] });
    }
    groups.get(key).frameIndices.push(i);
  }
  return [...groups.values()];
}

const api = {
  ROUND_TRIP_TOLERANCE_M,
  globalToSegmentLocal,
  segmentLocalToGlobal,
  signedGpsHeadingDeltaDeg,
  signedTrajectoryTurnCross,
  turnDirectionsAgree,
  headingDegForVehicleIcon,
  transformPolylineToSegmentLocal,
  resolveSegmentReferencePose,
  resolveActiveChunkPass,
  buildSegmentLocalMap,
  normalizeGeometrySource,
  buildLaneFragmentsForSource,
  buildSegmentTrajectory,
  buildRoadSurfacePolygons,
  annotateFragmentOutliers,
  resolveArrowOnSegmentMap,
  computeMapBounds,
  computeMapChecksum,
  computeRoadPolygonChecksum,
  computeRoadPolygonMetaChecksum,
  computeRoadPolygonBounds,
  computeRoadPolygonBoundsChecksum,
  enrichRoadSurfacePolygonLocalStats,
  freezeStationaryMapGeometry,
  shouldSkipStationaryRoadPolygon,
  selectStationaryRoadSurfacePolygons,
  maxConsecutiveRingJump,
  ringWidthM,
  listChunkPassGroups,
  polylineLength,
  distPointToTrajectory,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.SegmentLocalMap = api;
}
