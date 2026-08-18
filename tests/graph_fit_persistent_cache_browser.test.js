'use strict';

/**
 * Browser persistence tests for graph-fit IndexedDB cache (Puppeteer).
 * Run explicitly:
 *   $env:RUN_GRAPH_FIT_PERSIST_BROWSER="1"
 *   node --test tests/graph_fit_persistent_cache_browser.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ROOT,
  startVerifiedServer,
  inspectPort,
} = require('./helpers/graph_fit_persist_test_server');

const SEG = 14;
const SEG_FILE = `qlog_f449c_${SEG}.bz2`;
const SEG2_FILE = 'qlog_f449c_2.bz2';
const RUN_BROWSER_SUITE = process.env.RUN_GRAPH_FIT_PERSIST_BROWSER === '1';

let server;
let browser;
let puppeteer;
let testPort;

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
  await page.evaluate(async () => {
    await window.GraphFitPersistCache?.clearStore?.();
    window.__mapAcquisitionDebug?.clearStationaryMapCache?.();
  });
}

async function loadFitSegment(page, { requirePersistWrite = true, segmentFile = SEG_FILE, fitRequired = true } = {}) {
  await page.select('#segmentSelect', segmentFile);
  await page.click('#btnProcess');
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent?.startsWith('Done'),
    { timeout: 300000 },
  );
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await page.waitForFunction(() => document.getElementById('vizMode')?.value === 'local', { timeout: 300000 });
  await page.select('#localGeometryMode', 'pointAccumulated');
  await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
  await page.waitForFunction(() => document.getElementById('localGeometryMode')?.value === 'pointAccumulated', { timeout: 300000 });
  await page.evaluate(() => {
    const cb = document.getElementById('pointCausalPlayback');
    if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
  });
  await page.waitForFunction(
    (fitReq) => {
      const map = window.renderer?.stationaryLocalMap;
      const mode = document.getElementById('localGeometryMode')?.value;
      if (mode !== 'pointAccumulated' || !map) return false;
      if (fitReq) {
        return map?.pointAccumulated?.fittedPolylines != null
          && ['miss-build', 'persistent-hit', 'memory-hit', 'built'].includes(map?.cacheState);
      }
      return map?.pointAccumulated != null || map?.cacheState != null;
    },
    { timeout: 300000 },
    fitRequired,
  );
  if (requirePersistWrite) {
    const persistKey = await page.evaluate(() => window.renderer?.stationaryLocalMap?.persistCacheKey);
    assert.ok(persistKey, 'expected persistCacheKey after cold build');
    await page.evaluate(async (key) => {
      await window.GraphFitPersistCache.waitForWriteCommitted(key, { timeoutMs: 300000 });
    }, persistKey);
    const raw = await page.evaluate(async (key) => window.GraphFitPersistCache.readRawRecord(key), persistKey);
    assert.ok(raw?.map, 'expected raw IDB record after committed write');
    assert.equal(raw.schemaVersion, 'graph-fit-persist-v1');
    assert.ok(raw.payloadChecksum);
    assert.equal(raw.cacheKey, persistKey);
  }
}

async function readDiag(page) {
  return page.evaluate(() => {
    const map = window.renderer?.stationaryLocalMap;
    const pa = map?.pointAccumulated;
    const acceptedIds = (pa?.fittedPolylines?.results || [])
      .filter((r) => r.status === 'accepted')
      .map((r) => r.fragmentId)
      .sort();
    let coordChecksum = '';
    for (const r of (pa?.fittedPolylines?.results || [])) {
      if (r.status !== 'accepted') continue;
      const pts = Array.isArray(r.fittedPolyline) ? r.fittedPolyline.flat() : r.fittedPolyline;
      for (const p of (pts || [])) {
        coordChecksum += `${p.east},${p.north},${p.mirroredEast},${p.mirroredNorth};`;
      }
    }
    return {
      fitCalls: window.__fitPersistDiag?.mapFitCalls ?? null,
      fitConstructedRunsCalls: window.__fitPersistDiag?.fitConstructedRunsCalls ?? null,
      cacheState: map?.cacheState ?? null,
      persistCacheKey: map?.persistCacheKey ?? null,
      accepted: acceptedIds.length,
      acceptedIds,
      coordChecksum,
      supported: window.GraphFitPersistCache?.isSupported?.() ?? false,
      writeState: window.GraphFitPersistCache?.getPersistentWriteState?.() ?? null,
      hybridBoundaries: pa?.hybridFittedBoundaries?.boundaries?.length ?? 0,
      segmentSelect: document.getElementById('segmentSelect')?.value ?? null,
      inFlight: window.__mapAcquisitionDebug?.inFlightCount ?? null,
    };
  });
}

const hasFixture = fs.existsSync(path.join(ROOT, SEG_FILE));
const chromePath = resolveChromeExecutable();
const canRun = hasFixture && !!chromePath;

describe('graph-fit persistent cache — browser', { skip: !canRun || !RUN_BROWSER_SUITE }, () => {
  before(async () => {
    puppeteer = require('puppeteer');
    const preferred = process.env.GRAPH_FIT_PERSIST_TEST_PORT
      ? Number(process.env.GRAPH_FIT_PERSIST_TEST_PORT)
      : null;
    if (preferred != null) {
      const info = inspectPort(preferred);
      if (info.occupied) {
        throw new Error(`port ${preferred} occupied; refusing to attach: ${JSON.stringify(info.listeners)}`);
      }
    }
    server = await startVerifiedServer({ preferredPort: preferred });
    testPort = server.port;
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromePath,
      args: ['--no-sandbox'],
    });
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  });

  beforeEach(async () => {
    if (!browser) return;
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${testPort}/?fit=1`, { waitUntil: 'domcontentloaded' });
    await clearPersistStore(page);
    await page.close();
  });

  it('server serves current app.js and cache script signatures', () => {
    assert.ok(server.pid > 0);
    assert.ok(testPort > 0);
    assert.equal(server.signatures.implVersion, 'path1-heldout-memo-v1');
    assert.equal(server.signatures.schemaVersion, 'graph-fit-persist-v1');
  });

  it('Segment 2 cold build then persistent hit', async () => {
    if (!fs.existsSync(path.join(ROOT, SEG2_FILE))) return;
    const page = await browser.newPage();
    await installFitCounter(page);
    await page.goto(`http://127.0.0.1:${testPort}/?fit=1`, { waitUntil: 'domcontentloaded' });
    await clearPersistStore(page);
    await loadFitSegment(page, { segmentFile: SEG2_FILE });
    const cold = await readDiag(page);
    assert.ok(cold.fitConstructedRunsCalls >= 1, 'cold build must invoke fitConstructedRuns');
    assert.equal(cold.accepted, 4);
    assert.equal(cold.writeState?.state, 'committed');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.goto(`http://127.0.0.1:${testPort}/?fit=1`, { waitUntil: 'domcontentloaded' });
    await wrapBuildCounter(page);
    await loadFitSegment(page, { segmentFile: SEG2_FILE, requirePersistWrite: false });
    const warm = await readDiag(page);
    assert.equal(warm.fitConstructedRunsCalls, 0);
    assert.ok(['persistent-hit', 'memory-hit'].includes(warm.cacheState));
    await page.close();
  });

  it('Segment 14 hard reload: cold miss-build, committed write, persistent-hit without fitting', async () => {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`);
    });
    await installFitCounter(page);
    await page.goto(`http://127.0.0.1:${testPort}/?fit=1`, { waitUntil: 'networkidle0' });
    await clearPersistStore(page);

    await loadFitSegment(page);
    const cold = await readDiag(page);
    assert.equal(cold.supported, true);
    assert.ok(cold.fitConstructedRunsCalls >= 1, 'expected fitConstructedRuns on cold build');
    assert.equal(cold.accepted, 7);
    assert.equal(cold.writeState?.state, 'committed');

    const coldSnapshot = {
      acceptedIds: cold.acceptedIds,
      coordChecksum: cold.coordChecksum,
      persistCacheKey: cold.persistCacheKey,
    };

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.goto(`http://127.0.0.1:${testPort}/?fit=1`, { waitUntil: 'domcontentloaded' });
    await wrapBuildCounter(page);
    await loadFitSegment(page, { requirePersistWrite: false });
    await page.waitForFunction(
      () => {
        const map = window.renderer?.stationaryLocalMap;
        return map && ['persistent-hit', 'memory-hit'].includes(map.cacheState)
          && window.__fitPersistDiag?.fitConstructedRunsCalls === 0;
      },
      { timeout: 300000 },
    );

    const warm = await readDiag(page);
    assert.ok(['persistent-hit', 'memory-hit'].includes(warm.cacheState), `warm cacheState=${warm.cacheState}`);
    assert.equal(warm.fitConstructedRunsCalls, 0, 'persistent hit must not call fitConstructedRuns');
    assert.equal(warm.fitCalls, 0, 'persistent hit must not rebuild fit-enabled map');
    assert.deepEqual(warm.acceptedIds, coldSnapshot.acceptedIds);
    assert.equal(warm.coordChecksum, coldSnapshot.coordChecksum);
    assert.equal(warm.persistCacheKey, coldSnapshot.persistCacheKey);
    assert.ok(warm.hybridBoundaries > 0, 'hybrid layer should render');
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    await page.close();
  });

  it('new tab on same origin reuses persistent cache', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${testPort}/?fit=1`, { waitUntil: 'networkidle0' });
    await installFitCounter(page);
    await loadFitSegment(page);
    await page.close();

    const page2 = await browser.newPage();
    await installFitCounter(page2);
    await page2.goto(`http://127.0.0.1:${testPort}/?fit=1`, { waitUntil: 'networkidle0' });
    await wrapBuildCounter(page2);
    await loadFitSegment(page2, { requirePersistWrite: false });
    const diag = await readDiag(page2);
    assert.equal(diag.fitConstructedRunsCalls, 0, `fitConstructedRuns=${diag.fitConstructedRunsCalls}`);
    assert.ok(['persistent-hit', 'memory-hit'].includes(diag.cacheState));
    await page2.close();
  });

  it('fit-disabled URL never writes persistent cache', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${testPort}/`, { waitUntil: 'networkidle0' });
    await clearPersistStore(page);
    await installFitCounter(page);
    await loadFitSegment(page, { requirePersistWrite: false, fitRequired: false });
    const stats = await page.evaluate(async () => window.GraphFitPersistCache.storeStats());
    assert.equal(stats.entryCount, 0);
    await page.close();
  });

  it('causal playback does not use persistent fitted map path', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${testPort}/?fit=1`, { waitUntil: 'networkidle0' });
    await installFitCounter(page);
    await loadFitSegment(page);
    await page.evaluate(() => {
      const cb = document.getElementById('pointCausalPlayback');
      if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    });
    await page.waitForFunction(
      () => window.renderer?.getPointCausalPlayback?.() === true,
      { timeout: 30000 },
    );
    const causalDiag = await page.evaluate(() => ({
      causal: window.renderer?.getPointCausalPlayback?.(),
      hybridStroked: window.renderer?._hybridFittedStroked ?? 0,
      cacheState: window.renderer?.stationaryLocalMap?.cacheState ?? null,
    }));
    assert.equal(causalDiag.causal, true);
    assert.equal(causalDiag.hybridStroked, 0);
    await page.close();
  });

  it('stale async lookup does not overwrite after segment switch', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${testPort}/?fit=1`, { waitUntil: 'networkidle0' });
    await installFitCounter(page);

    await page.evaluate(() => {
      const GPC = window.GraphFitPersistCache;
      const origGet = GPC.get.bind(GPC);
      GPC.get = async function delayedGet(bundle) {
        await new Promise((r) => setTimeout(r, 800));
        return origGet(bundle);
      };
    });

    if (!fs.existsSync(path.join(ROOT, SEG2_FILE))) {
      await page.close();
      return;
    }

    await page.select('#segmentSelect', SEG_FILE);
    await page.click('#btnProcess');
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.startsWith('Done'),
      { timeout: 300000 },
    );
    await page.select('#vizMode', 'local');
    await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
    await page.select('#localGeometryMode', 'pointAccumulated');
    await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
    const seg14Playback = page.evaluate(async () => {
      const idx = parseInt(document.getElementById('timeline')?.value ?? '0', 10);
      return window.updateLocalPlayback(idx);
    });

    await page.select('#segmentSelect', SEG2_FILE);
    await page.click('#btnProcess');
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.startsWith('Done'),
      { timeout: 300000 },
    );
    await page.select('#vizMode', 'local');
    await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
    await page.select('#localGeometryMode', 'pointAccumulated');
    await page.evaluate(() => {
      const cb = document.getElementById('pointCausalPlayback');
      if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
      document.getElementById('localGeometryMode').dispatchEvent(new Event('change'));
    });

    await page.evaluate(async () => {
      const idx = parseInt(document.getElementById('timeline')?.value ?? '0', 10);
      await window.updateLocalPlayback(idx, { forceMapRebuild: true });
    });

    await page.waitForFunction(
      (seg2) => {
        const sel = document.getElementById('segmentSelect')?.value;
        const map = window.renderer?.stationaryLocalMap;
        const pa = map?.pointAccumulated;
        const accepted = (pa?.fittedPolylines?.results || []).filter((r) => r.status === 'accepted').length;
        return sel === seg2 && accepted === 4 && pa?.fittedPolylines != null;
      },
      { timeout: 300000 },
      SEG2_FILE,
    );

    const diag = await readDiag(page);
    assert.equal(diag.segmentSelect, SEG2_FILE);
    assert.equal(diag.accepted, 4);
    assert.notEqual(diag.accepted, 7, 'stale Segment 14 geometry must not remain on renderer');
    await seg14Playback.catch(() => {});
    await page.close();
  });

  it('in-flight deduplication shares one build for concurrent requests', async () => {
    if (!fs.existsSync(path.join(ROOT, SEG2_FILE))) return;
    const page = await browser.newPage();
    await installFitCounter(page);
    await page.goto(`http://127.0.0.1:${testPort}/?fit=1`, { waitUntil: 'domcontentloaded' });
    await clearPersistStore(page);
    await page.select('#segmentSelect', SEG2_FILE);
    await page.click('#btnProcess');
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.startsWith('Done'),
      { timeout: 300000 },
    );
    await page.select('#vizMode', 'local');
    await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
    await page.select('#localGeometryMode', 'pointAccumulated');
    await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));

    const peak = await page.evaluate(async () => {
      const idx = parseInt(document.getElementById('timeline')?.value ?? '0', 10);
      let maxInflight = 0;
      const poll = setInterval(() => {
        maxInflight = Math.max(maxInflight, window.__mapAcquisitionDebug?.inFlightCount ?? 0);
      }, 10);
      const p1 = window.updateLocalPlayback(idx, { forceMapRebuild: true });
      const p2 = window.updateLocalPlayback(idx, { forceMapRebuild: true });
      await Promise.all([p1, p2]);
      clearInterval(poll);
      return {
        fitCalls: window.__fitPersistDiag?.fitConstructedRunsCalls ?? 0,
        maxInflight,
      };
    });
    assert.ok(peak.maxInflight <= 1, `in-flight peak ${peak.maxInflight}`);
    assert.ok(peak.fitCalls >= 1);
    await page.close();
  });
});
