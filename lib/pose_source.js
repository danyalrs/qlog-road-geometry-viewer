/**
 * Localization source selection and reporting.
 * Pipeline uses GpsLocation (tag 20/47), NOT LiveLocationKalman for map projection.
 */
const capnp = require('capnp-ts');
const Log = require('@commaai/log_reader/capnp/log.capnp');
const { iterateEvents, UNION } = require('./qlog_decoder');

const SINGAPORE_LAT = 1.305;
const SINGAPORE_LON = 103.904;
const GEO_SANITY_DEG = 2.0;

function isPlausibleLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return false;
  return Math.abs(lat - SINGAPORE_LAT) < GEO_SANITY_DEG && Math.abs(lon - SINGAPORE_LON) < GEO_SANITY_DEG;
}

function auditLocalizationSources(buf, filename) {
  const gpsSamples = [];
  const kalmanSamples = [];

  for (const item of iterateEvents(buf, filename)) {
    const t = item.logMonoTime.toString();

    if (item.unionTag === UNION.GPS_LOCATION || item.unionTag === UNION.GPS_LOCATION_EXTERNAL) {
      try {
        const gps = capnp.Struct.getStruct(0, Log.GpsLocationData, item.event);
        gpsSamples.push({
          logMonoTime: t,
          source: item.unionTag === UNION.GPS_LOCATION ? 'gpsLocationDEPRECATED' : 'gpsLocationExternal',
          lat: gps.getLatitude(),
          lon: gps.getLongitude(),
          flags: gps.getFlags(),
          horizontalAccuracy: gps.getHorizontalAccuracy?.() ?? null,
          speed: gps.getSpeed?.() ?? null,
          bearingAccuracy: gps.getBearingAccuracyDeg?.() ?? null,
          speedAccuracy: gps.getSpeedAccuracy?.() ?? null,
          plausible: isPlausibleLatLon(gps.getLatitude(), gps.getLongitude()),
        });
      } catch (_) { /* skip */ }
    }

    if (item.unionTag === 70) {
      try {
        const llk = capnp.Struct.getStruct(0, Log.LiveLocationKalman, item.event);
        const geo = llk.getPositionGeodetic();
        const val = geo?.getValue?.();
        const lat = val?.getX?.() ?? null;
        const lon = val?.getY?.() ?? null;
        kalmanSamples.push({
          logMonoTime: t,
          gpsOK: llk.getGpsOK(),
          positionValid: geo?.getValid?.() ?? false,
          lat,
          lon,
          plausible: isPlausibleLatLon(lat, lon),
        });
      } catch (_) { /* skip */ }
    }
  }

  const validKalman = kalmanSamples.filter((s) => s.positionValid && s.gpsOK && s.plausible);
  const validGps = gpsSamples.filter((s) => s.plausible);

  let selectedSource = 'none';
  let poseUnavailable = true;

  if (validKalman.length >= 2) {
    selectedSource = 'liveLocationKalman';
    poseUnavailable = false;
  } else if (validGps.length >= 2) {
    selectedSource = 'gpsLocation';
    poseUnavailable = false;
  }

  const lowSpeed = gpsSamples.filter((s) => (s.speed ?? 0) < 2).length;
  const highBearingUnc = gpsSamples.filter((s) => (s.bearingAccuracy ?? 0) > 30).length;

  return {
    filename,
    pipelinePoseSource: 'gpsLocation',
    pipelineNote: 'process_route uses GpsLocation via extract_gps + interpolateGpsAtTime; LiveLocationKalman is NOT used for map projection',
    selectedSource,
    poseUnavailable,
    gpsCount: gpsSamples.length,
    kalmanCount: kalmanSamples.length,
    validGpsCount: validGps.length,
    validKalmanCount: validKalman.length,
    kalmanGpsOkFalse: kalmanSamples.filter((s) => !s.gpsOK).length,
    kalmanPositionInvalid: kalmanSamples.filter((s) => !s.positionValid).length,
    kalmanNotPlausible: kalmanSamples.filter((s) => !s.plausible).length,
    gpsLowSpeedSamples: lowSpeed,
    gpsHighBearingUncertainty: highBearingUnc,
    sampleGps: gpsSamples[0] ?? null,
    sampleKalman: kalmanSamples[0] ?? null,
    gpsAccuracyAvailable: gpsSamples.some((s) => s.horizontalAccuracy != null && s.horizontalAccuracy > 0),
  };
}

module.exports = {
  auditLocalizationSources,
  isPlausibleLatLon,
};
