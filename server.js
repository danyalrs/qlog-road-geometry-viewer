const express = require('express');
const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('./lib/process_route');
const { enrichTimelineWithMovement } = require('./lib/vehicle_movement_display');
const { PROCESSING_VERSION } = require('./lib/version');
const { normalizeProcessOptions } = require('./lib/process_defaults');
const { STAGE19_PROCESSING_VERSION, STAGE19_IMPLEMENTATION_CHECKPOINT, STAGE19_CHECKPOINT_PRESERVATION } = require('./lib/stage19_version');
const { resolveBundlePath, validateSafePath } = require('./lib/stage19_publication_production');
const { buildGeometryDebug } = require('./lib/geometry_debug');
const { buildLaneDiagnostics } = require('./lib/geometry_diagnostics');
const SLM = require('./lib/segment_local_map');
const { extractFromFile: extractModel } = require('./extract_modelv2');
const { extractFromFile: extractGps } = require('./extract_gps');
const { loadSegmentsData, fileHashIdentities, clearParseCache } = require('./lib/qlog_data');
const { loadJsonExtract } = require('./lib/json_extract');
const { auditQlogFile, buildCacheKey } = require('./lib/qlog_audit');
const { qualifySegments } = require('./lib/segment_qualify');
const { buildGeometryProvenance, buildPassProvenance } = require('./lib/geometry_provenance');
const { createVideoRouter } = require('./lib/video_routes');

const ROOT = __dirname;
const PORT = process.env.PORT || 3847;

const app = express();
app.use(express.json({ limit: '50mb' }));

/** Disable caching for API and static assets so refreshed code/data is always used. */
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use("/vv", express.static(path.join(ROOT, 'reports', 'video_verification'), { setHeaders: (res) => { res.setHeader("Cache-Control", "no-store"); } }));
app.use(express.static(path.join(ROOT, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  },
}));

let cachedModel = null;
let cachedGps = null;
let lastProcessResult = null;
/** @type {Map<string, { result, payload }>} */
const segmentResultCache = new Map();

function loadJsonIfExists(filePath) {
  const result = loadJsonExtract(filePath);
  if (result.status === 'malformed') {
    console.warn(`[server] Ignoring malformed legacy JSON ${result.path}: ${result.error}`);
  }
  return result.data;
}

function listSegments() {
  return fs.readdirSync(ROOT)
    .filter((f) => /^qlog_f449c.*\.bz2$/i.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/_(\d+)\.bz2$/)[1], 10);
      const nb = parseInt(b.match(/_(\d+)\.bz2$/)[1], 10);
      return na - nb;
    });
}

function ensureData() {
  if (!cachedModel) {
    cachedModel = loadJsonIfExists(path.join(ROOT, 'modelV2_extracted.json'));
  }
  if (!cachedGps) {
    cachedGps = loadJsonIfExists(path.join(ROOT, 'gps_extracted.json'));
  }
  return { model: cachedModel, gps: cachedGps };
}

function filterBySegments(events, segments) {
  if (!segments || !segments.length) return events;
  const set = new Set(segments);
  return events.filter((e) => set.has(e.sourceFile));
}

function cacheKey(segments, options, fileAudits) {
  if (fileAudits?.length) {
    return buildCacheKey(segments, options, fileAudits, PROCESSING_VERSION);
  }
  const segKey = (segments && segments.length) ? [...segments].sort().join('|') : '__all__';
  return `${PROCESSING_VERSION}::${segKey}::${JSON.stringify(options || {})}`;
}

function serializeRouteChunk(c) {
  return {
    chunkId: c.chunkId,
    sessionId: c.sessionId,
    files: c.files,
    frameCount: c.frameCount,
    gpsPointCount: c.gpsPointCount,
    startLogMonoTime: c.startLogMonoTime,
    endLogMonoTime: c.endLogMonoTime,
    durationSec: c.durationSec,
    distanceM: c.distanceM,
    maxInternalGpsGapM: c.maxInternalGpsGapM,
    gpsTrajectory: c.gpsTrajectory,
    vehiclePath: c.vehiclePath,
    fusedLaneLines: c.fusedLaneLines,
    fusedRoadEdges: c.fusedRoadEdges,
    centreLine: c.centreLine,
    roadSurfacePolygons: c.roadSurfacePolygons,
    polygonRejections: c.polygonRejections,
    passCoverage: c.passCoverage,
    passDiagnostics: c.passDiagnostics,
    laneTracks: c.laneTracks,
    framePairAudits: c.framePairAudits,
    laneOnlyCandidates: c.laneOnlyCandidates,
    geometryLayers: c.geometryLayers ? {
      acceptedCount: c.geometryLayers.acceptedFusedLanes?.length,
      laneOnlyCount: c.geometryLayers.laneOnlyCandidates?.length,
      rejectedCount: c.geometryLayers.rejectedOutliers?.length,
    } : null,
  };
}

function buildApiPayload(result, segments, processedAt, meta = {}) {
  const {
    fromCache = false,
    cacheHit = false,
    cacheKey: resultCacheKey = null,
    fileAudits = [],
    staleCacheWarnings = [],
    segmentQualifications = [],
    poseSourceReports = [],
    geometryProvenance = [],
    passProvenance = [],
  } = meta;
  const geometryDebug = buildGeometryDebug(result, segments);
  const timeline = enrichTimelineWithMovement(result.timeline || [], result.vehiclePath);
  let laneDiagnostics = null;
  try {
    const mode5 = SLM.buildSegmentLocalMap(
      { ...result, processingVersion: PROCESSING_VERSION, processingOptions: result.processingOptions },
      { geometrySource: 'cleaned', timelineIndex: 0 },
    );
    laneDiagnostics = buildLaneDiagnostics(
      {
        processingVersion: PROCESSING_VERSION,
        routeChunks: result.routeChunks,
        processingOptions: result.processingOptions,
      },
      mode5,
      { geometrySource: 'cleaned', ...result.processingOptions },
    );
  } catch (err) {
    laneDiagnostics = { error: err.message };
  }
  return {
    processingVersion: PROCESSING_VERSION,
    processingOptions: result.processingOptions,
    processedAt,
    fromCache,
    cacheHit,
    cacheKey: resultCacheKey,
    sourceFileHashes: fileAudits.map((a) => ({ filename: a.filename, sha256: a.sha256 })),
    fileAudits,
    staleCacheWarnings,
    segmentQualifications,
    poseSourceReports,
    geometryProvenance,
    passProvenance,
    mode: result.mode,
    stats: result.stats,
    origin: result.origin,
    geometryDebug,
    laneDiagnostics,
    timeline,
    chunkDiagnostics: result.chunkDiagnostics,
    routeChunks: (result.routeChunks || []).map(serializeRouteChunk),
    gpsTrajectory: result.gpsTrajectory,
    vehiclePath: result.vehiclePath,
    fusedLanes: result.fusedLanes,
    fusedEdges: result.fusedEdges,
    centreLine: result.centreLine,
    roadSurfacePolygons: result.roadSurfacePolygons,
    laneConnections: result.laneConnections || [],
    laneTracks: result.laneTracks || [],
    frames: result.frames.map((f, i) => ({
      index: i,
      logMonoTime: f.logMonoTime,
      sourceFile: f.sourceFile,
      frameId: f.frameId,
      chunkId: f.chunkId,
      passId: f.passId ?? null,
      vehicleRelative: !!f.vehicleRelative,
      laneCount: (f.lanes || []).length,
      edgeCount: (f.edges || []).length,
      pose: f.pose || null,
      lanes: f.lanes,
      edges: f.edges,
      path: f.path,
    })),
  };
}

function runProcessing(segments, options) {
  const filenames = segments?.length ? segments : listSegments();
  const loaded = loadSegmentsData(ROOT, filenames, options);
  const {
    audits, modelEvents, gpsEvents, staleCacheWarnings, poseSourceReports,
  } = loaded;
  const segmentQualifications = qualifySegments(audits);

  const result = processRoute(modelEvents, gpsEvents, normalizeProcessOptions({
    ...options,
    segmentQualifications,
    poseSourceReport: poseSourceReports.length === 1 ? poseSourceReports[0] : poseSourceReports,
    fileAudits: audits,
  }));
  result.timeline = buildTimeline(result.frames);
  result.segments = filenames;
  result.laneConnections = buildLaneConnections(result.frames);
  result.laneTracks = buildLaneTrackList(result.frames);
  result.fileAudits = audits;
  result.staleCacheWarnings = staleCacheWarnings;
  result.segmentQualifications = segmentQualifications;
  result.poseSourceReports = poseSourceReports;

  const cacheResultId = buildCacheKey(filenames, options, audits, PROCESSING_VERSION);
  result.geometryProvenance = buildGeometryProvenance(result, audits, cacheResultId);
  result.passProvenance = (result.routeChunks || []).flatMap((c) => buildPassProvenance(c, audits));

  return result;
}

function buildLaneConnections(frames) {
  const connections = [];
  const byPass = new Map();
  for (const f of frames) {
    const key = `${f.chunkId ?? 0}:${f.passId ?? 0}`;
    if (!byPass.has(key)) byPass.set(key, []);
    byPass.get(key).push(f);
  }
  for (const group of byPass.values()) {
    group.sort((a, b) => Number(BigInt(a.logMonoTime) - BigInt(b.logMonoTime)));
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const cur = group[i];
      for (const lane of cur.lanes || []) {
        const match = (prev.lanes || []).find((l) => l.laneTrackId != null && l.laneTrackId === lane.laneTrackId);
        if (!match) continue;
        const p0 = meanPoint(match.points);
        const p1 = meanPoint(lane.points);
        connections.push({
          trackId: lane.laneTrackId,
          kind: 'lane',
          fromFrameId: prev.frameId,
          toFrameId: cur.frameId,
          from: p0,
          to: p1,
        });
      }
    }
  }
  return connections;
}

function meanPoint(points) {
  if (!points?.length) return { east: 0, north: 0 };
  let e = 0; let n = 0;
  for (const p of points) { e += p.east; n += p.north; }
  return { east: e / points.length, north: n / points.length };
}

function buildLaneTrackList(frames) {
  const tracks = new Map();
  for (const f of frames) {
    for (const lane of f.lanes || []) {
      if (lane.laneTrackId == null) continue;
      if (!tracks.has(lane.laneTrackId)) {
        tracks.set(lane.laneTrackId, { trackId: lane.laneTrackId, kind: 'lane', frameIds: [], points: [] });
      }
      const t = tracks.get(lane.laneTrackId);
      t.frameIds.push(f.frameId);
      t.points.push(meanPoint(lane.points));
    }
  }
  return [...tracks.values()];
}

app.get('/api/segments', (_req, res) => {
  const segments = listSegments();
  res.json({
    processingVersion: PROCESSING_VERSION,
    segments,
    segmentCount: segments.length,
    note: 'File identity audit runs on process, not on page load',
  });
});

app.post('/api/extract', async (_req, res) => {
  try {
    const segments = listSegments();
    const modelEvents = [];
    const gpsEvents = [];
    for (const file of segments) {
      modelEvents.push(...extractModel(path.join(ROOT, file)));
      gpsEvents.push(...extractGps(path.join(ROOT, file)));
    }
    const modelOut = {
      schema: 'bukapilot release_ka2 cereal/log.capnp ModelDataV2',
      extractedAt: new Date().toISOString(),
      totalEvents: modelEvents.length,
      events: modelEvents,
    };
    const gpsOut = {
      schema: 'bukapilot release_ka2 cereal/log.capnp GpsLocationData',
      extractedAt: new Date().toISOString(),
      totalEvents: gpsEvents.length,
      events: gpsEvents,
    };
    fs.writeFileSync(path.join(ROOT, 'modelV2_extracted.json'), JSON.stringify(modelOut, null, 2));
    fs.writeFileSync(path.join(ROOT, 'gps_extracted.json'), JSON.stringify(gpsOut, null, 2));
    cachedModel = modelOut;
    cachedGps = gpsOut;
    segmentResultCache.clear();
    clearParseCache();
    res.json({ ok: true, modelEvents: modelEvents.length, gpsEvents: gpsEvents.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/process', (req, res) => {
  try {
    const { segments, options = {}, bustCache = false } = req.body || {};
    const processedAt = new Date().toISOString();
    const filenames = segments?.length ? segments : listSegments();
    const hashIdentities = fileHashIdentities(ROOT, filenames);
    const fileAuditsForKey = hashIdentities.map((h) => ({ filename: h.filename, sha256: h.sha256 }));
    const key = cacheKey(filenames, options, fileAuditsForKey);

    if (bustCache) {
      segmentResultCache.delete(key);
      console.log(`[process] cache bust for ${key}`);
    }

    let result;
    let cacheHit = false;
    let payload;
    if (!bustCache && segmentResultCache.has(key)) {
      const cached = segmentResultCache.get(key);
      result = cached.result;
      payload = {
        ...cached.payload,
        processedAt,
        fromCache: true,
        cacheHit: true,
      };
      cacheHit = true;
      console.log(`[process] cache hit ${key}`);
    } else {
      result = runProcessing(filenames, options);
      payload = buildApiPayload(result, filenames, processedAt, {
        fromCache: false,
        cacheHit: false,
        cacheKey: key,
        fileAudits: result.fileAudits,
        staleCacheWarnings: result.staleCacheWarnings || [],
        segmentQualifications: result.segmentQualifications || [],
        poseSourceReports: result.poseSourceReports || [],
        geometryProvenance: result.geometryProvenance || [],
        passProvenance: result.passProvenance || [],
      });
      segmentResultCache.set(key, { result, payload });
      lastProcessResult = result;
      console.log(`[process] fresh run ${key}`);
    }

    if (!payload.fileAudits?.length) {
      payload.fileAudits = result.fileAudits || hashIdentities.map((h) => ({
        filename: h.filename,
        sha256: h.sha256,
        fileSizeBytes: h.fileSizeBytes,
      }));
    }
    console.log(`[process] version=${PROCESSING_VERSION} cacheHit=${cacheHit} at=${processedAt}`);
    for (const a of payload.fileAudits) {
      console.log(`  file ${a.filename} size=${a.fileSizeBytes} sha256=${a.sha256} modelV2=${a.modelV2Count} gps=${a.gpsCount}`);
    }
    console.log(`[process] segments=${payload.geometryDebug.segmentCount} passes=${payload.geometryDebug.passCount} polygons=${payload.geometryDebug.polygonCount} frames=${payload.stats?.frameCounts?.displayedTimelineFrames ?? payload.stats?.validModelFrames}`);
    for (const p of payload.geometryDebug.polygons) {
      console.log(`  polygon chunk=${p.chunkId} pass=${p.passId} points=${p.pointCount} bounds=${JSON.stringify(p.bounds)}`);
    }
    for (const ev of payload.geometryDebug.splitEvents) {
      console.log(`  split chunk=${ev.chunkId} pass=${ev.passId} reason=${ev.reason} frameId=${ev.frameId}`);
    }

    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack, processingVersion: PROCESSING_VERSION });
  }
});

app.get('/api/export/json', (_req, res) => {
  if (!lastProcessResult) return res.status(404).json({ error: 'No processed data' });
  res.json({ processingVersion: PROCESSING_VERSION, ...lastProcessResult });
});

app.get('/api/export/csv', (_req, res) => {
  if (!lastProcessResult) return res.status(404).json({ error: 'No processed data' });
  const rows = ['east,north,modelX,modelY,laneIndex,prob,logMonoTime,frameId,laneTrackId'];
  for (const f of lastProcessResult.frames) {
    for (const lane of f.lanes || []) {
      for (const p of lane.points || []) {
        rows.push([
          p.east, p.north, p.modelX ?? '', p.modelY ?? '',
          lane.laneIndex, lane.prob, f.logMonoTime, f.frameId, lane.laneTrackId ?? '',
        ].join(','));
      }
    }
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=lane_points.csv');
  res.send(rows.join('\n'));
});

app.get('/api/export/geojson', (_req, res) => {
  if (!lastProcessResult) return res.status(404).json({ error: 'No processed data' });
  if (lastProcessResult.mode !== 'global') {
    return res.status(400).json({ error: 'GeoJSON export requires global GPS mode' });
  }
  const features = [];
  for (const chunk of lastProcessResult.routeChunks || []) {
    const { localToLatLon } = require('./lib/projection');
    const origin = lastProcessResult.origin;
    if (chunk.gpsTrajectory?.length) {
      features.push({
        type: 'Feature',
        properties: { layer: 'gpsTrajectory', chunkId: chunk.chunkId },
        geometry: {
          type: 'LineString',
          coordinates: chunk.gpsTrajectory.map((p) => [p.longitude, p.latitude]),
        },
      });
    }
    for (const lane of chunk.fusedLaneLines || []) {
      features.push({
        type: 'Feature',
        properties: { layer: 'fusedLane', chunkId: chunk.chunkId, laneIndex: lane.laneIndex },
        geometry: {
          type: 'LineString',
          coordinates: lane.points.map((p) => {
            const ll = localToLatLon(p.east, p.north, origin);
            return [ll.longitude, ll.latitude];
          }),
        },
      });
    }
  }
  res.json({ type: 'FeatureCollection', features });
});

app.use('/api/video', createVideoRouter(ROOT));

function loadStage19Summary() {
  const auditPath = path.join(ROOT, 'audit_stage19_dataset_sensitivity.json');
  const publicationRoot = path.join(ROOT, 'stage19_bundle');
  const base = {
    productionLaneCountImplemented: false,
    hdMapSystemComplete: false,
    stage19ProcessingVersion: STAGE19_PROCESSING_VERSION,
    implementationCheckpoint: STAGE19_IMPLEMENTATION_CHECKPOINT,
    checkpointPreservation: STAGE19_CHECKPOINT_PRESERVATION,
  };

  if (!fs.existsSync(auditPath)) {
    return {
      ...base,
      available: false,
      note: 'Run npm run stage19:audit to generate Stage 19 audit outputs',
    };
  }

  let audit;
  try {
    audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  } catch {
    return { ...base, available: false, malformed: true, note: 'audit JSON malformed' };
  }

  let publicationState = audit.publicationState || 'unknown';
  let currentRunId = audit.runId;
  const currentPath = path.join(publicationRoot, 'current.json');
  if (fs.existsSync(currentPath)) {
    try {
      const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
      currentRunId = current.runId || currentRunId;
      publicationState = current.runId === audit.runId ? 'current' : 'stale_current_pointer';
    } catch {
      publicationState = 'malformed_current_pointer';
    }
  }

  const intervalDecisions = {};
  const promotionDecisions = {};
  const intervalCaveats = {};
  if (audit.assessmentStatusCounts) {
    for (const [status, count] of Object.entries(audit.assessmentStatusCounts)) {
      intervalDecisions[status] = count;
    }
  }
  if (audit.promotionCounts) {
    for (const [decision, count] of Object.entries(audit.promotionCounts)) {
      promotionDecisions[decision] = count;
    }
  }

  return {
    ...base,
    available: true,
    stage19Status: audit.stage19Status,
    frozenV11ProcessingVersion: audit.frozenV11ProcessingVersion,
    runId: audit.runId,
    currentRunId,
    observationCount: audit.observationCount,
    genuineCrossPassCandidateCount: audit.genuineCrossPassCandidateCount,
    crossPassBundleCount: audit.crossPassBundleCount,
    acceptedIntervalCount: audit.acceptedIntervalCount,
    assessmentStatusCounts: audit.assessmentStatusCounts,
    intervalDecisions,
    promotionDecisions,
    promotionDecisionSummary: audit.promotionCounts
      ? Object.entries(audit.promotionCounts).map(([k, v]) => `${k} × ${v}`).join(', ')
      : undefined,
    intervalCaveats,
    crossPassConflictCount: audit.crossPassConflictCount,
    conflictEvidenceAvailable: audit.conflictEvidenceAvailable,
    conflictEvidenceNote: audit.genuineCrossPassCandidateCount === 0
      ? '0 measured conflicts because 0 genuine cross-pass candidates are available (not confirmed agreement)'
      : undefined,
    insufficientEvidenceIntervalCount: audit.insufficientEvidenceIntervalCount
      ?? audit.assessmentStatusCounts?.insufficient_evidence
      ?? 0,
    insufficientCrossPassCandidateCount: audit.insufficientCrossPassCandidateCount,
    partitionFailureCount: audit.partitionFailureCount,
    partitionOverflowCount: audit.partitionOverflowCount,
    singletonChainCount: audit.singletonChainCount,
    nonTrivialPartitionCount: audit.nonTrivialPartitionCount,
    partitionStats: audit.partitionStats,
    fallbackOrFailurePct: audit.fallbackOrFailurePct,
    p3Stats: audit.p3Stats,
    bevImageCount: audit.bevImageCount,
    bevArtifacts: audit.bevArtifacts,
    bevValidationOk: (audit.bevArtifacts || []).every((a) => a.layerValidation?.pass),
    sensitivitySummary: audit.sensitivitySummary,
    schemaValidationOk: audit.schemaValidation?.ok,
    semanticValidationOk: audit.semanticValidation?.ok,
    productionQualityGatesOk: audit.productionQualityGates?.ok,
    normativeVerificationOk: audit.normativeVerification?.ok,
    publicationState,
    auditedAt: audit.auditedAt,
  };
}

app.get('/api/stage19/summary', (_req, res) => {
  res.json(loadStage19Summary());
});

app.get('/api/stage19/bundle/*', (req, res) => {
  try {
    const rel = req.params[0] || '';
    validateSafePath(rel);
    const publicationRoot = path.join(ROOT, 'stage19_bundle');
    const currentPath = path.join(publicationRoot, 'current.json');
    if (!fs.existsSync(currentPath)) return res.status(404).json({ error: 'no_current_run' });
    let current;
    try {
      current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
    } catch {
      return res.status(400).json({ error: 'malformed_current_pointer' });
    }
    if (!current?.runId) return res.status(404).json({ error: 'no_current_run' });
    const runDir = path.join(publicationRoot, 'runs', current.runId);
    if (!fs.existsSync(runDir)) return res.status(404).json({ error: 'incomplete_run' });
    const filePath = resolveBundlePath(publicationRoot, current.runId, rel);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not_found' });
    res.sendFile(filePath);
  } catch (e) {
    const code = e.message === 'malformed_path_encoding' ? 400 : 400;
    res.status(code).json({ error: e.message || 'bad_request' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof URIError) {
    return res.status(400).json({ error: 'malformed_path_encoding' });
  }
  next(err);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Qlog Road Geometry Viewer: http://localhost:${PORT}`);
    console.log(`Processing version: ${PROCESSING_VERSION}`);
  });
}

module.exports = app;
module.exports.loadStage19Summary = loadStage19Summary;
