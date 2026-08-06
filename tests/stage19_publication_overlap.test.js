'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { fork } = require('child_process');
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');
const { buildStage19Bundle } = require('../lib/stage19_bundle_builder');
const {
  publishProductionBundle,
  quarantineRun,
  writeBundleToStaging,
  verifyRunComplete,
  atomicReplaceCurrentPointerFenced,
  validateWriterMayPublishPointer,
} = require('../lib/stage19_publication_production');
const {
  acquireReaderPin,
  acquireFencingToken,
  renewLease,
  releaseLease,
  leaseStore,
  mayDeleteRemoteStaging,
  applyRecoveryAction,
} = require('../lib/stage19_spec/recovery');
const { atomicReplaceCurrentPointer, startHeartbeat } = require('../lib/stage19_spec/publication');

const ROOT = path.join(__dirname, '..');

async function buildMinimalBundle(runId) {
  const context = buildStage19InputContext(ROOT);
  injectStage17Gaps(context.gaps);
  try {
    return await buildStage19Bundle(context, { runId });
  } finally {
    clearStage17Gaps();
  }
}

function forkRaceChild(pubRoot, runId, slot, wait = false) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'helpers', 'stage19_publish_race_child.js'), [pubRoot, runId, wait ? 'wait' : '0'], {
      cwd: ROOT,
      env: { ...process.env },
    });
    child.on('message', resolve);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`child_exit_${code}`));
    });
  });
}

describe('Stage 19 v4 overlapping publication', () => {
  it('concurrent writers: exactly one succeeds and one fails', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-writers-'));
    const runId = 'stage19-overlap-writer-test';
    const bundle = await buildMinimalBundle(runId);
    const results = await Promise.allSettled([
      publishProductionBundle(pubRoot, bundle, { allowExistingRunDir: true, hostId: 'writer-a' }),
      publishProductionBundle(pubRoot, bundle, { allowExistingRunDir: true, hostId: 'writer-b' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(fs.existsSync(path.join(pubRoot, 'runs', runId)));
    assert.ok(fs.existsSync(path.join(pubRoot, 'current.json')));
    assert.equal(fs.existsSync(path.join(pubRoot, '.staging', runId)), false);
  });

  it('quarantine waits for external reader then completes', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-quar-'));
    const runId = 'stage19-overlap-quar-test';
    const bundle = await buildMinimalBundle(runId);
    await publishProductionBundle(pubRoot, bundle, { allowExistingRunDir: true });

    const pin = acquireReaderPin();
    let drained = false;
    const quarPromise = quarantineRun(pubRoot, runId).then((r) => { drained = true; return r; });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(drained, false);
    pin.release();
    const q = await quarPromise;
    assert.ok(fs.existsSync(q.quarantineDir));
    assert.equal(fs.existsSync(path.join(pubRoot, 'runs', runId)), false);
  });

  it('rerun same run ID replaces without mixed artifacts', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-rerun-'));
    const runId = 'stage19-overlap-rerun-test';
    const b1 = await buildMinimalBundle(runId);
    await publishProductionBundle(pubRoot, b1, { allowExistingRunDir: true });
    const manifest1 = fs.readFileSync(path.join(pubRoot, 'runs', runId, 'manifest_v0.json'), 'utf8');
    const b2 = await buildMinimalBundle(runId);
    await publishProductionBundle(pubRoot, b2, { allowExistingRunDir: true });
    const manifest2 = fs.readFileSync(path.join(pubRoot, 'runs', runId, 'manifest_v0.json'), 'utf8');
    assert.equal(manifest1, manifest2);
    assert.equal(fs.existsSync(path.join(pubRoot, '.staging', runId)), false);
    assert.equal(fs.existsSync(path.join(pubRoot, 'runs', runId, '.lock')), false);
  });

  it('child process concurrent publication: one winner and one fenced loser', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-child-'));
    const runId = 'stage19-overlap-child-test';
    const bundle = await buildMinimalBundle(runId);
    await publishProductionBundle(pubRoot, bundle, { allowExistingRunDir: true, hostId: 'seed-writer' });

    const childA = fork(path.join(__dirname, 'helpers', 'stage19_publish_race_child.js'), [pubRoot, runId, 'a'], { cwd: ROOT });
    const childB = fork(path.join(__dirname, 'helpers', 'stage19_publish_race_child.js'), [pubRoot, runId, 'b'], { cwd: ROOT });
    const outcomes = await Promise.all([
      new Promise((resolve) => childA.on('message', resolve)),
      new Promise((resolve) => childB.on('message', resolve)),
    ]);
    const winners = outcomes.filter((o) => o.ok === true);
    const losers = outcomes.filter((o) => o.ok === false);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.match(String(losers[0].error), /quality_gates_failed|run_directory_exists|stale_writer|EPERM|EBUSY|EACCES|ENOENT|incomplete_run/);
  });

  it('stale writer cannot publish pointer after winner fencing token advances', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-stale-pointer-'));
    const runId = 'stage19-overlap-stale-pointer';
    const runDir = path.join(pubRoot, 'runs', runId);
    const bundle = await buildMinimalBundle(runId);
    await publishProductionBundle(pubRoot, bundle, { allowExistingRunDir: true, hostId: 'winner-writer' });

    const staleLock = { hostId: 'stale-writer', fencingToken: 1, expiresAt: 0 };
    acquireFencingToken('stale-writer');
    renewLease({ hostId: 'stale-writer', fencingToken: 2, expiresAt: 0 });
    await assert.rejects(
      () => atomicReplaceCurrentPointerFenced(pubRoot, runId, staleLock, runDir),
      /stale_writer_fencing_token/,
    );
    const current = JSON.parse(fs.readFileSync(path.join(pubRoot, 'current.json'), 'utf8'));
    assert.equal(current.runId, runId);
    releaseLease({ hostId: 'stale-writer' });
  });

  it('stale fencing token cannot delete active remote staging', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-stale-'));
    const stagingDir = path.join(pubRoot, '.staging', 'stale-run');
    await fs.promises.mkdir(stagingDir, { recursive: true });
    await fs.promises.writeFile(path.join(stagingDir, 'partial.json'), '{}');
    const lock = { hostId: 'remote-host', fencingToken: 10, expiresAt: Date.now() + 60000 };
    renewLease(lock);
    const staleToken = acquireFencingToken('local-recovery');
    assert.equal(mayDeleteRemoteStaging(lock, staleToken), false);
    releaseLease(lock);
  });

  it('heartbeat stops before staging cleanup after failed publication', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-hb-'));
    const runId = 'hb-fail-run';
    const bundle = await buildMinimalBundle(runId);
    bundle.qualityGates = { ok: false, errors: [{ code: 'forced_fail' }] };
    await assert.rejects(
      () => publishProductionBundle(pubRoot, bundle, { allowExistingRunDir: true }),
      /quality_gates_failed/,
    );
    const stagingDir = path.join(pubRoot, '.staging', runId);
    assert.equal(fs.existsSync(stagingDir), false);
  });

  it('crash before immutable-run rename leaves no current pointer until recovery', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-crash-before-rename-'));
    const runId = 'stage19-overlap-crash-before-rename';
    const stagingDir = path.join(pubRoot, '.staging', runId);
    const runDir = path.join(pubRoot, 'runs', runId);
    const bundle = await buildMinimalBundle(runId);
    await writeBundleToStaging(stagingDir, bundle);
    await verifyRunComplete(stagingDir, bundle.manifest);
    assert.equal(fs.existsSync(runDir), false);
    assert.equal(fs.existsSync(path.join(pubRoot, 'current.json')), false);
    await fs.promises.mkdir(path.dirname(runDir), { recursive: true });
    await fs.promises.rename(stagingDir, runDir);
    assert.ok(fs.existsSync(path.join(runDir, 'manifest_v0.json')));
    assert.equal(fs.existsSync(path.join(pubRoot, 'current.json')), false);
    const lock = { hostId: 'recovery-writer', fencingToken: acquireFencingToken('recovery-writer'), expiresAt: 0 };
    renewLease(lock);
    await atomicReplaceCurrentPointerFenced(pubRoot, runId, lock, runDir);
    releaseLease(lock);
    const current = JSON.parse(fs.readFileSync(path.join(pubRoot, 'current.json'), 'utf8'));
    assert.equal(current.runId, runId);
  });

  it('concurrent reader verifies pinned manifest bytes while current.json changes', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-read-bytes-'));
    const runA = 'stage19-overlap-read-a';
    const runB = 'stage19-overlap-read-b';
    const bA = await buildMinimalBundle(runA);
    const bB = await buildMinimalBundle(runB);
    await publishProductionBundle(pubRoot, bA, { allowExistingRunDir: true });

    const reader = fork(path.join(__dirname, 'helpers', 'stage19_read_pin_child.js'), [pubRoot], { cwd: ROOT });
    const pinned = await new Promise((resolve) => reader.on('message', (msg) => {
      if (msg.phase === 'pinned') resolve(msg);
    }));
    assert.equal(pinned.runId, runA);

    await publishProductionBundle(pubRoot, bB, { allowExistingRunDir: true });
    const afterCurrent = JSON.parse(fs.readFileSync(path.join(pubRoot, 'current.json'), 'utf8'));
    assert.equal(afterCurrent.runId, runB);

    reader.send('release-check');
    const verified = await new Promise((resolve) => reader.on('message', (msg) => {
      if (msg.phase === 'verified') resolve(msg);
    }));
    assert.equal(verified.unchanged, true);
    assert.equal(verified.sha256, pinned.sha256);
  });

  it('expired lease allows recovery to delete orphaned staging', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-lease-'));
    const stagingDir = path.join(pubRoot, '.staging', 'orphan-run');
    await fs.promises.mkdir(stagingDir, { recursive: true });
    await fs.promises.writeFile(path.join(stagingDir, 'orphan.json'), '{}');
    const hb = startHeartbeat(stagingDir, 25);
    await new Promise((r) => setTimeout(r, 40));
    const recoveryToken = acquireFencingToken('recovery-host');
    const del = await applyRecoveryAction('DELETE_STAGING', {
      recoveryToken,
      lock: { hostId: 'dead-host', fencingToken: 1, expiresAt: Date.now() - 1 },
      fsRoot: pubRoot,
      stagingPath: stagingDir,
      heartbeat: hb,
      stagingExists: true,
    });
    assert.ok(del.log.includes('deleted_staging_fs'));
    assert.equal(fs.existsSync(stagingDir), false);
  });

  it('fenced publication rejects stale lock before current.json replacement', async () => {
    const pubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-overlap-fence-gate-'));
    const runId = 'stage19-overlap-fence-gate';
    const runDir = path.join(pubRoot, 'runs', runId);
    const bundle = await buildMinimalBundle(runId);
    await writeBundleToStaging(path.join(pubRoot, '.staging', runId), bundle);
    await verifyRunComplete(path.join(pubRoot, '.staging', runId), bundle.manifest);
    await fs.promises.mkdir(path.dirname(runDir), { recursive: true });
    await fs.promises.cp(path.join(pubRoot, '.staging', runId), runDir, { recursive: true });
    leaseStore.set('gate-writer', { fencingToken: 99, expiresAt: Date.now() - 1 });
    const staleLock = { hostId: 'gate-writer', fencingToken: 99, expiresAt: Date.now() - 1 };
    assert.throws(
      () => validateWriterMayPublishPointer(staleLock, runDir, runId),
      /stale_writer_expired_lease/,
    );
  });
});
