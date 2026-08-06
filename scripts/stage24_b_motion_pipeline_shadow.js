'use strict';

const fs = require('fs');
const path = require('path');
const { runPipelineShadowEvaluation, buildDeliverables } = require('../lib/stage24_b_motion_pipeline_shadow');

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'deliverables');

function main() {
  const report = runPipelineShadowEvaluation({ root: ROOT });

  if (!report.outputEquivalencePassed) {
    console.error('Stage 24 output equivalence FAILED');
    if (report.developmentSetRevalidation.reproductionErrors?.length) {
      for (const err of report.developmentSetRevalidation.reproductionErrors) console.error(`  - ${err}`);
    }
    if (report.downstreamEquivalence.legacyAuthoritativeMismatches > 0) {
      console.error(`  - authoritative mismatches: ${report.downstreamEquivalence.legacyAuthoritativeMismatches}`);
    }
    process.exitCode = 1;
  }

  const { reportJson, runtimeDiagnosticsJson, manualReviewSampleJson, summaryMarkdown } = buildDeliverables(report);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = path.join(OUT_DIR, 'stage24-b-motion-pipeline-shadow-report.json');
  const summaryPath = path.join(OUT_DIR, 'stage24-b-motion-pipeline-shadow-summary.md');
  const diagPath = path.join(OUT_DIR, 'stage24-b-motion-runtime-comparison-diagnostics.json');
  const samplePath = path.join(OUT_DIR, 'stage24-b-motion-manual-review-sample.json');

  fs.writeFileSync(reportPath, `${JSON.stringify(reportJson, null, 2)}\n`);
  fs.writeFileSync(summaryPath, summaryMarkdown);
  fs.writeFileSync(diagPath, `${JSON.stringify(runtimeDiagnosticsJson, null, 2)}\n`);
  fs.writeFileSync(samplePath, `${JSON.stringify(manualReviewSampleJson, null, 2)}\n`);

  console.log('Stage 24 B-MOTION pipeline shadow integration');
  console.log(`  segments discovered: ${report.segmentDiscovery.discoveredCount}`);
  console.log(`  segments processed: ${report.segmentQualificationSummary.processed}`);
  console.log(`  segment failures: ${report.segmentQualificationSummary.failed}`);
  console.log(`  total pairs: ${report.pairEnumeration.totalConsecutivePairs}`);
  console.log(`  changed decisions: ${report.aggregateShadowStats.totalChangedDecisions}`);
  console.log(`  authoritative mismatches: ${report.downstreamEquivalence.legacyAuthoritativeMismatches}`);
  console.log(`  development revalidation: ${report.developmentSetRevalidation.reproductionPassed}`);
  console.log(`  manual review sample: ${report.manualReviewSample.sampleSize}`);
  console.log(`Wrote ${path.relative(ROOT, reportPath)}`);
  console.log(`Wrote ${path.relative(ROOT, summaryPath)}`);
  console.log(`Wrote ${path.relative(ROOT, diagPath)}`);
  console.log(`Wrote ${path.relative(ROOT, samplePath)}`);

  if (!report.outputEquivalencePassed) process.exit(1);
}

main();
