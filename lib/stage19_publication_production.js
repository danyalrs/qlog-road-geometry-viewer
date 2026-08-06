'use strict';

const fs = require('fs');
const path = require('path');
const { jcsSerialize, jcsUtf8Bytes } = require('./stage19_spec/jcs');
const {
  writeFileAtomic,
  startHeartbeat,
  stopHeartbeat,
  deleteStagingDirectory,
  atomicReplaceCurrentPointer,
} = require('./stage19_spec/publication');
const {
  acquireFencingToken,
  renewLease,
  releaseLease,
  mayDeleteRemoteStaging,
  acquireReaderPin,
  waitReaderDrain,
  leaseStore,
} = require('./stage19_spec/recovery');
const { retryFsOperation, removeDirectoryRecursive } = require('./stage19_publication_fs');
const { isPngSignature } = require('./stage19_bev_png');
const { validateSafePath, resolveBundlePath } = require('./stage19_path_validation');

function deterministicManifest(runId, fileEntries, processingVersion) {
  return {
    schemaVersion: 'stage19_manifest_v0',
    runId,
    files: fileEntries.slice().sort((a, b) => a.path.localeCompare(b.path)),
    createdAt: '1970-01-01T00:00:00.000Z',
    processingVersion,
  };
}

async function verifyRunComplete(stagingDir, manifest) {
  for (const f of manifest.files || []) {
    const p = path.join(stagingDir, f.path);
    if (!fs.existsSync(p)) throw new Error(`incomplete_run:${f.path}`);
  }
  if (!fs.existsSync(path.join(stagingDir, 'manifest_v0.json'))) throw new Error('incomplete_run:manifest');
  if (!fs.existsSync(path.join(stagingDir, 'commit_v0.json'))) throw new Error('incomplete_run:commit');
}

function validateWriterMayPublishPointer(lock, runDir, runId) {
  const lease = leaseStore.get(lock.hostId);
  if (!lease) throw new Error('stale_writer_no_lease');
  if (lease.fencingToken !== lock.fencingToken) throw new Error('stale_writer_fencing_token');
  if (lease.expiresAt <= Date.now()) throw new Error('stale_writer_expired_lease');
  if (!fs.existsSync(path.join(runDir, 'manifest_v0.json'))) throw new Error('incomplete_run_before_pointer');
  if (!fs.existsSync(path.join(runDir, 'commit_v0.json'))) throw new Error('incomplete_run_before_pointer');
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest_v0.json'), 'utf8'));
  if (manifest.runId !== runId) throw new Error('pointer_run_mismatch');
}

async function atomicReplaceCurrentPointerFenced(publicationRoot, runId, writerLock, runDir) {
  validateWriterMayPublishPointer(writerLock, runDir, runId);
  await atomicReplaceCurrentPointer(publicationRoot, runId);
}

async function writeBundleToStaging(stagingDir, bundle) {
  await fs.promises.mkdir(stagingDir, { recursive: true });
  for (const [name, bytes] of Object.entries(bundle.serialized)) {
    await writeFileAtomic(stagingDir, name, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  }
  for (const [rel, bytes] of Object.entries(bundle.payloadFiles || {})) {
    validateSafePath(rel);
    const dest = path.join(stagingDir, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (rel.endsWith('.png') && !isPngSignature(buf)) throw new Error(`invalid_png_payload:${rel}`);
    const tmp = `${dest}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, dest);
  }
  await writeFileAtomic(stagingDir, 'manifest_v0.json', bundle.manifestBytes);
  await writeFileAtomic(stagingDir, 'commit_v0.json', jcsUtf8Bytes(bundle.commit));
}

async function publishProductionBundle(publicationRoot, bundle, options = {}) {
  if (!bundle.semantics?.ok) throw new Error('semantic_validation_failed');
  if (!bundle.qualityGates?.ok) throw new Error('quality_gates_failed');
  if (bundle.schemaValidation && !bundle.schemaValidation.ok) throw new Error('schema_validation_failed');

  const hostId = options.hostId || 'stage19-prod';
  const fencingToken = acquireFencingToken(hostId);
  const lock = { hostId, fencingToken, expiresAt: 0 };
  renewLease(lock);

  const stagingDir = path.join(publicationRoot, '.staging', bundle.runId);
  const runDir = path.join(publicationRoot, 'runs', bundle.runId);
  const hb = startHeartbeat(stagingDir, options.heartbeatMs || 50);

  try {
    if (fs.existsSync(runDir) && !options.allowExistingRunDir) {
      throw new Error('run_directory_exists');
    }
    await writeBundleToStaging(stagingDir, bundle);
    await verifyRunComplete(stagingDir, bundle.manifest);

    await stopHeartbeat(hb);
    await sleepAfterHandleRelease(options.handleReleaseMs ?? 20);

    await fs.promises.mkdir(path.dirname(runDir), { recursive: true });
    if (fs.existsSync(runDir)) {
      await retryFsOperation('remove_existing_run', () => removeDirectoryRecursive(runDir));
    }
    await retryFsOperation('promote_staging_to_run', async () => {
      await fs.promises.rename(stagingDir, runDir);
    });
    await verifyRunComplete(runDir, bundle.manifest);

    renewLease(lock);
    await atomicReplaceCurrentPointerFenced(publicationRoot, bundle.runId, lock, runDir);

    const publishedLock = path.join(runDir, '.lock');
    if (fs.existsSync(publishedLock)) {
      await fs.promises.unlink(publishedLock);
    }

    if (fs.existsSync(stagingDir)) {
      await removeDirectoryRecursive(stagingDir);
    }
    const stagingParent = path.join(publicationRoot, '.staging');
    try {
      const remaining = await fs.promises.readdir(stagingParent);
      if (remaining.length === 0) await fs.promises.rmdir(stagingParent);
    } catch (_) { /* parent may not exist */ }

    return { runDir, currentPath: path.join(publicationRoot, 'current.json'), fencingToken };
  } catch (e) {
    await stopHeartbeat(hb);
    if (mayDeleteRemoteStaging({ hostId, fencingToken, expiresAt: Date.now() - 1 }, fencingToken)) {
      if (fs.existsSync(stagingDir)) {
        await deleteStagingDirectory(stagingDir, { stopped: true, timer: null, writes: hb.writes });
      }
    }
    throw e;
  } finally {
    releaseLease(lock);
  }
}

async function quarantineRun(publicationRoot, runId, options = {}) {
  if (options.simulateActiveReader) {
    const hold = acquireReaderPin();
    setImmediate(() => hold.release());
  }
  await waitReaderDrain();

  const versionDir = path.join(publicationRoot, 'runs', runId);
  const quarantineDir = path.join(publicationRoot, 'quarantine', runId);
  if (!fs.existsSync(versionDir)) throw new Error('run_missing');
  await fs.promises.mkdir(path.dirname(quarantineDir), { recursive: true });
  await fs.promises.rename(versionDir, quarantineDir);
  const cur = path.join(publicationRoot, 'current.json');
  if (fs.existsSync(cur)) {
    const current = JSON.parse(await fs.promises.readFile(cur, 'utf8'));
    if (current.runId === runId) await fs.promises.unlink(cur);
  }
  return { quarantineDir };
}

async function sleepAfterHandleRelease(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  deterministicManifest,
  publishProductionBundle,
  quarantineRun,
  validateSafePath,
  resolveBundlePath,
  verifyRunComplete,
  writeBundleToStaging,
  validateWriterMayPublishPointer,
  atomicReplaceCurrentPointerFenced,
  sleepAfterHandleRelease,
};
