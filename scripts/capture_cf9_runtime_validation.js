'use strict';

/**
 * Runtime validation captures for Segment 2 CF9 fitted vs source alignment.
 * Usage: node scripts/capture_cf9_runtime_validation.js
 */

const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3847;
const OUT_DIR = path.join(ROOT, 'reports', 'fitted_layer_probe', 'cf9_runtime');

async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      stdio: 'ignore', cwd: ROOT, env: { ...process.env, PORT: String(PORT) },
    });
    waitForServer(`http://localhost:${PORT}/api/segments`).then((ok) => {
      if (ok) resolve(child);
      else { child.kill(); reject(new Error('server did not start')); }
    });
  });
}

async function configurePage(page) {
  await page.goto(`http://localhost:${PORT}/?fit=1`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.select('#segmentSelect', 'qlog_f449c_2.bz2');
  await page.click('#btnProcess');
  await wait(8000);
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await wait(500);
  await page.select('#localGeometryMode', 'pointAccumulated');
  await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
  await wait(500);
  const setLayer = async (id, on) => {
    await page.evaluate((layerId, checked) => {
      const el = document.getElementById(layerId);
      el.checked = checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, id, on);
    await wait(300);
  };
  await setLayer('layerConstructedFragments', false);
  await setLayer('layerJoinedPolylines', false);
  await setLayer('layerFusedLanes', true);
  await setLayer('layerRoadSurface', false);
  return setLayer;
}

async function captureScenario(page, setLayer, name, opts) {
  const { mirror, showFragments, showFitted, fitToView } = opts;
  await setLayer('layerConstructedFragments', !!showFragments);
  await setLayer('layerFittedPolylines', !!showFitted);
  await setLayer('mirrorRoadLateral', !!mirror);
  await page.evaluate((m) => window.renderer.setMirrorRoadLateralDisplay(m), !!mirror);
  if (fitToView) {
    await page.click('#btnFit');
    await wait(500);
  }
  const diag = await page.evaluate(() => {
    const r = window.renderer;
    const map = r.stationaryLocalMap;
    const pa = map?.pointAccumulated;
    const cf9 = pa?.constructedFragments?.fragments?.find((f) => f.fragmentId === 'CF9');
    const fit9 = pa?.fittedPolylines?.results?.find((x) => x.fragmentId === 'CF9');
    const poly = fit9?.fittedPolyline;
    const flat = poly && Array.isArray(poly[0]) ? poly[0] : poly;
    const screenPts = [];
    for (const v of flat || []) {
      const p = r._fittedVertexScreen(v);
      if (p) screenPts.push(p);
    }
    const fragScreen = [];
    for (const v of cf9?.points || []) {
      const p = r.roadGeometryToScreen(v.east, v.north, v.mirroredEast, v.mirroredNorth);
      fragScreen.push(p);
    }
    const dists = [];
    for (const fp of screenPts) {
      let best = Infinity;
      for (const sp of fragScreen) best = Math.min(best, Math.hypot(fp.x - sp.x, fp.y - sp.y));
      dists.push(best);
    }
    return {
      fitStatus: fit9?.status,
      fitBounds: map?.fitBounds,
      viewport: { scale: r.scale, offsetX: r.offsetX, offsetY: r.offsetY },
      fittedScreenCount: screenPts.length,
      maxScreenSeparationPx: dists.length ? Math.max(...dists) : null,
      meanScreenSeparationPx: dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : null,
      fittedSample: flat?.[0] || null,
    };
  });
  const outPath = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: outPath, fullPage: false });
  return { ...diag, screenshot: outPath };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await startServer();
  const puppeteer = (await import('puppeteer')).default;
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const setLayer = await configurePage(page);
  const report = {
    segment: 'qlog_f449c_2.bz2',
    fragmentId: 'CF9',
    scenarios: {},
  };
  report.scenarios.A_fragmentOnly = await captureScenario(page, setLayer, 'A_cf9_fragment_only', {
    mirror: false, showFragments: true, showFitted: false, fitToView: true,
  });
  report.scenarios.B_fittedOnly = await captureScenario(page, setLayer, 'B_cf9_fitted_only', {
    mirror: false, showFragments: false, showFitted: true, fitToView: true,
  });
  report.scenarios.C_overlayMirrorOff = await captureScenario(page, setLayer, 'C_cf9_overlay_mirror_off', {
    mirror: false, showFragments: true, showFitted: true, fitToView: true,
  });
  report.scenarios.D_overlayMirrorOn = await captureScenario(page, setLayer, 'D_cf9_overlay_mirror_on', {
    mirror: true, showFragments: true, showFitted: true, fitToView: true,
  });
  report.scenarios.E_fullSegmentFitToView = await captureScenario(page, setLayer, 'E_segment2_fit_to_view', {
    mirror: true, showFragments: false, showFitted: true, fitToView: true,
  });
  // Segment 3 alignment check
  await page.select('#segmentSelect', 'qlog_f449c_3.bz2');
  await page.click('#btnProcess');
  await wait(8000);
  report.scenarios.seg3_mirrorOn = await captureScenario(page, setLayer, 'seg3_fitted_mirror_on', {
    mirror: true, showFragments: false, showFitted: true, fitToView: true,
  });
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  server.kill();
}

main().catch((e) => { console.error(e); process.exit(1); });
