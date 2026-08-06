'use strict';

/**
 * Capture Raw vs Fused local-playback screenshots for lane coverage audit segments.
 * Matching viewport via Fit after each segment load.
 *
 * Usage: node scripts/capture_lane_coverage_screenshots.js
 * Requires: server running on PORT (starts one if needed)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'lane_coverage_audit');
const PORT = 3861;
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const SEGMENTS = ['qlog_f449c_44.bz2', 'qlog_f449c_27.bz2'];
const MODES = [
  { label: 'raw_observations', mode: 'observations' },
  { label: 'fused_lane_lines', mode: 'fused' },
];

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) reject(new Error('server startup timeout'));
    }, 15000);
    const check = () => {
      http.get(`http://localhost:${PORT}/api/segments`, (res) => {
        if (res.statusCode === 200) {
          ready = true;
          clearTimeout(timer);
          resolve(child);
        } else checkRetry();
      }).on('error', checkRetry);
    };
    const checkRetry = () => setTimeout(check, 400);
    setTimeout(check, 800);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    try {
      puppeteer = (await import('puppeteer')).default;
    } catch {
      console.error('puppeteer required for screenshots');
      process.exit(1);
    }
  }

  let serverChild = null;
  try {
    serverChild = await startServer();
  } catch (e) {
    console.warn('Could not start server, assuming already running:', e.message);
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  const manifest = { generatedAt: new Date().toISOString(), viewport: VIEWPORT, captures: [] };

  for (const segFile of SEGMENTS) {
    const segNum = segFile.match(/_(\d+)\./)[1];
    await page.goto(`http://localhost:${PORT}/?v=lanecov20260805`, { waitUntil: 'networkidle0', timeout: 60000 });

    await page.select('#segmentSelect', segFile);
    await page.click('#btnProcess');
    await wait(5000);

    await page.select('#vizMode', 'local');
    await page.evaluate(() => {
      document.getElementById('vizMode').dispatchEvent(new Event('change'));
    });
    await wait(800);

    await page.click('#btnFit');
    await wait(500);
    const viewportMeta = await page.evaluate(() => ({
      scale: window.__mapScale,
      offsetX: window.__mapOffsetX,
      offsetY: window.__mapOffsetY,
    }));

    for (const { label, mode } of MODES) {
      await page.select('#localGeometryMode', mode);
      await page.evaluate((m) => {
        document.getElementById('localGeometryMode').value = m;
        document.getElementById('localGeometryMode').dispatchEvent(new Event('change'));
      }, mode);
      await wait(700);

      const filename = `segment_${segNum}_${label}.png`;
      const outPath = path.join(OUT_DIR, filename);
      await page.screenshot({ path: outPath });
      manifest.captures.push({
        segment: segNum,
        mode: label,
        filename,
        viewport: viewportMeta,
      });
      console.log('captured', filename);
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'capture_manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
  if (serverChild) serverChild.kill();
  console.log('Done:', OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
