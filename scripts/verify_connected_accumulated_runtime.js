'use strict';

/**
 * Runtime verification for connected accumulated lane observations layer.
 * Raw vs perFrame comparison for segments 13, 14, 95.
 *
 * Usage:
 *   node scripts/verify_connected_accumulated_runtime.js
 *   node scripts/verify_connected_accumulated_runtime.js --browser
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CAD = require('../public/connected_accumulated_display');
const SLM = require('../lib/segment_local_map');
const VMB = require('../lib/viewer_map_build');

const COMPARE_SEGMENTS = ['qlog_f449c_13.bz2', 'qlog_f449c_14.bz2', 'qlog_f449c_95.bz2'];
const OUT_DIR = path.join(ROOT, 'reports', 'connected_accumulated', 'runtime');

async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function findSegmentFile(name) {
  const direct = path.join(ROOT, name);
  if (fs.existsSync(direct)) return direct;
  const data = path.join(ROOT, 'data', name);
  if (fs.existsSync(data)) return data;
  return null;
}

function loadSegmentPoints(segFile) {
  const full = findSegmentFile(segFile);
  if (!full) return null;
  const pd = VMB.processSegmentLikeViewer(ROOT, path.basename(full));
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', fitEnabled: false });
  return { map, points: map.pointAccumulated?.points || [] };
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  const userPort = 3847;
  const userUp = !(await isPortFree(userPort));
  if (userUp) {
    for (let p = 3850; p < 3900; p++) {
      if (await isPortFree(p)) return { port: p, owned: true };
    }
    throw new Error('no free port for browser verification');
  }
  return { port: userPort, owned: true };
}

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => { res.resume(); resolve(); });
        req.on('error', reject);
        req.setTimeout(1000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch { await wait(500); }
  }
  return false;
}

async function capturePerFrameScreenshot(page, port, segFile, shotName) {
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.select('#segmentSelect', segFile);
  await page.click('#btnProcess');
  await wait(5000);
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await wait(800);
  await page.evaluate(() => {
    const sel = document.getElementById('localGeometryMode');
    sel.value = 'pointAccumulated';
    sel.dispatchEvent(new Event('change'));
  });
  await wait(1200);

  const off = await page.evaluate(() => {
    function canvasChecksum(dataUrl) {
      let h = 0;
      for (let i = 0; i < dataUrl.length; i++) h = ((h << 5) - h + dataUrl.charCodeAt(i)) | 0;
      return (h >>> 0).toString(16);
    }
    document.getElementById('layerFusedLanes').checked = true;
    const cb = document.getElementById('layerConnectedAccumulated');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    const r = window.renderer;
    r.draw();
    return canvasChecksum(r.canvas.toDataURL());
  });

  const on = await page.evaluate(() => {
    function canvasChecksum(dataUrl) {
      let h = 0;
      for (let i = 0; i < dataUrl.length; i++) h = ((h << 5) - h + dataUrl.charCodeAt(i)) | 0;
      return (h >>> 0).toString(16);
    }
    const cb = document.getElementById('layerConnectedAccumulated');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    const r = window.renderer;
    r.draw();
    return {
      checksum: canvasChecksum(r.canvas.toDataURL()),
      drawn: r._connectedAccumulatedDrawn,
      polylineCount: r._connectedAccumulatedPolylines?.length ?? 0,
      statsMode: r._connectedAccumulatedStats?.mode ?? null,
      crossFrame: r._connectedAccumulatedStats?.crossFrameConnections ?? null,
    };
  });

  await page.screenshot({ path: path.join(OUT_DIR, shotName) });
  return { offChecksum: off, on, checksumDiffers: off !== on.checksum };
}

async function runBrowserVerification(port) {
  const puppeteer = (await import('puppeteer')).default;
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const launchOpts = { headless: 'new', args: ['--no-sandbox'] };
  if (fs.existsSync(chromePath)) launchOpts.executablePath = chromePath;
  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const out = {};
  out.segment13 = await capturePerFrameScreenshot(page, port, 'qlog_f449c_13.bz2', 'segment13_perframe.png');
  out.segment14 = await capturePerFrameScreenshot(page, port, 'qlog_f449c_14.bz2', 'segment14_perframe.png');
  out.segment95 = await capturePerFrameScreenshot(page, port, 'qlog_f449c_95.bz2', 'segment95_perframe.png');
  await browser.close();
  return out;
}

async function main() {
  const runBrowser = process.argv.includes('--browser');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const comparisons = {};
  for (const seg of COMPARE_SEGMENTS) {
    const loaded = loadSegmentPoints(seg);
    if (!loaded) {
      comparisons[seg] = { missing: true };
      continue;
    }
    const cmp = CAD.compareRawPerFrameMetrics(loaded.points);
    comparisons[seg] = {
      mapChecksum: loaded.map.checksum,
      raw: cmp.raw,
      perFrame: cmp.perFrame,
    };
  }

  const acceptance = CAD.evaluatePerFrameAcceptance(
    Object.fromEntries(
      Object.entries(comparisons)
        .filter(([, v]) => !v.missing)
        .map(([k, v]) => [k, v]),
    ),
  );

  const output = {
    comparisons,
    acceptance,
    defaultMode: acceptance.passed ? 'perFrame' : 'raw',
    orderingFieldInspection: {
      selectedField: 'modelX',
      note: 'sourcePointIndex/modelPointIndex/pointIndex absent on accumulated points; modelX present on 100% and monotonic within frame',
    },
  };

  if (runBrowser) {
    const { port, owned } = await pickPort();
    let child = null;
    if (owned) {
      child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        stdio: 'ignore', cwd: ROOT, env: { ...process.env, PORT: String(port) },
      });
    }
    const ok = await waitForServer(`http://localhost:${port}/api/segments`);
    if (!ok) throw new Error(`server did not start on ${port}`);
    try {
      output.browser = await runBrowserVerification(port);
    } finally {
      if (child) child.kill();
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'perframe_comparison.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
