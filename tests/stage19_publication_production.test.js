'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');
const { buildStage19Bundle } = require('../lib/stage19_bundle_builder');
const {
  publishProductionBundle,
  quarantineRun,
} = require('../lib/stage19_publication_production');
const { runRecoveryFilesystemTests } = require('../lib/stage19_spec/recovery_fs');

const ROOT = path.join(__dirname, '..');

describe('Stage 19 v2 publication lifecycle', () => {
  it('cleans staging after successful publication', async () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      const bundle = await buildStage19Bundle(context, { runId: 'stage19-pub-v2-clean' });
      const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-pub-v2-'));
      const pub = await publishProductionBundle(pubRoot, bundle);
      const staging = path.join(pubRoot, '.staging', bundle.runId);
      assert.equal(fs.existsSync(staging), false);
      assert.ok(fs.existsSync(path.join(pub.runDir, 'bev_v0.json')));
      assert.ok(fs.existsSync(path.join(pubRoot, 'current.json')));
      const current = JSON.parse(fs.readFileSync(path.join(pubRoot, 'current.json'), 'utf8'));
      assert.equal(current.runId, 'stage19-pub-v2-clean');
    } finally {
      clearStage17Gaps();
    }
  });

  it('rejects publication when quality gates would fail', async () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      const bundle = await buildStage19Bundle(context, { runId: 'stage19-pub-v2-fail' });
      bundle.qualityGates = { ok: false, errors: [{ code: 'test' }] };
      const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-pub-v2-fail-'));
      await assert.rejects(() => publishProductionBundle(pubRoot, bundle), /quality_gates_failed/);
    } finally {
      clearStage17Gaps();
    }
  });

  it('runs normative recovery FS tests', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-rec-v2-'));
    const result = await runRecoveryFilesystemTests(tmp);
    assert.equal(result.allPass, true);
  });

  it('quarantines a run directory', async () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      const bundle = await buildStage19Bundle(context, { runId: 'stage19-quarantine-v2' });
      const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-quar-v2-'));
      await publishProductionBundle(pubRoot, bundle);
      const q = await quarantineRun(pubRoot, bundle.runId);
      assert.ok(fs.existsSync(q.quarantineDir));
      assert.equal(fs.existsSync(path.join(pubRoot, 'runs', bundle.runId)), false);
    } finally {
      clearStage17Gaps();
    }
  });
});
