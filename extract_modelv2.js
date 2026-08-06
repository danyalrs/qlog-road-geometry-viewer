/**
 * Extract modelV2 events from bukapilot qlog files.
 * Schema: https://github.com/kommuai/bukapilot/tree/release_ka2 (cereal/log.capnp)
 *
 * These qlogs use union tag 73 for modelV2 (matches bundled log_reader schema).
 * Note: ka2 log.capnp assigns modelV2 @75, but recorded logs here still emit tag 73.
 */
const fs = require('fs');
const path = require('path');
const { iterateEvents, getModelV2 } = require('./lib/qlog_decoder');
const toJSON = require('@commaai/capnp-json');

const MODEL_V2_TAG = 73;

function replacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Convert capnp-json PascalCase output to camelCase for readability. */
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

function extractFromBuffer(buf, sourceFile) {
  const records = [];
  for (const item of iterateEvents(buf, sourceFile)) {
    if (!item.event.isModelV2()) continue;
    const model = getModelV2(item.event);
    records.push({
      logMonoTime: item.logMonoTime.toString(),
      valid: item.valid,
      sourceFile,
      sourceEventIndex: item.sourceEventIndex,
      modelV2: modelV2ToJson(model),
    });
  }
  return records;
}

function extractFromFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return extractFromBuffer(buf, path.basename(filePath));
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--')) || __dirname;
  const outPath = args.includes('--out')
    ? args[args.indexOf('--out') + 1]
    : path.join(dir, 'modelV2_extracted.json');

  const pattern = /^qlog_f449c.*\.bz2$/i;
  const files = fs.readdirSync(dir)
    .filter(f => pattern.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/_(\d+)\.bz2$/)[1], 10);
      const nb = parseInt(b.match(/_(\d+)\.bz2$/)[1], 10);
      return na - nb;
    });

  if (!files.length) {
    console.error('No qlog_f449c*.bz2 files found in', dir);
    process.exit(1);
  }

  console.log('Extracting modelV2 from', files.length, 'files...');
  const allRecords = [];
  const summary = [];

  for (const file of files) {
    const records = extractFromFile(path.join(dir, file));
    if (records.length) {
      summary.push({ file, count: records.length });
      allRecords.push(...records);
    }
  }

  const output = {
    schema: 'bukapilot release_ka2 cereal/log.capnp ModelDataV2',
    extractedAt: new Date().toISOString(),
    totalEvents: allRecords.length,
    files: summary,
    events: allRecords,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, replacer, 2));
  console.log('Wrote', allRecords.length, 'modelV2 events to', outPath);
  console.log('Files with data:', summary.length, '/', files.length);
  if (summary.length) {
    console.log('Sample files:', summary.slice(0, 5).map(s => s.file + '(' + s.count + ')').join(', '));
  }
}

if (require.main === module) main();

module.exports = { extractFromFile, extractFromBuffer, modelV2ToJson, MODEL_V2_TAG };
