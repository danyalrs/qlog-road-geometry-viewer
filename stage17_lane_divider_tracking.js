#!/usr/bin/env node
/**
 * Stage 17 — temporal divider association and supported-run fusion CLI.
 */
const fs = require('fs');
const path = require('path');
const {
  buildStage17TrackingAudit,
  generateStage17Markdown,
} = require('./lib/stage17_tracking_audit');
const { generateBevInspections } = require('./lib/stage17_bev_inspection');
const { associateProjectedObservations, loadStage16ProjectedObservations } = require('./lib/stage17_divider_association');
const { fuseAllTracks } = require('./lib/stage17_supported_run_fusion');
const { TRACKING_SCHEMA_VERSION, STAGE17_PROCESSING_VERSION } = require('./lib/stage17_tracking_schema');

const ROOT = __dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  let out = path.join(ROOT, 'audit_stage17_lane_divider_tracking.json');
  let tracksOut = path.join(ROOT, 'lane_divider_tracks_v0.json');
  let runsOut = path.join(ROOT, 'lane_divider_supported_runs_v0.json');
  let stage16 = 'projected_lane_observations_v0.json';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i] === '--tracks-out' && args[i + 1]) tracksOut = args[++i];
    else if (args[i] === '--runs-out' && args[i + 1]) runsOut = args[++i];
    else if (args[i] === '--stage16' && args[i + 1]) stage16 = args[++i];
  }
  return { out, tracksOut, runsOut, stage16 };
}

function main() {
  const { out, tracksOut, runsOut, stage16 } = parseArgs();
  const audit = buildStage17TrackingAudit(ROOT, {
    stage16Path: stage16,
    includeAllTracks: true,
    includeAllRuns: true,
    includeAllGaps: true,
    includeAllOutcomes: true,
  });

  const loaded = loadStage16ProjectedObservations(path.join(ROOT, stage16));
  const assoc = associateProjectedObservations(loaded.projectedObservations);
  const fusion = fuseAllTracks(assoc.tracks, loaded.projectedObservations);

  const tracks = fusion.tracks;
  const supportedRuns = fusion.supportedRuns;
  const gaps = fusion.gaps;
  const outcomes = assoc.outcomes;

  delete audit.tracks;
  delete audit.supportedRuns;
  delete audit.gaps;
  delete audit.outcomes;

  const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.writeFileSync(outPath, JSON.stringify(audit, null, 2));

  const tracksPath = path.isAbsolute(tracksOut) ? tracksOut : path.join(ROOT, tracksOut);
  fs.writeFileSync(tracksPath, JSON.stringify({
    schemaVersion: TRACKING_SCHEMA_VERSION,
    processingVersion: STAGE17_PROCESSING_VERSION,
    stage16InputChecksum: audit.stage16InputChecksum,
    trackCount: tracks.length,
    tracks,
  }, null, 2));

  const runsPath = path.isAbsolute(runsOut) ? runsOut : path.join(ROOT, runsOut);
  fs.writeFileSync(runsPath, JSON.stringify({
    schemaVersion: TRACKING_SCHEMA_VERSION,
    processingVersion: STAGE17_PROCESSING_VERSION,
    supportedRunCount: supportedRuns.length,
    gapCount: gaps.length,
    supportedRuns,
    gaps,
  }, null, 2));

  const reportDir = path.join(ROOT, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'stage17_lane_divider_tracking.md');
  fs.writeFileSync(reportPath, generateStage17Markdown(audit));

  const bevDir = path.join(reportDir, 'stage17_bev');
  const bevManifest = generateBevInspections(
    audit,
    tracks,
    supportedRuns,
    gaps,
    outcomes,
    loaded.projectedObservations,
    bevDir,
  );

  console.log(`Stage 17 divider tracking — frozen baseline ${audit.frozenRoadSurfaceVersion}`);
  console.log(`  Stage 16 input: ${audit.stage16ProjectedObservationCount} projected observations`);
  console.log(`  Tracks: ${audit.trackCount}, supported runs: ${audit.supportedRunCount}, gaps: ${audit.gapCount}`);
  console.log(`  Tracking consistency: ${audit.trackingConsistency.passed}`);
  console.log(`  v11 geometry modified: ${audit.v11GeometryModified}`);
  console.log(`\nWrote ${outPath}`);
  console.log(`Wrote ${tracksPath}`);
  console.log(`Wrote ${runsPath}`);
  console.log(`Wrote ${reportPath}`);
  console.log(`Wrote ${bevDir} (${bevManifest.length} BEV inspections)`);
}

if (require.main === module) main();

module.exports = { main };
