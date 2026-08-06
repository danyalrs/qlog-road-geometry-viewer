'use strict';

/**
 * Capture Segment 2 road-surface Stage 1 prototype screenshots.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_road_surface_stage1');
const SCENES_PATH = path.join(OUT_DIR, 'verification_scenes.json');
const PORT = 3847;
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  spawnSync(process.execPath, [path.join(__dirname, 'export_segment2_road_surface_verification_geometry.js')], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  const sceneData = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
  const { scenes } = sceneData;
  const manifest = {
    generatedAt: new Date().toISOString(),
    method: 'stage1-prototype-harness-v2',
    geometrySource: sceneData.geometrySource,
    totalSurfaceCount: sceneData.totalSurfaceCount,
    viewport: VIEWPORT,
    captures: [],
    status: 'pending',
  };

  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.goto(`http://localhost:${PORT}/d12_geometry_verify.html?v=rs2`, { waitUntil: 'networkidle0', timeout: 15000 });

  for (const scene of scenes) {
    const renderMeta = await page.evaluate((s) => window.renderVerificationScene(s), scene);
    const filename = `${scene.sceneId}.png`;
    await page.screenshot({ path: path.join(OUT_DIR, filename) });
    manifest.captures.push({
      filename,
      targetId: scene.id,
      geometrySource: renderMeta.geometrySource,
      roadSurfacePolygonCount: renderMeta.roadSurfacePolygonCount,
      polygonsDrawn: renderMeta.polygonsDrawn,
      surfaceVisible: renderMeta.surfaceVisible,
      laneChecksum: renderMeta.laneChecksum,
      timelineIndex: renderMeta.timelineIndex,
      visibleSurfaceCount: scene.visibleSurfaceCount,
    });
    console.log('captured', filename, `drawn=${renderMeta.polygonsDrawn}/${renderMeta.roadSurfacePolygonCount}`);
  }

  manifest.status = 'completed';
  manifest.captureCount = manifest.captures.length;
  fs.writeFileSync(path.join(OUT_DIR, 'capture_manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
  console.log(`Done: ${manifest.captureCount} screenshots`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
