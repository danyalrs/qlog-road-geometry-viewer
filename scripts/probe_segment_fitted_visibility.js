'use strict';

/**
 * Deep probe: per-accepted-fit visibility for Segment 2 vs 3 (mirror, viewport).
 * Usage: node scripts/probe_segment_fitted_visibility.js
 */

const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3847;
const OUT_DIR = path.join(ROOT, 'reports', 'fitted_layer_probe');

const SEGMENTS = [
  { label: 'seg2', file: 'qlog_f449c_2.bz2' },
  { label: 'seg3', file: 'qlog_f449c_3.bz2' },
];

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

function boundsOf(nums) {
  const finite = nums.filter((n) => Number.isFinite(n));
  if (!finite.length) return { min: null, max: null };
  return { min: Math.min(...finite), max: Math.max(...finite) };
}

function screenBounds(renderer, poly) {
  const xs = [];
  const ys = [];
  for (const v of poly || []) {
    if (v.east == null || v.north == null) continue;
    const p = renderer.roadGeometryToScreen(v.east, v.north, v.mirroredEast, v.mirroredNorth);
    if (Number.isFinite(p.x)) xs.push(p.x);
    if (Number.isFinite(p.y)) ys.push(p.y);
  }
  return { x: boundsOf(xs), y: boundsOf(ys) };
}

function viewportBounds(renderer) {
  const w = renderer.w || 0;
  const h = renderer.h || 0;
  const corners = [
    renderer.worldToScreen(
      (-renderer.offsetX) / renderer.scale,
      (renderer.offsetY) / renderer.scale,
    ),
    renderer.worldToScreen(
      (w - renderer.offsetX) / renderer.scale,
      (renderer.offsetY - h) / renderer.scale,
    ),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return {
    canvasW: w,
    canvasH: h,
    scale: renderer.scale,
    offsetX: renderer.offsetX,
    offsetY: renderer.offsetY,
    screen: { x: boundsOf(xs), y: boundsOf(ys) },
    mapEastNorth: boundsOf([
      (-renderer.offsetX) / renderer.scale,
      (w - renderer.offsetX) / renderer.scale,
    ]),
    mapNorth: boundsOf([
      (renderer.offsetY) / renderer.scale,
      (renderer.offsetY - h) / renderer.scale,
    ]),
  };
}

function clipped(screenB, vp) {
  if (!screenB.x.min != null && screenB.x.min == null) return null;
  const pad = 8;
  const inX = screenB.x.max >= -pad && screenB.x.min <= vp.canvasW + pad;
  const inY = screenB.y.max >= -pad && screenB.y.min <= vp.canvasH + pad;
  return { inViewport: inX && inY, inX, inY };
}

async function configurePage(page, segmentFile) {
  await page.goto(`http://localhost:${PORT}/?fit=1`, { waitUntil: 'networkidle0', timeout: 45000 });
  await page.select('#segmentSelect', segmentFile);
  await page.click('#btnProcess');
  await wait(6000);
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await wait(400);
  await page.select('#localGeometryMode', 'pointAccumulated');
  await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
  await wait(400);
  const setLayer = async (id, on) => {
    await page.evaluate((layerId, checked) => {
      const el = document.getElementById(layerId);
      el.checked = checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, id, on);
    await wait(250);
  };
  await setLayer('layerConstructedFragments', false);
  await setLayer('layerJoinedPolylines', false);
  await setLayer('layerFittedPolylines', true);
  await setLayer('layerRoadSurface', false);
  await setLayer('layerEdges', false);
  await setLayer('layerFusedLanes', true);
  return setLayer;
}

async function captureScenario(page, setLayer, opts) {
  const { mirror, fitToView, screenshotName } = opts;
  await setLayer('mirrorRoadLateral', !!mirror);
  await page.evaluate((m) => {
    window.renderer.setMirrorRoadLateralDisplay(m);
  }, !!mirror);
  if (fitToView) {
    await page.click('#btnFit');
    await wait(400);
  }
  const diag = await page.evaluate(() => {
    const r = window.renderer;
    const map = r.stationaryLocalMap;
    const pa = map?.pointAccumulated;
    const fp = pa?.fittedPolylines;
    const accepted = (fp?.results || []).filter((x) => x.status === 'accepted');
    const fits = [];
    for (const res of accepted) {
      const polys = r._normalizeFittedPolylines(res.fittedPolyline);
      for (const poly of polys) {
        const easts = poly.map((p) => p.east);
        const norths = poly.map((p) => p.north);
        const me = poly.map((p) => p.mirroredEast);
        const mn = poly.map((p) => p.mirroredNorth);
        let strokeOk = false;
        let markerCount = 0;
        const origStroke = r.ctx.stroke.bind(r.ctx);
        const origFill = r.ctx.fill.bind(r.ctx);
        r.ctx.stroke = function () { strokeOk = true; return origStroke(); };
        r.ctx.fill = function () { markerCount++; return origFill(); };
        strokeOk = false;
        markerCount = 0;
        const layers = { ...r.layers };
        r.layers = { ...layers, fittedPolylines: true, constructedFragments: false, joinedPolylines: false };
        r._drawFittedPolylines(map, r.localElapsedIdx || 0, pa?.points || []);
        r.layers = layers;
        r.ctx.stroke = origStroke;
        r.ctx.fill = origFill;
        const screenPts = [];
        for (const v of poly) {
          if (v.east == null || v.north == null) continue;
          const p = r.roadGeometryToScreen(v.east, v.north, v.mirroredEast, v.mirroredNorth);
          screenPts.push(p);
        }
        const sx = screenPts.map((p) => p.x);
        const sy = screenPts.map((p) => p.y);
        const finite = poly.every((p) => Number.isFinite(p.east) && Number.isFinite(p.north));
        const hasMirrored = poly.some((p) => p.mirroredEast != null || p.mirroredNorth != null);
        fits.push({
          fragmentId: res.fragmentId,
          groupTrackId: res.groupTrackId,
          pointCount: poly.length,
          localEast: { min: Math.min(...easts.filter(Number.isFinite)), max: Math.max(...easts.filter(Number.isFinite)) },
          localNorth: { min: Math.min(...norths.filter(Number.isFinite)), max: Math.max(...norths.filter(Number.isFinite)) },
          mirroredEastPresent: hasMirrored,
          mirroredEastSample: me.find((x) => x != null) ?? null,
          mirroredNorthSample: mn.find((x) => x != null) ?? null,
          screenX: sx.length ? { min: Math.min(...sx), max: Math.max(...sx) } : null,
          screenY: sy.length ? { min: Math.min(...sy), max: Math.max(...sy) } : null,
          coordinatesFinite: finite,
          strokeReturnsTrue: strokeOk,
          endpointMarkerFills: markerCount,
          sampleVertex: poly[0] || null,
        });
      }
    }
    const vp = {
      canvasW: r.w,
      canvasH: r.h,
      scale: r.scale,
      offsetX: r.offsetX,
      offsetY: r.offsetY,
      localViewportBounds: r._localViewportBounds || null,
      fitBounds: map?.fitBounds || null,
    };
    const cyanPixels = (() => {
      const c = document.getElementById('canvas');
      const ctx = c.getContext('2d');
      const w = c.width;
      const h = c.height;
      const img = ctx.getImageData(0, 0, w, h).data;
      let n = 0;
      for (let i = 0; i < img.length; i += 4) {
        const r8 = img[i];
        const g8 = img[i + 1];
        const b8 = img[i + 2];
        const a8 = img[i + 3];
        if (a8 < 40) continue;
        if (r8 < 40 && g8 > 150 && b8 > 180) n++;
      }
      return n;
    })();
    return {
      mirror: r.getMirrorRoadLateralDisplay?.(),
      acceptedCount: accepted.length,
      fits,
      viewport: vp,
      cyanPixelCount: cyanPixels,
      cacheKey: map?.cacheKey || null,
      mapValid: map?.valid,
    };
  });
  if (screenshotName) {
    await page.screenshot({ path: path.join(OUT_DIR, screenshotName), fullPage: false });
  }
  return diag;
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

  const report = { generatedAt: new Date().toISOString(), segments: {} };

  for (const seg of SEGMENTS) {
    const setLayer = await configurePage(page, seg.file);
    report.segments[seg.label] = {
      file: seg.file,
      scenarios: {},
    };
    const scenarios = [
      { key: 'A_mirrorOn', mirror: true, fitToView: false, screenshotName: `${seg.label}_fitted_only_mirror_on.png` },
      { key: 'B_mirrorOff', mirror: false, fitToView: false, screenshotName: `${seg.label}_fitted_only_mirror_off.png` },
      { key: 'C_fitToView', mirror: true, fitToView: true, screenshotName: `${seg.label}_fitted_only_fit_to_view.png` },
    ];
    if (seg.label === 'seg3') {
      scenarios[0].screenshotName = 'seg3_control_mirror_on.png';
    }
    for (const sc of scenarios) {
      report.segments[seg.label].scenarios[sc.key] = await captureScenario(page, setLayer, sc);
    }
  }

  const outPath = path.join(OUT_DIR, 'segment_visibility_probe.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
  server.kill();
}

main().catch((e) => { console.error(e); process.exit(1); });
