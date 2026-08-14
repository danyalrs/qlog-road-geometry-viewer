'use strict';

/**
 * Runtime probe: fitted-layer checkbox toggle and canvas pixel diff.
 * Usage: node scripts/probe_fitted_layer_toggle.js [segment]
 */

const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3847;
const SEGMENT = process.argv[2] || 'qlog_f449c_2.bz2';
const OUT_DIR = path.join(ROOT, 'reports', 'fitted_layer_probe');

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

function canvasFingerprint(dataUrl) {
  const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  return { bytes: buf.length, sha: require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16) };
}

function pixelDiff(a, b) {
  if (a.length !== b.length) return { same: false, reason: 'size-mismatch', aLen: a.length, bLen: b.length };
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return { same: diff === 0, diffBytes: diff, totalBytes: a.length, pct: (diff / a.length * 100).toFixed(4) };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await startServer();
  const puppeteer = (await import('puppeteer')).default;
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const launchOpts = { headless: 'new', args: ['--no-sandbox'] };
  if (fs.existsSync(chromePath)) launchOpts.executablePath = chromePath;
  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message));

  await page.goto(`http://localhost:${PORT}/?fit=1`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.select('#segmentSelect', SEGMENT);
  await page.click('#btnProcess');
  await wait(5000);
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await wait(500);
  await page.select('#localGeometryMode', 'pointAccumulated');
  await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
  await wait(500);

  const setLayer = async (id, checked) => {
    await page.evaluate((layerId, on) => {
      const el = document.getElementById(layerId);
      el.checked = on;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, id, checked);
    await wait(400);
  };

  // Baseline: fragments on, fitted off
  await setLayer('layerConstructedFragments', true);
  await setLayer('layerJoinedPolylines', false);
  await setLayer('layerFittedPolylines', false);
  await setLayer('layerRoadSurface', false);
  await setLayer('layerEdges', false);
  await setLayer('layerFusedLanes', true);

  const stateOff = await page.evaluate(() => {
    const r = window.renderer;
    const map = r?.stationaryLocalMap;
    const fp = map?.pointAccumulated?.fittedPolylines;
    return {
      graphFitLoaded: typeof GraphFit !== 'undefined',
      segmentLocalMapLoaded: typeof SegmentLocalMap !== 'undefined',
      fitEnabledUrl: new URLSearchParams(location.search).get('fit') === '1',
      layers: { ...r.layers },
      fittedResults: fp?.results?.length ?? null,
      accepted: (fp?.results || []).filter((x) => x.status === 'accepted').length,
      fragmentCount: map?.pointAccumulated?.constructedFragments?.fragments?.length ?? null,
      causal: r.getPointCausalPlayback?.(),
      geometryMode: r.localGeometryMode,
    };
  });
  const canvasOff = await page.evaluate(() => document.getElementById('canvas').toDataURL('image/png'));
  const fpOff = canvasFingerprint(canvasOff);
  await page.screenshot({ path: path.join(OUT_DIR, 'seg2_fitted_off.png'), fullPage: false });

  await setLayer('layerFittedPolylines', true);
  const stateOn = await page.evaluate(() => ({
    layers: { ...window.renderer.layers },
    checkboxChecked: document.getElementById('layerFittedPolylines').checked,
  }));
  const canvasOn = await page.evaluate(() => document.getElementById('canvas').toDataURL('image/png'));
  const fpOn = canvasFingerprint(canvasOn);
  await page.screenshot({ path: path.join(OUT_DIR, 'seg2_fitted_on.png'), fullPage: false });

  // Fitted-only isolation (A vs C)
  await setLayer('layerConstructedFragments', false);
  await setLayer('layerJoinedPolylines', false);
  await setLayer('layerFittedPolylines', true);
  await wait(300);
  const canvasFittedOnly = await page.evaluate(() => document.getElementById('canvas').toDataURL('image/png'));
  await page.screenshot({ path: path.join(OUT_DIR, 'seg2_fitted_only.png'), fullPage: false });
  const fpFittedOnly = canvasFingerprint(canvasFittedOnly);

  const strokeProbe = await page.evaluate(() => {
    const r = window.renderer;
    const map = r.stationaryLocalMap;
    const pa = map?.pointAccumulated;
    const fp = pa?.fittedPolylines;
    const results = fp?.results || [];
    let strokeCount = 0;
    const origStroke = r.ctx.stroke.bind(r.ctx);
    r.ctx.stroke = function patchedStroke() {
      strokeCount++;
      return origStroke();
    };
    const orig = { ...r.layers };
    r.layers = { ...orig, constructedFragments: false, joinedPolylines: false, fittedPolylines: true };
    r._drawFittedPolylines(map, r.localElapsedIdx || 0, pa?.points || []);
    r.layers = orig;
    r.ctx.stroke = origStroke;
    const accepted = results.filter((x) => x.status === 'accepted');
    const polysPerAccepted = accepted.map((res) => r._normalizeFittedPolylines(res.fittedPolyline).length);
    return {
      acceptedResults: accepted.length,
      strokeCallsDuringFittedOnly: strokeCount,
      polylinesPerAccepted: polysPerAccepted,
      fittedPolylinesStroked: r._fittedPolylinesStroked ?? null,
    };
  });

  const bufOff = Buffer.from(canvasOff.replace(/^data:image\/png;base64,/, ''), 'base64');
  const bufOn = Buffer.from(canvasOn.replace(/^data:image\/png;base64,/, ''), 'base64');
  const diff = pixelDiff(bufOff, bufOn);

  const report = {
    segment: SEGMENT,
    stateOff,
    stateOn,
    canvasOff: fpOff,
    canvasOn: fpOn,
    canvasFittedOnly: fpFittedOnly,
    canvasIdentical: diff.same,
    pixelDiff: diff,
    strokeProbe,
    consoleErrors,
    screenshots: {
      off: path.join(OUT_DIR, 'seg2_fitted_off.png'),
      on: path.join(OUT_DIR, 'seg2_fitted_on.png'),
      fittedOnly: path.join(OUT_DIR, 'seg2_fitted_only.png'),
    },
  };
  const outPath = path.join(OUT_DIR, 'toggle_probe.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
  server.kill();
}

main().catch((e) => { console.error(e); process.exit(1); });
