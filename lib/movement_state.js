/**
 * Movement state classification from timestamped displacement and speed.
 * States: moving | stationary | creeping | uncertain
 */
const { dist2d, timeGapSec } = require('./chunking');

const DEFAULT_MOVEMENT_CONFIG = {
  stationaryMaxSpeedMps: 2.0,
  creepingMaxSpeedMps: 4.0,
  stationaryMaxStepM: 0.8,
  movingMinStepM: 0.3,
  stationaryMinConsecutive: 3,
  movingMinConsecutive: 2,
  uncertainHoldConsecutive: 2,
};

function classifyInstantState(speed, step, dt, cfg) {
  const implied = dt > 0 ? step / dt : 0;
  const effSpeed = Math.max(speed ?? 0, implied);

  if (effSpeed <= cfg.stationaryMaxSpeedMps && step <= cfg.stationaryMaxStepM) {
    return 'stationary';
  }
  if (effSpeed <= cfg.creepingMaxSpeedMps && step < cfg.movingMinStepM * 2) {
    return 'creeping';
  }
  if (effSpeed > cfg.stationaryMaxSpeedMps && step >= cfg.movingMinStepM) {
    return 'moving';
  }
  return 'uncertain';
}

/**
 * Classify movement state along a pose sequence with hysteresis.
 * @param {Array<{east,north,speed?,logMonoTime,headingDeg?}>} points
 */
function classifyMovementStates(points, options = {}) {
  const cfg = { ...DEFAULT_MOVEMENT_CONFIG, ...options };
  if (!points?.length) return { states: [], summary: {} };

  const raw = [];
  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      raw.push({ index: i, instant: 'uncertain', state: 'uncertain', step: 0, speed: points[i].speed ?? 0 });
      continue;
    }
    const prev = points[i - 1];
    const cur = points[i];
    const step = dist2d(prev, cur);
    const dt = Math.max(timeGapSec(prev, cur), 0.001);
    const instant = classifyInstantState(cur.speed ?? prev.speed, step, dt, cfg);
    raw.push({ index: i, instant, state: instant, step, speed: cur.speed ?? 0, dt, impliedSpeed: step / dt });
  }

  // Forward hysteresis: require N consecutive instants to change state
  let current = 'uncertain';
  let pending = null;
  let pendingCount = 0;

  for (let i = 1; i < raw.length; i++) {
    const instant = raw[i].instant;
    if (instant === current) {
      pending = null;
      pendingCount = 0;
      raw[i].state = current;
      continue;
    }
    if (instant === pending) {
      pendingCount++;
    } else {
      pending = instant;
      pendingCount = 1;
    }
    const need = instant === 'moving' ? cfg.movingMinConsecutive
      : instant === 'stationary' ? cfg.stationaryMinConsecutive
        : cfg.uncertainHoldConsecutive;
    if (pendingCount >= need) {
      current = instant;
      pending = null;
      pendingCount = 0;
    }
    raw[i].state = current;
  }

  const counts = { moving: 0, stationary: 0, creeping: 0, uncertain: 0 };
  for (const r of raw) counts[r.state] = (counts[r.state] || 0) + 1;

  return {
    states: raw,
    config: cfg,
    summary: counts,
  };
}

function annotatePathWithMovement(points, options = {}) {
  const { states, config, summary } = classifyMovementStates(points, options);
  return points.map((pt, i) => ({
    ...pt,
    movementState: states[i]?.state ?? 'uncertain',
    movementStepM: states[i]?.step ?? 0,
    movementImpliedSpeedMps: states[i]?.impliedSpeed ?? 0,
  }));
}

function isStationaryState(state) {
  return state === 'stationary' || state === 'uncertain';
}

function allowsReversalSplit(point, prevPoint, options = {}) {
  const cfg = { ...DEFAULT_MOVEMENT_CONFIG, ...options };
  if (!prevPoint) return false;
  const state = point.movementState ?? 'uncertain';
  if (state === 'stationary') return false;
  if (state === 'uncertain' && (point.speed ?? 0) < cfg.stationaryMaxSpeedMps) return false;
  const step = dist2d(prevPoint, point);
  const minDisp = options.minDisplacementForReversalM ?? 5.0;
  return step >= minDisp && state === 'moving';
}

module.exports = {
  DEFAULT_MOVEMENT_CONFIG,
  classifyMovementStates,
  annotatePathWithMovement,
  isStationaryState,
  allowsReversalSplit,
};
