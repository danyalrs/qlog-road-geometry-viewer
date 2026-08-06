/**
 * Load qlog data directly from .bz2 files with hash validation.
 * Uses single-pass parse + in-memory cache keyed by SHA-256.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseQlogBuffer, buildAuditFromParse } = require('./qlog_parse_once');
const { sha256Buffer } = require('./qlog_audit');
const { loadJsonExtract } = require('./json_extract');

/** @type {Map<string, { audit, modelEvents, gpsEvents, poseSourceReport, sha256 }>} */
const parseCache = new Map();

function cachedEventsForFile(json, filename) {
  if (!json?.events) return [];
  return json.events.filter((e) => e.sourceFile === filename);
}

const EXTRACT_CACHE_DIR = path.join(__dirname, '..', '.cache', 'qlog-extracts');

function ensureExtractCacheDir() {
  if (!fs.existsSync(EXTRACT_CACHE_DIR)) {
    fs.mkdirSync(EXTRACT_CACHE_DIR, { recursive: true });
  }
}

function extractCachePath(sha256) {
  return path.join(EXTRACT_CACHE_DIR, `${sha256}.json`);
}

function loadDiskExtract(sha256) {
  const p = extractCachePath(sha256);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveDiskExtract(sha256, entry) {
  ensureExtractCacheDir();
  fs.writeFileSync(extractCachePath(sha256), JSON.stringify({
    sha256,
    audit: entry.audit,
    modelEvents: entry.modelEvents,
    gpsEvents: entry.gpsEvents,
    poseSourceReport: entry.poseSourceReport,
    cachedAt: new Date().toISOString(),
  }));
}

function loadSegmentParsed(root, filename) {
  const absPath = path.join(root, filename);
  const stat = fs.statSync(absPath);
  const buf = fs.readFileSync(absPath);
  const hash = sha256Buffer(buf);
  const cacheKey = `${hash}:${stat.size}`;

  if (parseCache.has(cacheKey)) {
    const cached = parseCache.get(cacheKey);
    return { ...cached, extractionSource: 'memoryCache' };
  }

  const disk = loadDiskExtract(hash);
  if (disk?.modelEvents && disk.audit) {
    const entry = {
      audit: { ...disk.audit, extractionSource: 'diskCache' },
      modelEvents: disk.modelEvents,
      gpsEvents: disk.gpsEvents,
      poseSourceReport: disk.poseSourceReport,
      sha256: hash,
      extractionSource: 'diskCache',
    };
    parseCache.set(cacheKey, entry);
    return entry;
  }

  const result = parseQlogBuffer(buf, filename);
  const audit = buildAuditFromParse(absPath, stat, result.sha256, result.parsed);
  const entry = {
    audit: { ...audit, extractionSource: 'liveBz2' },
    modelEvents: result.modelEvents,
    gpsEvents: result.gpsEvents,
    poseSourceReport: result.poseSourceReport,
    sha256: result.sha256,
    extractionSource: 'liveBz2',
  };
  parseCache.set(cacheKey, entry);
  saveDiskExtract(hash, entry);
  return entry;
}

/** Fast SHA-256 identities for cache lookup without full Cap'n Proto parse. */
function fileHashIdentities(root, filenames) {
  return filenames.map((filename) => {
    const absPath = path.join(root, filename);
    const stat = fs.statSync(absPath);
    const buf = fs.readFileSync(absPath);
    const sha256 = sha256Buffer(buf);
    return { filename, sha256, fileSizeBytes: stat.size };
  });
}

function loadSegmentsData(root, filenames, options = {}) {
  const legacyPath = path.join(root, 'modelV2_extracted.json');
  const legacyExtract = loadJsonExtract(legacyPath);
  const legacyExtractWarnings = [];
  const cachedModel = legacyExtract.data;

  if (legacyExtract.status === 'malformed') {
    legacyExtractWarnings.push({
      file: legacyExtract.path,
      status: 'malformed',
      error: legacyExtract.error,
      message: `Ignoring malformed legacy extract ${path.basename(legacyExtract.path)}: ${legacyExtract.error}. Using live SHA-keyed .bz2 extracts.`,
    });
    console.warn(`[qlog_data] ${legacyExtractWarnings[0].message}`);
  } else if (legacyExtract.status === 'missing') {
    legacyExtractWarnings.push({
      file: legacyExtract.path,
      status: 'missing',
      message: `No legacy modelV2_extracted.json — using live SHA-keyed .bz2 extracts only.`,
    });
  }

  const staleCacheWarnings = [];

  const audits = [];
  const modelEvents = [];
  const gpsEvents = [];
  const poseSourceReports = [];

  for (const filename of filenames) {
    const entry = loadSegmentParsed(root, filename);
    audits.push(entry.audit);
    poseSourceReports.push(entry.poseSourceReport);
    modelEvents.push(...entry.modelEvents);
    gpsEvents.push(...entry.gpsEvents);

    if (cachedModel) {
      const cachedCount = cachedEventsForFile(cachedModel, filename).length;
      if (cachedCount !== entry.modelEvents.length) {
        staleCacheWarnings.push({
          filename,
          fileSha256: entry.sha256,
          cachedModelV2Count: cachedCount,
          liveModelV2Count: entry.modelEvents.length,
          cachedExtractedAt: cachedModel.extractedAt,
          message: `Stale modelV2_extracted.json: cached ${cachedCount} events vs live ${entry.modelEvents.length}`,
        });
      }
    }
  }

  return {
    audits,
    modelEvents,
    gpsEvents,
    poseSourceReports,
    staleCacheWarnings,
    legacyExtractWarnings,
    configHash: require('./qlog_audit').configHash(options),
  };
}

function clearParseCache() {
  parseCache.clear();
}

module.exports = {
  loadSegmentsData,
  loadSegmentParsed,
  fileHashIdentities,
  clearParseCache,
  loadJsonExtract: (p) => loadJsonExtract(p),
  parseCache,
};
