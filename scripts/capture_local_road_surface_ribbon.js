'use strict';

/**
 * Capture Segment 2 continuous road-surface ribbon verification screenshots.
 * Usage: node scripts/capture_local_road_surface_ribbon.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'local_road_surface_ribbon');
const PORT = process.env.PORT || 3847;
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sampleSurfaceAlongRoute(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#mapCanvas');
    const renderer = window.roadRenderer;
    const map = renderer?.stationaryLocalMap;
    if (!canvas || !renderer || !map?.trajectory?.length) {
      return { ok: false, reason: 'missing canvas/renderer/map' };
    }
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;
    const image = ctx.getImageData(0, 0, w, h);
    const data = image.data;
    const samples = [];
    for (let i = 0; i < map.trajectory.length; i += 2) {
      const pt = map.trajectory[i];
      const screen = renderer.worldToScreen(pt.east, pt.north);
      const sx = Math.round(screen.x * dpr);
      const sy = Math.round(screen.y * dpr);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const idx = (sy * w + sx) * 4;
      samples.push({
        trajIndex: i,
        rgba: [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]],
      });
    }
    const filled = samples.filter((s) => s.rgba[3] > 20);
    const greyish = samples.filter((s) => {
      const [r, g, b, a] = s.rgba;
      return a > 20 && r > 80 && g > 90 && b > 110 && Math.abs(r - g) < 40;
    });
    const stats = renderer._roadSurfaceDrawStats || null;
    return {
      ok: true,
      sampleCount: samples.length,
      filledAlongRoute: filled.length,
      greyishAlongRoute: greyish.length,
      ribbonStats: stats?.ribbonStats ?? null,
      ribbonCount: stats?.ribbonCount ?? null,
      surfaceDisplaySource: stats?.surfaceDisplaySource ?? null,
      trajectoryPoints: map.trajectory.length,
    };
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    console.error('puppeteer required: npm install puppeteer');
    process.exit(1);
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  const url = `http://localhost:${PORT}/?v=20260805j`;
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  } catch (e) {
    console.error('Could not reach dev server at', url, e.message);
    await browser.close();
    process.exit(1);
  }

  await page.select('#segmentSelect', 'qlog_f449c_2.bz2');
  await page.click('#btnProcess');
  await wait(4000);
  await page.select('#vizMode', 'local');
  await page.evaluate(() => {
    document.getElementById('vizMode').dispatchEvent(new Event('change'));
  });
  await wait(800);
  await page.click('#btnFit');
  await wait(600);

  const manifest = {
    segment: 'qlog_f449c_2.bz2',
    capturedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    implementation: 'trajectory-derived ribbon',
    screenshots: [],
    pixelEvidence: {},
    checksums: {},
  };

  async function capture(name, mode, timelineIdx = 16) {
    if (mode) {
      await page.select('#localGeometryMode', mode);
      await page.evaluate((m) => {
        document.getElementById('localGeometryMode').value = m;
        document.getElementById('localGeometryMode').dispatchEvent(new Event('change'));
      }, mode);
      await wait(500);
    }
    await page.evaluate((i) => {
      const tl = document.getElementById('timeline');
      tl.value = String(i);
      tl.dispatchEvent(new Event('input'));
    }, timelineIdx);
    await wait(500);
    await page.click('#btnFit');
    await wait(400);
    const pixelEvidence = await sampleSurfaceAlongRoute(page);
    const filename = `${name}.png`;
    await page.screenshot({ path: path.join(OUT_DIR, filename) });
    manifest.screenshots.push({ filename, mode: mode || 'fused', timelineIdx });
    manifest.pixelEvidence[filename] = pixelEvidence;
    console.log('captured', filename, pixelEvidence);
    return pixelEvidence;
  }

  const fusedFit = await capture('fused_mode_fit_view', 'fused', 16);
  const rawFit = await capture('observations_mode_fit_view', 'observations', 16);
  const fullRoute = await capture('full_route_fit_view', 'fused', 0);
  await page.click('#btnFit');
  await wait(400);
  await page.screenshot({ path: path.join(OUT_DIR, 'full_route_fit_view.png') });
  const curveView = await capture('curve_section_view', 'fused', 8);

  const greyPathStyle = await page.evaluate(() => {
    const renderer = window.roadRenderer;
    const map = renderer?.stationaryLocalMap;
    const stats = renderer?._roadSurfaceDrawStats;
    return {
      trajectoryJsonLen: map?.trajectory ? JSON.stringify(map.trajectory).length : 0,
      ribbonCount: stats?.ribbonCount,
      sectionCount: stats?.sectionCount,
      ribbonStats: stats?.ribbonStats,
      surfaceDisplaySource: stats?.surfaceDisplaySource,
      roadSurfaceChecksum: map?.roadSurfaceChecksum,
      laneChecksum: map?.laneChecksum,
    };
  });

  manifest.segment2Ribbon = greyPathStyle;
  manifest.checksums = {
    laneChecksum: greyPathStyle.laneChecksum,
    roadSurfaceChecksum: greyPathStyle.roadSurfaceChecksum,
  };
  manifest.verdict = {
    continuousSurfaceAlongRoute: fusedFit.filledAlongRoute >= 10,
    greyPathVisible: fusedFit.greyishAlongRoute >= 5,
    rawMatchesFusedRibbon: rawFit.ribbonCount === fusedFit.ribbonCount,
    displaySource: fusedFit.surfaceDisplaySource === 'trajectoryRibbon',
  };

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
  console.log('Done:', OUT_DIR);
  console.log(JSON.stringify(manifest.verdict, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
