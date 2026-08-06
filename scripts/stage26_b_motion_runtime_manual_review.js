'use strict';

const fs = require('fs');
const path = require('path');
const {
  runRuntimeManualReviewExecution,
  buildDeliverables,
  DEFAULT_INPUTS,
} = require('../lib/stage26_b_motion_runtime_manual_review');

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'deliverables');

function main() {
  const report = runRuntimeManualReviewExecution({ root: ROOT, resume: true });
  const deliverables = buildDeliverables(report);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const paths = {
    reviews: path.join(OUT_DIR, 'stage26-b-motion-runtime-manual-reviews.json'),
    progress: path.join(OUT_DIR, 'stage26-b-motion-runtime-review-progress.json'),
    stratified: path.join(OUT_DIR, 'stage26-b-motion-runtime-stratified-results.json'),
    summary: path.join(OUT_DIR, 'stage26-b-motion-runtime-manual-review-summary.md'),
  };

  fs.writeFileSync(paths.reviews, `${JSON.stringify(deliverables.reviewsJson, null, 2)}\n`);
  fs.writeFileSync(paths.progress, `${JSON.stringify(deliverables.progressJson, null, 2)}\n`);
  fs.writeFileSync(paths.stratified, `${JSON.stringify(deliverables.stratifiedJson, null, 2)}\n`);
  fs.writeFileSync(paths.summary, deliverables.summaryMarkdown);

  console.log('Stage 26 B-MOTION runtime manual evidence review');
  console.log(`  manifest: ${report.inputIntegrity.manifestCount}`);
  console.log(`  development/runtime-only: ${report.inputIntegrity.developmentRecords}/${report.inputIntegrity.runtimeOnlyRecords}`);
  console.log(`  evidence success: ${report.evidenceGeneration.success}/${report.evidenceGeneration.attempted}`);
  console.log(`  evidence failures: ${report.evidenceGeneration.failure}`);
  console.log(`  pending human review: ${report.progress.totals.pendingHuman}`);
  console.log(`  auto-unresolved: ${report.progress.totals.autoUnresolved}`);
  console.log(`  runtime-only resolved: ${report.validationSufficiency.currentRuntimeOnlyResolved}`);
  console.log(`  repeated physical-pair clusters: ${report.repeatedPhysicalPairClusters.length}`);
  console.log(`  recommendation: ${report.recommendation.decision}`);
  for (const [k, p] of Object.entries(paths)) {
    console.log(`Wrote ${path.relative(ROOT, p)}`);
  }
}

main();
