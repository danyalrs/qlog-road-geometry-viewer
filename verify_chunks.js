/** Verification with GPS gap assertions. */
const fs = require('fs');
const path = require('path');
const { processRoute } = require('./lib/process_route');

const ROOT = __dirname;
const MAX_GPS_GAP = 30;
const TOLERANCE = 0.5;

function loadData() {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'modelV2_extracted.json'), 'utf8'));
  const gps = JSON.parse(fs.readFileSync(path.join(ROOT, 'gps_extracted.json'), 'utf8'));
  return { model, gps };
}

function filterEvents(events, segments) {
  const set = new Set(segments);
  return events.filter((e) => set.has(e.sourceFile));
}

function report(label, segments) {
  const { model, gps } = loadData();
  const modelEvents = filterEvents(model.events, segments);
  const gpsEvents = filterEvents(gps.events, segments);
  const result = processRoute(modelEvents, gpsEvents, { maxGpsGapM: MAX_GPS_GAP });

  const maxInternal = result.stats.maxInternalGpsGapPerChunkM ?? 0;
  const maxBetween = result.stats.maxGpsGapBetweenChunksM ?? 0;

  console.log(`\n=== ${label} ===`);
  console.log('Files:', segments.length);
  console.log('Route chunks:', result.stats.routeChunkCount);
  console.log('Max internal GPS gap per chunk (m):', maxInternal.toFixed(1));
  console.log('Max GPS gap between chunks (m):', maxBetween.toFixed(1));
  console.log('Road polygon count:', result.stats.roadPolygonCount);
  console.log('Largest polygon area:', result.stats.largestPolygonArea.toFixed(1));
  console.log('Largest polygon width:', result.stats.largestPolygonWidth?.toFixed?.(1) ?? 'n/a');
  console.log('Rejected polygons:', result.stats.rejectedPolygonCount);

  if (maxInternal > MAX_GPS_GAP + TOLERANCE) {
    console.error(`ASSERTION FAILED: internal gap ${maxInternal.toFixed(1)}m > ${MAX_GPS_GAP}m`);
    for (const c of result.chunkDiagnostics) {
      if ((c.maxInternalGpsGapM || 0) > MAX_GPS_GAP + TOLERANCE) {
        console.error(`  chunk ${c.chunkId}: internal=${c.maxInternalGpsGapM?.toFixed(1)} raw=${c.rawGpsMaxGapM?.toFixed(1)} files=${c.files?.join(',')}`);
      }
    }
    process.exitCode = 1;
  }

  return result;
}

const one = ['qlog_f449c_0.bz2'];
const two = ['qlog_f449c_0.bz2', 'qlog_f449c_1.bz2'];
const all = fs.readdirSync(ROOT)
  .filter((f) => /^qlog_f449c.*\.bz2$/i.test(f))
  .sort((a, b) => parseInt(a.match(/_(\d+)\.bz2$/)[1], 10) - parseInt(b.match(/_(\d+)\.bz2$/)[1], 10));

report('1. Single segment (qlog_f449c_0.bz2)', one);
report('2. Two consecutive segments (0 + 1)', two);
report('3. All segments', all);
