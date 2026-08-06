#!/usr/bin/env node
/**
 * Stage 16 — projected lane-line observation prototype CLI.
 * Usage: node stage16_lane_line_projection.js [--out audit_stage16_projected_lane_observations.json]
 */
const fs = require('fs');
const path = require('path');
const {
  buildStage16ProjectionAudit,
  generateStage16Markdown,
} = require('./lib/stage16_projection_audit');
const { generateBevInspections } = require('./lib/stage16_bev_inspection');

const ROOT = __dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  let out = path.join(ROOT, 'audit_stage16_projected_lane_observations.json');
  let obsOut = path.join(ROOT, 'projected_lane_observations_v0.json');
  let segments = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i] === '--observations-out' && args[i + 1]) obsOut = args[++i];
    else if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => `qlog_f449c_${n.trim()}.bz2`);
    }
  }
  return { out, obsOut, segments };
}

function main() {
  const { out, obsOut, segments } = parseArgs();
  const opts = segments ? { filenames: segments } : {};

  const audit = buildStage16ProjectionAudit(ROOT, { ...opts, includeAllObservations: true });
  const observations = audit.observations || [];
  delete audit.observations;

  const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.writeFileSync(outPath, JSON.stringify(audit, null, 2));

  const obsPath = path.isAbsolute(obsOut) ? obsOut : path.join(ROOT, obsOut);
  fs.writeFileSync(obsPath, JSON.stringify({
    schemaVersion: audit.projectionSchemaVersion,
    processingVersion: audit.stage16ProcessingVersion,
    observationCount: observations.length,
    observations,
  }, null, 2));

  const reportDir = path.join(ROOT, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'stage16_projected_lane_observations.md');
  fs.writeFileSync(reportPath, generateStage16Markdown(audit));

  const bevDir = path.join(reportDir, 'stage16_bev');
  const bevManifest = generateBevInspections(audit, observations, bevDir, {
    modelEvents: audit.modelEvents || [],
  });
  delete audit.modelEvents;

  console.log(`Stage 16 projected lane-line observations — frozen baseline ${audit.frozenRoadSurfaceVersion}`);
  console.log(`  Segments: ${audit.physicalRouteSegments}, chunks: ${audit.totalRouteChunks}`);
  console.log(`  Source slots: ${audit.datasetSummary.totalSourceSlots}, projected: ${audit.datasetSummary.projectedObservations}`);
  console.log(`  Projection consistency: ${audit.projectionConsistency.passed}`);
  console.log(`  v11 geometry modified: ${audit.v11GeometryModified}`);
  console.log(`\nWrote ${outPath}`);
  console.log(`Wrote ${obsPath}`);
  console.log(`Wrote ${reportPath}`);
  console.log(`Wrote ${bevDir} (${bevManifest.length} BEV inspections)`);
}

if (require.main === module) main();

module.exports = { main };
