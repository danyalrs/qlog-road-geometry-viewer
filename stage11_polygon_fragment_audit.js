#!/usr/bin/env node
/**
 * Stage 11 full-dataset polygon fragment audit.
 * Usage:
 *   node stage11_polygon_fragment_audit.js --all --out audit_stage11_fragments_v11.json
 *   node stage11_polygon_fragment_audit.js --segments 2,10,46
 */
const fs = require('fs');
const path = require('path');
const { PROCESSING_VERSION } = require('./lib/version');
const {
  DEFAULT_OPTS,
  auditSegmentFragments,
  buildDatasetDistributions,
  loadV10PolygonCounts,
} = require('./lib/stage11_fragment_audit');

const ROOT = __dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  let segments = null;
  let all = false;
  let out = path.join(ROOT, 'audit_stage11_fragments_v11.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') all = true;
    else if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => parseInt(n.trim(), 10));
    } else if (args[i] === '--out' && args[i + 1]) out = args[++i];
  }
  if (all) {
    segments = fs.readdirSync(ROOT)
      .filter((f) => /^qlog_f449c.*\.bz2$/i.test(f))
      .map((f) => parseInt(f.match(/_(\d+)/)[1], 10))
      .sort((a, b) => a - b);
  }
  if (!segments) segments = [2, 5, 10, 24, 46, 58, 99];
  return { segments, out };
}

function main() {
  const { segments, out } = parseArgs();
  const v10Counts = loadV10PolygonCounts();
  console.log(`Stage 11 fragment audit — ${segments.length} segment(s), version ${PROCESSING_VERSION}`);

  const results = [];
  for (const seg of segments) {
    process.stdout.write(`  seg ${seg}...`);
    try {
      const audit = auditSegmentFragments(seg, DEFAULT_OPTS, v10Counts.get(seg) ?? null);
      console.log(` ${audit.polygonCount} polygons (v10 ${audit.v10PolygonCount ?? '?'})`);
      results.push(audit);
    } catch (e) {
      console.log(` ERROR ${e.message}`);
      results.push({ segmentId: seg, error: e.message });
    }
  }

  const ok = results.filter((r) => !r.error);
  const distributions = buildDatasetDistributions(ok);
  const highFragment = ok.filter((r) => r.polygonCount >= 10).map((r) => r.segmentId);

  const output = {
    auditedAt: new Date().toISOString(),
    processingVersion: PROCESSING_VERSION,
    segmentCount: results.length,
    distributions,
    segmentsWithAtLeast10Polygons: highFragment,
    results,
  };

  fs.writeFileSync(path.isAbsolute(out) ? out : path.join(ROOT, out), JSON.stringify(output, null, 2));
  console.log(`\nWrote ${out}`);
  console.log(`Polygons/segment median: ${distributions.polygonsPerSegment.median}, max: ${distributions.polygonsPerSegment.max}`);
  console.log(`Overlap pairs total: ${distributions.overlapPairsTotal}, tiny fragments: ${distributions.tinyPolygonCount}`);
  console.log(`Sharp v10→v11 increases (delta≥3): ${distributions.sharpIncreasesFromV10.length}`);
}

if (require.main === module) main();

module.exports = { main, parseArgs };
