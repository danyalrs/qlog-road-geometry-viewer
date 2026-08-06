/**
 * Temporal projection — project onto trajectory segments near observation time only.
 */

const { dist2d } = require('./chunking');
const { projectOnSegment, signedLateral, buildReferenceTrajectory } = require('./trajectory');

function absBigInt(v) { return v < 0n ? -v : v; }

function findNearestPathIndex(trajectory, logMonoTime) {
  if (!trajectory?.points?.length) return 0;
  const target = BigInt(logMonoTime);
  let bestIdx = 0;
  let bestDt = absBigInt(BigInt(trajectory.points[0].logMonoTime) - target);
  for (let i = 0; i < trajectory.points.length; i++) {
    const dt = absBigInt(BigInt(trajectory.points[i].logMonoTime) - target);
    if (dt < bestDt) { bestDt = dt; bestIdx = i; }
  }
  return bestIdx;
}

function projectPointTemporal(trajectory, east, north, logMonoTime, options = {}) {
  if (!trajectory?.segments?.length) {
    return { valid: false, reason: 'emptyTrajectory' };
  }

  const temporalWindow = options.temporalWindowSegments ?? 4;
  const maxTimeDeltaNs = options.maxProjectionTimeDeltaNs ?? 4e9;
  const centerIdx = findNearestPathIndex(trajectory, logMonoTime);
  const obsTime = BigInt(logMonoTime);

  const segStart = Math.max(0, centerIdx - temporalWindow);
  const segEnd = Math.min(trajectory.segments.length - 1, centerIdx + temporalWindow - 1);

  let best = null;
  let ambiguous = false;
  const candidates = [];

  for (let si = segStart; si <= segEnd; si++) {
    const seg = trajectory.segments[si];
    const proj = projectOnSegment(seg.a, seg.b, { east, north });
    const s = seg.s0 + proj.t * seg.length;
    const d = signedLateral(seg.a, seg.b, { east, north });
    const midTime = BigInt(seg.a.logMonoTime) + (BigInt(seg.b.logMonoTime) - BigInt(seg.a.logMonoTime)) / 2n;
    const timeDeltaNs = Number(absBigInt(obsTime - midTime));
    candidates.push({ s, d, perpDist: proj.dist, segIndex: si, timeDeltaNs });

    if (timeDeltaNs > maxTimeDeltaNs) continue;
    if (!best || proj.dist < best.perpDist) {
      if (best && Math.abs(proj.dist - best.perpDist) < 1.0 && Math.abs(s - best.s) > 10) {
        ambiguous = true;
      }
      best = { s, d, perpDist: proj.dist, segIndex: si, timeDeltaNs };
    }
  }

  if (!best) {
    return { valid: false, reason: 'outsideTemporalWindow', candidates: candidates.length };
  }

  return {
    valid: true,
    ...best,
    ambiguous,
    projectionMethod: 'temporal',
  };
}

function projectPointGlobal(trajectory, east, north) {
  if (!trajectory?.segments?.length) return { valid: false, reason: 'emptyTrajectory' };
  let best = null;
  for (const seg of trajectory.segments) {
    const proj = projectOnSegment(seg.a, seg.b, { east, north });
    const s = seg.s0 + proj.t * seg.length;
    const d = signedLateral(seg.a, seg.b, { east, north });
    if (!best || proj.dist < best.perpDist) {
      best = { s, d, perpDist: proj.dist, segIndex: seg.index };
    }
  }
  return { valid: true, ...best, projectionMethod: 'global' };
}

function compareProjectionMethods(trajectory, observations, options = {}) {
  let changed = 0;
  const diffs = [];
  for (const obs of observations) {
    const global = projectPointGlobal(trajectory, obs.east, obs.north);
    const temporal = projectPointTemporal(trajectory, obs.east, obs.north, obs.logMonoTime, options);
    if (!global.valid || !temporal.valid) continue;
    const ds = Math.abs(global.s - temporal.s);
    if (ds > 5) {
      changed++;
      diffs.push({ frameId: obs.frameId, globalS: global.s, temporalS: temporal.s, deltaS: ds, ambiguous: temporal.ambiguous });
    }
  }
  return { changedCount: changed, total: observations.length, diffs };
}

function vehicleSAtTimeTemporal(trajectory, logMonoTime) {
  const idx = findNearestPathIndex(trajectory, logMonoTime);
  if (!trajectory.points[idx]) return 0;
  const p = trajectory.points[idx];
  const proj = projectPointTemporal(trajectory, p.east, p.north, logMonoTime, {});
  return proj.valid ? proj.s : 0;
}

module.exports = {
  projectPointTemporal,
  projectPointGlobal,
  compareProjectionMethods,
  findNearestPathIndex,
  vehicleSAtTimeTemporal,
};
