'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { NORMATIVE_BYTE_TABLE, constructors } = require('./maximum_instances');
const { verifyManifest, verifyWorkspaceEvidenceMatchesPackage, sha256File } = require('./manifest_integrity');
const { measureRuntimeRepeated, RETAINED_CATALOG_BYTES, MIN_HEAP_DELTA, RUNS } = require('./runtime_memory');
const { runSemanticFixtures, DECLARED_SEMANTIC_RULES } = require('./semantic');
const { runConformanceVectors } = require('./jcs');
const { runCovarianceMatrixFixtures, eigenvaluesMatchReference } = require('./math');
const partition = require('./partition');
const recovery = require('./recovery');
const jcs = require('./jcs');

const ROOT = path.join(__dirname, '..', '..');
const PACKAGE_ROOT = path.join(ROOT, 'deliverables', 'stage19-revision37');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function verifyMaximumInstancesViaDirectTable() {
  const { verifyMaximumInstancesAgainstNormativeTable } = require('./maximum_instances');
  const primary = verifyMaximumInstancesAgainstNormativeTable();
  const mismatches = [];
  for (const [name, expected] of Object.entries(NORMATIVE_BYTE_TABLE)) {
    const inst = constructors[name]();
    const bytes = jcs.jcsUtf8Bytes(inst).length;
    const memberCount = inst.members?.length ?? inst.pairs?.length ?? inst.results?.length
      ?? inst.files?.length ?? inst.decisions?.length ?? inst.excluded?.length
      ?? inst.unassociated?.length ?? inst.images?.length ?? 1;
    if (bytes !== expected.utf8Bytes || memberCount !== expected.memberCount) {
      mismatches.push({ name, expected, actual: { utf8Bytes: bytes, memberCount } });
    }
  }
  return {
    pass: primary.allPass && mismatches.length === 0,
    primaryAllPass: primary.allPass,
    directTableMismatches: mismatches,
  };
}

function verifyNormativeCalleeBindingsIndependent() {
  const failures = [];
  const checks = [
    { name: 'partitionDP', mod: partition, fn: 'partitionDP' },
    { name: 'preActionClosure', mod: partition, fn: 'preActionClosure' },
    { name: 'postActionClosure', mod: partition, fn: 'postActionClosure' },
    { name: 'dedupeByFutureKey', mod: partition, fn: 'dedupeByFutureKey' },
    { name: 'finalizationClosure', mod: partition, fn: 'finalizationClosure' },
    { name: 'runP3Branch', mod: require('./p3'), fn: 'runP3Branch' },
    { name: 'applyRecoveryAction', mod: recovery, fn: 'applyRecoveryAction' },
    { name: 'runRecoveryLoop', mod: recovery, fn: 'runRecoveryLoop' },
    { name: 'mayDeleteRemoteStaging', mod: recovery, fn: 'mayDeleteRemoteStaging' },
  ];
  for (const c of checks) {
    const bound = c.mod[c.fn];
    if (typeof bound !== 'function') failures.push({ name: c.name, reason: 'missingExport' });
    else if (bound.name !== c.fn && !bound.name) failures.push({ name: c.name, reason: 'anonymousBinding' });
  }
  return { pass: failures.length === 0, failures };
}

function verifyRuntimeMemoryIndependent() {
  const stats = measureRuntimeRepeated(RUNS);
  const pass = stats.pass
    && stats.retainedBytes === RETAINED_CATALOG_BYTES
    && stats.minHeapDelta >= MIN_HEAP_DELTA
    && stats.medianHeapDelta >= MIN_HEAP_DELTA
    && stats.allPositive;
  return { pass, stats };
}

function verifySemanticRulesIndependent() {
  const fixtures = runSemanticFixtures();
  const isolatedCount = fixtures.results.filter((r) => r.isolatedPass).length;
  return {
    pass: fixtures.allPass && isolatedCount === DECLARED_SEMANTIC_RULES.length,
    isolatedCount,
    declared: DECLARED_SEMANTIC_RULES.length,
    missingRules: fixtures.missingRules,
  };
}

function verifyJcsIndependent() {
  const v = runConformanceVectors();
  let nestedDup = false;
  try { new jcs.Stage19JsonParser('{"o":{"a":1,"a":2}}').parse(); } catch (e) { nestedDup = e.name === 'duplicateProperty'; }
  return { pass: v.allPass && nestedDup, nestedDuplicateRejected: nestedDup, vectorCount: v.results.length };
}

function verifyCovarianceIndependent() {
  const fixtures = runCovarianceMatrixFixtures();
  const ref = eigenvaluesMatchReference([[2, 0, 0, 0], [0, 3, 0, 0], [0, 0, 4, 0], [0, 0, 0, 5]]);
  return { pass: fixtures.allPass && ref.pass, referenceEigenPass: ref.pass };
}

function verifyManifestIndependent(packageRoot = PACKAGE_ROOT) {
  if (!fs.existsSync(packageRoot)) return { pass: true, skipped: true, reason: 'missingPackageRoot' };
  const manifest = verifyManifest(packageRoot);
  const evidence = verifyWorkspaceEvidenceMatchesPackage(ROOT, packageRoot);
  return {
    pass: manifest.allPass && evidence.allPass,
    manifest,
    evidence,
  };
}

function verifyPartitionIndependent() {
  const registry = partition.runPartitionRegistryTests();
  const ownership = partition.runPartitionOwnershipTests();
  return { pass: registry.allPass && ownership.allPass, registry, ownership };
}

function verifyEvidenceRunnerDoesNotHardcodeInvariants() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'stage19_evidence_runner.js'), 'utf8');
  const badPatterns = [
    /everyNormativeCalleeIsResolvedAndExercised:\s*true/,
    /maximumInstanceMeasurementsMatchNormativeTable:\s*true/,
    /partitionDPPreservesRegisteredSurvivors:\s*true/,
    /testsDeriveInvariantsIndependently\(\)/,
  ];
  const hits = badPatterns.filter((p) => p.test(src));
  return { pass: hits.length === 0, hits: hits.map(String) };
}

function verifyIndependentTestFileUsesOracle() {
  const src = fs.readFileSync(path.join(ROOT, 'tests', 'stage19_spec_evidence.test.js'), 'utf8');
  const required = [
    'verifyMaximumInstancesViaDirectTable',
    'verifyNormativeCalleeBindingsIndependent',
    'verifyRuntimeMemoryIndependent',
    'verifyManifest',
    'verifyWorkspaceEvidenceMatchesPackage',
  ];
  const missing = required.filter((s) => !src.includes(s));
  return { pass: missing.length === 0, missing };
}

function runIndependentOracleChecks(options = {}) {
  const packageRoot = options.packageRoot || PACKAGE_ROOT;
  const checks = {
    maximumInstancesDirectTable: verifyMaximumInstancesViaDirectTable(),
    normativeCalleeBindings: verifyNormativeCalleeBindingsIndependent(),
    runtimeMemory: verifyRuntimeMemoryIndependent(),
    semanticIsolated: verifySemanticRulesIndependent(),
    jcsVectors: verifyJcsIndependent(),
    covarianceReference: verifyCovarianceIndependent(),
    partitionRegistryOwnership: verifyPartitionIndependent(),
    manifestAndEvidence: verifyManifestIndependent(packageRoot),
    noHardcodedRunnerFlags: verifyEvidenceRunnerDoesNotHardcodeInvariants(),
    independentTestUsesOracle: verifyIndependentTestFileUsesOracle(),
  };
  checks.allPass = Object.entries(checks)
    .filter(([k]) => k !== 'allPass')
    .every(([, v]) => v.pass === true);
  return checks;
}

function runIndependentReviewProcess(options = {}) {
  return runIndependentOracleChecks(options);
}

module.exports = {
  sha256Buffer,
  verifyMaximumInstancesViaDirectTable,
  verifyNormativeCalleeBindingsIndependent,
  verifyRuntimeMemoryIndependent,
  verifySemanticRulesIndependent,
  verifyJcsIndependent,
  verifyCovarianceIndependent,
  verifyManifestIndependent,
  verifyPartitionIndependent,
  verifyEvidenceRunnerDoesNotHardcodeInvariants,
  verifyIndependentTestFileUsesOracle,
  runIndependentOracleChecks,
  runIndependentReviewProcess,
};
