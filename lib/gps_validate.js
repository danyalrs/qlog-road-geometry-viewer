/** GPS validation and rejection tracking. */

const GPS_FLAGS_HAS_LAT_LON = 1;

function createRejectionStats() {
  return {
    invalidNumber: 0,
    latOutOfRange: 0,
    lonOutOfRange: 0,
    nearZero: 0,
    noFix: 0,
    accuracyTooHigh: 0,
    positionJump: 0,
    missingTimestamp: 0,
    total: 0,
  };
}

function isValidNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function validateGpsRecord(record, options = {}, prev = null, stats = null) {
  const {
    maxAccuracyM = 50,
    maxJumpM = 200,
    nearZeroThreshold = 0.0001,
  } = options;

  const lat = record.latitude;
  const lon = record.longitude;

  function reject(reason) {
    if (stats) stats[reason] = (stats[reason] || 0) + 1;
    if (stats) stats.total++;
    return false;
  }

  if (!isValidNumber(lat) || !isValidNumber(lon)) return reject('invalidNumber');
  if (lat < -90 || lat > 90) return reject('latOutOfRange');
  if (lon < -180 || lon > 180) return reject('lonOutOfRange');
  if (Math.abs(lat) < nearZeroThreshold && Math.abs(lon) < nearZeroThreshold) return reject('nearZero');

  const flags = record.flags || 0;
  if ((flags & GPS_FLAGS_HAS_LAT_LON) === 0 && flags === 0) return reject('noFix');

  const acc = record.horizontalAccuracy;
  if (isValidNumber(acc) && acc > 0 && acc > maxAccuracyM) return reject('accuracyTooHigh');

  if (!record.logMonoTime) return reject('missingTimestamp');

  if (prev && isValidNumber(prev.east) && isValidNumber(prev.north)) {
    const de = record.east - prev.east;
    const dn = record.north - prev.north;
    const dist = Math.hypot(de, dn);
    if (dist > maxJumpM) return reject('positionJump');
  }

  if (stats) stats.total++;
  return true;
}

function gpsStructToRecord(ev, gps, source, sourceFile, sourceEventIndex) {
  let vned = [];
  try {
    if (gps.hasVNED && gps.hasVNED()) {
      const list = gps.getVNED();
      if (list) vned = [...list];
    }
  } catch (_) { /* optional field */ }
  return {
    logMonoTime: ev.getLogMonoTime().toString(),
    source,
    sourceFile,
    sourceEventIndex,
    flags: gps.getFlags(),
    latitude: gps.getLatitude(),
    longitude: gps.getLongitude(),
    altitude: gps.getAltitude(),
    speed: gps.getSpeed(),
    bearingDeg: gps.getBearingDeg(),
    horizontalAccuracy: gps.getAccuracy(),
    unixTimestampMillis: gps.getTimestamp().toString(),
    verticalAccuracy: gps.getVerticalAccuracy(),
    bearingAccuracyDeg: gps.getBearingAccuracyDeg(),
    speedAccuracy: gps.getSpeedAccuracy(),
    vNED: vned,
  };
}

module.exports = {
  GPS_FLAGS_HAS_LAT_LON,
  createRejectionStats,
  validateGpsRecord,
  gpsStructToRecord,
};
