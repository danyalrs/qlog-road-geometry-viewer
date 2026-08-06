'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_lane_continuity_stage8');
const SCENES_PATH = path.join(OUT_DIR, 'verification_scenes.json');
const PORT = 3858;
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const filePath = path.join(ROOT, 'public', urlPath === '/' ? 'd12_geometry_verify.html' : urlPath.replace(/^\//, ''));
    const safeRoot = path.join(ROOT, 'public');
    if (!filePath.startsWith(safeRoot)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  spawnSync(process.execPath, [path.join(__dirname, 'export_segment2_lane_continuity_stage8_scenes.js')], {
    stdio: 'inherit', cwd: ROOT,
  });
  const sceneData = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
  const server = await startStaticServer();
  const manifest = {
    generatedAt: new Date().toISOString(),
    method: 'lane-continuity-stage8-harness-v1',
    beforeChecksum: sceneData.beforeChecksum,
    afterChecksum: sceneData.afterChecksum,
    beforeCoordinateChecksum: sceneData.beforeCoordinateChecksum,
    afterCoordinateChecksum: sceneData.afterCoordinateChecksum,
    viewport: VIEWPORT,
    captures: [],
    status: 'pending',
  };

  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.goto(`http://localhost:${PORT}/d12_geometry_verify.html?v=lc8`, { waitUntil: 'networkidle0', timeout: 30000 });

  for (const scene of sceneData.scenes) {
    const renderMeta = await page.evaluate((s) => window.renderVerificationScene(s), scene);
    const filename = `${scene.sceneId}.png`;
    await page.screenshot({ path: path.join(OUT_DIR, filename) });
    manifest.captures.push({
      filename,
      sceneId: scene.sceneId,
      disconnectionId: scene.disconnectionMeta?.disconnectionId ?? null,
      repaired: scene.disconnectionMeta?.repaired ?? null,
      laneChecksum: scene.laneChecksum || sceneData.afterChecksum,
      coordinateChecksum: sceneData.afterCoordinateChecksum,
      pixelsPerMetre: renderMeta?.pixelsPerMetre,
      status: 'captured',
    });
    console.log('captured', filename);
  }

  manifest.status = 'completed';
  manifest.captureCount = manifest.captures.length;
  fs.writeFileSync(path.join(OUT_DIR, 'capture_manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
  server.close();
  console.log(`Done: ${manifest.captureCount} screenshots`);
}

main().catch((e) => { console.error(e); process.exit(1); });
