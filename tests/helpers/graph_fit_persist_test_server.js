'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

const APP_JS_MARKERS = [
  'getOrBuildStationaryMapAsync',
  'mapAcquisitionGeneration',
  'mapContextsCompatible',
  'GraphFitPersistCache',
];

const CACHE_JS_MARKERS = [
  'kommuGraphFitPersistV1',
  'graph-fit-persist-v1',
  'getPersistentWriteState',
  'waitForWriteCommitted',
  'readRawRecord',
];

const GRAPH_FIT_JS_MARKERS = [
  'path1-heldout-memo-v1',
  'GRAPH_FIT_CACHE_IMPL_VERSION',
];

function inspectPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr ":${port}"`, { encoding: 'utf8' });
    const listeners = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (!pid) continue;
      let cmdline = null;
      try {
        cmdline = execSync(`wmic process where processid=${pid} get CommandLine /value`, { encoding: 'utf8' })
          .split(/\r?\n/)
          .find((l) => l.startsWith('CommandLine='))
          ?.slice('CommandLine='.length)
          ?.trim() || null;
      } catch {
        cmdline = '(command line unavailable)';
      }
      listeners.push({ pid, cmdline });
    }
    return { occupied: listeners.length > 0, listeners };
  } catch {
    return { occupied: false, listeners: [] };
  }
}

function findFreePort(start = 3860, end = 3999) {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryNext = () => {
      if (port > end) {
        reject(new Error(`no free port in range ${start}-${end}`));
        return;
      }
      const info = inspectPort(port);
      if (info.occupied) {
        port += 1;
        tryNext();
        return;
      }
      const srv = net.createServer();
      srv.once('error', () => {
        port += 1;
        tryNext();
      });
      srv.listen(port, '127.0.0.1', () => {
        const chosen = srv.address().port;
        srv.close(() => resolve(chosen));
      });
    };
    tryNext();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error(`timeout: ${url}`)); });
  });
}

async function waitForHealth(port, { attempts = 60, intervalMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/api/segments`);
      if (res.status === 200) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function verifyScriptMarkers(body, markers, label) {
  const missing = markers.filter((m) => !body.includes(m));
  if (missing.length) {
    throw new Error(`${label} missing markers: ${missing.join(', ')}`);
  }
}

async function verifyServerAssets(port) {
  const app = await httpGet(`http://127.0.0.1:${port}/app.js`);
  if (app.status !== 200) throw new Error(`/app.js returned ${app.status}`);
  verifyScriptMarkers(app.body, APP_JS_MARKERS, 'app.js');

  const cache = await httpGet(`http://127.0.0.1:${port}/graph_fit_persistent_cache.js`);
  if (cache.status !== 200) throw new Error(`/graph_fit_persistent_cache.js returned ${cache.status}`);
  verifyScriptMarkers(cache.body, CACHE_JS_MARKERS, 'graph_fit_persistent_cache.js');

  const gf = await httpGet(`http://127.0.0.1:${port}/graph_fit.js`);
  if (gf.status !== 200) throw new Error(`/graph_fit.js returned ${gf.status}`);
  verifyScriptMarkers(gf.body, GRAPH_FIT_JS_MARKERS, 'graph_fit.js');

  return {
    appJsBytes: app.body.length,
    cacheJsBytes: cache.body.length,
    graphFitJsBytes: gf.body.length,
    implVersion: (gf.body.match(/path1-heldout-memo-v1/) || [])[0] || null,
    schemaVersion: (cache.body.match(/graph-fit-persist-v1/) || [])[0] || null,
  };
}

async function startVerifiedServer({ preferredPort = null } = {}) {
  const port = await findFreePort();
  if (preferredPort != null && preferredPort !== port) {
    const info = inspectPort(preferredPort);
    if (!info.occupied) {
      // preferred port verified free; use bind-selected port anyway for safety
    }
  }

  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => stdout.push(d.toString()));
  child.stderr.on('data', (d) => stderr.push(d.toString()));

  const earlyExit = new Promise((_, reject) => {
    child.once('error', (err) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`EADDRINUSE on port ${port}`));
      else reject(err);
    });
    child.once('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        reject(new Error(`server exited early code=${code} signal=${signal}\n${stderr.join('')}`));
      }
    });
  });

  const healthy = await Promise.race([
    waitForHealth(port).then((ok) => {
      if (!ok) throw new Error(`health check failed on port ${port}`);
      return true;
    }),
    earlyExit,
  ]);

  if (!healthy) throw new Error(`server failed to become healthy on port ${port}`);

  const signatures = await verifyServerAssets(port);

  return {
    port,
    pid: child.pid,
    cwd: ROOT,
    signatures,
    stdout,
    stderr,
    stop() {
      return new Promise((resolve) => {
        if (child.killed || child.exitCode != null) {
          resolve(child.exitCode);
          return;
        }
        child.once('exit', () => resolve(child.exitCode));
        child.kill();
      });
    },
  };
}

module.exports = {
  ROOT,
  APP_JS_MARKERS,
  CACHE_JS_MARKERS,
  GRAPH_FIT_JS_MARKERS,
  inspectPort,
  findFreePort,
  startVerifiedServer,
  verifyServerAssets,
  httpGet,
};
