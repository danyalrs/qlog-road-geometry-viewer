/** Smoothed vehicle reference trajectory and s/d projection. */

const { dist2d } = require('./chunking');

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

function sToMap(trajectory, s, d) {
  if (!trajectory?.segments?.length) return null;
  for (const seg of trajectory.segments) {
    if (s >= seg.s0 - 1e-6 && s <= seg.s1 + 1e-6) {
      const t = seg.length > 1e-9 ? (s - seg.s0) / seg.length : 0;
      const de = seg.b.east - seg.a.east;
      const dn = seg.b.north - seg.a.north;
      const len = Math.hypot(de, dn) || 1;
      const nx = -dn / len;
      const ny = de / len;
      const baseE = seg.a.east + t * de;
      const baseN = seg.a.north + t * dn;
      return { east: baseE + d * nx, north: baseN + d * ny };
    }
  }
  const last = trajectory.segments[trajectory.segments.length - 1];
  return { east: last.b.east, north: last.b.north };
}

function vehicleSAtTime(trajectory, logMonoTime) {
  if (!trajectory?.points?.length) return 0;
  const target = BigInt(logMonoTime);
  let best = trajectory.points[0];
  let bestDt = absBigInt(BigInt(best.logMonoTime) - target);
  for (const p of trajectory.points) {
    const dt = absBigInt(BigInt(p.logMonoTime) - target);
    if (dt < bestDt) { bestDt = dt; best = p; }
  }
  const proj = projectPoint(trajectory, best.east, best.north);
  return proj.valid ? proj.s : 0;
}

function absBigInt(v) { return v < 0n ? -v : v; }

module.exports = {
  buildReferenceTrajectory,
  projectPoint,
  projectOnSegment,
  signedLateral,
  sToMap,
  vehicleSAtTime,
};
