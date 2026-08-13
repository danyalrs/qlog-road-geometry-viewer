'use strict';

/**
 * Point-accumulated lane geometry for Local playback — raw-dot baseline.
 *
 * This mode displays every valid modelV2 lane point from its first observation
 * and accumulates causally as Local playback advances. It intentionally mirrors
 * the Raw mapped observations source set: confidence, repeated-frame support,
 * perpendicular distance, and lateral extent are NOT visibility gates. Only
 * structurally invalid data (non-finite coordinates / unusable geometry) is
 * excluded. Confidence and support are preserved as metadata (and may drive an
 * optional diagnostic colour/opacity only).
 *
 * No curves or connecting lines are produced. No cross-chunk/pass/side/lane
 * association is performed.
 *
 * Coordinates:
 * - Global ENU (east/north, metres) is the source frame of lane.points.
 * - Segment-local frame (east = forward along reference heading, north = left)
 *   is the stable frame used by Local playback (see globalToSegmentLocal).
 * - Road-relative (s = along-track route-s, d = signed lateral, both metres) is
 *   computed by projection onto the reference vehicle trajectory and is kept
 *   as metadata only.
 */

const POINT_ACCUMULATION_DEFAULTS = {
  // Display thinning along each observed lane polyline (metres). 0 = keep every
  // existing modelV2 point. Thinning only ever reduces density along one source
  // curve and never removes the first/last point.
  pointSpacingM: 0,
  // Road-relative lateral tolerance used only for support metadata (metres).
  associationLateralToleranceM: 1.0,
  // Road-relative longitudinal window used only for support metadata (metres).
  longitudinalWindowM: 4.0,
  // Heading tolerance used only for support metadata (degrees).
  maxHeadingDeltaDeg: 25,
  // Diagnostic threshold: a point with fewer distinct supporting frames is
  // flagged as single-observation. Does NOT hide the point.
  minSupportingObservations: 2,
  // Optional final-curve overlay. Disabled by default; never enabled here.
  finalCurveOverlay: false,
  // Optional near-exact spatial dedup grid (metres). 0 = no dedup (default).
  dedupSnapM: 0,
  // Reliability-input tuning (display-only).
  headingWindowSec: 4,
  stationarySpeedMps: 1.0,
};

function dist2d(a, b) {
  return Math.hypot((b.east ?? 0) - (a.east ?? 0), (b.north ?? 0) - (a.north ?? 0));
}

/** Lightweight reference trajectory from a global vehicle path. */
function buildReferenceTrajectory(vehiclePath) {
  const points = (vehiclePath || []).map((p) => ({
    east: p.east,
    north: p.north,
    logMonoTime: p.logMonoTime,
    frameId: p.frameId,
    sourceFile: p.sourceFile,
    headingDeg: p.headingDeg,
  }));

  const segments = [];
  let totalLength = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const len = dist2d(points[i], points[i + 1]);
    segments.push({
      index: i,
      a: points[i],
      b: points[i + 1],
      s0: totalLength,
      s1: totalLength + len,
      length: len,
    });
    totalLength += len;
  }

  return { points, segments, totalLength };
}

function projectOnSegment(a, b, p) {
  const de = b.east - a.east;
  const dn = b.north - a.north;
  const len2 = de * de + dn * dn;
  if (len2 < 1e-12) {
    return { t: 0, dist: dist2d(a, p), east: a.east, north: a.north };
  }
  let t = ((p.east - a.east) * de + (p.north - a.north) * dn) / len2;
  t = Math.max(0, Math.min(1, t));
  const pe = a.east + t * de;
  const pn = a.north + t * dn;
  return { t, dist: Math.hypot(p.east - pe, p.north - pn), east: pe, north: pn };
}

function signedLateral(a, b, p) {
  const de = b.east - a.east;
  const dn = b.north - a.north;
  const len = Math.hypot(de, dn) || 1;
  const nx = -dn / len;
  const ny = de / len;
  return (p.east - a.east) * nx + (p.north - a.north) * ny;
}

/** Project a global point onto the reference trajectory -> { s, d, perpDist }. */
function projectPoint(trajectory, east, north) {
  if (!trajectory?.segments?.length) {
    return { valid: false, reason: 'emptyTrajectory' };
  }
  let best = null;
  for (const seg of trajectory.segments) {
    const proj = projectOnSegment(seg.a, seg.b, { east, north });
    const s = seg.s0 + proj.t * seg.length;
    const d = signedLateral(seg.a, seg.b, { east, north });
    if (!best || proj.dist < best.perpDist) {
      best = { s, d, perpDist: proj.dist, segIndex: seg.index, east: proj.east, north: proj.north };
    }
  }
  return { valid: true, ...best };
}

/** Index of the side of the lane line from modelV2 lane index (D-001). */
function sideFromLaneIndex(laneIndex) {
  if (laneIndex == null) return null;
  // 0 = outer-right, 1 = inner-right ego, 2 = inner-left ego, 3 = outer-left.
  return laneIndex <= 1 ? 'right' : 'left';
}

/**
 * Select source point indices along an observed lane polyline.
 * pointSpacingM <= 0 keeps every existing modelV2 point. When thinning is
 * requested it only reduces density between already-sampled points; the first
 * and last points are always retained. No interpolation is performed.
 */
function samplePointIndicesAtSpacing(lane, referencePose, pointSpacingM) {
  const pts = lane?.points || [];
  if (!pts.length) return [];
  if (!(pointSpacingM > 0)) {
    return pts.map((_, i) => i);
  }
  const kept = [0];
  let lastLocal = localFromGlobal(pts[0].east, pts[0].north, referencePose);
  for (let i = 1; i < pts.length; i++) {
    const local = localFromGlobal(pts[i].east, pts[i].north, referencePose);
    if (dist2d(lastLocal, local) >= pointSpacingM) {
      kept.push(i);
      lastLocal = local;
    }
  }
  if (kept[kept.length - 1] !== pts.length - 1) kept.push(pts.length - 1);
  return kept;
}

/**
 * Accumulate every valid point observation from frames restricted to a
 * chunk/pass. Visibility gates are limited to structurally invalid data
 * (non-finite or unusable coordinates). Confidence, support, s/d, perpDist are
 * preserved as metadata and never hide a point.
 *
 * Each observation carries `frameIndex` (the index into the caller's frames
 * array, i.e. the timeline index) so playback can display observations 0..N
 * causally.
 */
function accumulatePointObservations({
  frames = [],
  timeline = [],
  referencePose = null,
  chunkId = 0,
  passId = 0,
  trajectory = null,
  options = {},
}) {
  const opts = { ...POINT_ACCUMULATION_DEFAULTS, ...options };
  // A zero-length reference trajectory (fully stationary vehicle locked to one
  // anchor) cannot provide along-track s: projecting against it collapses every
  // observation onto s=0,d=0, losing the lane geometry's forward/lateral
  // extent. Treat a degenerate trajectory as absent so s/d fall back to the
  // fixed-anchor forward/lateral frame (s = forward distance, d = lateral
  // offset).
  const traj = trajectory && trajectory.totalLength != null && trajectory.totalLength > 1e-6
    ? trajectory
    : null;
  const tlByTime = new Map();
  for (const tl of timeline || []) {
    if (tl?.logMonoTime != null) tlByTime.set(String(tl.logMonoTime), tl);
  }

  // Causal reliability-input context per eligible frame (turning state from
  // recent heading history; previous compatible frame for temporal agreement).
  const relCtx = buildFrameReliabilityContext(frames, chunkId, passId, opts);

  const observations = [];
  let invalidExcluded = 0;
  let frameIndex = 0;
  for (const frame of frames || []) {
    if (frame.chunkId != null && frame.chunkId !== chunkId) { frameIndex++; continue; }
    const fPass = frame.passId ?? frame.temporalPassId ?? 0;
    if (passId != null && fPass !== passId) { frameIndex++; continue; }
    const tlEntry = tlByTime.get(String(frame.logMonoTime));
    const movementState = tlEntry?.movementState ?? null;
    const ctx = relCtx.get(frameIndex) || null;

    for (const lane of frame.lanes || []) {
      if (!lane?.points?.length) continue;
      const side = sideFromLaneIndex(lane.laneIndex);
      const keptIndices = samplePointIndicesAtSpacing(lane, referencePose, opts.pointSpacingM);

      // Per-point temporal disagreement vs previous compatible observation.
      const prevLane = ctx?.prevLanes?.get(lane.laneIndex);
      const temporal = computeTemporalDisagreementForLane(
        frame, ctx?.prevFrame || null, lane, prevLane, ctx?.displacementM ?? null,
      );

      for (const i of keptIndices) {
        const pt = lane.points[i];
        if (!Number.isFinite(pt.east) || !Number.isFinite(pt.north)
          || !Number.isFinite(pt.modelX ?? pt.east) || !Number.isFinite(pt.modelY ?? pt.north)) {
          invalidExcluded++;
          continue;
        }
        const local = localFromGlobal(pt.east, pt.north, referencePose);
        if (!Number.isFinite(local.east) || !Number.isFinite(local.north)) {
          invalidExcluded++;
          continue;
        }
        // Mirrored road point (fixed, observation-time set): lateral sign
        // reversed in the vehicle-relative frame, then converted to the
        // segment-local map frame. Never depends on the playback frame.
        const mirroredLocal = (pt.mirroredEast != null && pt.mirroredNorth != null)
          ? localFromGlobal(pt.mirroredEast, pt.mirroredNorth, referencePose)
          : null;
        const proj = traj ? projectPoint(traj, pt.east, pt.north) : null;
        const tMatch = temporal[i] || {};
        const pose = frame.pose || {};
        observations.push({
          east: pt.east,
          north: pt.north,
          localEast: local.east,
          localNorth: local.north,
          mirroredLocalEast: mirroredLocal ? mirroredLocal.east : undefined,
          mirroredLocalNorth: mirroredLocal ? mirroredLocal.north : undefined,
          modelX: pt.modelX ?? null,
          modelY: pt.modelY ?? null,
          s: proj?.s ?? local.east,
          d: proj?.d ?? local.north,
          perpDist: proj?.perpDist ?? null,
          laneIndex: lane.laneIndex ?? null,
          laneTrackId: lane.laneTrackId ?? null,
          prob: lane.prob ?? 1,
          frameId: frame.frameId,
          logMonoTime: frame.logMonoTime,
          sourceFile: frame.sourceFile,
          segmentId: frame.sourceFile,
          chunkId,
          passId: fPass,
          side,
          movementState,
          frameIndex,
          // --- Experimental reliability inputs (display-only) ---
          reliabilityInputs: {
            prob: lane.prob ?? 1,
            modelX: pt.modelX ?? null,
            turnRateDegPerSec: ctx?.turnRateDegPerSec ?? null,
            headingDeg: ctx?.headingDeg ?? null,
            temporalDisagreementM: tMatch.disagreementM ?? null,
            hasTemporalAgreement: !!tMatch.matched,
            poseAccuracyM: Number.isFinite(pose.horizontalAccuracy) ? pose.horizontalAccuracy : null,
            headingSource: pose.headingSource ?? null,
          },
        });
      }
    }
    frameIndex++;
  }
  return { observations, invalidExcluded };
}

/**
 * Turning state from recent heading history (causal). Computes a yaw-rate-like
 * feature in deg/s from the current pose heading and the previous eligible
 * frame's heading within a time window. Null when the previous frame is too
 * old, when stationary, or when headings are missing/low-quality.
 *
 * @param {Array} frames full frame list
 * @param {number} index current frame index
 * @param {object} opts { headingWindowSec, stationarySpeedMps, maxHeadingSource }
 * @returns {{turnRateDegPerSec:number|null, headingDeg:number|null, dtSec:number|null}}
 */
function computeTurningContext(frames, index, opts = {}) {
  const frame = frames[index];
  if (!frame?.pose) return { turnRateDegPerSec: null, headingDeg: null, dtSec: null };
  const cur = frame.pose;
  const curHeading = Number.isFinite(cur.headingDeg) ? cur.headingDeg : null;
  const headingWindowSec = opts.headingWindowSec ?? 4;
  const stationarySpeedMps = opts.stationarySpeedMps ?? 1.0;

  // Find previous eligible frame (same chunk/pass, has pose) within window.
  let prevHeading = null;
  let dtSec = null;
  const curTime = BigInt(frame.logMonoTime);
  for (let j = index - 1; j >= 0; j--) {
    const pf = frames[j];
    if (!pf?.pose) continue;
    const dt = Number(curTime - BigInt(pf.logMonoTime)) / 1e9;
    if (dt > headingWindowSec) break;
    if (!Number.isFinite(pf.pose.headingDeg)) continue;
    prevHeading = pf.pose.headingDeg;
    dtSec = dt;
    break;
  }

  // Stationary handling: turning is undefined at standstill.
  const speed = cur.speed ?? 0;
  if (Number.isFinite(speed) && speed < stationarySpeedMps) {
    return { turnRateDegPerSec: null, headingDeg: curHeading, dtSec };
  }
  if (curHeading == null || prevHeading == null || dtSec == null || dtSec < 1e-3) {
    return { turnRateDegPerSec: null, headingDeg: curHeading, dtSec };
  }
  let delta = curHeading - prevHeading;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return { turnRateDegPerSec: delta / dtSec, headingDeg: curHeading, dtSec };
}

/**
 * Per-point temporal disagreement against the previous compatible observation
 * of the same predicted physical area. Compensates vehicle forward progress by
 * shifting the previous frame's modelX by the vehicle displacement ds. Only
 * earlier data is used; no future observations.
 *
 * @returns {Array<{modelX:number, disagreementM:number|null, matched:boolean}>}
 */
function computeTemporalDisagreementForLane(frame, prevFrame, lane, prevLane, ds) {
  if (!prevFrame?.pose || !prevLane?.points?.length || ds <= 0) {
    return (lane.points || []).map((p) => ({ modelX: p.modelX ?? 0, disagreementM: null, matched: false }));
  }
  const toleranceM = 10; // modelX matching window after progress compensation
  return (lane.points || []).map((p) => {
    const modelX = p.modelX ?? 0;
    if (!Number.isFinite(p.east) || !Number.isFinite(p.north)) {
      return { modelX, disagreementM: null, matched: false };
    }
    const targetX = modelX + ds;
    let best = null;
    let bestD = Infinity;
    for (const q of prevLane.points) {
      const d = Math.abs((q.modelX ?? 0) - targetX);
      if (d < bestD) { bestD = d; best = q; }
    }
    if (!best || bestD > toleranceM || !Number.isFinite(best.east) || !Number.isFinite(best.north)) {
      return { modelX, disagreementM: null, matched: false };
    }
    const disagreementM = Math.hypot(p.east - best.east, p.north - best.north);
    return { modelX, disagreementM, matched: true };
  });
}

/**
 * Build per-frame causal context needed for the reliability inputs: turning
 * state (from recent heading history) and the previous compatible frame per
 * lane. Indexed by full frame index.
 */
function buildFrameReliabilityContext(frames, chunkId, passId, opts = {}) {
  const ctx = new Map();
  const eligible = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.chunkId != null && f.chunkId !== chunkId) continue;
    const fp = f.passId ?? f.temporalPassId ?? 0;
    if (passId != null && fp !== passId) continue;
    if (!f.pose) continue;
    eligible.push({ i, f });
  }
  for (let k = 0; k < eligible.length; k++) {
    const { i, f } = eligible[k];
    const turn = computeTurningContext(frames, i, opts);
    // Previous eligible frame (causal) for temporal comparison.
    const prev = k > 0 ? eligible[k - 1] : null;
    let prevFrameByLane = new Map();
    let ds = null;
    if (prev) {
      ds = Math.hypot(f.pose.east - prev.f.pose.east, f.pose.north - prev.f.pose.north);
      prevFrameByLane = new Map((prev.f.lanes || []).map((l) => [l.laneIndex, l]));
    }
    ctx.set(i, {
      frameIndex: i,
      turnRateDegPerSec: turn.turnRateDegPerSec,
      headingDeg: turn.headingDeg,
      prevFrame: prev ? prev.f : null,
      prevLanes: prevFrameByLane,
      prevFrameIndex: prev ? prev.i : null,
      displacementM: ds,
    });
  }
  return ctx;
}

function headingDeltaDeg(a, b) {
  let d = Math.abs(a - b);
  if (d > 180) d = 360 - d;
  return d;
}

function headingOf(o) {
  if (o._headingDeg != null) return o._headingDeg;
  return null;
}

/**
 * Build the display point set from accumulated observations.
 *
 * Every valid observation becomes a displayed point. Support (distinct frames
 * within the diagnostic windows) and confidence are preserved as metadata and
 * drive diagnostics only. Grouping key preserves safety separation metadata:
 * chunk, pass, side, lane index. Optional near-exact spatial dedup (dedupSnapM
 * > 0) may reduce the displayed count and is reported in stats.
 */
function buildPointDisplay(observations, options = {}) {
  const opts = { ...POINT_ACCUMULATION_DEFAULTS, ...options };
  const groups = new Map();
  for (const o of observations) {
    const key = `${o.chunkId}:${o.passId}:${o.side}:${o.laneIndex ?? 'x'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  // Assign a stable per-group identity for colouring (boundary identity).
  const groupTrackId = new Map();
  let trackSeq = 0;
  for (const key of groups.keys()) {
    groupTrackId.set(key, trackSeq++);
  }

  const points = [];
  for (const o of observations) {
    const groupKey = `${o.chunkId}:${o.passId}:${o.side}:${o.laneIndex ?? 'x'}`;
    const members = groups.get(groupKey) || [];
    const supportFrames = new Set([o.frameId]);
    for (const other of members) {
      if (other.frameId === o.frameId) continue;
      const ds = Math.abs(o.s - other.s);
      const dd = Math.abs(o.d - other.d);
      if (ds > opts.longitudinalWindowM || dd > opts.associationLateralToleranceM) continue;
      const hi = headingOf(o);
      const hj = headingOf(other);
      if (hi != null && hj != null && headingDeltaDeg(hi, hj) > opts.maxHeadingDeltaDeg) continue;
      supportFrames.add(other.frameId);
    }
    points.push({
      ...o,
      groupKey,
      groupTrackId: groupTrackId.get(groupKey),
      supportFrameCount: supportFrames.size,
      singleObservation: supportFrames.size < opts.minSupportingObservations,
      lowConfidence: (o.prob ?? 1) < 0.5,
      accepted: true,
      isolated: false,
    });
  }

  let displayed = points;
  let dedupRemoved = 0;
  if (opts.dedupSnapM > 0) {
    const seen = new Map();
    const deduped = [];
    for (const p of points) {
      const key = `${p.groupKey}:${Math.round(p.s / opts.dedupSnapM)}:${Math.round(p.d / opts.dedupSnapM)}`;
      if (seen.has(key)) { dedupRemoved++; continue; }
      seen.set(key, true);
      deduped.push(p);
    }
    displayed = deduped;
  }

  const stats = {
    pointSpacingM: opts.pointSpacingM,
    dedupSnapM: opts.dedupSnapM,
    associationLateralToleranceM: opts.associationLateralToleranceM,
    longitudinalWindowM: opts.longitudinalWindowM,
    maxHeadingDeltaDeg: opts.maxHeadingDeltaDeg,
    minSupportingObservations: opts.minSupportingObservations,
    totalValidSourcePoints: observations.length,
    invalidExcluded: opts._invalidExcluded ?? 0,
    displayedPoints: displayed.length,
    dedupRemoved,
    lowConfidenceCount: points.filter((p) => p.lowConfidence).length,
    singleObservationCount: points.filter((p) => p.singleObservation).length,
    repeatedSupportCount: points.filter((p) => !p.singleObservation).length,
    boundaryCount: groups.size,
    associatedGroupCount: new Set(points.map((p) => p.groupTrackId)).size,
    curveOverlay: false,
    curveCount: 0,
    coverageParity:
      observations.length > 0 ? displayed.length / observations.length : 0,
  };

  return { points: displayed, rejected: [], stats, curves: [] };
}

/**
 * Local-frame transform injection point. Kept separate from the core module so
 * tests can provide their own, and segment_local_map supplies the real one.
 */
function localFromGlobal(east, north, referencePose) {
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

module.exports = {
  POINT_ACCUMULATION_DEFAULTS,
  dist2d,
  buildReferenceTrajectory,
  projectPoint,
  sideFromLaneIndex,
  samplePointIndicesAtSpacing,
  accumulatePointObservations,
  buildPointDisplay,
  computeTurningContext,
  computeTemporalDisagreementForLane,
  buildFrameReliabilityContext,
  headingDeltaDeg,
  localFromGlobal,
};
if (typeof window !== 'undefined') {
  window.PointAccumulation = module.exports;
}
