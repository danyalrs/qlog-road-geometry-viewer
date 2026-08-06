#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { runShadowEvaluation, CANDIDATE_CONFIGS } = require('../lib/stage22_b_motion_shadow_evaluation');

const ROOT = path.join(__dirname, '..');

function buildSummaryMarkdown(report) {
  const lines = [
    '# Stage 22 B-MOTION Shadow Evaluation Summary',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Input integrity',
  ];

  for (const [k, h] of Object.entries(report.inputIntegrity.hashes)) {
    lines.push(`- ${k}: \`${h}\``);
  }
  lines.push(`- Resolved records: **${report.inputIntegrity.resolvedCount}**`);
  lines.push('');

  lines.push('## Vector compensation');
  lines.push(`- Formula: ${report.vectorCompensation.formula}`);
  lines.push(`- Coordinate frame: ${report.vectorCompensation.frames}`);
  lines.push(`- Opposite-direction cases (scalar masking): **${report.coordinateFrameFindings.oppositeDirectionCount}**`);
  lines.push('');

  lines.push('## Candidate metrics (zero-division=0, primary 175 records)');
  lines.push('| Config | Acc | Pos F1 | Neg F1 | Macro F1 | Bal Acc | Corrected | Damaged |');
  lines.push('|--------|-----|--------|--------|----------|---------|-----------|---------|');
  for (const c of report.configResultsPrimary) {
    lines.push(`| ${c.configId} | ${c.accuracy.rate} | ${c.positiveF1.rate} | ${c.negativeF1.rate} | ${c.macroF1.rate} | ${c.balancedAccuracy.rate} | ${c.correctedRecordIndices.length} | ${c.newlyDamagedRecordIndices.length} |`);
  }
  lines.push('');

  lines.push('## Record 207 sensitivity');
  lines.push(`- Label unchanged in primary evaluation`);
  lines.push(`- Macro F1 delta when excluded: ${JSON.stringify(report.record207Sensitivity.metricDelta)}`);
  lines.push('');

  lines.push('## Rank soft signal (Config F vs baseline)');
  lines.push(`- Fixes: ${report.rankSoftSignalImpact.fixes.join(', ') || '(none)'}`);
  lines.push(`- Damages: ${report.rankSoftSignalImpact.damages.join(', ') || '(none)'}`);
  lines.push('');

  lines.push('## Recommendation');
  lines.push(`- **${report.recommendation.decision}**`);
  lines.push(`- ${report.recommendation.rationale}`);
  if (report.recommendation.bestCandidate) lines.push(`- Best-supported candidate: **${report.recommendation.bestCandidate}**`);
  lines.push('');

  lines.push('## Offline threshold sweep (not approved)');
  lines.push(`- Tested values (m): ${report.offlineThresholdSweep.testedValuesM.join(', ')}`);
  lines.push('');
  lines.push(`*${report.terminology}*`);

  return `${lines.join('\n')}\n`;
}

function main() {
  const report = runShadowEvaluation({ root: ROOT });

  const jsonPath = path.join(ROOT, 'deliverables', 'stage22-b-motion-shadow-evaluation.json');
  const summaryPath = path.join(ROOT, 'deliverables', 'stage22-b-motion-shadow-summary.md');
  const diagnosticsPath = path.join(ROOT, 'deliverables', 'stage22-b-motion-per-record-diagnostics.json');

  const { perRecordDiagnostics, ...evaluationCore } = report;
  fs.writeFileSync(jsonPath, `${JSON.stringify(evaluationCore, null, 2)}\n`);
  fs.writeFileSync(diagnosticsPath, `${JSON.stringify({
    generatedAt: report.generatedAt,
    recordCount: perRecordDiagnostics.length,
    diagnostics: perRecordDiagnostics,
  }, null, 2)}\n`);
  fs.writeFileSync(summaryPath, buildSummaryMarkdown(report));

  console.log('Stage 22 B-MOTION shadow evaluation');
  console.log('  hashes:', report.inputIntegrity.hashes);
  console.log('  resolved:', report.inputIntegrity.resolvedCount);
  for (const c of report.configResultsPrimary) {
    console.log(`  config ${c.configId}: acc=${c.accuracy.rate} macroF1=${c.macroF1.rate} corrected=${c.correctedRecordIndices.length} damaged=${c.newlyDamagedRecordIndices.length}`);
  }
  console.log('  recommendation:', report.recommendation.decision, report.recommendation.bestCandidate || '');
  console.log(`Wrote ${path.relative(ROOT, jsonPath)}`);
  console.log(`Wrote ${path.relative(ROOT, summaryPath)}`);
  console.log(`Wrote ${path.relative(ROOT, diagnosticsPath)}`);

  if (!report.inputIntegrity.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = { main, buildSummaryMarkdown };
