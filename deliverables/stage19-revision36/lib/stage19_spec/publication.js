'use strict';

const fs = require('fs');
const path = require('path');
const { jcsSerialize, jcsUtf8Bytes } = require('./jcs');

function validatePathComponent(c) {
  if (c.includes('/') || c.includes('\\') || c === '..' || c === '.') throw new Error('invalidPathComponent');
}

async function writeFileAtomic(dir, name, bytes) {
  validatePathComponent(name);
  const target = path.join(dir, name);
  const tmp = `${target}.tmp`;
  await fs.promises.writeFile(tmp, bytes);
  await fs.promises.rename(tmp, target);
}

function startHeartbeat(stagingDir, intervalMs = 50) {
  const hb = { stopped: false, timer: null, writes: 0 };
  hb.timer = setInterval(() => {
    if (hb.stopped) return;
    fs.writeFileSync(path.join(stagingDir, '.lock'), String(Date.now()));
    hb.writes += 1;
  }, intervalMs);
  return hb;
}

async function stopHeartbeat(hb) {
  hb.stopped = true;
  if (hb.timer) {
    clearInterval(hb.timer);
    hb.timer = null;
  }
}

async function deleteStagingDirectory(stagingDir, hb) {
  await stopHeartbeat(hb);
  await fs.promises.rm(stagingDir, { recursive: true, force: true });
}

async function atomicReplaceCurrentPointer(root, runId) {
  const tmp = path.join(root, 'current.json.tmp');
  const cur = path.join(root, 'current.json');
  const bytes = Buffer.from(jcsSerialize({ runId }), 'utf8');
  await fs.promises.writeFile(tmp, bytes);
  await fs.promises.rename(tmp, cur);
}

async function publishStage19Bundle(root, bundle) {
  const staging = path.join(root, '.staging', bundle.runId);
  const hb = startHeartbeat(staging);
  try {
    await fs.promises.mkdir(staging, { recursive: true });
    for (const f of bundle.files) {
      await writeFileAtomic(staging, f.name, f.bytes);
    }
    await atomicReplaceCurrentPointer(root, bundle.runId);
    await stopHeartbeat(hb);
    return { ok: true, staging, hb };
  } catch (e) {
    await deleteStagingDirectory(staging, hb);
    throw e;
  }
}

async function runPublicationIntegrationTests(tmpRoot) {
  const root = path.join(tmpRoot, 'pub-root');
  await fs.promises.mkdir(root, { recursive: true });
  const results = [];

  const bundle = {
    runId: 'run-pub-test',
    files: [{ name: 'manifest.json', bytes: Buffer.from('{}') }],
  };
  const pub = await publishStage19Bundle(root, bundle);
  const current = JSON.parse(await fs.promises.readFile(path.join(root, 'current.json'), 'utf8'));
  results.push({ name: 'publish-writes-current', pass: current.runId === 'run-pub-test' });
  results.push({ name: 'heartbeat-stopped', pass: pub.hb.stopped === true && pub.hb.timer === null });

  const failRoot = path.join(tmpRoot, 'pub-fail');
  await fs.promises.mkdir(failRoot, { recursive: true });
  const staging = path.join(failRoot, '.staging', 'run-fail');
  await fs.promises.mkdir(staging, { recursive: true });
  const hb2 = startHeartbeat(staging, 20);
  await new Promise((r) => setTimeout(r, 60));
  const writesBefore = hb2.writes;
  await deleteStagingDirectory(staging, hb2);
  const stagingExists = fs.existsSync(staging);
  results.push({ name: 'failure-cleanup-removes-staging', pass: !stagingExists });
  results.push({ name: 'heartbeat-stopped-before-delete', pass: hb2.stopped && writesBefore > 0 });

  return { allPass: results.every((r) => r.pass), results };
}

module.exports = {
  validatePathComponent,
  writeFileAtomic,
  startHeartbeat,
  stopHeartbeat,
  deleteStagingDirectory,
  atomicReplaceCurrentPointer,
  publishStage19Bundle,
  runPublicationIntegrationTests,
};
