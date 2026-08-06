#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  compareBaseline,
  buildDeliverables,
  DEFAULT_MANUAL_REVIEWS_PATH,
  DEFAULT_AUTOMATIC_MANIFEST_PATH,
} = require('../lib/stage20_b_motion_baseline_compare');

const ROOT = path.join(__dirname, '..');

function main() {
  const report = compareBaseline({ root: ROOT });
  const deliverables = buildDeliverables(report);

  const comparisonPath = path.join(ROOT, 'deliverables', 'stage20-b-motion-baseline-comparison.json');
  const disagreementsPath = path.join(ROOT, 'deliverables', 'stage20-b-motion-baseline-disagreements.json');
  const summaryPath = path.join(ROOT, 'deliverables', 'stage20-b-motion-baseline-summary.md');

  fs.writeFileSync(comparisonPath, `${JSON.stringify(deliverables.comparisonJson, null, 2)}\n`);
  fs.writeFileSync(disagreementsPath, `${JSON.stringify(deliverables.disagreementsJson, null, 2)}\n`);
  fs.writeFileSync(summaryPath, deliverables.summaryMarkdown);

  console.log('Stage 20 B-MOTION baseline comparison');
  console.log(`  automatic: ${report.inputs.automaticManifestPath}`);
  console.log(`  manual:    ${report.inputs.manualReviewsPath}`);
  console.log(`  automatic sha256: ${report.inputs.automaticManifestSha256}`);
  console.log(`  manual sha256:    ${report.inputs.manualReviewsSha256}`);
  console.log(`  matched resolved: ${report.joinSummary.resolvedManualCount}`);
  console.log(`  unresolved:       ${report.joinSummary.unresolvedManualCount}`);
  console.log(`  unmatched manual:   ${report.joinSummary.unmatchedManualPairIds.length}`);

  if (report.metricsBlocked) {
    console.log('  METRICS BLOCKED');
    for (const issue of report.blockingIssues) {
      console.log(`    ${issue.code}: ${issue.items.length}`);
    }
    process.exit(1);
  }

  const c = report.confusionMatrix;
  const m = report.metrics;
  console.log('  confusion matrix:', c);
  console.log('  accuracy:', `${m.accuracy.rate} (${m.accuracy.numerator}/${m.accuracy.denominator})`);
  console.log('  positive precision/recall/f1:', m.positivePrecision.rate, m.positiveRecall.rate, m.positiveF1.rate);
  console.log('  negative precision/recall/f1:', m.negativePrecision.rate, m.negativeRecall.rate, m.negativeF1.rate);
  console.log('  balanced accuracy:', m.balancedAccuracy.rate);
  console.log('  macro f1:', m.macroF1.rate);
  console.log('  class support:', m.classSupport);
  console.log('  confidence missing:', report.confidence.missingConfidenceCount);
  console.log('  confidence direction:', report.confidence.confidenceDirection);
  console.log('  FP record indices:', report.falsePositiveRecordIndices.join(', ') || '(none)');
  console.log('  FN record indices:', report.falseNegativeRecordIndices.join(', ') || '(none)');
  console.log('  unresolved categories:', report.unresolvedAnalysis.categoryCounts);
  console.log(`Wrote ${path.relative(ROOT, comparisonPath)}`);
  console.log(`Wrote ${path.relative(ROOT, disagreementsPath)}`);
  console.log(`Wrote ${path.relative(ROOT, summaryPath)}`);
}

if (require.main === module) main();

module.exports = { main };
