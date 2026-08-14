'use strict';

/**
 * Compare browser runtime fit summary with lib/viewer_map_build for segments 3,9,16,54.
 * Usage: node scripts/probe_viewer_browser_parity.js
 */

const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const { summarizeViewerSegment } = require('../lib/viewer_map_build');

const ROOT = path.join(__dirname, '..');
const PORT = 3848;
const OUT = path.join(ROOT, 'reports', 'fitted_layer_probe', 'viewer_browser_parity.json');
const SEGMENTS = [3, 9, 16, 54];

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

async function browserSummary(page, segmentFile) {
  await page.goto(`http://localhost:${PORT}/?fit=1`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.select('#segmentSelect', segmentFile);
  await page.click('#btnProcess');
  await wait(8000);
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await wait(400);
  await page.select('#localGeometryMode', 'pointAccumulated');
  await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
  await wait(400);
  return page.evaluate(() => {
    const map = window.renderer.stationaryLocalMap
      || window.SegmentLocalMap.buildSegmentLocalMap(window.processData || {}, {
        geometrySource: 'pointAccumulated',
        timelineIndex: 0,
        fitEnabled: new URLSearchParams(window.location.search).get('fit') === '1',
        minHeadingSpeedMps: parseFloat(document.getElementById('minBearingSpeed')?.value ?? 2),
      });
    const pa = map?.pointAccumulated;
    const fp = pa?.fittedPolylines;
    const accepted = (fp?.results || []).filter((r) => r.status === 'accepted');
    const chunk = window.processData?.routeChunks?.[0];
    const vehiclePath = chunk?.vehiclePath || [];
    const GF = window.GraphFit;
    const built = vehiclePath.length >= 2 && window.PointAccumulation
      ? window.PointAccumulation.buildReferenceTrajectory(vehiclePath)
      : null;
    return {
      processingVersion: window.processData?.processingVersion,
      acceptedCount: accepted.length,
      acceptedIds: accepted.map((r) => r.fragmentId).sort(),
      statusCounts: fp?.statusCounts || {},
      polygonCount: map?.roadSurfacePolygonCount ?? map?.roadSurfacePolygons?.length ?? 0,
      fragmentCount: pa?.constructedFragments?.fragments?.length ?? 0,
      fitEnabled: !!fp?.stats?.fitEnabled,
      cache: fp?.stats?.cache || null,
      trajectory: {
        vehiclePathPoints: vehiclePath.length,
        builtTrajectoryTotalLengthM: built?.totalLength ?? null,
        isStationary: GF ? GF.isDegenerateTrajectory(built) : null,
      },
      referencePose: map?.referencePose || null,
    };
  });
}

async function main() {
  const report = { generatedAt: new Date().toISOString(), segments: [] };
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
  for (const segNum of SEGMENTS) {
    const segmentFile = `qlog_f449c_${segNum}.bz2`;
    if (!fs.existsSync(path.join(ROOT, segmentFile))) continue;
    const lib = summarizeViewerSegment(ROOT, segmentFile, { fitEnabled: true });
    const browser = await browserSummary(page, segmentFile);
    report.segments.push({
      segNum,
      segmentFile,
      lib: {
        accepted: lib.fitOn.acceptedCount,
        acceptedIds: lib.fitOn.acceptedIds,
        polygonCount: lib.polygonCountOn,
        fragmentCount: lib.fragmentCount,
        processingVersion: lib.processingVersion,
        trajectory: lib.trajectory,
        fitEnabled: lib.fitOn.fitEnabled,
      },
      browser,
      parity: {
        acceptedCount: lib.fitOn.acceptedCount === browser.acceptedCount,
        acceptedIds: JSON.stringify(lib.fitOn.acceptedIds) === JSON.stringify(browser.acceptedIds),
        polygonCount: lib.polygonCountOn === browser.polygonCount,
        fragmentCount: lib.fragmentCount === browser.fragmentCount,
        processingVersion: lib.processingVersion === browser.processingVersion,
        isStationary: lib.trajectory.isStationary === browser.trajectory?.isStationary,
      },
    });
  }
  await browser.close();
  server.kill();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
