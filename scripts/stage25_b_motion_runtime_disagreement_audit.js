'use strict';

const fs = require('fs');
const path = require('path');
const { runRuntimeDisagreementAudit, buildDeliverables } = require('../lib/stage25_b_motion_runtime_disagreement_audit');

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'deliverables');

function main() {
  const report = runRuntimeDisagreementAudit({ root: ROOT });
  const {
    auditJson,
    residualAuditJson,
    reviewManifestJson,
    summaryMarkdown,
  } = buildDeliverables(report);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const paths = {
    audit: path.join(OUT_DIR, 'stage25-b-motion-runtime-disagreement-audit.json'),
    summary: path.join(OUT_DIR, 'stage25-b-motion-runtime-disagreement-summary.md'),
    manifest: path.join(OUT_DIR, 'stage25-b-motion-manual-review-manifest.json'),
    residual: path.join(OUT_DIR, 'stage25-b-motion-residual-distribution-audit.json'),
  };

  fs.writeFileSync(paths.audit, `${JSON.stringify(auditJson, null, 2)}\n`);
  fs.writeFileSync(paths.summary, summaryMarkdown);
  fs.writeFileSync(paths.manifest, `${JSON.stringify(reviewManifestJson, null, 2)}\n`);
  fs.writeFileSync(paths.residual, `${JSON.stringify(residualAuditJson, null, 2)}\n`);

  console.log('Stage 25 B-MOTION runtime disagreement audit');
  console.log(`  records: ${report.inputIntegrity.recordCount}`);
  console.log(`  changed integrity: ${report.changedDecisionAudit.countsMatch}`);
  console.log(`  same-negative median explanation: clarification=${report.residualDistributionAudit.sameNegativeMedianExplanation.reportingClarificationRequired}`);
  console.log(`  dev changed: ${report.developmentVsRuntime.changedInDevelopmentSet}, runtime-only: ${report.developmentVsRuntime.changedRuntimeOnly}`);
  console.log(`  review manifest: ${report.reviewManifest.totalSelected}`);
  console.log(`  recommendation: ${report.validationPlan.recommendation}`);
  for (const [k, p] of Object.entries(paths)) {
    console.log(`Wrote ${path.relative(ROOT, p)}`);
  }
}

main();
