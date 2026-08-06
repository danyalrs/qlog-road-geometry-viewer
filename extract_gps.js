/**
 * Extract gpsLocation and gpsLocationExternal from qlog files.
 * Uses Cap'n Proto union discriminators via qlog_decoder (tags 20 and 47).
 */
const fs = require('fs');
const path = require('path');
const {
  iterateEvents,
  getGpsLocation,
  UNION,
} = require('./lib/qlog_decoder');
const { gpsStructToRecord } = require('./lib/gps_validate');

function extractFromBuffer(buf, sourceFile) {
  const records = [];
  for (const item of iterateEvents(buf, sourceFile)) {
    let source = null;
    if (item.unionTag === UNION.GPS_LOCATION) source = 'gpsLocation';
    else if (item.unionTag === UNION.GPS_LOCATION_EXTERNAL) source = 'gpsLocationExternal';
    else continue;

    const gps = getGpsLocation(item.event);
    records.push(gpsStructToRecord(item.event, gps, source, sourceFile, item.sourceEventIndex));
  }
  return records;
}

function extractFromFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return extractFromBuffer(buf, path.basename(filePath));
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--')) || __dirname;
  const outPath = args.includes('--out')
    ? args[args.indexOf('--out') + 1]
    : path.join(dir, 'gps_extracted.json');

  const pattern = /^qlog_f449c.*\.bz2$/i;
  const files = fs.readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/_(\d+)\.bz2$/)[1], 10);
      const nb = parseInt(b.match(/_(\d+)\.bz2$/)[1], 10);
      return na - nb;
    });

  if (!files.length) {
    console.error('No qlog_f449c*.bz2 files found in', dir);
    process.exit(1);
  }

  console.log('Extracting GPS from', files.length, 'files...');
  const allRecords = [];
  const summary = [];
  let gpsLocation = 0;
  let gpsExternal = 0;

  for (const file of files) {
    const records = extractFromFile(path.join(dir, file));
    gpsLocation += records.filter((r) => r.source === 'gpsLocation').length;
    gpsExternal += records.filter((r) => r.source === 'gpsLocationExternal').length;
    if (records.length) {
      summary.push({ file, count: records.length });
      allRecords.push(...records);
    }
  }

  const output = {
    schema: 'bukapilot release_ka2 cereal/log.capnp GpsLocationData',
    unionTags: { gpsLocation: UNION.GPS_LOCATION, gpsLocationExternal: UNION.GPS_LOCATION_EXTERNAL },
    extractedAt: new Date().toISOString(),
    totalEvents: allRecords.length,
    gpsLocationCount: gpsLocation,
    gpsLocationExternalCount: gpsExternal,
    files: summary,
    events: allRecords,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log('Wrote', allRecords.length, 'GPS events to', outPath);
  console.log('  gpsLocation:', gpsLocation, '| gpsLocationExternal:', gpsExternal);
}

if (require.main === module) main();

module.exports = { extractFromFile, extractFromBuffer };
