'use strict';

/**
 * Capture Segment 2 road-surface verification screenshots.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_road_surface_stage2');
const SCENES_PATH = path.join(OUT_DIR, 'verification_scenes.json');
const PORT = 3848;
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const filePath = path.join(ROOT, 'public', urlPath === '/' ? 'd12_geometry_verify.html' : urlPath.replace(/^\//, ''));
    const safeRoot = path.join(ROOT, 'public');
    if (!filePath.startsWith(safeRoot)) {
      res.writeHead(403); res.end(); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  spawnSync(process.execPath, [path.join(__dirname, 'export_segment2_road_surface_stage2_geometry.js')], {
    stdio: 'inherit', cwd: ROOT,
  });
  if (!fs.existsSync(SCENES_PATH)) {
    console.error('Missing scenes file');
    process.exit(1);
  }
  const sceneData = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
  const { scenes } = sceneData;

  const server = await startStaticServer();
  const manifest = {
    generatedAt: new Date().toISOString(),
    method: 'stage2-prototype-harness-v1',
    geometrySource: sceneData.geometrySource,
    totalSurfaceCount: sceneData.totalSurfaceCount,
    roadSurfaceChecksum: sceneData.roadSurfaceChecksum,
    mode5Checksum: sceneData.mode5Checksum,
    viewport: VIEWPORT,
    captures: [],
    status: 'pending',
  };

  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.goto(`http://localhost:${PORT}/d12_geometry_verify.html?v=rs2stage2`, { waitUntil: 'networkidle0', timeout: 30000 });

  for (const scene of scenes) {
    const renderMeta = await page.evaluate((s) => window.renderVerificationScene(s), scene);
    const filename = `${scene.sceneId}.png`;
    await page.screenshot({ path: path.join(OUT_DIR, filename) });
    manifest.captures.push({
      filename,
      displayMode: scene.geometrySource || scene.modeLabel,
      polygonIdsVisible: (scene.roadSurfacePolygons || []).map((p) => p.polygonId),
      polygonCountDrawn: renderMeta.polygonsDrawn,
      canvasDimensions: { width: VIEWPORT.width, height: VIEWPORT.height },
      devicePixelRatio: VIEWPORT.deviceScaleFactor,
      zoom: renderMeta.scale,
      pan: renderMeta.pan || { x: renderMeta.offsetX, y: renderMeta.offsetY },
      routeSTarget: scene.id,
      timelineIndex: scene.timelineIndex ?? 0,
      pixelsPerMetre: renderMeta.pixelsPerMetre,
      laneChecksum: renderMeta.laneChecksum,
      roadSurfaceChecksum: sceneData.roadSurfaceChecksum,
      surfaceVisibility: renderMeta.surfaceVisible,
      viewportBoundingBox: renderMeta.viewportBoundingBox,
      structuralVerdict: 'pending',
      visualVerdict: 'pending',
      status: 'captured',
    });
    console.log('captured', filename);
  }

  manifest.status = 'completed';
  manifest.captureCount = manifest.captures.length;
  fs.writeFileSync(path.join(OUT_DIR, 'capture_manifest.json'), JSON.stringify(manifest, null, 2));

  const pixelAudit = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'audit_segment2_road_surface_stage2_pixel_verification.json'), 'utf8',
  ));
  pixelAudit.generatedAt = new Date().toISOString();
  pixelAudit.status = 'completed';
  pixelAudit.captureCount = manifest.captureCount;
  pixelAudit.manifestPath = 'screenshots/segment2_road_surface_stage2/capture_manifest.json';
  pixelAudit.captures = manifest.captures;
  fs.writeFileSync(
    path.join(ROOT, 'audit_segment2_road_surface_stage2_pixel_verification.json'),
    JSON.stringify(pixelAudit, null, 2),
  );

  await browser.close();
  server.close();
  console.log(`Done: ${manifest.captureCount} screenshots`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
