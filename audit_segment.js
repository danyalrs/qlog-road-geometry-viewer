/** Full trajectory-topology audit for a single qlog segment. */
const fs = require('fs');
const path = require('path');
const { processRoute } = require('./lib/process_route');
const { detectPasses } = require('./lib/passes');
const { exportChunkGeometryDiagnostic } = require('./lib/sd_fusion');
const { dist2d, maxInternalGpsGap, trajectoryLength } = require('./lib/chunking');
const { extractFromFile } = require('./extract_modelv2');

const file = process.argv[2] || 'qlog_f449c_2.bz2';
const ROOT = __dirname;

function load(fileName) {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'modelV2_extracted.json'), 'utf8'));
  const gps = JSON.parse(fs.readFileSync(path.join(ROOT, 'gps_extracted.json'), 'utf8'));
  return {
    modelEvents: model.events.filter((e) => e.sourceFile === fileName),
    gpsEvents: gps.events.filter((e) => e.sourceFile === fileName),
  };
}

function main() {
  const { modelEvents, gpsEvents } = load(file);
  const live = extractFromFile(path.join(ROOT, file));
  const result = processRoute(modelEvents, gpsEvents, {});
  const chunk = result.routeChunks[0];
  const vp = chunk?.vehiclePath || [];
  const { passes, diagnostics: passDiag } = detectPasses(vp, {});

  const gpsTraj = chunk?.gpsTrajectory || [];
  const accs = gpsTraj.map((g) => g.horizontalAccuracy).filter((a) => a != null);

  const report = {
    file,
    durationSec: chunk?.durationSec,
    decodedModelV2: live.length,
    cachedModelV2: modelEvents.length,
    transformedFrames: result.frames.length,
    rejectedGpsAlignment: result.stats.rejectedModelFrames,
    gpsSamples: gpsTraj.length,
    startCoord: vp[0] ? { east: vp[0].east, north: vp[0].north, logMonoTime: vp[0].logMonoTime, frameId: vp[0].frameId } : null,
    endCoord: vp.length ? { east: vp[vp.length - 1].east, north: vp[vp.length - 1].north, logMonoTime: vp[vp.length - 1].logMonoTime, frameId: vp[vp.length - 1].frameId } : null,
    startEndDisplacementM: vp.length >= 2 ? dist2d(vp[0], vp[vp.length - 1]) : 0,
    travelledGpsDistanceM: trajectoryLength(gpsTraj),
    travelledVehiclePathM: trajectoryLength(vp),
    passCount: passes.length,
    directionReversals: passDiag.directionReversals,
    selfIntersections: passDiag.selfIntersections,
    minNonAdjacentDistM: passDiag.minNonAdjacentDistM,
    suspiciousLoop: passDiag.suspiciousLoop,
    splitEvents: passDiag.splitEvents,
    maxGpsGapM: maxInternalGpsGap(gpsTraj),
    gpsAccuracy: accs.length ? { min: Math.min(...accs), max: Math.max(...accs), median: accs.sort((a, b) => a - b)[Math.floor(accs.length / 2)] } : null,
    fusedLaneFragments: chunk?.fusedLaneLines?.length ?? 0,
    fusedEdgeFragments: chunk?.fusedRoadEdges?.length ?? 0,
    acceptedPolygons: chunk?.roadSurfacePolygons?.length ?? 0,
    rejectedPolygons: chunk?.polygonRejections?.length ?? 0,
    rejectionReasons: [...new Set((chunk?.polygonRejections || []).flatMap((r) => r.reasons || []))],
    passCoverage: chunk?.passCoverage,
    passes: passes.map((p) => ({
      passId: p.passId,
      frameCount: p.frameCount,
      pathLengthM: p.pathLengthM,
      suspiciousGps: p.suspiciousGps,
      trusted: p.trusted,
      selfIntersections: p.selfIntersections?.count,
    })),
  };

  const outPath = path.join(ROOT, `audit_${file.replace('.bz2', '')}.json`);
  const diag = chunk ? exportChunkGeometryDiagnostic(chunk.frames, chunk.vehiclePath, result.options) : null;
  fs.writeFileSync(outPath, JSON.stringify({ report, diagnostic: diag, passDiagnostics: passDiag }, null, 2));

  console.log(`\n=== Audit: ${file} ===\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log('\nExported:', outPath);
}

main();
