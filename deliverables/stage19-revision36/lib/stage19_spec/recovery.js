'use strict';

const { config } = require('./config');

const leaseStore = new Map();
const fencingMonotonic = new Map();

function acquireFencingToken(hostId) {
  const prev = fencingMonotonic.get(hostId) || 0;
  const next = prev + 1;
  fencingMonotonic.set(hostId, next);
  return next;
}

function renewLease(lock) {
  lock.expiresAt = Date.now() + config.leaseTtlMs;
  leaseStore.set(lock.hostId, { fencingToken: lock.fencingToken, expiresAt: lock.expiresAt });
}

function releaseLease(lock) {
  leaseStore.delete(lock.hostId);
}

function mayDeleteRemoteStaging(lock, recoveryToken) {
  const lease = leaseStore.get(lock.hostId);
  if (lease && lease.fencingToken === lock.fencingToken && lease.expiresAt > Date.now()) return false;
  return recoveryToken > (lease?.fencingToken || 0);
}

const readerPins = { generation: 0, active: 0 };

function acquireReaderPin() {
  const g = readerPins.generation;
  readerPins.active += 1;
  return {
    generation: g,
    release: () => { readerPins.active -= 1; },
  };
}

async function waitReaderDrain() {
  while (readerPins.active > 0) await new Promise((r) => setTimeout(r, 1));
}

function selectRecoveryAction(ctx) {
  if (ctx.abort) return 'ABORT_RECOVERY';
  if (!ctx.validRunId && ctx.currentMissing) return 'FAIL_NO_VALID_VERSION';
  if (ctx.stagingExists && ctx.lock) return 'DELETE_STAGING';
  if (ctx.currentTmpExists) return 'DELETE_CURRENT_TMP';
  if (ctx.quarantineNeeded) return 'QUARANTINE_VERSION';
  if (ctx.currentPointsToMissing) return 'DELETE_CURRENT_FILE';
  if (ctx.validRunId && ctx.rewritePointer) return 'WRITE_CURRENT_POINTER';
  return 'NO_OP';
}

async function applyRecoveryAction(action, ctx) {
  const log = [];
  switch (action) {
    case 'NO_OP':
      return { stable: true, log };
    case 'DELETE_STAGING':
      if (mayDeleteRemoteStaging(ctx.lock, ctx.recoveryToken)) {
        log.push('deleted_staging');
      } else {
        log.push('staging_delete_denied');
      }
      ctx.stagingExists = false;
      return { stable: false, log };
    case 'WRITE_CURRENT_POINTER':
      log.push(`write_pointer:${ctx.validRunId}`);
      ctx.rewritePointer = false;
      ctx.currentPointsToMissing = false;
      return { stable: false, log };
    case 'DELETE_CURRENT_FILE':
      readerPins.generation += 1;
      await waitReaderDrain();
      log.push('deleted_current');
      ctx.currentMissing = true;
      return { stable: false, log };
    case 'DELETE_CURRENT_TMP':
      log.push('deleted_current_tmp');
      ctx.currentTmpExists = false;
      return { stable: false, log };
    case 'QUARANTINE_VERSION':
      readerPins.generation += 1;
      await waitReaderDrain();
      log.push('quarantined_version');
      ctx.quarantineNeeded = false;
      ctx.currentPointsToMissing = true;
      return { stable: false, log };
    case 'ABORT_RECOVERY':
      return { stable: true, terminal: 'ABORT', log };
    case 'FAIL_NO_VALID_VERSION':
      return { stable: true, terminal: 'FAIL', log };
    default:
      throw new Error('unknownRecoveryAction');
  }
}

async function runRecoveryLoop(ctx) {
  const recoveryToken = acquireFencingToken(ctx.hostId);
  ctx.recoveryToken = recoveryToken;
  const trace = [];
  for (let i = 0; i < 20; i++) {
    const action = selectRecoveryAction(ctx);
    const r = await applyRecoveryAction(action, ctx);
    trace.push({ action, ...r });
    if (r.stable) return { terminal: r.terminal || 'STABLE', trace };
  }
  return { terminal: 'LOOP_LIMIT', trace };
}

function runRecoveryFixtures() {
  const results = [];
  leaseStore.clear();
  fencingMonotonic.clear();
  const hostId = 'host-1';
  const lock = { hostId, fencingToken: 5, expiresAt: Date.now() + 60000 };
  renewLease(lock);
  const deny = mayDeleteRemoteStaging(lock, acquireFencingToken(hostId));
  results.push({ name: 'active-lease-denies-delete', pass: deny === false });

  releaseLease(lock);
  fencingMonotonic.set(hostId, 5);
  const allow = mayDeleteRemoteStaging(lock, 6);
  results.push({ name: 'expired-lease-allows-newer-token', pass: allow === true });

  return { allPass: results.every((r) => r.pass), results };
}

module.exports = {
  acquireFencingToken,
  renewLease,
  releaseLease,
  mayDeleteRemoteStaging,
  acquireReaderPin,
  waitReaderDrain,
  selectRecoveryAction,
  applyRecoveryAction,
  runRecoveryLoop,
  runRecoveryFixtures,
  readerPins,
  leaseStore,
  fencingMonotonic,
};
