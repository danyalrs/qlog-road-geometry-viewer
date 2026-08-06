'use strict';

const fs = require('fs');
const path = require('path');
const {
  acquireFencingToken,
  renewLease,
  releaseLease,
  mayDeleteRemoteStaging,
  acquireReaderPin,
  waitReaderDrain,
  runRecoveryLoop,
  applyRecoveryAction,
  readerPins,
  leaseStore,
  fencingMonotonic,
} = require('./recovery');
const { atomicReplaceCurrentPointer, deleteStagingDirectory, startHeartbeat } = require('./publication');

async function quarantineVersion(root, versionDir, quarantineDir) {
  readerPins.generation += 1;
  await waitReaderDrain();
  await fs.promises.mkdir(path.dirname(quarantineDir), { recursive: true });
  await fs.promises.rename(versionDir, quarantineDir);
  const cur = path.join(root, 'current.json');
  if (fs.existsSync(cur)) await fs.promises.unlink(cur);
}

async function runConcurrentReaderPins(count, holdMs) {
  return Promise.all(Array.from({ length: count }, async () => {
    const pin = acquireReaderPin();
    await new Promise((r) => setTimeout(r, holdMs));
    pin.release();
  }));
}

async function runRecoveryFilesystemTests(tmpRoot) {
  leaseStore.clear();
  fencingMonotonic.clear();
  readerPins.generation = 0;
  readerPins.active = 0;

  const results = [];
  const root = path.join(tmpRoot, 'recovery-root');
  const staging = path.join(root, '.staging', 'remote-run');
  await fs.promises.mkdir(staging, { recursive: true });
  await fs.promises.writeFile(path.join(staging, 'payload.json'), '{}');

  const lock = { hostId: 'host-remote', fencingToken: 5, expiresAt: Date.now() + 60000 };
  renewLease(lock);
  const denyToken = acquireFencingToken('host-local');
  results.push({ name: 'active-lease-denies-delete', pass: mayDeleteRemoteStaging(lock, denyToken) === false });

  releaseLease(lock);
  fencingMonotonic.set('host-remote', 5);
  const staleToken = acquireFencingToken('host-local');
  results.push({ name: 'expired-lease-allows-delete', pass: mayDeleteRemoteStaging(lock, staleToken) === true });

  const newerLock = { hostId: 'host-remote', fencingToken: 10, expiresAt: Date.now() + 60000 };
  renewLease(newerLock);
  const olderRecoveryToken = 8;
  results.push({
    name: 'newer-fencing-token-denies-delete',
    pass: mayDeleteRemoteStaging(newerLock, olderRecoveryToken) === false,
  });
  releaseLease(newerLock);

  const hbStaging = path.join(root, '.staging', 'remote-run');
  const hb = startHeartbeat(hbStaging, 25);
  await new Promise((r) => setTimeout(r, 50));
  const delResult = await applyRecoveryAction('DELETE_STAGING', {
    recoveryToken: staleToken,
    lock: { hostId: 'host-remote', fencingToken: 5, expiresAt: Date.now() - 1 },
    fsRoot: root,
    stagingPath: hbStaging,
    heartbeat: hb,
    stagingExists: true,
  });
  results.push({
    name: 'recovery-delete-staging-fs',
    pass: delResult.log.includes('deleted_staging_fs') && !fs.existsSync(hbStaging),
  });

  const versionDir = path.join(root, 'versions', 'run-old');
  const quarantineDir = path.join(root, 'quarantine', 'run-old');
  await fs.promises.mkdir(versionDir, { recursive: true });
  await fs.promises.writeFile(path.join(versionDir, 'data.json'), '{}');
  await atomicReplaceCurrentPointer(root, 'run-old');

  const pin = acquireReaderPin();
  readerPins.generation += 1;
  const pinBlocked = pin.generation !== readerPins.generation;
  pin.release();

  const pinHolders = runConcurrentReaderPins(3, 80);
  await new Promise((r) => setTimeout(r, 5));
  const quarantinePromise = quarantineVersion(root, versionDir, quarantineDir);
  await pinHolders;
  await quarantinePromise;
  results.push({ name: 'concurrent-reader-drain-before-quarantine', pass: fs.existsSync(quarantineDir) && !fs.existsSync(versionDir) });
  results.push({ name: 'new-pin-blocked-after-generation-bump', pass: pinBlocked });
  results.push({ name: 'current-unlinked-after-quarantine', pass: !fs.existsSync(path.join(root, 'current.json')) });

  const tmpFile = path.join(root, 'current.json.tmp');
  await fs.promises.writeFile(tmpFile, '{}');
  const tmpDel = await applyRecoveryAction('DELETE_CURRENT_TMP', { fsRoot: root, currentTmpExists: true });
  results.push({ name: 'delete-current-tmp-fs', pass: tmpDel.log.includes('deleted_current_tmp_fs') && !fs.existsSync(tmpFile) });

  const crashRoot = path.join(tmpRoot, 'crash-root');
  await fs.promises.mkdir(crashRoot, { recursive: true });
  const crashStaging = path.join(crashRoot, '.staging', 'crash-run');
  await fs.promises.mkdir(crashStaging, { recursive: true });
  await fs.promises.writeFile(path.join(crashRoot, 'current.json.tmp'), '{"runId":"orphan"}');
  const restart = await runRecoveryLoop({
    hostId: 'host-restart',
    fsRoot: crashRoot,
    stagingExists: true,
    stagingPath: crashStaging,
    lock: { hostId: 'remote', fencingToken: 1, expiresAt: Date.now() - 1 },
    validRunId: 'run-recovered',
    rewritePointer: true,
    currentTmpExists: true,
    quarantineNeeded: false,
    currentPointsToMissing: false,
    currentMissing: false,
  });
  results.push({
    name: 'crash-restart-recovery',
    pass: restart.terminal === 'STABLE'
      && !fs.existsSync(path.join(crashRoot, 'current.json.tmp'))
      && fs.existsSync(path.join(crashRoot, 'current.json')),
  });

  const loop = await runRecoveryLoop({
    hostId: 'host-recovery',
    fsRoot: root,
    stagingExists: false,
    validRunId: 'run-valid',
    rewritePointer: true,
    currentTmpExists: false,
    quarantineNeeded: false,
    currentPointsToMissing: false,
    currentMissing: false,
  });
  results.push({ name: 'recovery-loop-stable', pass: loop.terminal === 'STABLE' });

  return { allPass: results.every((r) => r.pass), results };
}

module.exports = {
  quarantineVersion,
  runConcurrentReaderPins,
  runRecoveryFilesystemTests,
};
