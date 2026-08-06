/**
 * Single-pass qlog parse: audit + modelV2 + GPS + pose stats in one Cap'n Proto scan.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const capnp = require('capnp-ts');
const Log = require('@commaai/log_reader/capnp/log.capnp');
const toJSON = require('@commaai/capnp-json');
const { iterateEvents, UNION, getModelV2, getGpsLocation } = require('./qlog_decoder');
const { gpsStructToRecord } = require('./gps_validate');
const { isPlausibleLatLon } = require('./pose_source');

const TAG_NAMES = {
  0: 'initData',
  20: 'gpsLocationDEPRECATED',
  47: 'gpsLocationExternal',
  70: 'liveLocationKalman',
  73: 'modelV2',
};

function pascalToCamel(key) {
  return key.charAt(0).toLowerCase() + key.slice(1);
}

function normalizeKeys(obj) {
  if (typeof obj === 'bigint') return obj.toString();
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(normalizeKeys);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[pascalToCamel(k)] = normalizeKeys(v);
  }
  return out;
}

function modelV2ToJson(model) {
  return normalizeKeys(toJSON(model));
}

function durationSec(times) {
  if (times.length < 2) return times.length ? 0 : 0;
  return Number(BigInt(times[times.length - 1]) - BigInt(times[0])) / 1e9;
}

function buildAuditFromParse(absPath, stat, hash, parsed) {
  const tagSummary = {};
  for (const [tag, count] of [...parsed.tagCounts.entries()].sort((a, b) => a[0] - b[0])) {
    tagSummary[tag] = { name: TAG_NAMES[tag] || `tag${tag}`, count };
  }

  const modelV2Count = parsed.tagCounts.get(UNION.MODEL_V2) || 0;
  let classification = 'normal';
  if (modelV2Count <= 1) classification = 'insufficientTemporalObservations';
  if (durationSec(parsed.modelV2Times) < 10 && modelV2Count < 5) classification = 'incompleteLog';
  if (stat.size < 500000 && modelV2Count < 5) classification = 'incompleteLog';

  return {
    absolutePath: absPath,
    filename: path.basename(absPath),
    fileSizeBytes: stat.size,
    sha256: hash,
    rawMessageCount: parsed.rawMessageCount,
    modelV2Count,
    gpsCount: (parsed.tagCounts.get(UNION.GPS_LOCATION) || 0) + (parsed.tagCounts.get(UNION.GPS_LOCATION_EXTERNAL) || 0),
    liveLocationKalmanCount: parsed.tagCounts.get(70) || 0,
    modelV2FrameIds: parsed.modelV2FrameIds,
    firstTimestamp: {
      modelV2: parsed.modelV2Times[0] ?? null,
      gps: parsed.gpsTimes[0] ?? null,
      kalman: parsed.kalmanTimes[0] ?? null,
    },
    lastTimestamp: {
      modelV2: parsed.modelV2Times[parsed.modelV2Times.length - 1] ?? null,
      gps: parsed.gpsTimes[parsed.gpsTimes.length - 1] ?? null,
      kalman: parsed.kalmanTimes[parsed.kalmanTimes.length - 1] ?? null,
    },
    durationSec: {
      modelV2: durationSec(parsed.modelV2Times),
      gps: durationSec(parsed.gpsTimes),
      kalman: durationSec(parsed.kalmanTimes),
    },
    unionTags: tagSummary,
    kalmanSample: parsed.kalmanSample,
    kalmanGpsOkFalse: parsed.kalmanGpsOkFalse,
    kalmanPositionInvalid: parsed.kalmanPositionInvalid,
    classification,
  };
}

function buildPoseReport(filename, parsed) {
  const validKalman = parsed.kalmanCount - parsed.kalmanGpsOkFalse;
  const validGps = parsed.validGpsCount;

  let selectedSource = 'none';
  if (parsed.validKalmanCount >= 2) selectedSource = 'liveLocationKalman';
  else if (validGps >= 2) selectedSource = 'gpsLocation';

  return {
    filename,
    pipelinePoseSource: 'gpsLocation',
    pipelineNote: 'process_route uses GpsLocation via extract_gps + interpolateGpsAtTime; LiveLocationKalman is NOT used for map projection',
    selectedSource,
    poseUnavailable: selectedSource === 'none',
    gpsCount: parsed.gpsCount,
    kalmanCount: parsed.kalmanCount,
    validGpsCount: validGps,
    validKalmanCount: parsed.validKalmanCount,
    kalmanGpsOkFalse: parsed.kalmanGpsOkFalse,
    kalmanPositionInvalid: parsed.kalmanPositionInvalid,
    kalmanNotPlausible: parsed.kalmanNotPlausible,
    gpsLowSpeedSamples: parsed.gpsLowSpeed,
    gpsHighBearingUncertainty: parsed.gpsHighBearingUnc,
    sampleGps: parsed.sampleGps,
    sampleKalman: parsed.kalmanSample,
    gpsAccuracyAvailable: parsed.gpsAccuracyAvailable,
  };
}

function parseQlogBuffer(buf, filename) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const tagCounts = new Map();
  const modelV2Times = [];
  const gpsTimes = [];
  const kalmanTimes = [];
  const modelV2FrameIds = [];
  const modelEvents = [];
  const gpsEvents = [];

  let rawMessageCount = 0;
  let kalmanGpsOkFalse = 0;
  let kalmanPositionInvalid = 0;
  let kalmanNotPlausible = 0;
  let validKalmanCount = 0;
  let validGpsCount = 0;
  let gpsCount = 0;
  let kalmanCount = 0;
  let gpsLowSpeed = 0;
  let gpsHighBearingUnc = 0;
  let gpsAccuracyAvailable = false;
  let kalmanSample = null;
  let sampleGps = null;

  for (const item of iterateEvents(buf, filename)) {
    rawMessageCount++;
    tagCounts.set(item.unionTag, (tagCounts.get(item.unionTag) || 0) + 1);
    const t = item.logMonoTime.toString();

    if (item.unionTag === UNION.MODEL_V2) {
      modelV2Times.push(t);
      const model = getModelV2(item.event);
      modelV2FrameIds.push(model.getFrameId?.() ?? null);
      modelEvents.push({
        logMonoTime: t,
        valid: item.valid,
        sourceFile: filename,
        sourceEventIndex: item.sourceEventIndex,
        modelV2: modelV2ToJson(model),
      });
    }

    if (item.unionTag === UNION.GPS_LOCATION || item.unionTag === UNION.GPS_LOCATION_EXTERNAL) {
      gpsTimes.push(t);
      gpsCount++;
      const source = item.unionTag === UNION.GPS_LOCATION ? 'gpsLocation' : 'gpsLocationExternal';
      const gps = getGpsLocation(item.event);
      const rec = gpsStructToRecord(item.event, gps, source, filename, item.sourceEventIndex);
      gpsEvents.push(rec);
      const plausible = isPlausibleLatLon(rec.latitude, rec.longitude);
      if (plausible) validGpsCount++;
      if ((rec.speed ?? 0) < 2) gpsLowSpeed++;
      if ((rec.bearingAccuracy ?? 0) > 30) gpsHighBearingUnc++;
      if (rec.horizontalAccuracy != null && rec.horizontalAccuracy > 0) gpsAccuracyAvailable = true;
      if (!sampleGps) {
        sampleGps = {
          logMonoTime: t,
          source: item.unionTag === UNION.GPS_LOCATION ? 'gpsLocationDEPRECATED' : 'gpsLocationExternal',
          lat: rec.latitude,
          lon: rec.longitude,
          flags: rec.flags,
          horizontalAccuracy: rec.horizontalAccuracy,
          speed: rec.speed,
          bearingAccuracy: rec.bearingAccuracy,
          speedAccuracy: rec.speedAccuracy,
          plausible,
        };
      }
    }

    if (item.unionTag === 70) {
      kalmanTimes.push(t);
      kalmanCount++;
      try {
        const llk = capnp.Struct.getStruct(0, Log.LiveLocationKalman, item.event);
        const geo = llk.getPositionGeodetic();
        const val = geo?.getValue?.();
        const lat = val?.getX?.() ?? null;
        const lon = val?.getY?.() ?? null;
        const gpsOK = llk.getGpsOK();
        const positionValid = geo?.getValid?.() ?? false;
        if (!gpsOK) kalmanGpsOkFalse++;
        if (!positionValid) kalmanPositionInvalid++;
        const plausible = isPlausibleLatLon(lat, lon);
        if (!plausible) kalmanNotPlausible++;
        if (gpsOK && positionValid && plausible) validKalmanCount++;
        if (!kalmanSample) {
          kalmanSample = { logMonoTime: t, gpsOK, positionValid, lat, lon };
        }
      } catch (_) { /* skip */ }
    }
  }

  const parsed = {
    tagCounts,
    rawMessageCount,
    modelV2Times,
    gpsTimes,
    kalmanTimes,
    modelV2FrameIds,
    kalmanGpsOkFalse,
    kalmanPositionInvalid,
    kalmanNotPlausible,
    validKalmanCount,
    validGpsCount,
    gpsCount,
    kalmanCount,
    gpsLowSpeed,
    gpsHighBearingUnc,
    gpsAccuracyAvailable,
    kalmanSample,
    sampleGps,
  };

  return {
    sha256: hash,
    modelEvents,
    gpsEvents,
    parsed,
    poseSourceReport: buildPoseReport(filename, parsed),
  };
}

function parseQlogFile(filePath) {
  const absPath = path.resolve(filePath);
  const stat = fs.statSync(absPath);
  const buf = fs.readFileSync(absPath);
  const filename = path.basename(absPath);
  const result = parseQlogBuffer(buf, filename);
  const audit = buildAuditFromParse(absPath, stat, result.sha256, result.parsed);
  return {
    audit,
    modelEvents: result.modelEvents,
    gpsEvents: result.gpsEvents,
    poseSourceReport: result.poseSourceReport,
    sha256: result.sha256,
  };
}

module.exports = {
  parseQlogBuffer,
  parseQlogFile,
  buildAuditFromParse,
};
