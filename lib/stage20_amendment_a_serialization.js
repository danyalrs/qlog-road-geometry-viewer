/**
 * Stage 20 Amendment A — canonical JSON and content hashing.
 */
const crypto = require('crypto');

const TIMESTAMP_EXCLUDE_PATHS = new Set([
  'boundaryProvenance.copiedAt',
  'provenance.createdAt',
]);

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

function stripExcludedTimestamps(value, prefix = '') {
  if (Array.isArray(value)) return value.map((v, i) => stripExcludedTimestamps(v, `${prefix}[${i}]`));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (TIMESTAMP_EXCLUDE_PATHS.has(path)) continue;
      out[key] = stripExcludedTimestamps(val, path);
    }
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function contentHashSha256(payload) {
  const stripped = stripExcludedTimestamps(payload);
  return crypto.createHash('sha256').update(JSON.stringify(sortKeysDeep(stripped))).digest('hex');
}

function sortRuns(runs) {
  return [...runs].sort((a, b) => a.dividerRunId.localeCompare(b.dividerRunId));
}

function sortGaps(gaps) {
  return [...gaps].sort((a, b) => a.gapId.localeCompare(b.gapId));
}

function sortLinkageRecords(records) {
  return [...records].sort((a, b) => a.corridorLinkageId.localeCompare(b.corridorLinkageId));
}

module.exports = {
  canonicalJson,
  contentHashSha256,
  sortRuns,
  sortGaps,
  sortLinkageRecords,
  sortKeysDeep,
  stripExcludedTimestamps,
};
