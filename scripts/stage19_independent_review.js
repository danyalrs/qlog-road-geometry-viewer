'use strict';

const fs = require('fs');
const path = require('path');
const spec = require('../lib/stage19_spec');

const ROOT = path.join(__dirname, '..');
const PACKAGE_ROOT = path.join(ROOT, 'deliverables', 'stage19-revision37');

async function main() {
  if (typeof global.gc !== 'function') {
    console.error('exposeGcRequired: run node with --expose-gc');
    process.exit(1);
  }

  const capturedPath = path.join(ROOT, 'docs', 'stage19', 'evidence', 'captured_results.json');
  if (!fs.existsSync(capturedPath)) {
    console.error('missing captured_results.json — run npm run stage19:evidence first');
    process.exit(1);
  }
  const captured = JSON.parse(fs.readFileSync(capturedPath, 'utf8'));

  const oracle = spec.runIndependentOracleChecks({ packageRoot: PACKAGE_ROOT });
  const callees = await spec.verifyNormativeCallees();
  const manifest = fs.existsSync(PACKAGE_ROOT) ? spec.verifyManifest(PACKAGE_ROOT) : { allPass: false, reason: 'missingPackage' };
  const evidence = fs.existsSync(PACKAGE_ROOT)
    ? spec.verifyWorkspaceEvidenceMatchesPackage(ROOT, PACKAGE_ROOT)
    : { allPass: false };

  const checks = [
    { name: 'oracle-all-pass', pass: oracle.allPass, detail: oracle },
    { name: 'callees-identity-exercised', pass: callees.allPass && callees.results.every((r) => r.identity && r.exercised) },
    { name: 'runtime-20-run-stable', pass: oracle.runtimeMemory.pass },
    { name: 'semantic-isolated-rules', pass: oracle.semanticIsolated.pass },
    { name: 'manifest-verified', pass: manifest.allPass },
    { name: 'workspace-package-evidence-hash', pass: evidence.allPass },
    { name: 'recovery-fs-effects', pass: captured.recoveryFs?.allPass === true },
    { name: 'no-hardcoded-runner-flags', pass: oracle.noHardcodedRunnerFlags.pass },
    { name: 'captured-invariants-derived', pass: Object.entries(captured.invariants || {})
      .filter(([k]) => !k.startsWith('final') && k !== 'selfContainedClaimMatchesTheDeliveredArtifact')
      .every(([, v]) => typeof v === 'boolean') },
    { name: 'captured-matches-live-oracle', pass: captured.invariants?.testsDeriveInvariantsIndependently === oracle.allPass },
  ];

  const livePass = checks.every((c) => c.pass);
  const report = {
    revision: 'revision37',
    generatedAt: new Date().toISOString(),
    checks,
    oracleSummary: {
      allPass: oracle.allPass,
      runtimeMedianDelta: oracle.runtimeMemory.stats?.medianHeapDelta,
      runtimeRuns: oracle.runtimeMemory.stats?.runs,
      manifestFileCount: manifest.fileCount,
      semanticIsolated: oracle.semanticIsolated.isolatedCount,
    },
    invariantClassification: Object.fromEntries(
      Object.entries(captured.invariants || {}).map(([k, v]) => [k, v === true ? 'VERIFIED' : 'FAILED']),
    ),
    independentReviewPass: livePass,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = livePass ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
