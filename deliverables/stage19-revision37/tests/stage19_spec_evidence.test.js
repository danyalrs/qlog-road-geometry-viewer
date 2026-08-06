'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const spec = require('../lib/stage19_spec');

const ROOT = path.join(__dirname, '..');
const SCHEMA_DIR = path.join(ROOT, 'docs', 'schemas', 'stage19');
const PACKAGE_ROOT = path.join(ROOT, 'deliverables', 'stage19-revision37');
const SCHEMA_FILES = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.json')).sort();

test('ten schemas delivered and meta-valid', async () => {
  assert.equal(SCHEMA_FILES.length, 10);
  for (const file of SCHEMA_FILES) {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    assert.equal(ajv.getSchema('https://json-schema.org/draft/2020-12/schema')(schema), true);
  }
});

test('manifest integrity verified for deliverable tree', () => {
  if (!fs.existsSync(PACKAGE_ROOT)) {
    assert.ok(true, 'skip until npm run stage19:build');
    return;
  }
  const v = spec.verifyManifest(PACKAGE_ROOT);
  assert.equal(v.allPass, true, JSON.stringify({ missing: v.missing, extra: v.extra, mismatched: v.mismatched }));
});

test('independent manifest oracle when package present', () => {
  if (!fs.existsSync(PACKAGE_ROOT)) {
    assert.ok(true, 'skip until npm run stage19:build');
    return;
  }
  const v = spec.verifyManifestIndependent(PACKAGE_ROOT);
  assert.equal(v.pass, true, JSON.stringify(v));
});

test('workspace evidence hash matches packaged evidence', () => {
  if (!fs.existsSync(PACKAGE_ROOT)) {
    assert.ok(true, 'skip until npm run stage19:build');
    return;
  }
  const v = spec.verifyWorkspaceEvidenceMatchesPackage(ROOT, PACKAGE_ROOT);
  assert.equal(v.allPass, true, JSON.stringify(v));
});

test('maximum instances match normative byte table', () => {
  const v = spec.verifyMaximumInstancesAgainstNormativeTable();
  assert.equal(v.allPass, true, JSON.stringify(v.results.filter((r) => !r.pass)));
  assert.equal(v.results.find((r) => r.name === 'exclusions').actual.memberCount, 136);
});

test('independent oracle direct table verification', () => {
  const v = spec.verifyMaximumInstancesViaDirectTable();
  assert.equal(v.pass, true, JSON.stringify(v));
});

test('normative callees resolved identity exercised', async () => {
  const v = await spec.verifyNormativeCallees();
  assert.equal(v.allPass, true, JSON.stringify(v.results.filter((r) => !r.pass)));
  for (const r of v.results) {
    assert.equal(r.identity, true, r.name);
    assert.equal(r.exercised, true, r.name);
  }
});

test('normative callee negative controls reject stubs', async () => {
  const partition = require('../lib/stage19_spec/partition');
  const real = partition.preActionClosure;
  partition.preActionClosure = () => ({ states: [] });
  const fail = await spec.verifyNormativeCallees();
  partition.preActionClosure = real;
  assert.equal(fail.allPass, false);
  assert.ok(fail.results.find((r) => r.name === 'preActionClosure' && !r.exercised));
});

test('independent normative binding checks', () => {
  const v = spec.verifyNormativeCalleeBindingsIndependent();
  assert.equal(v.pass, true, JSON.stringify(v.failures));
});

test('partition registry and ownership', () => {
  const r = spec.runPartitionRegistryTests();
  assert.equal(r.allPass, true, JSON.stringify(r.results));
  const o = spec.runPartitionOwnershipTests();
  assert.equal(o.allPass, true);
});

test('covariance matrix fixtures with reference eigenvalues', () => {
  const r = spec.runCovarianceMatrixFixtures();
  assert.equal(r.allPass, true, JSON.stringify(r.results.filter((x) => !x.pass)));
  const ref = spec.eigenvaluesMatchReference([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 2]]);
  assert.equal(ref.pass, true);
});

test('jcs conformance including nested duplicates and float vectors', () => {
  const r = spec.runConformanceVectors();
  assert.equal(r.allPass, true, JSON.stringify(r.results.filter((x) => !x.pass)));
  assert.equal(r.nestedDuplicateRejected, true);
  assert.throws(() => new spec.Stage19JsonParser('{"o":{"a":1,"a":2}}').parse(), spec.DuplicatePropertyError);
});

test('semantic rule inventory isolated per rule', () => {
  const r = spec.runSemanticFixtures();
  assert.equal(r.missingRules.length, 0, r.missingRules.join(','));
  assert.equal(r.allPass, true, JSON.stringify(r.results.filter((x) => !x.pass)));
  assert.equal(r.declaredRuleCount, spec.DECLARED_SEMANTIC_RULES.length);
  for (const row of r.results) assert.equal(row.isolatedPass, true, row.code);
});

test('independent semantic oracle', () => {
  const v = spec.verifySemanticRulesIndependent();
  assert.equal(v.pass, true);
  assert.equal(v.isolatedCount, spec.DECLARED_SEMANTIC_RULES.length);
});

test('runtime memory 20-run regression with expose-gc', () => {
  if (typeof global.gc !== 'function') {
    assert.fail('exposeGcRequired: run node with --expose-gc');
  }
  const r = spec.runtimePeakFixture();
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.equal(r.retainedBytes, 232428);
  assert.equal(r.runs, 20);
  assert.ok(r.minHeapDelta >= spec.MIN_HEAP_DELTA);
  assert.ok(r.medianHeapDelta >= spec.MIN_HEAP_DELTA);
  assert.ok(r.coefficientOfVariation <= spec.MAX_COEFFICIENT_OF_VARIATION);
});

test('independent runtime memory oracle', () => {
  const v = spec.verifyRuntimeMemoryIndependent();
  assert.equal(v.pass, true, JSON.stringify(v.stats));
});

test('measured conflict fixtures', () => {
  assert.equal(spec.runMeasuredConflictFixture().pass, true);
  assert.equal(spec.runMeasuredConflictEmptyFixture().pass, true);
});

test('publication filesystem integration', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-test-pub-'));
  try {
    const r = await spec.runPublicationIntegrationTests(tmp);
    assert.equal(r.allPass, true, JSON.stringify(r.results));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('recovery filesystem integration with real effects', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-test-rec-'));
  try {
    const r = await spec.runRecoveryFilesystemTests(tmp);
    assert.equal(r.allPass, true, JSON.stringify(r.results));
    assert.ok(r.results.some((x) => x.name === 'recovery-delete-staging-fs' && x.pass));
    assert.ok(r.results.some((x) => x.name === 'concurrent-reader-drain-before-quarantine' && x.pass));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('independent oracle aggregate', () => {
  const o = spec.runIndependentOracleChecks({ packageRoot: PACKAGE_ROOT });
  assert.equal(o.noHardcodedRunnerFlags.pass, true);
  assert.equal(o.independentTestUsesOracle.pass, true);
  if (fs.existsSync(PACKAGE_ROOT)) {
    assert.equal(o.manifestAndEvidence.pass, true, JSON.stringify(o.manifestAndEvidence));
  }
});

test('captured results match independently derived checks', async () => {
  const capturedPath = path.join(ROOT, 'docs', 'stage19', 'evidence', 'captured_results.json');
  assert.ok(fs.existsSync(capturedPath), 'run npm run stage19:evidence first');
  const captured = JSON.parse(fs.readFileSync(capturedPath, 'utf8'));
  const callees = await spec.verifyNormativeCallees();
  const maximum = spec.verifyMaximumInstancesAgainstNormativeTable();
  const semantic = spec.runSemanticFixtures();
  const oracle = spec.runIndependentOracleChecks({ packageRoot: PACKAGE_ROOT });
  assert.equal(captured.invariants.everyNormativeCalleeIsResolvedAndExercised, callees.allPass);
  assert.equal(captured.invariants.maximumInstanceMeasurementsMatchNormativeTable, maximum.allPass);
  assert.equal(captured.invariants.everySemanticRuleHasValidAndInvalidEvidence, semantic.allPass);
  assert.equal(captured.invariants.testsDeriveInvariantsIndependently, oracle.allPass);
});
