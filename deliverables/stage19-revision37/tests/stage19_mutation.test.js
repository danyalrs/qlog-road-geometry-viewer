'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const spec = require('../lib/stage19_spec');

const ROOT = path.join(__dirname, '..');
const PACKAGE_ROOT = path.join(ROOT, 'deliverables', 'stage19-revision37');

test('mutation: stub callee fails normative verification', async () => {
  const partition = require('../lib/stage19_spec/partition');
  const real = partition.preActionClosure;
  partition.preActionClosure = () => ({ states: [] });
  const v = await spec.verifyNormativeCallees();
  partition.preActionClosure = real;
  assert.equal(v.allPass, false);
});

test('mutation: byte table mismatch detected by independent oracle', () => {
  const max = require('../lib/stage19_spec/maximum_instances');
  const saved = max.NORMATIVE_BYTE_TABLE.catalog.utf8Bytes;
  max.NORMATIVE_BYTE_TABLE.catalog.utf8Bytes = saved + 1;
  const v = spec.verifyMaximumInstancesViaDirectTable();
  max.NORMATIVE_BYTE_TABLE.catalog.utf8Bytes = saved;
  assert.equal(v.pass, false);
});

test('mutation: manifest hash mismatch fails verification', () => {
  if (!fs.existsSync(PACKAGE_ROOT)) return;
  const manifestPath = path.join(PACKAGE_ROOT, 'MANIFEST.sha256');
  const original = fs.readFileSync(manifestPath, 'utf8');
  fs.writeFileSync(manifestPath, `${'0'.repeat(64)}  lib/stage19_spec/config.js\n${original}`);
  const v = spec.verifyManifest(PACKAGE_ROOT);
  fs.writeFileSync(manifestPath, original);
  assert.equal(v.allPass, false);
});

test('mutation: stale packaged evidence hash detected', () => {
  if (!fs.existsSync(PACKAGE_ROOT)) return;
  const pkgEvidence = path.join(PACKAGE_ROOT, 'docs/stage19/evidence/captured_results.json');
  const wsEvidence = path.join(ROOT, 'docs/stage19/evidence/captured_results.json');
  const original = fs.readFileSync(pkgEvidence);
  fs.writeFileSync(pkgEvidence, Buffer.from('{}'));
  const v = spec.verifyWorkspaceEvidenceMatchesPackage(ROOT, PACKAGE_ROOT);
  fs.writeFileSync(pkgEvidence, original);
  assert.equal(v.allPass, false);
});

test('mutation: semantic isolation detects multi-error bundles', () => {
  const semantic = require('../lib/stage19_spec/semantic');
  const b = semantic.buildValidSemanticBundle();
  b.assessments[0].status = 'failed';
  b.assessments[0].promotion = 'reject';
  const r = semantic.validateStage19Semantics(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 1);
  assert.ok(r.errors.some((e) => e.code === 'failed_missing_evidence'));
});

test('mutation: recovery filesystem no-op detected', async () => {
  const inv = require('../lib/stage19_spec/normative_inventory');
  const recovery = require('../lib/stage19_spec/recovery');
  const real = recovery.applyRecoveryAction;
  recovery.applyRecoveryAction = async () => ({ stable: false, log: ['noop'] });
  try {
    const ex = await inv.exerciseCallee('applyRecoveryAction');
    assert.equal(ex.pass, false);
  } finally {
    recovery.applyRecoveryAction = real;
  }
});

test('mutation: independent oracle detects hardcoded invariant flags', () => {
  const runnerPath = path.join(ROOT, 'scripts', 'stage19_evidence_runner.js');
  const original = fs.readFileSync(runnerPath, 'utf8');
  const tampered = original.replace(
    'everyNormativeCalleeIsResolvedAndExercised: normativeCallees.allPass',
    'everyNormativeCalleeIsResolvedAndExercised: true',
  );
  fs.writeFileSync(runnerPath, tampered);
  const tamperedCheck = spec.verifyEvidenceRunnerDoesNotHardcodeInvariants();
  fs.writeFileSync(runnerPath, original);
  const restoredCheck = spec.verifyEvidenceRunnerDoesNotHardcodeInvariants();
  assert.equal(tamperedCheck.pass, false);
  assert.equal(restoredCheck.pass, true);
});
