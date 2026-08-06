/** Circular bearing utilities and GPS interpolation. */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function normalizeDeg(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

function lerpAngleDeg(a, b, t) {
  a = normalizeDeg(a);
  b = normalizeDeg(b);
  let diff = b - a;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return normalizeDeg(a + diff * t);
}

function bearingFromDelta(east, north) {
  if (Math.hypot(east, north) < 1e-6) return null;
  return normalizeDeg(Math.atan2(east, north) * RAD2DEG);
}

function estimateBearingFromPositions(prev, curr) {
  if (!prev || !curr) return null;
  const de = curr.east - prev.east;
  const dn = curr.north - prev.north;
  return bearingFromDelta(de, dn);
}

function chooseHeading(gps, prev, next, options = {}) {
  const minSpeedForGpsBearing = options.minSpeedForGpsBearing ?? 2.0;
  const maxBearingAccuracy = options.maxBearingAccuracy ?? 45;

  const speed = gps.speed ?? 0;
  const bearingAcc = gps.bearingAccuracyDeg ?? 999;

  if (speed >= minSpeedForGpsBearing && Number.isFinite(gps.bearingDeg) && bearingAcc <= maxBearingAccuracy) {
    return { headingDeg: normalizeDeg(gps.bearingDeg), source: 'gps' };
  }

  const fromMotion = estimateBearingFromPositions(prev, next || gps);
  if (fromMotion !== null && speed > 0.5) {
    return { headingDeg: fromMotion, source: 'motion' };
  }

  if (Number.isFinite(gps.bearingDeg)) {
    return { headingDeg: normalizeDeg(gps.bearingDeg), source: 'gps_fallback' };
  }

  return { headingDeg: 0, source: 'default' };
}

function interpolateGpsAtTime(gpsRecords, logMonoTime, maxDeltaNs = 2e9) {
  const t = BigInt(logMonoTime);
  if (!gpsRecords.length) return null;

  if (t <= BigInt(gpsRecords[0].logMonoTime)) {
    const dt = Number(gpsRecords[0].logMonoTime) - Number(t);
    if (Math.abs(dt) > maxDeltaNs) return null;
    return { ...gpsRecords[0], interpolated: false };
  }

  const last = gpsRecords[gpsRecords.length - 1];
  if (t >= BigInt(last.logMonoTime)) {
    const dt = Number(t) - Number(last.logMonoTime);
    if (dt > maxDeltaNs) return null;
    return { ...last, interpolated: false };
  }

  let lo = 0;
  let hi = gpsRecords.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (BigInt(gpsRecords[mid].logMonoTime) <= t) lo = mid;
    else hi = mid;
  }

  const a = gpsRecords[lo];
  const b = gpsRecords[hi];
  const t0 = Number(a.logMonoTime);
  const t1 = Number(b.logMonoTime);
  if (t1 === t0) return { ...a, interpolated: false };

  const frac = (Number(t) - t0) / (t1 - t0);
  const east = a.east + (b.east - a.east) * frac;
  const north = a.north + (b.north - a.north) * frac;
  const speed = a.speed + (b.speed - a.speed) * frac;
  const heading = lerpAngleDeg(a.headingDeg ?? 0, b.headingDeg ?? 0, frac);

  return {
    logMonoTime: logMonoTime.toString(),
    east,
    north,
    latitude: a.latitude + (b.latitude - a.latitude) * frac,
    longitude: a.longitude + (b.longitude - a.longitude) * frac,
    speed,
    headingDeg: heading,
    horizontalAccuracy: Math.max(a.horizontalAccuracy || 0, b.horizontalAccuracy || 0),
    headingSource: 'interpolated',
    interpolated: true,
    sourceFile: frac < 0.5 ? a.sourceFile : b.sourceFile,
  };
}

function enrichGpsHeadings(gpsRecords, options = {}) {
  const out = [];
  for (let i = 0; i < gpsRecords.length; i++) {
    const g = { ...gpsRecords[i] };
    const prev = out[i - 1] || null;
    const next = gpsRecords[i + 1] || null;
    const { headingDeg, source } = chooseHeading(g, prev, next, options);
    g.headingDeg = headingDeg;
    g.headingSource = source;
    out.push(g);
  }
  return out;
}

module.exports = {
  normalizeDeg,
  lerpAngleDeg,
  bearingFromDelta,
  estimateBearingFromPositions,
  chooseHeading,
  interpolateGpsAtTime,
  enrichGpsHeadings,
};
