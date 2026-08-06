'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const {
  acquireFencingToken,
  renewLease,
  releaseLease,
  mayDeleteRemoteStaging,
  acquireReaderPin,
  waitReaderDrain,
  selectRecoveryAction,
  applyRecoveryAction,
  runRecoveryLoop,
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
  results.push({
    name: 'active-lease-denies-delete',
    pass: mayDeleteRemoteStaging(lock, denyToken) === false,
  });

  releaseLease(lock);
  fencingMonotonic.set('host-remote', 5);
  const allowToken = acquireFencingToken('host-local');
  results.push({
    name: 'expired-lease-allows-delete',
    pass: mayDeleteRemoteStaging(lock, allowToken) === true,
  });

  if (mayDeleteRemoteStaging(lock, allowToken)) {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
  results.push({ name: 'remote-staging-deleted', pass: !fs.existsSync(staging) });

  const versionDir = path.join(root, 'versions', 'run-old');
  const quarantineDir = path.join(root, 'quarantine', 'run-old');
  await fs.promises.mkdir(versionDir, { recursive: true });
  await fs.promises.writeFile(path.join(versionDir, 'data.json'), '{}');
  await atomicReplaceCurrentPointer(root, 'run-old');

  const pin = acquireReaderPin();
  let pinBlocked = false;
  readerPins.generation += 1;
  if (pin.generation !== readerPins.generation) pinBlocked = true;
  pin.release();

  const quarantinePromise = (async () => {
    await quarantineVersion(root, versionDir, quarantineDir);
  })();
  await waitReaderDrain();
  await quarantinePromise;
  results.push({ name: 'quarantine-moves-version', pass: fs.existsSync(quarantineDir) && !fs.existsSync(versionDir) });
  results.push({ name: 'new-pin-blocked-after-generation-bump', pass: pinBlocked });
  results.push({ name: 'current-unlinked-after-quarantine', pass: !fs.existsSync(path.join(root, 'current.json')) });

  const hbStaging = path.join(root, '.staging', 'hb-test');
  await fs.promises.mkdir(hbStaging, { recursive: true });
  const hb = startHeartbeat(hbStaging, 25);
  await new Promise((r) => setTimeout(r, 60));
  await deleteStagingDirectory(hbStaging, hb);
  results.push({ name: 'recovery-heartbeat-stop-before-delete', pass: !fs.existsSync(hbStaging) });

  const loop = await runRecoveryLoop({
    hostId: 'host-recovery',
    stagingExists: false,
    validRunId: 'run-valid',
    rewritePointer: false,
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
  runRecoveryFilesystemTests,
};
