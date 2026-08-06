#!/usr/bin/env node
/**
 * Stage 19 — dataset-wide lane-interval sensitivity & BEV evidence audit CLI.
 */
const path = require('path');
const { runAndWriteStage19Audit } = require('./lib/stage19_dataset_sensitivity_audit');
const { PROCESSING_VERSION } = require('./lib/version');
const { STAGE19_PROCESSING_VERSION } = require('./lib/stage19_version');

const ROOT = __dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  let auditOut = 'audit_stage19_dataset_sensitivity.json';
  let bundleDir = 'stage19_bundle';
  let runId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) auditOut = args[++i];
    else if (args[i] === '--bundle-dir' && args[i + 1]) bundleDir = args[++i];
    else if (args[i] === '--run-id' && args[i + 1]) runId = args[++i];
  }
  return { auditOut, bundleDir, runId };
}

async function main() {
  const { auditOut, bundleDir, runId } = parseArgs();
  const started = Date.now();
  const { audit, bundleDir: writtenDir, auditPath } = await runAndWriteStage19Audit(ROOT, {
    auditOut,
    bundleDir,
    runId,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`Stage 19 dataset sensitivity audit — frozen v11 ${PROCESSING_VERSION}`);
  console.log(`  Stage 19 version: ${STAGE19_PROCESSING_VERSION}`);
  console.log(`  Observations: ${audit.observationCount}, genuine cross-pass: ${audit.genuineCrossPassCandidateCount}`);
  console.log(`  Gaps excluded: ${audit.gapExclusionCount}, intervals assessed: ${audit.assessmentCount}`);
  console.log(`  Normative bindings: ${audit.normativeVerification?.ok ? 'PASS' : 'FAIL'}`);
  console.log(`  Semantic validation: ${audit.semanticValidation?.ok ? 'PASS' : 'FAIL'}`);
  console.log(`  Production quality gates: ${audit.productionQualityGates?.ok ? 'PASS' : 'FAIL'}`);
  console.log(`  Cross-pass conflicts: ${audit.crossPassConflictCount}`);
  console.log(`  Insufficient evidence intervals: ${audit.insufficientEvidenceIntervalCount}`);
  console.log(`  Partition failures: ${audit.partitionFailureCount} (overflow: ${audit.partitionOverflowCount})`);
  console.log(`  BEV images: ${audit.bevImageCount}`);
  console.log(`  Production lane counting: ${audit.productionLaneCountImplemented ? 'enabled' : 'disabled'}`);
  console.log(`\nWrote ${auditPath}`);
  console.log(`Wrote ${writtenDir}`);
  console.log(`Wrote reports/stage19_dataset_sensitivity.md`);
  console.log(`Completed in ${elapsed}s`);
  if (!audit.semanticValidation?.ok) {
    console.error('Semantic validation errors:', audit.semanticValidation?.errors?.slice(0, 5));
    process.exit(1);
  }
  if (!audit.productionQualityGates?.ok) {
    console.error('Production quality gate errors:', audit.productionQualityGates?.errors?.slice(0, 5));
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
