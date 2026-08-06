'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const spec = require('../lib/stage19_spec');

const SCHEMA_DIR = path.join(__dirname, '..', 'docs', 'schemas', 'stage19');
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

test('maximum instances match normative byte table', () => {
  const v = spec.verifyMaximumInstancesAgainstNormativeTable();
  assert.equal(v.allPass, true, JSON.stringify(v.results.filter((r) => !r.pass)));
  assert.equal(v.results.find((r) => r.name === 'exclusions').actual.memberCount, 136);
});

test('normative callees resolved and exercised', async () => {
  const v = await spec.verifyNormativeCallees();
  assert.equal(v.allPass, true, JSON.stringify(v.results.filter((r) => !r.pass)));
});

test('partition registry preserves survivors', () => {
  const r = spec.runPartitionRegistryTests();
  assert.equal(r.allPass, true, JSON.stringify(r.results));
});

test('partition ownership micro-tests', () => {
  const r = spec.runPartitionOwnershipTests();
  assert.equal(r.allPass, true);
});

test('covariance matrix fixtures', () => {
  const r = spec.runCovarianceMatrixFixtures();
  assert.equal(r.allPass, true, JSON.stringify(r.results.filter((x) => !x.pass)));
});

test('jcs conformance including nested duplicates', () => {
  const r = spec.runConformanceVectors();
  assert.equal(r.allPass, true, JSON.stringify(r.results.filter((x) => !x.pass)));
  assert.equal(r.nestedDuplicateRejected, true);
  assert.throws(() => new spec.Stage19JsonParser('{"o":{"a":1,"a":2}}').parse(), spec.DuplicatePropertyError);
});

test('semantic rule inventory fully covered', () => {
  const r = spec.runSemanticFixtures();
  assert.equal(r.missingRules.length, 0, r.missingRules.join(','));
  assert.equal(r.allPass, true, JSON.stringify(r.results.filter((x) => !x.pass)));
  assert.equal(r.declaredRuleCount, spec.DECLARED_SEMANTIC_RULES.length);
});

test('runtime peak measured not trivial', () => {
  const r = spec.runtimePeakFixture();
  assert.equal(r.pass, true);
  assert.equal(r.retainedBytes, 232428);
  assert.ok(r.heapUsedDelta > 0);
  assert.ok(r.ratio <= 100);
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

test('recovery filesystem integration', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-test-rec-'));
  try {
    const r = await spec.runRecoveryFilesystemTests(tmp);
    assert.equal(r.allPass, true, JSON.stringify(r.results));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyBranchSelection and partitionDP independently', () => {
  const u = spec.applyBranchSelection(
    { requiredScalars: [{ confidenceLevel: 0.95, halfWidth: 1.96 }] },
    { uncertaintyInterpretation: 'one_sigma', documentedIndependent: true },
  );
  assert.equal(u.ok, true);
  const M = [spec.makeTestMatch(0, 0), spec.makeTestMatch(1, 5)];
  const p = spec.partitionDP(M, 'inc');
  assert.equal(p.ok, true);
  p.finalize();
  assert.equal(p.registry.size(), 0);
});

test('captured results file matches independently derived checks', async () => {
  const capturedPath = path.join(__dirname, '..', 'docs', 'stage19', 'evidence', 'captured_results.json');
  assert.ok(fs.existsSync(capturedPath), 'run npm run stage19:evidence first');
  const captured = JSON.parse(fs.readFileSync(capturedPath, 'utf8'));
  const callees = await spec.verifyNormativeCallees();
  const maximum = spec.verifyMaximumInstancesAgainstNormativeTable();
  const semantic = spec.runSemanticFixtures();
  assert.equal(captured.invariants.everyNormativeCalleeIsResolvedAndExercised, callees.allPass);
  assert.equal(captured.invariants.maximumInstanceMeasurementsMatchNormativeTable, maximum.allPass);
  assert.equal(captured.invariants.everySemanticRuleHasValidAndInvalidEvidence, semantic.allPass);
});
