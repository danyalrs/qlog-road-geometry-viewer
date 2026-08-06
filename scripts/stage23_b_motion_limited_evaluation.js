'use strict';

const fs = require('fs');
const path = require('path');
const { runLimitedEvaluation, buildDeliverables } = require('../lib/stage23_b_motion_limited_evaluation');

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'deliverables');

function main() {
  const report = runLimitedEvaluation({ root: ROOT });

  if (!report.reproductionPassed) {
    console.error('Stage 23 Config B reproduction FAILED:');
    for (const err of report.reproductionErrors) console.error(`  - ${err}`);
    process.exitCode = 1;
  }

  const { reportJson, comparisonDiagnosticsJson, summaryMarkdown } = buildDeliverables(report);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = path.join(OUT_DIR, 'stage23-b-motion-limited-implementation-report.json');
  const summaryPath = path.join(OUT_DIR, 'stage23-b-motion-limited-implementation-summary.md');
  const diagPath = path.join(OUT_DIR, 'stage23-b-motion-comparison-diagnostics.json');

  fs.writeFileSync(reportPath, `${JSON.stringify(reportJson, null, 2)}\n`);
  fs.writeFileSync(summaryPath, summaryMarkdown);
  fs.writeFileSync(diagPath, `${JSON.stringify(comparisonDiagnosticsJson, null, 2)}\n`);

  console.log('Stage 23 B-MOTION limited implementation evaluation');
  console.log(`  reproduction passed: ${report.reproductionPassed}`);
  console.log(`  legacy: TP=${report.legacyRegression.confusionMatrix.tp} acc=${report.legacyRegression.accuracy.rate}`);
  console.log(`  vector_limited: TP=${report.configBReproduction.confusionMatrix.tp} acc=${report.configBReproduction.accuracy.rate}`);
  console.log(`  corrected=${report.configBReproduction.correctedRecordIndices.length} damaged=${report.configBReproduction.newlyDamagedRecordIndices.length} net=+${report.configBReproduction.netCorrectImprovement}`);
  console.log(`  fallback count: ${report.fallbackCount}`);
  console.log(`Wrote ${path.relative(ROOT, reportPath)}`);
  console.log(`Wrote ${path.relative(ROOT, summaryPath)}`);
  console.log(`Wrote ${path.relative(ROOT, diagPath)}`);

  if (!report.reproductionPassed) process.exit(1);
}

main();
