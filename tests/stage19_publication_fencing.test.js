'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  publishProductionBundle,
  validateWriterMayPublishPointer,
  atomicReplaceCurrentPointerFenced,
  writeBundleToStaging,
  verifyRunComplete,
} = require('../lib/stage19_publication_production');
const {
  renewLease,
  releaseLease,
  acquireFencingToken,
  leaseStore,
} = require('../lib/stage19_spec/recovery');
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');
const { buildStage19Bundle } = require('../lib/stage19_bundle_builder');

const ROOT = path.join(__dirname, '..');

async function minimalBundle(runId) {
  const context = buildStage19InputContext(ROOT);
  injectStage17Gaps(context.gaps);
  try {
    return await buildStage19Bundle(context, { runId });
  } finally {
    clearStage17Gaps();
  }
}

describe('Stage 19 v5 publication fencing', () => {
  it('rejects stale writer with expired lease on pointer update', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-fence-stale-'));
    const runId = 'fence-stale-run';
    const runDir = path.join(pubRoot, 'runs', runId);
    await fs.promises.mkdir(runDir, { recursive: true });
    await fs.promises.writeFile(path.join(runDir, 'manifest_v0.json'), JSON.stringify({ runId }));
    await fs.promises.writeFile(path.join(runDir, 'commit_v0.json'), '{}');
    leaseStore.set('stale-host', { fencingToken: 1, expiresAt: Date.now() - 1 });
    const staleLock = { hostId: 'stale-host', fencingToken: 1, expiresAt: Date.now() - 1 };
    assert.throws(
      () => validateWriterMayPublishPointer(staleLock, runDir, runId),
      /stale_writer_expired_lease/,
    );
  });

  it('rejects pointer update when fencing token does not match active lease', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-fence-token-'));
    const runId = 'fence-token-run';
    const runDir = path.join(pubRoot, 'runs', runId);
    await fs.promises.mkdir(runDir, { recursive: true });
    await fs.promises.writeFile(path.join(runDir, 'manifest_v0.json'), JSON.stringify({ runId }));
    await fs.promises.writeFile(path.join(runDir, 'commit_v0.json'), '{}');
    const lock = { hostId: 'writer-a', fencingToken: 5, expiresAt: 0 };
    renewLease(lock);
    assert.throws(
      () => validateWriterMayPublishPointer({ hostId: 'writer-a', fencingToken: 4, expiresAt: 0 }, runDir, runId),
      /stale_writer_fencing_token/,
    );
    releaseLease(lock);
  });

  it('successful publish uses fenced pointer bound to immutable run', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-fence-ok-'));
    const bundle = await minimalBundle('stage19-fence-ok-run');
    const pub = await publishProductionBundle(pubRoot, bundle, { allowExistingRunDir: true });
    const current = JSON.parse(fs.readFileSync(path.join(pubRoot, 'current.json'), 'utf8'));
    assert.equal(current.runId, bundle.runId);
    assert.ok(fs.existsSync(path.join(pub.runDir, 'manifest_v0.json')));
    assert.equal(fs.existsSync(path.join(pubRoot, '.staging', bundle.runId)), false);
  });

  it('post-immutable pre-pointer trace: stale token rejected, current unchanged, run complete', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-fence-trace-'));
    const runId = 'fence-trace-run';
    const stagingDir = path.join(pubRoot, '.staging', runId);
    const runDir = path.join(pubRoot, 'runs', runId);
    const currentPath = path.join(pubRoot, 'current.json');
    const bundle = await minimalBundle(runId);
    await writeBundleToStaging(stagingDir, bundle);
    await verifyRunComplete(stagingDir, bundle.manifest);
    await fs.promises.mkdir(path.dirname(runDir), { recursive: true });
    await fs.promises.rename(stagingDir, runDir);
    assert.equal(fs.existsSync(currentPath), false);
    assert.equal(fs.existsSync(path.join(runDir, 'manifest_v0.json')), true);
    assert.equal(fs.existsSync(path.join(runDir, 'commit_v0.json')), true);
    const staleLock = { hostId: 'trace-writer', fencingToken: 1, expiresAt: 0 };
    acquireFencingToken('trace-writer');
    renewLease({ hostId: 'trace-writer', fencingToken: 2, expiresAt: Date.now() + 60000 });
    await assert.rejects(
      () => atomicReplaceCurrentPointerFenced(pubRoot, runId, staleLock, runDir),
      /stale_writer_fencing_token/,
    );
    assert.equal(fs.existsSync(currentPath), false);
    await verifyRunComplete(runDir, bundle.manifest);
    releaseLease({ hostId: 'trace-writer' });
  });

  it('token change between staging write and pointer update is rejected for stale lock', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-fence-mid-'));
    const runId = 'fence-mid-run';
    const stagingDir = path.join(pubRoot, '.staging', runId);
    const runDir = path.join(pubRoot, 'runs', runId);
    const bundle = await minimalBundle(runId);
    await writeBundleToStaging(stagingDir, bundle);
    await verifyRunComplete(stagingDir, bundle.manifest);
    await fs.promises.mkdir(path.dirname(runDir), { recursive: true });
    await fs.promises.rename(stagingDir, runDir);
    const staleLock = { hostId: 'mid-writer', fencingToken: 1, expiresAt: 0 };
    acquireFencingToken('mid-writer');
    renewLease({ hostId: 'mid-writer', fencingToken: 2, expiresAt: Date.now() + 60000 });
    await assert.rejects(
      () => atomicReplaceCurrentPointerFenced(pubRoot, runId, staleLock, runDir),
      /stale_writer_fencing_token/,
    );
    releaseLease({ hostId: 'mid-writer' });
  });
});
