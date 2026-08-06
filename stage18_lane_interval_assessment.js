#!/usr/bin/env node
/**
 * Stage 18 — lane-interval construction and prototype lane-count assessment CLI.
 */
const fs = require('fs');
const path = require('path');
const {
  buildStage18LaneIntervalAudit,
  generateStage18Markdown,
  buildStage18FromContext,
} = require('./lib/stage18_lane_interval_audit');
const { buildStage18InputContext } = require('./lib/stage18_stage17_loader');
const { generateBevInspections } = require('./lib/stage18_bev_inspection');
const { INTERVAL_SCHEMA_VERSION, STAGE18_PROCESSING_VERSION } = require('./lib/stage18_lane_interval_schema');

const ROOT = __dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  let out = path.join(ROOT, 'audit_stage18_lane_interval_assessment.json');
  let intervalsOut = path.join(ROOT, 'lane_intervals_v0.json');
  let countsOut = path.join(ROOT, 'lane_count_assessments_v0.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i] === '--intervals-out' && args[i + 1]) intervalsOut = args[++i];
    else if (args[i] === '--counts-out' && args[i + 1]) countsOut = args[++i];
  }
  return { out, intervalsOut, countsOut };
}

function main() {
  const { out, intervalsOut, countsOut } = parseArgs();
  const audit = buildStage18LaneIntervalAudit(ROOT, {
    includeAllIntervals: true,
    includeAllAssessments: true,
    includeAllRejected: true,
    skipSensitivity: false,
  });

  const context = buildStage18InputContext(ROOT);
  const built = buildStage18FromContext(context);

  const intervals = built.acceptedIntervals;
  const assessments = built.countAssessments;
  const rejected = built.rejectedIntervals;

  delete audit.acceptedIntervals;
  delete audit.countAssessments;
  delete audit.rejectedIntervals;
  delete audit.runUsageRecords;
  if (!audit.runUsageByOutcome) {
    audit.runUsageByOutcome = {};
  }

  const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.writeFileSync(outPath, JSON.stringify(audit, null, 2));

  const intervalsPath = path.isAbsolute(intervalsOut) ? intervalsOut : path.join(ROOT, intervalsOut);
  fs.writeFileSync(intervalsPath, JSON.stringify({
    schemaVersion: INTERVAL_SCHEMA_VERSION,
    processingVersion: STAGE18_PROCESSING_VERSION,
    intervalCount: intervals.length,
    rejectedIntervalRecordCount: rejected.length,
    intervals,
    rejectedIntervals: rejected,
  }, null, 2));

  const countsPath = path.isAbsolute(countsOut) ? countsOut : path.join(ROOT, countsOut);
  fs.writeFileSync(countsPath, JSON.stringify({
    schemaVersion: INTERVAL_SCHEMA_VERSION,
    processingVersion: STAGE18_PROCESSING_VERSION,
    assessmentCount: assessments.length,
    assessments,
    unsupportedRegions: built.unsupportedRegions,
  }, null, 2));

  const reportDir = path.join(ROOT, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'stage18_lane_interval_assessment.md'), generateStage18Markdown(audit));

  const bevDir = path.join(reportDir, 'stage18_bev');
  const manifest = generateBevInspections(
    audit,
    [...intervals, ...rejected],
    assessments,
    context.supportedRuns,
    context.gaps,
    context.tracks,
    bevDir,
  );

  console.log(`Stage 18 lane-interval assessment — frozen baseline ${audit.frozenRoadSurfaceVersion}`);
  console.log(`  Stage 17 input: ${audit.stage17SupportedRunCount} supported runs`);
  console.log(`  Accepted intervals: ${audit.laneIntervalCount}, count assessments: ${audit.countAssessmentCount}`);
  console.log(`  Consistency: ${audit.trackingConsistency.passed}`);
  console.log(`\nWrote ${outPath}`);
  console.log(`Wrote ${intervalsPath}`);
  console.log(`Wrote ${countsPath}`);
  console.log(`Wrote ${path.join(reportDir, 'stage18_lane_interval_assessment.md')}`);
  console.log(`Wrote ${bevDir} (${manifest.length} BEV inspections)`);
}

if (require.main === module) main();

module.exports = { main };
