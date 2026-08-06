#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { runErrorAnalysis } = require('../lib/stage21_b_motion_error_analysis');

const ROOT = path.join(__dirname, '..');

function buildSummaryMarkdown(report) {
  const lines = [
    '# Stage 21 B-MOTION Error Analysis Summary',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Input integrity',
  ];

  for (const [key, hash] of Object.entries(report.inputIntegrity.hashes)) {
    lines.push(`- ${key}: \`${hash}\``);
  }
  lines.push(`- Matched disagreements: **${report.matchedDisagreementCount}**`);
  lines.push(`- Join unmatched manual: **${report.inputIntegrity.joinSummary.unmatchedManual.length}**`);
  lines.push(`- QC manual file preserved: **${report.inputIntegrity.manualFilePreserved}**`);
  lines.push('');

  lines.push('## False-positive categories');
  for (const [cat, count] of Object.entries(report.falsePositiveAnalysis.categoryCounts)) {
    if (count > 0) lines.push(`- ${cat}: ${count}`);
  }
  lines.push('');

  lines.push('## False-negative categories');
  for (const [cat, count] of Object.entries(report.falseNegativeAnalysis.categoryCounts)) {
    if (count > 0) lines.push(`- ${cat}: ${count}`);
  }
  lines.push('');

  lines.push('## FN observation-pair clusters');
  for (const cluster of report.falseNegativeAnalysis.observationPairClusters) {
    lines.push(`- ${cluster.key}: indices ${cluster.recordIndices.join(', ')}`);
  }
  lines.push('');

  lines.push('## Rank evidence');
  lines.push(`- Strong rank evidence: ${report.rankEvidenceSummary.strongRankEvidenceCount}/${report.rankEvidenceSummary.totalDisagreements}`);
  lines.push(`- Method: ${report.rankEvidenceSummary.rankDerivationMethod}`);
  lines.push('');

  lines.push('## Manual recheck list');
  if (!report.manualRecheckList.length) lines.push('- (none flagged)');
  else {
    for (const item of report.manualRecheckList) {
      lines.push(`- [${item.recordIndex}] ${item.reviewPairId}: ${item.reason}`);
    }
  }
  lines.push('');

  lines.push('## Candidate signals (ranked by likely benefit)');
  for (const signal of report.candidateSignals) {
    lines.push(`- **${signal.signal}** (benefit score ${signal.likelyBenefitRank}): may correct ${signal.mayCorrect.length}, may damage ${signal.mayDamage.length}`);
    lines.push(`  - Limitation: ${signal.limitation}`);
  }
  lines.push('');

  lines.push('## Metric convention clarification (baseline unchanged)');
  const mc = report.metricConventionReport;
  lines.push(`- Negative F1 null convention: ${mc.negativeF1NullConvention.value} — ${mc.negativeF1NullConvention.reason}`);
  lines.push(`- Zero-division=0 convention: negative F1 = ${mc.zeroDivisionEqualsZeroConvention.negativeF1}, macro F1 ≈ ${mc.zeroDivisionEqualsZeroConvention.macroF1}`);
  lines.push(`- ${mc.note}`);
  lines.push('');
  lines.push(`*${report.terminology}*`);

  return `${lines.join('\n')}\n`;
}

function main() {
  const includeQlogRank = process.argv.includes('--no-qlog') ? false : true;
  const report = runErrorAnalysis({ root: ROOT, includeQlogRank });

  const jsonPath = path.join(ROOT, 'deliverables', 'stage21-b-motion-error-analysis.json');
  const summaryPath = path.join(ROOT, 'deliverables', 'stage21-b-motion-error-analysis-summary.md');
  const recheckPath = path.join(ROOT, 'deliverables', 'stage21-b-motion-manual-recheck-list.json');

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(summaryPath, buildSummaryMarkdown(report));
  fs.writeFileSync(recheckPath, `${JSON.stringify({
    generatedAt: report.generatedAt,
    records: report.manualRecheckList,
    note: 'Do not auto-revise manual labels; visual recheck only',
  }, null, 2)}\n`);

  console.log('Stage 21 B-MOTION error analysis');
  console.log('  input hashes:', report.inputIntegrity.hashes);
  console.log('  matched disagreements:', report.matchedDisagreementCount);
  console.log('  FP categories:', report.falsePositiveAnalysis.categoryCounts);
  console.log('  FN categories:', report.falseNegativeAnalysis.categoryCounts);
  console.log('  rank evidence strong:', report.rankEvidenceSummary.strongRankEvidenceCount);
  console.log('  manual recheck:', report.manualRecheckList.length);
  console.log('  top signal:', report.candidateSignals[0]?.signal);
  console.log(`Wrote ${path.relative(ROOT, jsonPath)}`);
  console.log(`Wrote ${path.relative(ROOT, summaryPath)}`);
  console.log(`Wrote ${path.relative(ROOT, recheckPath)}`);

  if (!report.inputIntegrity.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = { main, buildSummaryMarkdown };
