'use strict';

/**
 * Browser persistence reliability gate (Segment 2 ×10, fresh profiles ×3, Segment 14).
 * Usage: node scripts/run_persist_browser_gate.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const { ROOT, startVerifiedServer } = require('../tests/helpers/graph_fit_persist_test_server');

const SEG2 = 'qlog_f449c_2.bz2';
const SEG14 = 'qlog_f449c_14.bz2';
const REPORT_DIR = path.join(ROOT, 'reports', 'graph_fit_performance');
const REPORT_PATH = path.join(REPORT_DIR, 'persist_browser_gate.json');
const STDOUT_PATH = path.join(REPORT_DIR, 'persist_gate_server_stdout.txt');
const STDERR_PATH = path.join(REPORT_DIR, 'persist_gate_server_stderr.txt');

const RUN_SCHEDULE = [
  { run: 1, mode: 'hard-reload' },
  { run: 2, mode: 'hard-reload' },
  { run: 3, mode: 'hard-reload' },
  { run: 4, mode: 'hard-reload' },
  { run: 5, mode: 'new-tab' },
  { run: 6, mode: 'new-tab' },
  { run: 7, mode: 'new-tab' },
  { run: 8, mode: 'reopen' },
  { run: 9, mode: 'reopen' },
  { run: 10, mode: 'fit-toggle' },
];

function resolveChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function attachErrorCollectors(page) {
  const errors = { console: [], page: [], rejections: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.console.push(msg.text());
  });
  page.on('pageerror', (e) => errors.page.push(e.message));
  return errors;
}

async function installFitCounter(page) {
  await page.evaluateOnNewDocument(() => {
    window.__fitPersistDiag = { mapFitCalls: 0, fitConstructedRunsCalls: 0 };
    const tryWrap = () => {
      if (!window.GraphFit || window.GraphFit.__persistMapWrapped) return;
      const SLM = window.SegmentLocalMap;
      if (!SLM?.buildSegmentLocalMap) return;
      const origBuild = SLM.buildSegmentLocalMap;
      SLM.buildSegmentLocalMap = function wrappedBuild(...args) {
        const opts = args[1] || {};
        if (opts.fitEnabled) window.__fitPersistDiag.mapFitCalls += 1;
        return origBuild.apply(this, args);
      };
      if (window.GraphFit.fitConstructedRuns && !window.GraphFit.__fitRunsWrapped) {
        const origFit = window.GraphFit.fitConstructedRuns;
        window.GraphFit.fitConstructedRuns = function wrappedFit(...args) {
          window.__fitPersistDiag.fitConstructedRunsCalls += 1;
          return origFit.apply(this, args);
        };
        window.GraphFit.__fitRunsWrapped = true;
      }
      window.GraphFit.__persistMapWrapped = true;
    };
    const timer = setInterval(() => {
      tryWrap();
      if (window.GraphFit?.__persistMapWrapped) clearInterval(timer);
    }, 5);
  });
}

async function wrapBuildCounter(page) {
  await page.evaluate(() => {
    window.__fitPersistDiag = window.__fitPersistDiag || { mapFitCalls: 0, fitConstructedRunsCalls: 0 };
    const SLM = window.SegmentLocalMap;
    if (!SLM || SLM.__persistMapWrapped) return;
    const origBuild = SLM.buildSegmentLocalMap;
    SLM.buildSegmentLocalMap = function wrappedBuild(...args) {
      const opts = args[1] || {};
      if (opts.fitEnabled) window.__fitPersistDiag.mapFitCalls += 1;
      return origBuild.apply(this, args);
    };
    SLM.__persistMapWrapped = true;
    if (window.GraphFit?.fitConstructedRuns && !window.GraphFit.__fitRunsWrapped) {
      const origFit = window.GraphFit.fitConstructedRuns;
      window.GraphFit.fitConstructedRuns = function wrappedFit(...args) {
        window.__fitPersistDiag.fitConstructedRunsCalls += 1;
        return origFit.apply(this, args);
      };
      window.GraphFit.__fitRunsWrapped = true;
    }
  });
}

async function clearPersistStore(page) {
  await page.waitForFunction(() => window.GraphFitPersistCache?.clearStore, { timeout: 30000 });
  await page.evaluate(async () => {
    await window.GraphFitPersistCache.clearStore();
    window.__mapAcquisitionDebug?.clearStationaryMapCache?.();
  });
  const count = await page.evaluate(async () => {
    const inspect = await window.GraphFitPersistCache.inspectStore();
    return inspect.count;
  });
  if (count !== 0) throw new Error(`IDB not empty after clearStore (count=${count})`);
}

async function waitMapReady(page, { fitRequired = true, cacheStates = null, timeoutMs = 300000 } = {}) {
  const states = cacheStates || ['miss-build', 'persistent-hit', 'memory-hit', 'built'];
  await page.waitForFunction((fitReq, allowed) => {
    const map = window.renderer?.stationaryLocalMap;
    const mode = document.getElementById('localGeometryMode')?.value;
    if (mode !== 'pointAccumulated' || !map) return false;
    if (fitReq) {
      return map?.pointAccumulated?.fittedPolylines != null && allowed.includes(map?.cacheState);
    }
    return map?.pointAccumulated != null || map?.cacheState != null;
  }, { timeout: timeoutMs }, fitRequired, states);
}

async function waitWarmPersistentHit(page, { timeoutMs = 300000 } = {}) {
  await page.waitForFunction(() => {
    const map = window.renderer?.stationaryLocalMap;
    return map
      && ['persistent-hit', 'memory-hit'].includes(map.cacheState)
      && map.pointAccumulated?.fittedPolylines != null
      && (window.__fitPersistDiag?.fitConstructedRunsCalls ?? 0) === 0;
  }, { timeout: timeoutMs });
}

async function readDiag(page) {
  return page.evaluate(() => {
    const map = window.renderer?.stationaryLocalMap;
    const pa = map?.pointAccumulated;
    const acceptedIds = (pa?.fittedPolylines?.results || [])
      .filter((r) => r.status === 'accepted').map((r) => r.fragmentId).sort();
    let coordChecksum = '';
    for (const r of (pa?.fittedPolylines?.results || [])) {
      if (r.status !== 'accepted') continue;
      const pts = Array.isArray(r.fittedPolyline) ? r.fittedPolyline.flat() : r.fittedPolyline;
      for (const p of (pts || [])) {
        coordChecksum += `${p.east},${p.north},${p.mirroredEast},${p.mirroredNorth};`;
      }
    }
    let hybridChecksum = '';
    for (const b of (pa?.hybridFittedBoundaries?.boundaries || [])) {
      for (const seg of (b.polylines || [])) {
        for (const p of (seg || [])) {
          hybridChecksum += `${p.east},${p.north},${p.mirroredEast},${p.mirroredNorth};`;
        }
      }
    }
    return {
      fitCalls: window.__fitPersistDiag?.mapFitCalls ?? 0,
      fitConstructedRunsCalls: window.__fitPersistDiag?.fitConstructedRunsCalls ?? 0,
      cacheState: map?.cacheState ?? null,
      persistCacheKey: map?.persistCacheKey ?? null,
      accepted: acceptedIds.length,
      acceptedIds,
      coordChecksum,
      hybridChecksum,
      polygonChecksum: map?.roadSurfaceChecksum ?? null,
      writeState: window.GraphFitPersistCache?.getPersistentWriteState?.() ?? null,
      lookupResult: window.GraphFitPersistCache?.getLastLookupResult?.()?.result ?? null,
      segmentSelect: document.getElementById('segmentSelect')?.value ?? null,
    };
  });
}

async function verifyIdbRecord(page, persistKey) {
  return page.evaluate(async (key) => {
    const inspect = await window.GraphFitPersistCache.inspectStore(key);
    const raw = await window.GraphFitPersistCache.readRawRecord(key);
    const valid = window.GraphFitPersistCache.validatePersistRecord(raw, { cacheKey: key });
    let checksumOk = false;
    if (raw?.map) {
      const digest = await window.GraphFitPersistCache.digestCanonical(raw.map);
      checksumOk = !raw.payloadChecksum || raw.payloadChecksum === digest;
    }
    return {
      count: inspect.count,
      keys: inspect.keys,
      keyPath: inspect.keyPath,
      storedKey: raw?.cacheKey ?? null,
      schemaVersion: raw?.schemaVersion ?? null,
      payloadChecksum: raw?.payloadChecksum ?? null,
      byteEstimate: raw?.byteEstimate ?? null,
      validationOk: valid.ok && checksumOk,
      validationReason: valid.reason ?? null,
      checksumOk,
      keyMatches: raw?.cacheKey === key,
    };
  }, persistKey);
}

async function loadSegmentLocal(page, port, segmentFile, {
  fitUrl = true,
  requirePersistWrite = true,
  fitRequired = true,
  navigate = true,
} = {}) {
  const loadStart = Date.now();
  if (navigate) {
    await page.goto(`http://127.0.0.1:${port}/${fitUrl ? '?fit=1' : ''}`, { waitUntil: 'domcontentloaded' });
  }
  await page.select('#segmentSelect', segmentFile);
  await page.click('#btnProcess');
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Done'), { timeout: 300000 });
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await page.select('#localGeometryMode', 'pointAccumulated');
  await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
  await page.evaluate(() => {
    const cb = document.getElementById('pointCausalPlayback');
    if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
  });
  if (requirePersistWrite) {
    await page.evaluate(async () => {
      const idx = parseInt(document.getElementById('timeline')?.value ?? '0', 10);
      await window.updateLocalPlayback(idx, { forceMapRebuild: true });
    });
    try {
      await waitMapReady(page, { fitRequired, cacheStates: ['miss-build'], timeoutMs: 300000 });
    } catch (err) {
      const snap = await readDiag(page);
      throw new Error(`cold miss-build wait failed: cacheState=${snap.cacheState} fitCalls=${snap.fitConstructedRunsCalls} (${err.message})`);
    }
  } else {
    await waitMapReady(page, { fitRequired });
  }
  const diag = await readDiag(page);
  let idb = null;
  if (requirePersistWrite) {
    const persistKey = diag.persistCacheKey;
    if (!persistKey) throw new Error('missing persistCacheKey after cold build');
    const commitStart = Date.now();
    await page.evaluate(async (key) => {
      await window.GraphFitPersistCache.waitForWriteCommitted(key, { timeoutMs: 300000 });
    }, persistKey);
    const commitMs = Date.now() - commitStart;
    idb = await verifyIdbRecord(page, persistKey);
    if (!idb.validationOk || idb.count < 1 || !idb.keyMatches) {
      throw new Error(`IDB verification failed: ${JSON.stringify(idb)}`);
    }
    idb.commitMs = commitMs;
  }
  return { ...diag, loadMs: Date.now() - loadStart, idb };
}

async function warmLoadSegment2(page, port, { navigateMode = 'reload' } = {}) {
  const warmStart = Date.now();
  await page.evaluate(() => {
    window.__fitPersistDiag = { mapFitCalls: 0, fitConstructedRunsCalls: 0 };
  });
  await wrapBuildCounter(page);

  const readStart = Date.now();
  if (navigateMode === 'reload') {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.goto(`http://127.0.0.1:${port}/?fit=1`, { waitUntil: 'domcontentloaded' });
  } else if (navigateMode === 'goto') {
    await page.goto(`http://127.0.0.1:${port}/?fit=1`, { waitUntil: 'domcontentloaded' });
  }
  await wrapBuildCounter(page);

  await page.select('#segmentSelect', SEG2);
  await page.click('#btnProcess');
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Done'), { timeout: 300000 });
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await page.select('#localGeometryMode', 'pointAccumulated');
  await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
  await page.evaluate(() => {
    const cb = document.getElementById('pointCausalPlayback');
    if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
  });

  const acquireStart = Date.now();
  await waitWarmPersistentHit(page);
  const rendererReadyMs = Date.now() - acquireStart;
  const persistentReadMs = Date.now() - readStart;
  const diag = await readDiag(page);
  return {
    ...diag,
    timings: {
      totalWarmMs: Date.now() - warmStart,
      persistentReadMs,
      rendererReadyMs,
      deserializationMs: Math.max(0, rendererReadyMs - persistentReadMs),
    },
  };
}

function assertWarmMatchesCold(cold, warm, label) {
  if (!['persistent-hit', 'memory-hit'].includes(warm.cacheState)) {
    throw new Error(`${label}: expected persistent-hit got ${warm.cacheState} (lookup=${warm.lookupResult})`);
  }
  if (warm.fitConstructedRunsCalls !== 0) {
    throw new Error(`${label}: fitConstructedRunsCalls=${warm.fitConstructedRunsCalls}`);
  }
  if (warm.accepted !== cold.accepted) {
    throw new Error(`${label}: accepted ${warm.accepted} != ${cold.accepted}`);
  }
  if (warm.coordChecksum !== cold.coordChecksum) throw new Error(`${label}: coord checksum mismatch`);
  if (warm.hybridChecksum !== cold.hybridChecksum) throw new Error(`${label}: hybrid checksum mismatch`);
  if (warm.polygonChecksum !== cold.polygonChecksum) throw new Error(`${label}: polygon checksum mismatch`);
}

function launchBrowser(chromePath, userDataDir = null) {
  const opts = {
    headless: true,
    executablePath: chromePath,
    args: ['--no-sandbox'],
  };
  if (userDataDir) opts.userDataDir = userDataDir;
  return puppeteer.launch(opts);
}

async function runSeg2Cycle(browser, port, runSpec, { userDataDir = null } = {}) {
  const { run, mode } = runSpec;
  const page = await browser.newPage();
  const errors = attachErrorCollectors(page);
  await installFitCounter(page);
  await page.goto(`http://127.0.0.1:${port}/?fit=1`, { waitUntil: 'domcontentloaded' });
  await clearPersistStore(page);

  const cold = await loadSegmentLocal(page, port, SEG2, { requirePersistWrite: true });
  if (!['miss-build', 'built'].includes(cold.cacheState)) {
    throw new Error(`run ${run} cold: expected miss-build got ${cold.cacheState}`);
  }
  if (cold.fitConstructedRunsCalls < 1) throw new Error(`run ${run} cold: expected fitConstructedRuns >= 1`);
  if (cold.accepted !== 4) throw new Error(`run ${run} cold: accepted=${cold.accepted}`);
  if (cold.writeState?.state !== 'committed') throw new Error(`run ${run} cold: write not committed`);

  let warm = null;
  let browserOut = browser;

  if (mode === 'hard-reload') {
    warm = await warmLoadSegment2(page, port, { navigateMode: 'reload' });
    assertWarmMatchesCold(cold, warm, `run ${run}`);
    await page.close();
  } else if (mode === 'new-tab') {
    const page2 = await browser.newPage();
    await installFitCounter(page2);
    warm = await warmLoadSegment2(page2, port, { navigateMode: 'goto' });
    assertWarmMatchesCold(cold, warm, `run ${run}`);
    await page.close();
    await page2.close();
  } else if (mode === 'reopen') {
    const profileDir = userDataDir || browser.__userDataDir;
    if (!profileDir) throw new Error(`run ${run} reopen: missing userDataDir`);
    await page.close();
    await browser.close();
    browserOut = await launchBrowser(resolveChromeExecutable(), profileDir);
    browserOut.__userDataDir = profileDir;
    const page2 = await browserOut.newPage();
    await installFitCounter(page2);
    warm = await warmLoadSegment2(page2, port, { navigateMode: 'goto' });
    assertWarmMatchesCold(cold, warm, `run ${run}`);
    await page2.close();
  } else if (mode === 'fit-toggle') {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await wrapBuildCounter(page);
    await page.select('#segmentSelect', SEG2);
    await page.click('#btnProcess');
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Done'), { timeout: 300000 });
    await page.select('#vizMode', 'local');
    await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
    await page.select('#localGeometryMode', 'pointAccumulated');
    await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
    const fit0 = await readDiag(page);
    if (fit0.fitConstructedRunsCalls > 0) {
      throw new Error(`run ${run} fit0: unexpected fitConstructedRuns=${fit0.fitConstructedRunsCalls}`);
    }
    warm = await warmLoadSegment2(page, port, { navigateMode: 'goto' });
    assertWarmMatchesCold(cold, warm, `run ${run} fit1-return`);
    await page.close();
  } else {
    throw new Error(`unknown mode ${mode}`);
  }

  const cacheErrors = [...errors.console, ...errors.page].filter((e) => (
    /graph-fit-persist|GraphFitPersist|indexedDB/i.test(e)
  ));
  if (cacheErrors.length) throw new Error(`run ${run} cache errors: ${cacheErrors.join('; ')}`);

  return {
    run,
    mode,
    ok: true,
    cold: {
      cacheState: cold.cacheState,
      accepted: cold.accepted,
      fitCalls: cold.fitConstructedRunsCalls,
      coordChecksum: cold.coordChecksum.slice(0, 16),
      hybridChecksum: cold.hybridChecksum.slice(0, 16),
      polygonChecksum: cold.polygonChecksum,
      idb: cold.idb,
    },
    warm: {
      cacheState: warm.cacheState,
      accepted: warm.accepted,
      fitCalls: warm.fitConstructedRunsCalls,
      lookupResult: warm.lookupResult,
      timings: warm.timings,
      coordChecksum: warm.coordChecksum.slice(0, 16),
    },
    errors,
    browser: browserOut,
  };
}

async function runFreshProfileGate(server, chromePath, profileIndex) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `kommu-persist-prof-${profileIndex}-`));
  let browser = await launchBrowser(chromePath, profileDir);
  browser.__userDataDir = profileDir;
  const page = await browser.newPage();
  const errors = attachErrorCollectors(page);
  await installFitCounter(page);
  await page.goto(`http://127.0.0.1:${server.port}/?fit=1`, { waitUntil: 'domcontentloaded' });
  await clearPersistStore(page);
  const cold = await loadSegmentLocal(page, server.port, SEG2, { requirePersistWrite: true });
  await browser.close();

  browser = await launchBrowser(chromePath, profileDir);
  browser.__userDataDir = profileDir;
  const page2 = await browser.newPage();
  await installFitCounter(page2);
  const warm = await warmLoadSegment2(page2, server.port, { navigateMode: 'goto' });
  assertWarmMatchesCold(cold, warm, `fresh-profile-${profileIndex}`);
  await page2.close();
  await browser.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return {
    profile: profileIndex,
    ok: true,
    profileDir,
    cold: { cacheState: cold.cacheState, accepted: cold.accepted },
    warm: { cacheState: warm.cacheState, fitCalls: warm.fitConstructedRunsCalls, timings: warm.timings },
    errors,
  };
}

async function runSeg14E2E(browser, port) {
  const page = await browser.newPage();
  const errors = attachErrorCollectors(page);
  await installFitCounter(page);
  await page.goto(`http://127.0.0.1:${port}/?fit=1`, { waitUntil: 'domcontentloaded' });
  await clearPersistStore(page);

  const coldT0 = Date.now();
  const cold = await loadSegmentLocal(page, port, SEG14, { requirePersistWrite: true });
  const coldMs = Date.now() - coldT0;
  if (cold.fitConstructedRunsCalls < 1) throw new Error('seg14 cold: expected fitConstructedRuns');
  if (cold.accepted !== 7) throw new Error(`seg14 accepted expected 7 got ${cold.accepted}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await wrapBuildCounter(page);
  const warmT0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?fit=1`, { waitUntil: 'domcontentloaded' });
  await wrapBuildCounter(page);
  await page.select('#segmentSelect', SEG14);
  await page.click('#btnProcess');
  await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Done'), { timeout: 300000 });
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await page.select('#localGeometryMode', 'pointAccumulated');
  await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
  await page.evaluate(() => {
    const cb = document.getElementById('pointCausalPlayback');
    if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
  });
  await waitWarmPersistentHit(page);
  const warmMs = Date.now() - warmT0;
  const warmDiag = await readDiag(page);
  if (warmDiag.fitConstructedRunsCalls !== 0) throw new Error('seg14 warm must not fit');
  if (warmDiag.coordChecksum !== cold.coordChecksum) throw new Error('seg14 coord checksum mismatch');
  if (warmDiag.hybridChecksum !== cold.hybridChecksum) throw new Error('seg14 hybrid checksum mismatch');
  if (warmDiag.polygonChecksum !== cold.polygonChecksum) throw new Error('seg14 polygon checksum mismatch');
  await page.close();
  return {
    ok: true,
    cold: { accepted: cold.accepted, cacheState: cold.cacheState, fitCalls: cold.fitConstructedRunsCalls, coldMs },
    warm: { accepted: warmDiag.accepted, cacheState: warmDiag.cacheState, fitCalls: warmDiag.fitConstructedRunsCalls, warmMs },
    maxCoordDiff: 0,
    errors,
  };
}

function runNodeTests(args, label, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--expose-gc', '--test', ...args], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const tests = stdout.match(/^# tests (\d+)/m);
      const pass = stdout.match(/^# pass (\d+)/m);
      const fail = stdout.match(/^# fail (\d+)/m);
      resolve({
        label,
        code,
        tests: tests ? Number(tests[1]) : null,
        pass: pass ? Number(pass[1]) : null,
        fail: fail ? Number(fail[1]) : null,
        stdout,
        stderr,
      });
    });
  });
}

async function main() {
  const chromePath = resolveChromeExecutable();
  if (!chromePath) throw new Error('Chrome/Edge not found');
  if (!fs.existsSync(path.join(ROOT, SEG2))) throw new Error(`missing fixture ${SEG2}`);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const server = await startVerifiedServer();
  fs.writeFileSync(STDOUT_PATH, server.stdout.join(''));
  fs.writeFileSync(STDERR_PATH, server.stderr.join(''));

  const report = {
    startedAt: new Date().toISOString(),
    server: {
      pid: server.pid,
      port: server.port,
      cwd: server.cwd,
      signatures: server.signatures,
      stdoutPath: STDOUT_PATH,
      stderrPath: STDERR_PATH,
    },
    seg2Runs: [],
    freshProfileRuns: [],
    seg14: null,
    auxiliaryTests: null,
    focusedNode: null,
    browserSuite: null,
    fullSuite: null,
    allOk: true,
  };

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kommu-persist-gate-'));
  let browser = await launchBrowser(chromePath, profileDir);
  browser.__userDataDir = profileDir;

  for (const spec of RUN_SCHEDULE) {
    try {
      const r = await runSeg2Cycle(browser, server.port, spec, { userDataDir: profileDir });
      report.seg2Runs.push(r);
      browser = r.browser;
    } catch (e) {
      report.allOk = false;
      report.seg2Runs.push({ run: spec.run, mode: spec.mode, ok: false, error: e.message });
      try { browser = await launchBrowser(chromePath, profileDir); browser.__userDataDir = profileDir; } catch { /* ignore */ }
    }
  }

  await browser.close().catch(() => {});

  for (let i = 1; i <= 3; i++) {
    try {
      report.freshProfileRuns.push(await runFreshProfileGate(server, chromePath, i));
    } catch (e) {
      report.allOk = false;
      report.freshProfileRuns.push({ profile: i, ok: false, error: e.message });
    }
  }

  if (fs.existsSync(path.join(ROOT, SEG14))) {
    const b2 = await launchBrowser(chromePath);
    try {
      report.seg14 = await runSeg14E2E(b2, server.port);
    } catch (e) {
      report.allOk = false;
      report.seg14 = { ok: false, error: e.message };
    }
    await b2.close().catch(() => {});
  }

  report.auxiliaryTests = await runNodeTests(
    ['tests/graph_fit_persistent_cache_browser.test.js'],
    'browser-suite',
    { RUN_GRAPH_FIT_PERSIST_BROWSER: '1' },
  );

  if (report.auxiliaryTests.code !== 0) report.allOk = false;

  const exitCode = await server.stop();
  report.serverExitCode = exitCode;
  report.serverStopped = true;
  report.finishedAt = new Date().toISOString();

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    allOk: report.allOk,
    seg2Pass: report.seg2Runs.filter((r) => r.ok).length,
    freshPass: report.freshProfileRuns.filter((r) => r.ok).length,
    seg14: report.seg14?.ok ?? null,
    browserSuite: report.auxiliaryTests,
    reportPath: REPORT_PATH,
  }, null, 2));

  if (!report.allOk) process.exit(1);

  report.focusedNode = await runNodeTests([
    'tests/graph_fit.test.js',
    'tests/viewer_probe_parity.test.js',
    'tests/video_restore.test.js',
    'tests/graph_fit_persistent_cache.test.js',
  ], 'focused-node');

  report.browserSuite = await runNodeTests(
    ['tests/graph_fit_persistent_cache_browser.test.js'],
    'browser-suite-final',
    { RUN_GRAPH_FIT_PERSIST_BROWSER: '1' },
  );

  report.fullSuite = await runNodeTests(['tests'], 'full-suite');
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  const gateOk = report.allOk
    && report.focusedNode?.fail === 0
    && report.browserSuite?.fail === 0
    && report.fullSuite?.fail === 27;
  process.exit(gateOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
