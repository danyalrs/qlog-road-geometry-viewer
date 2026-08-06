'use strict';

/**
 * Pixel-capture verification using authoritative lib geometry + canvas renderer.
 * Usage:
 *   node scripts/export_segment2_d12_verification_geometry.js
 *   npm start
 *   node scripts/capture_segment2_d12_verification.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_d12_verification');
const SCENES_PATH = path.join(OUT_DIR, 'verification_scenes.json');
const PORT = 3847;
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  spawnSync(process.execPath, [path.join(__dirname, 'export_segment2_d12_verification_geometry.js')], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (!fs.existsSync(SCENES_PATH)) {
    console.error('Failed to export verification scenes');
    process.exit(1);
  }
  const { scenes, playbackChecksums } = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));

  const manifest = {
    generatedAt: new Date().toISOString(),
    method: 'authoritative-lib-geometry-canvas-renderer',
    note: 'Renders Mode 3/5/7 geometry from lib/ via d12_geometry_verify.html. Main UI bundle was broken (require in browser); geometry matches node tests.',
    viewport: VIEWPORT,
    segment: 'qlog_f449c_2.bz2',
    playbackChecksums,
    captures: [],
    status: 'pending',
  };

  let puppeteer;
  try {
    const mod = await import('puppeteer');
    puppeteer = mod.default || mod;
  } catch (e) {
    manifest.status = 'failed';
    manifest.error = `puppeteer: ${e.message}`;
    manifest.manualSteps = ['npm install --save-dev puppeteer', 'npm start', 'node scripts/capture_segment2_d12_verification.js'];
    fs.writeFileSync(path.join(OUT_DIR, 'capture_manifest.json'), JSON.stringify(manifest, null, 2));
    process.exit(1);
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  try {
    await page.goto(`http://localhost:${PORT}/d12_geometry_verify.html?v=pixel1`, { waitUntil: 'networkidle0', timeout: 15000 });
  } catch (e) {
    manifest.status = 'failed';
    manifest.error = `server not running on ${PORT}: ${e.message}`;
    manifest.manualSteps = ['npm start', 'node scripts/capture_segment2_d12_verification.js'];
    fs.writeFileSync(path.join(OUT_DIR, 'capture_manifest.json'), JSON.stringify(manifest, null, 2));
    await browser.close();
    process.exit(1);
  }

  for (const scene of scenes) {
    const renderMeta = await page.evaluate((s) => window.renderVerificationScene(s), scene);
    const filename = `${scene.sceneId}.png`;
    const filePath = path.join(OUT_DIR, filename);
    await page.screenshot({ path: filePath });
    const captureEntry = {
      filename,
      file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      targetId: scene.id,
      mode: scene.modeLabel,
      modeValue: scene.geometrySource,
      timelineIndex: scene.timelineIndex,
      routeSTarget: scene.routeSTarget ?? null,
      zoom: renderMeta.scale,
      pan: { offsetX: 0, offsetY: 0 },
      expectedGapM: scene.expectedGapM,
      canvasWidth: VIEWPORT.width,
      canvasHeight: VIEWPORT.height,
      devicePixelRatio: VIEWPORT.deviceScaleFactor,
      scale: renderMeta.scale,
      pixelDistanceAcrossOpening: renderMeta.pixelDistanceAcrossOpening,
      gapEndpointsScreen: renderMeta.gapEndpointsScreen,
      laneChecksum: scene.laneChecksum,
      roadSurfaceCount: scene.roadSurfaceCount,
      layerVisibility: { fused: scene.modeLabel === 'mode3', cleaned: scene.modeLabel === 'mode5', debug: scene.modeLabel === 'mode7', roadSurface: false },
      closeup: scene.closeup || false,
      playbackHud: scene.playbackHud || false,
      vehicleArrow: scene.vehicleArrow || null,
      status: 'captured',
    };
    manifest.captures.push(captureEntry);
    console.log('captured', filename, renderMeta.pixelDistanceAcrossOpening ? `px=${renderMeta.pixelDistanceAcrossOpening.toFixed(1)}` : '');
  }

  manifest.status = 'completed';
  manifest.captureCount = manifest.captures.length;
  manifest.playbackCaptures = manifest.captures.filter((c) => c.playbackHud);
  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'capture_manifest.json'), JSON.stringify(manifest, null, 2));
  spawnSync(process.execPath, [path.join(__dirname, 'analyze_segment2_d12_pixels.js')], { stdio: 'inherit', cwd: ROOT });
  console.log(`Done: ${manifest.captureCount} screenshots`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
