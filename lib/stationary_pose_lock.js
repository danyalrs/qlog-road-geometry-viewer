/**
 * Stationary pose locking for the lane-mapping pipeline.
 *
 * When the physical vehicle is stationary, per-frame GPS position and bearing
 * noise are interpreted as real movement, causing the mapping pose used to
 * transform lane observations to drift, rotate or fold. This module computes a
 * movement-state machine with time-based dwell and freezes the MAPPING pose at
 * a stable anchor while stationary, so lane observations accumulate in one
 * common vehicle/map frame.
 *
 * Design:
 *  - States: MOVING, CANDIDATE_STOP, STATIONARY, CANDIDATE_MOVE.
 *  - Primary motion signal: reported GPS speed (reliable at low speed).
 *    Displacement is only a weak secondary; it is never used to imply a large
 *    speed from a short time delta (GPS position noise).
 *  - Entering STATIONARY requires speed below a stop threshold for a time-based
 *    dwell. Leaving requires speed above a (higher) move threshold for a
 *    time-based dwell. One spike cannot release the lock; one low sample
 *    cannot freeze a moving vehicle.
 *  - While STATIONARY the mapping east/north/heading are frozen at an anchor
 *    selected from the stop transition; raw GPS stays available for diagnostics.
 *  - On movement resumption, the mapping pose is reconciled to the anchor
 *    without translating or rotating previously accumulated geometry.
 *
 * This module only produces the corrected MAPPING pose; it does not modify raw
 * telemetry, lane detections, identities or joining decisions.
 */

const { dist2d, timeGapSec } = require('./chunking');
const { normalizeDeg, lerpAngleDeg } = require('./alignment');

const DEFAULT_STATIONARY_LOCK_CONFIG = {
  // Reported-speed thresholds (m/s). Stationary GPS speeds across the dataset
  // cluster below ~1.0 m/s; genuine driving is ~11.5 m/s median. Hysteresis:
  // stop threshold must be lower than the move threshold.
  stopSpeedMps: 1.0,
  moveSpeedMps: 2.0,
  // Time-based dwell (seconds).
  stopDwellSec: 3.0,
  moveDwellSec: 3.0,
  // Weak secondary displacement signal: used only when reported speed is
  // missing, and never to imply speed from a tiny time delta.
  maxDisplacementMps: 0.5,
  // Anchor selection: median over the last N poses at stop transition.
  anchorWindowFrames: 5,
  // Maximum distance (m) a "moving" pose may be from the anchor before the
  // movement resumption is treated as a genuine departure (avoid jump).
  maxResumeGapM: 8.0,
  // When reported speed is absent, fall back to displacement-based implied
  // speed ONLY if the time delta is large enough to be reliable.
  minReliableDtSec: 1.0,
};

// --- helpers ---------------------------------------------------------------

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function bearingDelta(a, b) {
  const ba = normalizeDeg(a ?? 0);
  const bb = normalizeDeg(b ?? 0);
  let d = Math.abs(bb - ba);
  if (d > 180) d = 360 - d;
  return d;
}

/** Reliable motion evidence for one sample. Returns speed estimate + source. */
function sampleSpeed(cur, prev, cfg) {
  if (cur.speed != null && Number.isFinite(cur.speed)) {
    return { speed: Math.max(0, cur.speed), source: 'gps' };
  }
  // fallback: displacement-based, only when dt is reliable (not jitter)
  if (prev && cur.east != null && prev.east != null) {
    const dt = Math.max(timeGapSec(prev, cur), 0);
    const step = dist2d(prev, cur);
    if (dt >= cfg.minReliableDtSec) {
      return { speed: step / dt, source: 'displacement' };
    }
  }
  return { speed: null, source: 'none' };
}

// --- main -------------------------------------------------------------------

/**
 * Compute a per-frame stationary-pose lock over the pose sequence.
 * @param {Array<{east,north,speed?,headingDeg?,logMonoTime}>} poses
 * @param {object} options
 * @returns {{ frames: Array<{mappingPose, stationaryLocked, movementState,
 *          stateDurationSec, anchor, rawPose}>, config, summary }}
 */
/**
 * Two-pass stationary pose lock.
 *
 * PASS 1 — classify each frame's movement state (MOVING / CANDIDATE_STOP /
 * STATIONARY / CANDIDATE_MOVE) with time-based dwell on continuous low/high
 * speed evidence. This only LABELS states; no poses are committed here.
 *
 * PASS 2 — for every confirmed STATIONARY interval, determine the EFFECTIVE
 * STOP ONSET (the first frame of the validated CANDIDATE_STOP run, or the
 * last trustworthy moving frame), select a robust anchor from the last
 * reliable moving poses (excluding post-stop GPS drift), and apply that anchor
 * to EVERY frame from effectiveStopTime through the end of the interval.
 * Poses produced during CANDIDATE_STOP are therefore corrected retrospectively
 * rather than left committed at their drifting raw values.
 *
 * This makes the offline mapping pose sequence final before any geometry is
 * transformed, so lane/road observations in the confirmation window share the
 * confirmed stationary anchor.
 */
function computeStationaryPoseLock(poses, options = {}) {
  const cfg = { ...DEFAULT_STATIONARY_LOCK_CONFIG, ...options };
  const summary = { stateCounts: {}, transitions: 0, anchorSamples: 0, lockedSamples: 0, effectiveStops: 0 };

  // ---- PASS 1: classify states (forward, time-based dwell) ----------------
  const states = new Array(poses.length);
  let state = poses.length ? 'MOVING' : 'STATIONARY';
  let lowSpeedSince = null;
  let highSpeedSince = null;
  let t0 = poses.length ? Number(BigInt(poses[0].logMonoTime)) / 1e9 : 0;

  const recordState = (s) => {
    if (state !== s) summary.transitions++;
    state = s;
    summary.stateCounts[s] = (summary.stateCounts[s] || 0) + 1;
  };

  for (let i = 0; i < poses.length; i++) {
    const cur = poses[i];
    const prev = i > 0 ? poses[i - 1] : null;
    const t = Number(BigInt(cur.logMonoTime)) / 1e9;
    const { speed, source } = sampleSpeed(cur, prev, cfg);
    const step = prev && cur.east != null && prev.east != null ? dist2d(prev, cur) : 0;
    const belowStop = speed != null ? speed <= cfg.stopSpeedMps : step <= cfg.maxDisplacementMps;
    const aboveMove = speed != null ? speed >= cfg.moveSpeedMps : step > cfg.maxDisplacementMps * 4;
    if (i === 0) recordState(state);

    const lowSec = lowSpeedSince != null ? t - Number(BigInt(lowSpeedSince)) / 1e9 : 0;
    const highSec = highSpeedSince != null ? t - Number(BigInt(highSpeedSince)) / 1e9 : 0;
    if (belowStop) {
      if (highSpeedSince != null) highSpeedSince = null;
      if (lowSpeedSince == null) lowSpeedSince = cur.logMonoTime;
    } else if (aboveMove) {
      if (lowSpeedSince != null) lowSpeedSince = null;
      if (highSpeedSince == null) highSpeedSince = cur.logMonoTime;
    } else {
      lowSpeedSince = null;
      highSpeedSince = null;
    }

    if (state === 'MOVING') {
      if (belowStop && lowSec >= cfg.stopDwellSec) recordState('STATIONARY');
      else if (!belowStop) recordState('MOVING');
      else recordState('CANDIDATE_STOP');
    } else if (state === 'CANDIDATE_STOP') {
      if (aboveMove) recordState('MOVING');
      else if (lowSec >= cfg.stopDwellSec) recordState('STATIONARY');
      else recordState('CANDIDATE_STOP');
    } else if (state === 'STATIONARY') {
      if (aboveMove && highSec >= cfg.moveDwellSec) recordState('MOVING');
      else if (aboveMove) recordState('CANDIDATE_MOVE');
      else recordState('STATIONARY');
    } else if (state === 'CANDIDATE_MOVE') {
      if (aboveMove && highSec >= cfg.moveDwellSec) recordState('MOVING');
      else if (!aboveMove) recordState('STATIONARY');
      else recordState('CANDIDATE_MOVE');
    }
    states[i] = state;
  }

  // ---- PASS 2: apply confirmed anchors from effective stop onset ----------
  // Precompute the pose for every frame. For each STATIONARY interval, the
  // anchor applies from effectiveStopTime (start of the preceding CANDIDATE_STOP
  // run, or the interval start if the segment begins stationary) through the
  // end of the interval. All other frames use the raw pose.
  const frames = [];
  const intervals = []; // {start, end, effStart, anchor}
  {
    let i = 0;
    while (i < poses.length) {
      if (states[i] !== 'STATIONARY') { i++; continue; }
      const start = i;
      let end = start;
      while (end + 1 < poses.length && states[end + 1] === 'STATIONARY') end++;
      let effStart = start;
      while (effStart > 0 && states[effStart - 1] === 'CANDIDATE_STOP') effStart--;
      // anchor: last reliable moving pose strictly BEFORE effStart. Prefer the
      // single last pose with reported speed >= stop threshold (trustworthy
      // translation closest to the physical stop), so post-stop GPS drift cannot
      // centre the anchor and there is no backward jump from the last moving
      // pose. Fall back to the median of the last few such poses, then a short
      // raw window for initially-stationary segments.
      let anchorSrc = [];
      for (let k = effStart - 1; k >= Math.max(0, effStart - cfg.anchorWindowFrames); k--) {
        if (poses[k].east == null || poses[k].north == null) continue;
        anchorSrc.unshift(poses[k]);
      }
      const moving = anchorSrc.filter((p) => (p.speed ?? 0) >= cfg.stopSpeedMps);
      if (moving.length) {
        anchorSrc = [moving[moving.length - 1]]; // last trustworthy moving pose
      } else if (!anchorSrc.length) {
        for (let k = start; k <= Math.min(end, start + cfg.anchorWindowFrames); k++) {
          if (poses[k].east == null || poses[k].north == null) continue;
          anchorSrc.push(poses[k]);
        }
      }
      let anchor;
      if (anchorSrc.length) {
        let h = null;
        for (let k = anchorSrc.length - 1; k >= 0; k--) {
          if (anchorSrc[k].headingDeg != null && (anchorSrc[k].speed ?? 0) > cfg.stopSpeedMps) { h = anchorSrc[k].headingDeg; break; }
        }
        if (h == null) h = anchorSrc[anchorSrc.length - 1].headingDeg ?? 0;
        anchor = { east: median(anchorSrc.map((p) => p.east)), north: median(anchorSrc.map((p) => p.north)), headingDeg: normalizeDeg(h), ts: poses[effStart].logMonoTime, source: 'effectiveStop' };
        summary.anchorSamples += anchorSrc.length;
      } else {
        anchor = { east: poses[start].east, north: poses[start].north, headingDeg: normalizeDeg(poses[start].headingDeg ?? 0), ts: poses[start].logMonoTime, source: 'firstUsable' };
        summary.anchorSamples += 1;
      }
      summary.effectiveStops++;
      intervals.push({ start, end, effStart, anchor });
      i = end + 1;
    }
  }

  // emit every frame in order, applying the anchor where the frame lies inside
  // [effStart .. end] of a confirmed stationary interval
  for (let i = 0; i < poses.length; i++) {
    const cur = poses[i];
    const { speed, source } = sampleSpeed(cur, i > 0 ? poses[i - 1] : null, cfg);
    const inInterval = intervals.find((iv) => i >= iv.effStart && i <= iv.end);
    if (inInterval) {
      const a = inInterval.anchor;
      frames.push({
        logMonoTime: cur.logMonoTime,
        movementState: 'STATIONARY',
        stationaryLocked: true,
        anchor: { east: +a.east.toFixed(4), north: +a.north.toFixed(4), headingDeg: +a.headingDeg.toFixed(2) },
        mappingPose: { east: a.east, north: a.north, headingDeg: a.headingDeg, stationaryLocked: true },
        rawPose: { east: cur.east, north: cur.north, headingDeg: cur.headingDeg ?? 0, speed, speedSource: source },
      });
      summary.lockedSamples++;
    } else {
      frames.push({
        logMonoTime: cur.logMonoTime,
        movementState: states[i],
        stationaryLocked: false,
        anchor: null,
        mappingPose: { east: cur.east, north: cur.north, headingDeg: normalizeDeg(cur.headingDeg ?? 0), stationaryLocked: false },
        rawPose: { east: cur.east, north: cur.north, headingDeg: cur.headingDeg ?? 0, speed, speedSource: source },
      });
    }
  }

  return { frames, config: cfg, summary };
}

module.exports = {
  DEFAULT_STATIONARY_LOCK_CONFIG,
  computeStationaryPoseLock,
};
