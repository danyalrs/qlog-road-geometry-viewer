/**
 * Qlog file identity audit — hash, message counts, timestamps.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const capnp = require('capnp-ts');
const Log = require('@commaai/log_reader/capnp/log.capnp');
const { iterateEvents, UNION, getModelV2, getGpsLocation } = require('./qlog_decoder');

const TAG_NAMES = {
  0: 'initData',
  20: 'gpsLocationDEPRECATED',
  47: 'gpsLocationExternal',
  70: 'liveLocationKalman',
  73: 'modelV2',
};

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return sha256Buffer(buf);
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function auditQlogFile(filePath) {
  const { parseQlogFile } = require('./qlog_parse_once');
  const parsed = parseQlogFile(filePath);
  return parsed.audit;
}

function auditSegments(root, filenames) {
  return filenames.map((f) => auditQlogFile(path.join(root, f)));
}

function configHash(options = {}) {
  return crypto.createHash('sha256').update(JSON.stringify(options)).digest('hex').slice(0, 16);
}

function buildCacheKey(segments, options, fileAudits, processingVersion) {
  const hashes = (fileAudits || []).map((a) => `${a.filename}:${a.sha256}`).sort().join('|');
  return `${processingVersion}::${configHash(options)}::${hashes}`;
}

module.exports = {
  auditQlogFile,
  auditSegments,
  sha256File,
  sha256Buffer,
  configHash,
  buildCacheKey,
};
