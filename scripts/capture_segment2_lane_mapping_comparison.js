'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_lane_mapping_comparison');
const SCENES_PATH = path.join(OUT_DIR, 'comparison_scenes.json');
const PORT = 3859;
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
  spawnSync(process.execPath, [path.join(__dirname, 'export_segment2_lane_mapping_comparison.js')], {
    stdio: 'inherit', cwd: ROOT,
  });
  const sceneData = JSON.parse(fs.readFileSync(SCENES_PATH, 'utf8'));
  const server = await startStaticServer();
  const manifest = {
    generatedAt: new Date().toISOString(),
    method: 'lane-mapping-comparison-v1',
    viewport: VIEWPORT,
    variants: sceneData.variants,
    captures: [],
    status: 'pending',
  };

  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.goto(`http://localhost:${PORT}/d12_geometry_verify.html?v=compare`, { waitUntil: 'networkidle0', timeout: 30000 });

  for (const scene of sceneData.scenes) {
    const renderMeta = await page.evaluate((s) => window.renderVerificationScene(s), scene);
    const filename = `${scene.sceneId}.png`;
    await page.screenshot({ path: path.join(OUT_DIR, filename) });
    manifest.captures.push({
      filename,
      sceneId: scene.sceneId,
      variantId: scene.variantId,
      viewId: scene.viewId,
      laneChecksum: scene.laneChecksum,
      coordinateChecksum: scene.coordinateChecksum,
      flagSummary: scene.flagSummary,
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
  console.log(`Done: ${manifest.captureCount} screenshots in ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
