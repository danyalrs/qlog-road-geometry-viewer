/** Route chunk detection — never fuse across chunk boundaries. */

const { normalizeDeg } = require('./alignment');

function dist2d(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot((b.east ?? 0) - (a.east ?? 0), (b.north ?? 0) - (a.north ?? 0));
}

function timeGapSec(a, b) {
  return Math.abs(Number(BigInt(b.logMonoTime) - BigInt(a.logMonoTime))) / 1e9;
}

function impliedSpeedMps(prev, curr) {
  const dt = timeGapSec(prev, curr);
  if (dt < 1e-6) return Infinity;
  return dist2d(prev.pose || prev, curr.pose || curr) / dt;
}

function bearingDelta(a, b) {
  const ba = normalizeDeg(a ?? 0);
  const bb = normalizeDeg(b ?? 0);
  let d = Math.abs(bb - ba);
  if (d > 180) d = 360 - d;
  return d;
}

function shouldStartNewChunk(prev, curr, options = {}) {
  if (!prev) return false;

  const maxTimeGapSec = options.maxTimeGapSec ?? 3;
  const maxGpsGapM = options.maxGpsGapM ?? 30;
  const maxImpliedSpeedMps = options.maxImpliedSpeedMps ?? 55;
  const maxBearingJumpLowSpeed = options.maxBearingJumpLowSpeed ?? 90;
  const lowSpeedThreshold = options.lowSpeedThreshold ?? 2;

  if (BigInt(curr.logMonoTime) < BigInt(prev.logMonoTime)) return { reason: 'backwardTime' };

  const tg = timeGapSec(prev, curr);
  if (tg > maxTimeGapSec) return { reason: 'timeGap', value: tg };

  const dg = dist2d(prev.pose, curr.pose);
  const speed = impliedSpeedMps(prev, curr);
  const expectedMaxDist = tg * maxImpliedSpeedMps;

  if (dg > maxGpsGapM && (tg < 1 || speed > maxImpliedSpeedMps * 0.85)) {
    return { reason: 'gpsGap', value: dg };
  }
  if (dg > Math.max(maxGpsGapM, expectedMaxDist * 1.25)) {
    return { reason: 'gpsGap', value: dg };
  }
  if (speed > maxImpliedSpeedMps) return { reason: 'implausibleSpeed', value: speed };

  const avgSpeed = ((prev.pose?.speed ?? 0) + (curr.pose?.speed ?? 0)) / 2;
  const bd = bearingDelta(prev.pose?.headingDeg, curr.pose?.headingDeg);
  const maxBearingDisplacement = options.maxBearingDisplacementM ?? 5;
  if (avgSpeed < lowSpeedThreshold && dg < maxBearingDisplacement && dg > 0.5 && bd > maxBearingJumpLowSpeed) {
    return { reason: 'bearingJumpLowSpeed', value: bd };
  }

  return null;
}

function chunkFrames(frames, options = {}) {
  const chunks = [];
  let current = [];
  let chunkId = 0;
  let sessionId = 0;

  for (let i = 0; i < frames.length; i++) {
    const frame = { ...frames[i] };
    const prev = current[current.length - 1];
    const split = shouldStartNewChunk(prev, frame, options);

    if (split && current.length) {
      chunks.push(buildChunk(chunkId++, sessionId, current));
      current = [];
      if (split.reason === 'backwardTime' || split.reason === 'timeGap' || split.reason === 'gpsGap' || split.reason === 'implausibleSpeed') {
        sessionId++;
      }
    } else if (split?.reason === 'backwardTime' && !current.length && i > 0) {
      sessionId++;
    }

    frame.chunkId = chunkId;
    frame.sessionId = sessionId;
    current.push(frame);
  }

  if (current.length) chunks.push(buildChunk(chunkId, sessionId, current));
  return chunks;
}

function buildChunk(chunkId, sessionId, frames) {
  const files = [...new Set(frames.map((f) => f.sourceFile))];
  const t0 = frames[0].logMonoTime;
  const t1 = frames[frames.length - 1].logMonoTime;
  return {
    chunkId,
    sessionId,
    files,
    frames,
    startLogMonoTime: t0,
    endLogMonoTime: t1,
    durationSec: Math.abs(Number(BigInt(t1) - BigInt(t0))) / 1e9,
  };
}

function chunkGpsTrajectory(gpsPoints, options = {}) {
  const chunks = [];
  let current = [];
  let chunkId = 0;

  for (let i = 0; i < gpsPoints.length; i++) {
    const pt = { ...gpsPoints[i] };
    const prev = current[current.length - 1];
    let split = false;

    if (prev) {
      if (prev.sourceFile !== pt.sourceFile) split = true;
      else if (BigInt(pt.logMonoTime) < BigInt(prev.logMonoTime)) split = true;
      else if (timeGapSec(prev, pt) > (options.maxTimeGapSec ?? 3)) split = true;
      else if (dist2d(prev, pt) > (options.maxGpsGapM ?? 30)) split = true;
    }

    if (split && current.length) {
      chunks.push({ chunkId: chunkId++, points: current });
      current = [];
    }
    pt.chunkId = chunkId;
    current.push(pt);
  }

  if (current.length) chunks.push({ chunkId, points: current });
  return chunks;
}

function maxInternalGpsGap(points) {
  let max = 0;
  for (let i = 1; i < points.length; i++) {
    max = Math.max(max, dist2d(points[i - 1], points[i]));
  }
  return max;
}

function trajectoryLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += dist2d(points[i - 1], points[i]);
  return d;
}

module.exports = {
  shouldStartNewChunk,
  chunkFrames,
  chunkGpsTrajectory,
  dist2d,
  timeGapSec,
  maxInternalGpsGap,
  trajectoryLength,
};
