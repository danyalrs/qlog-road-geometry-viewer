/** Frame-count and GPS-gap investigation for a single qlog segment. */
const fs = require('fs');
const path = require('path');
const { extractFromFile } = require('./extract_modelv2');
const { iterateEvents } = require('./lib/qlog_decoder');
const { processRoute, buildTimeline, filterContinuousGpsPoints, maxGapBetweenChunks } = require('./lib/process_route');
const { exportChunkGeometryDiagnostic } = require('./lib/sd_fusion');

const ROOT = __dirname;
const file = process.argv[2] || 'qlog_f449c_0.bz2';

function load() {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'modelV2_extracted.json'), 'utf8'));
  const gps = JSON.parse(fs.readFileSync(path.join(ROOT, 'gps_extracted.json'), 'utf8'));
  return {
    modelEvents: model.events.filter((e) => e.sourceFile === file),
    gpsEvents: gps.events.filter((e) => e.sourceFile === file),
  };
}

function rawDecodeStats(filePath) {
  const buf = fs.readFileSync(path.join(ROOT, filePath));
  let total = 0;
  let modelV2 = 0;
  for (const item of iterateEvents(buf, filePath)) {
    total++;
    if (item.event.isModelV2()) modelV2++;
  }
  return { totalDecodedEvents: total, decodedModelV2Events: modelV2 };
}

function main() {
  const { modelEvents, gpsEvents } = load();
  const live = extractFromFile(path.join(ROOT, file));
  const raw = rawDecodeStats(file);
  const result = processRoute(modelEvents, gpsEvents, {});
  const timeline = buildTimeline(result.frames);
  const chunk = result.routeChunks[0];

  const t0 = modelEvents.length ? BigInt(modelEvents[0].logMonoTime) : 0n;
  const t1 = modelEvents.length ? BigInt(modelEvents[modelEvents.length - 1].logMonoTime) : 0n;
  const durationSec = modelEvents.length > 1 ? Number(t1 - t0) / 1e9 : 0;

  console.log(`\n=== Frame investigation: ${file} ===\n`);
  console.log('Qlog duration (s):', durationSec.toFixed(2));
  console.log('Total decoded events:', raw.totalDecodedEvents);
  console.log('Decoded modelV2 events (live extract):', live.length);
  console.log('Decoded modelV2 events (cached JSON):', modelEvents.length);
  console.log('modelV2 frequency (Hz):', durationSec > 0 ? ((modelEvents.length - 1) / durationSec).toFixed(3) : 'n/a');
  console.log('');
  console.log('Pipeline stages:');
  console.log('  model events in source file:', modelEvents.length);
  console.log('  valid geometry frames:', result.stats.pipelineAudit?.modelEventsWithGeometry);
  console.log('  GPS-aligned transformed frames:', result.frames.length);
  console.log('  rejected GPS alignment:', result.stats.rejectedModelFrames);
  console.log('  timeline frames:', timeline.length);
  console.log('  rendered frames:', timeline.length);
  console.log('  downsampling:', 'none');
  console.log('');
  console.log('Meaning of "21 frames":', result.stats.pipelineAudit?.meaningOfFrameCount);
  console.log('Rejection reason:', result.stats.pipelineAudit?.rejectionReason);
  console.log('');

  if (chunk) {
    const diag = exportChunkGeometryDiagnostic(chunk.frames, chunk.vehiclePath, result.options);
    const outPath = path.join(ROOT, `geometry_diagnostic_${file.replace('.bz2', '')}.json`);
    fs.writeFileSync(outPath, JSON.stringify(diag, null, 2));
    console.log('Exported geometry diagnostic:', outPath);
    console.log('');
    console.log('SD fusion metrics:');
    console.log('  input edge observations:', diag.diagnostics.inputEdgeObservationCount);
    console.log('  rejected observations:', diag.diagnostics.rejectedEdgeObservationCount);
    console.log('  fused left points:', diag.diagnostics.fusedLeftPointCount);
    console.log('  fused right points:', diag.diagnostics.fusedRightPointCount);
    console.log('  spike count:', diag.diagnostics.spikeCount);
    console.log('  polygon count:', chunk.roadSurfacePolygons.length);
    console.log('  self-intersections:', diag.diagnostics.selfIntersectionCount);
    if (chunk.roadSurfacePolygons[0]?.stats) {
      const s = chunk.roadSurfacePolygons[0].stats;
      console.log('  median width:', s.medianWidth?.toFixed(2), 'max width:', s.maxWidth?.toFixed(2));
    }
    let maxJump = 0;
    for (const e of chunk.fusedRoadEdges || []) {
      for (let i = 1; i < e.points.length; i++) {
        const d = Math.hypot(e.points[i].east - e.points[i - 1].east, e.points[i].north - e.points[i - 1].north);
        maxJump = Math.max(maxJump, d);
      }
    }
    console.log('  max boundary consecutive gap:', maxJump.toFixed(2), 'm');
  }
}

main();
