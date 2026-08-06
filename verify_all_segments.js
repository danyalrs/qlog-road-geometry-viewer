/** Process segments 0,2,4,6 and all — report pass/polygon coverage. */
const fs = require('fs');
const path = require('path');
const { processRoute } = require('./lib/process_route');

const ROOT = __dirname;
const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'modelV2_extracted.json'), 'utf8'));
const gps = JSON.parse(fs.readFileSync(path.join(ROOT, 'gps_extracted.json'), 'utf8'));

function load(files) {
  const set = new Set(files);
  return {
    modelEvents: model.events.filter((e) => set.has(e.sourceFile)),
    gpsEvents: gps.events.filter((e) => set.has(e.sourceFile)),
  };
}

function report(label, files) {
  const { modelEvents, gpsEvents } = load(files);
  const r = processRoute(modelEvents, gpsEvents, {});
  console.log(`\n=== ${label} ===`);
  console.log(`Chunks: ${r.routeChunks.length}, Frames: ${r.frames.length}, Rejected model: ${r.stats.rejectedModelFrames}`);
  for (const c of r.routeChunks) {
    console.log(`  Chunk ${c.chunkId}: ${c.sourceFiles?.join(', ')}`);
    console.log(`    passes: ${c.passCoverage?.length ?? 0}, polygons: ${c.roadSurfacePolygons?.length ?? 0}, rejected: ${c.polygonRejections?.length ?? 0}`);
    for (const p of c.passCoverage || []) {
      console.log(`      pass ${p.passId}: frames=${p.frameCount} dist=${p.pathLengthM?.toFixed(1)}m paired=${p.pairedCoverageM?.toFixed(1)}m poly=${p.acceptedPolygonCount} rej=${p.rejectedPolygonCount} cov=${p.coveragePercent?.toFixed(1)}% suspicious=${p.suspiciousGps}`);
    }
  }
  const totalPoly = r.routeChunks.reduce((n, c) => n + (c.roadSurfacePolygons?.length || 0), 0);
  const totalRej = r.routeChunks.reduce((n, c) => n + (c.polygonRejections?.length || 0), 0);
  console.log(`  TOTAL polygons: ${totalPoly}, rejected: ${totalRej}`);
  return r;
}

const segs = ['qlog_f449c_0.bz2', 'qlog_f449c_2.bz2', 'qlog_f449c_4.bz2', 'qlog_f449c_6.bz2'];
for (const s of segs) report(s, [s]);
report('ALL', [...new Set(model.events.map((e) => e.sourceFile))]);
