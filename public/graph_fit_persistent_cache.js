'use strict';

/**
 * Browser persistent cache for fit-enabled stationary local maps (IndexedDB).
 * Core identity/serialization mirrors lib/graph_fit_persistent_cache.js.
 *
 * Cache impl version policy (GRAPH_FIT_CACHE_IMPL_VERSION in graph_fit.js):
 * - Bump when graph-fit algorithm or fitted output semantics change.
 * - Do not bump for renderer-only styling changes.
 * - Schema bump (PERSIST_SCHEMA_VERSION) only when payload storage compatibility breaks.
 */
(function initGraphFitPersistCache(global) {
  const PERSIST_SCHEMA_VERSION = 'graph-fit-persist-v1';
  const DB_NAME = 'kommuGraphFitPersistV1';
  const STORE_NAME = 'stationaryMaps';
  const DEFAULT_MAX_STORE_BYTES = 512 * 1024 * 1024;

  let maxStoreBytes = DEFAULT_MAX_STORE_BYTES;

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
    if (Array.isArray(value)) return value.map((v) => canonicalize(v)).filter((v) => v !== undefined);
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

  async function sha256Hex(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function digestCanonical(value) {
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

  async function buildProcessIdentity(processData) {
    const audits = (processData?.fileAudits || [])
      .map((a) => ({ filename: a.filename, sha256: a.sha256 }))
      .sort((a, b) => a.filename.localeCompare(b.filename));
    return digestCanonical({
      processingVersion: processData?.processingVersion ?? null,
      processingOptions: processData?.processingOptions ?? {},
      fileAudits: audits,
    });
  }

  async function digestReferencePose(referencePose) {
    if (!referencePose) return null;
    return digestCanonical({
      east: referencePose.east,
      north: referencePose.north,
      headingDeg: referencePose.headingDeg,
      frameId: referencePose.frameId ?? null,
      logMonoTime: referencePose.logMonoTime != null ? String(referencePose.logMonoTime) : null,
    });
  }

  async function digestTrajectorySummary(routeChunks, chunkId, passId) {
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

  async function digestRunPoints(run) {
    if (!run?.length) return null;
    let s = '';
    for (let i = 0; i < run.length; i++) {
      const p = run[i];
      s += `${canonicalNumber(p.east)},${canonicalNumber(p.north)},`
        + `${canonicalNumber(p.mirroredEast)},${canonicalNumber(p.mirroredNorth)},`
        + `${p.frameId ?? ''},${p.frameIndex ?? ''};`;
    }
    return (await sha256Hex(s)).slice(0, 32);
  }

  async function digestFragmentProvenance(constructedFragments, runs) {
    const fragments = constructedFragments?.fragments || [];
    const rows = [];
    for (let i = 0; i < fragments.length; i++) {
      const f = fragments[i];
      rows.push({
        fragmentId: f.fragmentId,
        chunkId: f.chunkId,
        passId: f.passId,
        groupTrackId: f.groupTrackId,
        laneIndex: f.laneIndex,
        pointCount: (f.points || []).length,
        runDigest: await digestRunPoints(runs?.[i] || constructedFragments?.runs?.[i]),
      });
    }
    rows.sort((a, b) => String(a.fragmentId).localeCompare(String(b.fragmentId)));
    return digestCanonical(rows);
  }

  function identityFragmentOptions(options) {
    return { ...options, fitEnabled: false };
  }

  function isDiagTraceEnabled() {
    return !!(global.__graphFitPersistTrace || global.location?.search?.includes('persistDiag=1'));
  }

  function tracePersist(event, detail) {
    if (!isDiagTraceEnabled()) return;
    const row = { ts: Date.now(), event, ...detail };
    if (!global.__graphFitPersistTraceLog) global.__graphFitPersistTraceLog = [];
    global.__graphFitPersistTraceLog.push(row);
  }

  let lastLookupResult = null;

  function mapValidationReason(reason) {
    switch (reason) {
      case 'missingRecord': return 'key-not-found';
      case 'schemaVersion': return 'record-schema-invalid';
      case 'cacheKey': return 'record-key-invalid';
      case 'missingMap': return 'record-payload-invalid';
      case 'checksum': return 'record-checksum-invalid';
      default: return 'record-payload-invalid';
    }
  }

  async function computeIdentity(processData, options) {
    const SLM = global.SegmentLocalMap;
    const GF = global.GraphFit;
    if (!processData || !SLM || !options?.fitEnabled) return null;
    tracePersist('identity-start', { segment: processData?.fileAudits?.[0]?.filename ?? null });
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
      processIdentity: await buildProcessIdentity(processData),
      segmentFiles: (processData.fileAudits || []).map((a) => a.filename).sort(),
      chunkId,
      passId,
      geometrySource,
      fitEnabled: true,
      fitConfigDigest: await digestCanonical(pickFitOptions(options, defaults)),
      referencePoseDigest: await digestReferencePose(referencePose),
      trajectoryDigest: await digestTrajectorySummary(processData.routeChunks, chunkId, passId),
      fragmentProvenanceDigest: await digestFragmentProvenance(cf, runs),
    };
    const cacheKey = await sha256Hex(canonicalStringify(identity));
    tracePersist('identity-complete', {
      cacheKey,
      cacheKeyLength: cacheKey.length,
      chunkId,
      passId,
      geometrySource,
      graphFitImplVersion: implVersion,
    });
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
      try { return structuredClone(map); } catch (_) { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(map, jsonReplacer));
  }

  function estimateByteSize(value) {
    try {
      return new TextEncoder().encode(JSON.stringify(value, jsonReplacer)).length;
    } catch (_) {
      return 0;
    }
  }

  async function buildPersistRecord(map, identityBundle) {
    const payload = cloneMapForStorage(map);
    const payloadChecksum = await digestCanonical(payload);
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
    return { ok: true, record };
  }

  async function validateChecksum(record) {
    const checksum = await digestCanonical(record.map);
    if (record.payloadChecksum && record.payloadChecksum !== checksum) {
      return { ok: false, reason: 'checksum' };
    }
    return { ok: true };
  }

  let dbPromise = null;
  let persistentWriteState = { state: 'idle', cacheKey: null, error: null };
  const writeWaiters = new Map();

  function isSupported() {
    return typeof indexedDB !== 'undefined';
  }

  function getPersistentWriteState() {
    return { ...persistentWriteState };
  }

  function notifyWriteWaiters(cacheKey, success, error) {
    const waiters = writeWaiters.get(cacheKey);
    if (!waiters) return;
    for (const w of waiters) {
      clearTimeout(w.timer);
      if (success) w.resolve();
      else w.reject(error || new Error('indexedDB write failed'));
    }
    writeWaiters.delete(cacheKey);
  }

  function waitForWriteCommitted(cacheKey, { timeoutMs = 300000 } = {}) {
    if (persistentWriteState.state === 'committed' && persistentWriteState.cacheKey === cacheKey) {
      return Promise.resolve();
    }
    if (persistentWriteState.state === 'failed' && persistentWriteState.cacheKey === cacheKey) {
      return Promise.reject(new Error(persistentWriteState.error || 'indexedDB write failed'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitForWriteCommitted timeout')), timeoutMs);
      if (!writeWaiters.has(cacheKey)) writeWaiters.set(cacheKey, new Set());
      writeWaiters.get(cacheKey).add({ resolve, reject, timer });
    });
  }

  function openDb() {
    if (!isSupported()) return Promise.reject(new Error('indexedDB unavailable'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
            store.createIndex('lastAccessedAt', 'lastAccessedAt');
          }
        };
        req.onblocked = () => {
          reject(new Error('indexedDB open blocked'));
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          dbPromise = null;
          reject(req.error || new Error('indexedDB open failed'));
        };
      });
    }
    return dbPromise;
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('indexedDB tx failed'));
      tx.onabort = () => reject(tx.error || new Error('indexedDB tx aborted'));
    });
  }

  function runTransaction(db, mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      let result;
      let settled = false;
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(val);
      };
      Promise.resolve(work(tx.objectStore(STORE_NAME)))
        .then((val) => { result = val; })
        .catch((err) => finish(err));
      tx.oncomplete = () => { if (!settled) finish(null, result); };
      tx.onerror = () => finish(tx.error || new Error('indexedDB tx failed'));
      tx.onabort = () => finish(tx.error || new Error('indexedDB tx aborted'));
    });
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB request failed'));
    });
  }

  async function listEntries(db) {
    return runTransaction(db, 'readonly', (store) => idbRequest(store.getAll()));
  }

  async function readRawRecord(cacheKey) {
    if (!cacheKey) return null;
    const db = await openDb();
    return runTransaction(db, 'readonly', (store) => idbRequest(store.get(cacheKey)));
  }

  function getLastLookupResult() {
    return lastLookupResult ? { ...lastLookupResult } : null;
  }

  async function inspectStore(cacheKey = null) {
    const db = await openDb();
    return runTransaction(db, 'readonly', async (store) => {
      const count = await idbRequest(store.count());
      const keys = await idbRequest(store.getAllKeys());
      const record = cacheKey ? await idbRequest(store.get(cacheKey)) : null;
      return {
        dbName: DB_NAME,
        storeName: STORE_NAME,
        keyPath: 'cacheKey',
        count,
        keys,
        record: record ? {
          cacheKey: record.cacheKey,
          schemaVersion: record.schemaVersion,
          payloadChecksum: record.payloadChecksum,
          byteEstimate: record.byteEstimate,
          identity: record.identity,
        } : null,
      };
    });
  }

  function getTraceLog() {
    return global.__graphFitPersistTraceLog ? [...global.__graphFitPersistTraceLog] : [];
  }

  function clearTraceLog() {
    if (global.__graphFitPersistTraceLog) global.__graphFitPersistTraceLog.length = 0;
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

  async function evictIfNeeded(db, incomingBytes, protectKey = null) {
    const entries = await listEntries(db);
    let total = entries.reduce((a, e) => a + (e.byteEstimate || 0), 0);
    if (total + incomingBytes <= maxStoreBytes) return;
    const sorted = [...entries].sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0));
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const entry of sorted) {
      if (total + incomingBytes <= maxStoreBytes) break;
      if (protectKey && entry.cacheKey === protectKey) continue;
      store.delete(entry.cacheKey);
      total -= entry.byteEstimate || 0;
    }
    await txDone(tx);
  }

  async function get(identityBundle) {
    if (!identityBundle?.cacheKey) {
      lastLookupResult = { result: 'persistent-unavailable', reason: 'missingIdentity' };
      return null;
    }
    if (!isSupported()) {
      lastLookupResult = { result: 'persistent-unavailable', reason: 'indexedDB unavailable' };
      return null;
    }
    tracePersist('idb-read-start', { cacheKey: identityBundle.cacheKey });
    let db;
    try {
      tracePersist('idb-open-start', { dbName: DB_NAME });
      db = await openDb();
      tracePersist('idb-open-complete', { dbName: DB_NAME, version: db.version });
    } catch (err) {
      lastLookupResult = { result: 'database-open-failed', error: String(err?.message || err) };
      return null;
    }
    let record;
    let storeCount = null;
    let allKeys = null;
    try {
      const storeInfo = await runTransaction(db, 'readonly', async (store) => {
        const count = await idbRequest(store.count());
        const keys = await idbRequest(store.getAllKeys());
        const rec = await idbRequest(store.get(identityBundle.cacheKey));
        return { count, keys, rec };
      });
      storeCount = storeInfo.count;
      allKeys = storeInfo.keys;
      record = storeInfo.rec;
    } catch (err) {
      lastLookupResult = { result: 'read-transaction-aborted', error: String(err?.message || err) };
      return null;
    }
    tracePersist('idb-read-complete', { cacheKey: identityBundle.cacheKey, storeCount, keyCount: allKeys?.length ?? 0 });
    if (!record) {
      lastLookupResult = {
        result: storeCount === 0 ? 'store-empty' : 'key-not-found',
        cacheKey: identityBundle.cacheKey,
        storeCount,
        allKeys,
      };
      return null;
    }
    const valid = validatePersistRecord(record, identityBundle);
    if (!valid.ok) {
      lastLookupResult = {
        result: mapValidationReason(valid.reason),
        reason: valid.reason,
        cacheKey: identityBundle.cacheKey,
        recordCacheKey: record.cacheKey,
      };
      return null;
    }
    const checksum = await validateChecksum(record);
    tracePersist('record-validation-complete', { cacheKey: identityBundle.cacheKey, checksumOk: checksum.ok });
    if (!checksum.ok) {
      lastLookupResult = { result: 'record-checksum-invalid', cacheKey: identityBundle.cacheKey };
      await deleteKey(identityBundle.cacheKey);
      return null;
    }
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const touched = { ...record, lastAccessedAt: Date.now() };
    store.put(touched);
    await txDone(tx);
    lastLookupResult = { result: 'persistent-hit', cacheKey: identityBundle.cacheKey };
    return { ...valid.record, map: cloneMapForStorage(valid.record.map), lookupResult: lastLookupResult.result };
  }

  async function put(processData, options, map) {
    const identityBundle = await computeIdentity(processData, options);
    if (!identityBundle) return null;
    const cacheKey = identityBundle.cacheKey;
    persistentWriteState = { state: 'writing', cacheKey, error: null };
    try {
      const record = await buildPersistRecord(map, identityBundle);
      tracePersist('idb-write-start', { cacheKey });
      const db = await openDb();
      await evictIfNeeded(db, record.byteEstimate || 0, cacheKey);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(record);
      req.onerror = () => {
        persistentWriteState = { state: 'failed', cacheKey, error: String(req.error || 'put failed') };
        notifyWriteWaiters(cacheKey, false, req.error);
      };
      await txDone(tx);
      tracePersist('idb-transaction-complete', { cacheKey });
      persistentWriteState = { state: 'committed', cacheKey, error: null };
      notifyWriteWaiters(cacheKey, true);
      return cacheKey;
    } catch (err) {
      persistentWriteState = { state: 'failed', cacheKey, error: String(err?.message || err) };
      notifyWriteWaiters(cacheKey, false, err);
      throw err;
    }
  }

  async function deleteKey(cacheKey) {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(cacheKey);
    await txDone(tx);
  }

  async function clearStore() {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    await txDone(tx);
    persistentWriteState = { state: 'idle', cacheKey: null, error: null };
  }

  async function storeStats() {
    const db = await openDb();
    const entries = await listEntries(db);
    return {
      entryCount: entries.length,
      totalBytes: entries.reduce((a, e) => a + (e.byteEstimate || 0), 0),
      maxBytes: maxStoreBytes,
    };
  }

  function setMaxStoreBytesForTest(bytes) {
    maxStoreBytes = bytes;
  }

  function resetMaxStoreBytesForTest() {
    maxStoreBytes = DEFAULT_MAX_STORE_BYTES;
  }

  global.GraphFitPersistCache = {
    PERSIST_SCHEMA_VERSION,
    get MAX_STORE_BYTES() { return maxStoreBytes; },
    DEFAULT_MAX_STORE_BYTES,
    DB_NAME,
    STORE_NAME,
    isSupported,
    getPersistentWriteState,
    waitForWriteCommitted,
    computeIdentity,
    get,
    put,
    deleteKey,
    clearStore,
    storeStats,
    readRawRecord,
    inspectStore,
    getLastLookupResult,
    getTraceLog,
    clearTraceLog,
    cloneMapForStorage,
    validatePersistRecord,
    buildPersistRecord,
    canonicalStringify,
    digestCanonical,
    estimateByteSize,
    simulateLruEviction,
    setMaxStoreBytesForTest,
    resetMaxStoreBytesForTest,
  };
}(typeof window !== 'undefined' ? window : globalThis));
