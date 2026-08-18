'use strict';

/**
 * Persistent graph-fit local-map cache — identity, serialization, and validation.
 * Browser IndexedDB storage lives in public/graph_fit_persistent_cache.js.
 */

const crypto = require('crypto');

const PERSIST_SCHEMA_VERSION = 'graph-fit-persist-v1';
const MAX_STORE_BYTES = 512 * 1024 * 1024;

const FIT_OPTION_KEYS = [
  'fitEnabled', 'fitMethod', 'fitLambdaCutoffsM', 'fitKnotSpacingM', 'fitMaxBasis',
  'fitTukeyK', 'fitMaxGapM', 'fitStationaryMaxGapM', 'fitOrderingMaxStepM',
  'fitMinSupport', 'fitLowSupportWeight', 'fitStationaryBinM', 'fitMinPointsPerRun',
  'fitMinTotalFrames', 'fitMinTrainingFrames', 'fitMinSpanM', 'fitMinPosesForTravelFit',
  'fitOutputStepM', 'fitMaxHeldOutMedianM', 'fitMaxHeldOutP95M', 'fitSelectMedianTol',
  'fitSelectP95Tol', 'fitMaxSourceCorridorM', 'fitFoldCountMax', 'fitMaxCond', 'fitJitterEps',
  'fitIRLSMaxIter', 'fitIRLSTol', 'fitMaxEndTrimM', 'fitCrossingToleranceM',
  'fitDiagnosticDashed', 'fitIsStationary', 'minHeadingSpeedMps',
];

function canonicalNumber(n) {
  if (typeof n !== 'number') return n;
  if (Number.isNaN(n)) return '__NaN__';
  if (n === Infinity) return '__Infinity__';
  if (n === -Infinity) return '__-Infinity__';
  if (Object.is(n, -0)) return 0;
  return n;
}

function canonicalize(value) {
  if (value === undefined || typeof value === 'function') return undefined;
  if (value === null) return null;
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v)).filter((v) => v !== undefined);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new Error('typed arrays are not supported in persistent cache payloads');
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const cv = canonicalize(value[key]);
      if (cv !== undefined) out[key] = cv;
    }
    return out;
  }
  return undefined;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function digestCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function pickFitOptions(options = {}, defaults = {}) {
  const out = {};
  for (const k of FIT_OPTION_KEYS) {
    if (options[k] !== undefined) out[k] = options[k];
    else if (defaults[k] !== undefined) out[k] = defaults[k];
  }
  out.fitEnabled = !!options.fitEnabled;
  return out;
}

function buildProcessIdentity(processData) {
  const audits = (processData?.fileAudits || [])
    .map((a) => ({ filename: a.filename, sha256: a.sha256 }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  return digestCanonical({
    processingVersion: processData?.processingVersion ?? null,
    processingOptions: processData?.processingOptions ?? {},
    fileAudits: audits,
  });
}

function digestReferencePose(referencePose) {
  if (!referencePose) return null;
  return digestCanonical({
    east: referencePose.east,
    north: referencePose.north,
    headingDeg: referencePose.headingDeg,
    frameId: referencePose.frameId ?? null,
    logMonoTime: referencePose.logMonoTime != null ? String(referencePose.logMonoTime) : null,
  });
}

function digestTrajectorySummary(routeChunks, chunkId, passId) {
  const chunk = routeChunks?.find((c) => c.chunkId === chunkId) ?? routeChunks?.[0];
  const path = chunk?.vehiclePath || [];
  if (!path.length) return digestCanonical({ points: 0 });
  const sample = path.map((p) => ({
    east: canonicalNumber(p.east),
    north: canonicalNumber(p.north),
    logMonoTime: p.logMonoTime != null ? String(p.logMonoTime) : null,
  }));
  return digestCanonical({ chunkId, passId, points: sample.length, sample });
}

function digestRunPoints(run) {
  if (!run?.length) return null;
  let s = '';
  for (let i = 0; i < run.length; i++) {
    const p = run[i];
    s += `${canonicalNumber(p.east)},${canonicalNumber(p.north)},`
      + `${canonicalNumber(p.mirroredEast)},${canonicalNumber(p.mirroredNorth)},`
      + `${p.frameId ?? ''},${p.frameIndex ?? ''};`;
  }
  return sha256Hex(s).slice(0, 32);
}

function digestFragmentProvenance(constructedFragments, runs) {
  const fragments = constructedFragments?.fragments || [];
  const rows = fragments.map((f, i) => ({
    fragmentId: f.fragmentId,
    chunkId: f.chunkId,
    passId: f.passId,
    groupTrackId: f.groupTrackId,
    laneIndex: f.laneIndex,
    pointCount: (f.points || []).length,
    runDigest: digestRunPoints(runs?.[i] || constructedFragments?.runs?.[i]),
  })).sort((a, b) => String(a.fragmentId).localeCompare(String(b.fragmentId)));
  return digestCanonical(rows);
}

/** Fragment construction for identity only — must not invoke graph fitting. */
function identityFragmentOptions(options) {
  return { ...options, fitEnabled: false };
}

function computeFitPersistIdentity(processData, options, deps) {
  const { SLM, GF } = deps;
  if (!processData || !SLM || !options?.fitEnabled) return null;
  const geometrySource = SLM.normalizeGeometrySource(options.geometrySource);
  if (geometrySource !== 'pointAccumulated') return null;

  const timelineIndex = options.timelineIndex ?? 0;
  const active = options.chunkId != null
    ? { chunkId: options.chunkId, passId: options.passId ?? 0 }
    : SLM.resolveActiveChunkPass(processData, timelineIndex);
  const { chunkId, passId } = active;

  const referencePose = SLM.resolveSegmentReferencePose({
    frames: processData.frames || [],
    timeline: processData.timeline || [],
    chunkId,
    passId,
    options,
  });
  if (!referencePose) return null;

  const fragmentBuild = SLM.buildLaneFragmentsForSource(processData, {
    geometrySource,
    frames: processData.frames || [],
    timeline: processData.timeline || [],
    referencePose,
    chunkId,
    passId,
    options: identityFragmentOptions(options),
  });
  const pa = fragmentBuild.pointAccumulated;
  const cf = pa?.constructedFragments;
  const runs = pa?.constructedFragmentRuns || cf?.runs || [];

  const defaults = GF?.GRAPH_FIT_DEFAULTS || {};
  const implVersion = GF?.GRAPH_FIT_CACHE_IMPL_VERSION || 'unknown';

  const identity = {
    schemaVersion: PERSIST_SCHEMA_VERSION,
    processingVersion: processData.processingVersion ?? null,
    graphFitImplVersion: implVersion,
    processIdentity: buildProcessIdentity(processData),
    segmentFiles: (processData.fileAudits || []).map((a) => a.filename).sort(),
    chunkId,
    passId,
    geometrySource,
    fitEnabled: true,
    fitConfigDigest: digestCanonical(pickFitOptions(options, defaults)),
    referencePoseDigest: digestReferencePose(referencePose),
    trajectoryDigest: digestTrajectorySummary(processData.routeChunks, chunkId, passId),
    fragmentProvenanceDigest: digestFragmentProvenance(cf, runs),
  };

  const cacheKey = sha256Hex(canonicalStringify(identity));
  return { cacheKey, identity };
}

function jsonReplacer(_key, value) {
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Map || value instanceof Set) {
    throw new Error('Map/Set not supported in persistent cache payloads');
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new Error('typed arrays not supported in persistent cache payloads');
  }
  return value;
}

function cloneMapForStorage(map) {
  if (!map) return null;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(map);
    } catch (_) { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(map, jsonReplacer));
}

function estimateByteSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value, jsonReplacer));
  } catch (_) {
    return 0;
  }
}

function buildPersistRecord(map, identityBundle) {
  const payload = cloneMapForStorage(map);
  const payloadChecksum = digestCanonical(payload);
  const byteEstimate = estimateByteSize(payload);
  const now = Date.now();
  return {
    schemaVersion: PERSIST_SCHEMA_VERSION,
    cacheKey: identityBundle.cacheKey,
    identity: identityBundle.identity,
    payloadChecksum,
    byteEstimate,
    createdAt: now,
    lastAccessedAt: now,
    map: payload,
  };
}

function validatePersistRecord(record, identityBundle) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'missingRecord' };
  if (record.schemaVersion !== PERSIST_SCHEMA_VERSION) return { ok: false, reason: 'schemaVersion' };
  if (!record.cacheKey || record.cacheKey !== identityBundle.cacheKey) return { ok: false, reason: 'cacheKey' };
  if (!record.map) return { ok: false, reason: 'missingMap' };
  const checksum = digestCanonical(record.map);
  if (record.payloadChecksum && record.payloadChecksum !== checksum) return { ok: false, reason: 'checksum' };
  return { ok: true, record: { ...record, map: cloneMapForStorage(record.map) } };
}

function maxCoordinateDiff(maps) {
  const [a, b] = maps;
  let max = 0;
  const ar = a?.pointAccumulated?.fittedPolylines?.results || [];
  const br = b?.pointAccumulated?.fittedPolylines?.results || [];
  for (const ra of ar) {
    const rb = br.find((x) => x.fragmentId === ra.fragmentId);
    if (!rb || ra.status !== rb.status) continue;
    if (ra.status !== 'accepted') continue;
    const pa = Array.isArray(ra.fittedPolyline) ? ra.fittedPolyline.flat() : ra.fittedPolyline;
    const pb = Array.isArray(rb.fittedPolyline) ? rb.fittedPolyline.flat() : rb.fittedPolyline;
    if (!pa || !pb || pa.length !== pb.length) continue;
    for (let i = 0; i < pa.length; i++) {
      max = Math.max(max, Math.abs(pa[i].east - pb[i].east), Math.abs(pa[i].north - pb[i].north));
      if (pa[i].mirroredEast != null && pb[i].mirroredEast != null) {
        max = Math.max(max, Math.abs(pa[i].mirroredEast - pb[i].mirroredEast));
        max = Math.max(max, Math.abs(pa[i].mirroredNorth - pb[i].mirroredNorth));
      }
    }
  }
  return max;
}

function comparePersistedMaps(a, b) {
  const acceptedA = (a?.pointAccumulated?.fittedPolylines?.results || [])
    .filter((r) => r.status === 'accepted').map((r) => r.fragmentId).sort();
  const acceptedB = (b?.pointAccumulated?.fittedPolylines?.results || [])
    .filter((r) => r.status === 'accepted').map((r) => r.fragmentId).sort();
  return {
    checksumMatch: a?.checksum === b?.checksum,
    polygonChecksumMatch: a?.roadSurfaceChecksum === b?.roadSurfaceChecksum,
    acceptedIdsMatch: JSON.stringify(acceptedA) === JSON.stringify(acceptedB),
    maxCoordinateDifference: maxCoordinateDiff([a, b]),
    hybridCountMatch: (a?.pointAccumulated?.hybridFittedBoundaries?.boundaries?.length ?? 0)
      === (b?.pointAccumulated?.hybridFittedBoundaries?.boundaries?.length ?? 0),
  };
}

function auditStructuredCloneCompatibility(map) {
  const result = {
    structuredCloneOk: false,
    jsonRoundTripOk: false,
    hasMap: false,
    hasSet: false,
    hasFunction: false,
    hasTypedArray: false,
    error: null,
  };
  const walk = (v) => {
    if (v == null || typeof v !== 'object') return;
    if (typeof v === 'function') result.hasFunction = true;
    if (v instanceof Map) result.hasMap = true;
    if (v instanceof Set) result.hasSet = true;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) result.hasTypedArray = true;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    Object.values(v).forEach(walk);
  };
  walk(map);
  try {
    if (typeof structuredClone === 'function') {
      structuredClone(map);
      result.structuredCloneOk = true;
    }
  } catch (e) {
    result.error = e.message;
  }
  try {
    JSON.parse(JSON.stringify(map, jsonReplacer));
    result.jsonRoundTripOk = true;
  } catch (e) {
    result.error = result.error || e.message;
  }
  return result;
}

function simulateLruEviction(entries, incomingBytes, limitBytes) {
  const rows = entries.map((e) => ({ ...e }));
  let total = rows.reduce((a, e) => a + (e.byteEstimate || 0), 0);
  const evicted = [];
  if (total + incomingBytes <= limitBytes) {
    return { entries: rows, evicted, totalBytes: total };
  }
  rows.sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0));
  while (rows.length && total + incomingBytes > limitBytes) {
    const victim = rows.shift();
    evicted.push(victim.cacheKey);
    total -= victim.byteEstimate || 0;
  }
  return { entries: rows, evicted, totalBytes: total };
}

module.exports = {
  PERSIST_SCHEMA_VERSION,
  MAX_STORE_BYTES,
  FIT_OPTION_KEYS,
  canonicalStringify,
  canonicalize,
  sha256Hex,
  digestCanonical,
  pickFitOptions,
  buildProcessIdentity,
  digestRunPoints,
  identityFragmentOptions,
  computeFitPersistIdentity,
  cloneMapForStorage,
  estimateByteSize,
  buildPersistRecord,
  validatePersistRecord,
  comparePersistedMaps,
  maxCoordinateDiff,
  auditStructuredCloneCompatibility,
  simulateLruEviction,
};
