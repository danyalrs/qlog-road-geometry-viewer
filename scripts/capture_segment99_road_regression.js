'use strict';

/**
 * Segment 99 road rendering regression capture and pixel comparison.
 * Usage:
 *   node scripts/capture_segment99_road_regression.js all
 *   node scripts/capture_segment99_road_regression.js baseline
 *   node scripts/capture_segment99_road_regression.js current [prefix]
 *   node scripts/capture_segment99_road_regression.js before
 *   node scripts/capture_segment99_road_regression.js compare
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'connected_accumulated', 'runtime', 'segment99_road_regression');
const BASELINE_DIR = path.join(require('os').tmpdir(), 'Kommu-road-baseline-1b3b1c8');
const SEGMENT = 'qlog_f449c_99.bz2';
const TIMELINE_IDX = 0;
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const COMMIT = '1b3b1c82b818daa6a12bad409a0671fa30eaafe2';

const CAD = require('../public/connected_accumulated_display');
const SLM = require('../lib/segment_local_map');
const VMB = require('../lib/viewer_map_build');
const LRR = require('../lib/local_road_surface_ribbon');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(url, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => { res.resume(); resolve(); });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch {
      await wait(500);
    }
  }
  return false;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function hashString(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function combineRoadChecksum(road) {
  return `${road.trajectoryChecksum}:${road.ribbonInputChecksum}:${road.roadPolygonChecksum}`;
}

function buildMapChecksums(segRoot) {
  const pd = VMB.processSegmentLikeViewer(segRoot, SEGMENT);
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', fitEnabled: false });
  const road = CAD.computeRoadDisplayInputChecksum(map);
  const ribbon = LRR.buildTrajectoryRoadSurfaceRibbons(map.trajectory, map.edgeFragments, {});
  const ribbonRing = (ribbon.ribbons?.[0]?.ring || []).map((v) => `${v.east.toFixed(4)},${v.north.toFixed(4)}`).join(';');
  return {
    mapChecksum: String(map.checksum),
    referencePoseChecksum: road.referencePoseChecksum,
    trajectoryChecksum: road.trajectoryChecksum,
    roadPolygonChecksum: road.roadPolygonChecksum,
    ribbonInputChecksum: road.ribbonInputChecksum,
    selectedRoadDrawablesChecksum: hashString(ribbonRing),
    roadDisplayChecksum: combineRoadChecksum(road),
    mirrorState: true,
    timelineIndex: TIMELINE_IDX,
  };
}

function ensureBaselineLauncher(baselineDir) {
  const launcherPath = path.join(baselineDir, '_segment99_task_baseline_server.js');
  const serverPath = path.join(baselineDir, 'server.js');
  let src = fs.readFileSync(serverPath, 'utf8');
  if (!src.includes('BASELINE_ROOT')) {
    src = src.replace(
      'const ROOT = __dirname;',
      'const BASELINE_ROOT = __dirname;\nconst ROOT = process.env.KOMMU_DATA_ROOT || __dirname;',
    );
    src = src.replace(
      "app.use(express.static(path.join(ROOT, 'public')",
      "app.use(express.static(path.join(BASELINE_ROOT, 'public')",
    );
  }
  fs.writeFileSync(launcherPath, src);
  return launcherPath;
}

function guessContentType(filePath) {
  if (filePath.endsWith('.js')) return 'application/javascript';
  if (filePath.endsWith('.html')) return 'text/html';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function installBaselineAssetInterception(page, baselineDir) {
  const publicRoot = path.join(baselineDir, 'public');
  return page.setRequestInterception(true).then(() => {
    page.on('request', (req) => {
      try {
        const url = new URL(req.url());
        if (url.pathname.startsWith('/api') || url.pathname.startsWith('/vv')) {
          req.continue();
          return;
        }
        const rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
        if (!rel || rel.includes('..')) {
          req.continue();
          return;
        }
        const candidate = path.join(publicRoot, rel);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          req.respond({
            status: 200,
            contentType: guessContentType(candidate),
            body: fs.readFileSync(candidate),
          });
          return;
        }
      } catch {
        // fall through
      }
      req.continue();
    });
  });
}

function brokenMirrorCoordsSource() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'viewer_mirror_coords.js'), 'utf8');
  return src.replace(
    'if (options.useTrajectoryFallback && options.trajectory?.length >= 2) {',
    'if (options.trajectory?.length >= 2) {',
  );
}

function startServer({ launcherPath, cwd, port, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcherPath], {
      cwd,
      env: { ...process.env, PORT: String(port), KOMMU_DATA_ROOT: ROOT, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    waitForServer(`http://127.0.0.1:${port}/api/segments`).then((ok) => {
      if (ok) resolve({ child, port, pid: child.pid });
      else {
        child.kill();
        reject(new Error(`server did not start on ${port}: ${stderr.slice(0, 400)}`));
      }
    });
  });
}

async function verifyBaselineAssets(baselineDir) {
  const files = ['public/app.js', 'public/render.js', 'public/index.html'];
  const hashes = {};
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(baselineDir, rel));
    hashes[rel] = hashBuffer(buf);
  }
  return { commit: COMMIT, hashes };
}

async function captureViewer({
  serverRoot,
  port,
  prefix,
  commitLabel,
  serverMeta = {},
  brokenMirror = false,
  baselineAssetDir = null,
}) {
  const puppeteer = (await import('puppeteer')).default;
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on('pageerror', (err) => console.warn('[pageerror]', err.message));

  if (brokenMirror) {
    const brokenSrc = brokenMirrorCoordsSource();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('viewer_mirror_coords.js')) {
        req.respond({ status: 200, contentType: 'application/javascript', body: brokenSrc });
        return;
      }
      req.continue();
    });
  } else if (baselineAssetDir) {
    await installBaselineAssetInterception(page, baselineAssetDir);
  }

  const url = `http://127.0.0.1:${port}/?mirrorRoadLateral=1&v=${Date.now()}`;
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.select('#segmentSelect', SEGMENT);
  await page.click('#btnProcess');
  await wait(8000);
  await page.select('#vizMode', 'local');
  await page.evaluate(() => document.getElementById('vizMode').dispatchEvent(new Event('change')));
  await wait(600);
  await page.select('#localGeometryMode', 'pointAccumulated');
  await page.evaluate(() => document.getElementById('localGeometryMode').dispatchEvent(new Event('change')));
  await wait(600);
  await page.evaluate(() => {
    const ids = [
      'layerConnectedAccumulated', 'layerConstructedFragments', 'layerJoinedPolylines',
      'layerFittedPolylines', 'layerFittedEndpoints', 'layerFittedOutliers', 'layerFittedUnverified',
      'layerFittedGaps', 'layerUnconfirmedCandidates', 'pointCausalPlayback', 'layerExperimentalReliability',
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) { el.checked = false; el.dispatchEvent(new Event('change')); }
    }
    const mirror = document.getElementById('mirrorRoadLateral');
    if (mirror) { mirror.checked = true; mirror.dispatchEvent(new Event('change')); }
    const hide = ['#videoPanel', '#speedDisplay', '.loading', '#legend', '#statusText'];
    for (const sel of hide) {
      document.querySelectorAll(sel).forEach((el) => { el.style.visibility = 'hidden'; });
    }
  });
  await wait(500);
  await page.evaluate((idx) => {
    const tl = document.getElementById('timeline');
    tl.value = String(idx);
    tl.dispatchEvent(new Event('input'));
  }, TIMELINE_IDX);
  await wait(800);
  await page.click('#btnFit');
  await wait(1000);

  const rendererState = await page.evaluate(() => {
    const r = window.renderer;
    const map = r?.stationaryLocalMap;
    return {
      canvasWidth: r?.canvas?.width,
      canvasHeight: r?.canvas?.height,
      devicePixelRatio: window.devicePixelRatio,
      scale: r?.scale,
      offsetX: r?.offsetX,
      offsetY: r?.offsetY,
      mirrorOn: r?.getMirrorRoadLateralDisplay?.(),
      mapChecksum: map?.checksum,
      bounds: map?.bounds ?? null,
      trajectoryLength: map?.trajectory?.length ?? 0,
      connectedDisplayMode: document.getElementById('connectedDisplayMode')?.value ?? null,
    };
  });

  const checksums = buildMapChecksums(ROOT);
  const state = {
    commitLabel,
    port,
    serverRoot,
    serverMeta,
    rendererState,
    checksums,
    viewerConfig: {
      segment: SEGMENT,
      vizMode: 'local',
      localGeometryMode: 'pointAccumulated',
      mirrorRoadLateral: true,
      connectedLayerOff: true,
      timelineIndex: TIMELINE_IDX,
      viewport: VIEWPORT,
    },
    capturedAt: new Date().toISOString(),
  };

  const fullPath = path.join(OUT_DIR, `${prefix}_segment99_full.png`);
  await page.screenshot({ path: fullPath, clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height } });

  const roadOnlyPath = path.join(OUT_DIR, `${prefix}_segment99_road_only.png`);
  const roadOnlyBuf = await page.evaluate(() => {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const src = ctx.getImageData(0, 0, w, h);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d');
    const img = octx.createImageData(w, h);
    const data = img.data;
    const s = src.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = s[i];
        const g = s[i + 1];
        const b = s[i + 2];
        const a = s[i + 3];
        const isRoadGrey = a > 10 && (
          (Math.abs(r - 148) < 40 && Math.abs(g - 163) < 40 && Math.abs(b - 184) < 40)
          || (Math.abs(r - 100) < 45 && Math.abs(g - 116) < 45 && Math.abs(b - 139) < 45)
          || (Math.abs(r - 203) < 35 && Math.abs(g - 213) < 35 && Math.abs(b - 225) < 35)
        );
        if (isRoadGrey) {
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = 255;
        }
      }
    }
    octx.putImageData(img, 0, 0);
    return out.toDataURL('image/png');
  });
  const b64 = roadOnlyBuf.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(roadOnlyPath, Buffer.from(b64, 'base64'));
  state.roadOnlyPixelChecksum = hashBuffer(fs.readFileSync(roadOnlyPath));

  fs.writeFileSync(path.join(OUT_DIR, `${prefix}_state.json`), JSON.stringify(state, null, 2));
  await browser.close();
  return state;
}

async function comparePng(aPath, bPath) {
  const a = await sharp(aPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(bPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = Math.min(a.info.width, b.info.width);
  const h = Math.min(a.info.height, b.info.height);
  let diffCount = 0;
  let sum = 0;
  let max = 0;
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  const diffRaw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dr = Math.abs(a.data[i] - b.data[i]);
      const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
      const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
      const da = Math.abs(a.data[i + 3] - b.data[i + 3]);
      const d = (dr + dg + db + da) / 4;
      if (d > 2) {
        diffCount++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      sum += d;
      max = Math.max(max, d);
      diffRaw[i] = Math.min(255, dr * 4);
      diffRaw[i + 1] = 0;
      diffRaw[i + 2] = 0;
      diffRaw[i + 3] = 255;
    }
  }
  const total = w * h;
  const diffPng = await sharp(diffRaw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return {
    width: w,
    height: h,
    totalPixels: total,
    differingPixels: diffCount,
    differingPct: (diffCount / total) * 100,
    boundingBox: diffCount ? { minX, minY, maxX, maxY } : null,
    meanAbsRgbaDiff: sum / total,
    maxRgbaDiff: max,
    roadOnlyPixelChecksumA: hashBuffer(fs.readFileSync(aPath)),
    roadOnlyPixelChecksumB: hashBuffer(fs.readFileSync(bPath)),
    diffPng,
  };
}

function writeComparison(label, outJson, outPng, aPath, bPath) {
  return comparePng(aPath, bPath).then((cmp) => {
    const { diffPng, ...rest } = cmp;
    fs.writeFileSync(outJson, JSON.stringify({ label, ...rest }, null, 2));
    fs.writeFileSync(outPng, diffPng);
    console.log(`[compare] ${label}: ${rest.differingPct.toFixed(3)}% (${rest.differingPixels}/${rest.totalPixels})`);
    return rest;
  });
}

async function runComparePhase() {
  const baselinePng = path.join(OUT_DIR, 'baseline_segment99_road_only.png');
  const beforePng = path.join(OUT_DIR, 'current_before_segment99_road_only.png');
  const afterPng = path.join(OUT_DIR, 'current_after_segment99_road_only.png');
  const results = {};
  if (fs.existsSync(baselinePng) && fs.existsSync(beforePng)) {
    results.baselineVsBefore = await writeComparison(
      'baseline_vs_current_before',
      path.join(OUT_DIR, 'pixel_comparison_before.json'),
      path.join(OUT_DIR, 'pixel_diff_before.png'),
      baselinePng,
      beforePng,
    );
  }
  if (fs.existsSync(baselinePng) && fs.existsSync(afterPng)) {
    results.baselineVsAfter = await writeComparison(
      'baseline_vs_current_after',
      path.join(OUT_DIR, 'pixel_comparison_after.json'),
      path.join(OUT_DIR, 'pixel_diff_after.png'),
      baselinePng,
      afterPng,
    );
  }
  if (fs.existsSync(beforePng) && fs.existsSync(afterPng)) {
    results.beforeVsAfter = await writeComparison(
      'current_before_vs_current_after',
      path.join(OUT_DIR, 'pixel_comparison_before_after.json'),
      path.join(OUT_DIR, 'pixel_diff_before_after.png'),
      beforePng,
      afterPng,
    );
  }
  fs.writeFileSync(path.join(OUT_DIR, 'pixel_comparison_summary.json'), JSON.stringify(results, null, 2));
  return results;
}

async function main() {
  const phase = process.argv[2] || 'all';
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const started = Date.now();
  console.log(`[phase 0] Segment 99 road regression — ${phase}`);

  let baselineMeta = null;

  if (phase === 'baseline' || phase === 'all') {
    const baselineDir = process.argv[3] || BASELINE_DIR;
    if (!fs.existsSync(path.join(baselineDir, 'public', 'render.js'))) {
      console.error('Baseline worktree missing:', baselineDir);
      process.exit(1);
    }
    const port = Number(process.argv[4]) || await findFreePort();
    const assetHashes = await verifyBaselineAssets(baselineDir);
    console.log(`[phase 2] Baseline capture via ROOT server port ${port} assets ${baselineDir}`);
    const { child, pid } = await startServer({ launcherPath: path.join(ROOT, 'server.js'), cwd: ROOT, port });
    const baselineMeta = { baselineDir, port, pid, ...assetHashes, harness: 'root-server-baseline-asset-intercept' };
    fs.writeFileSync(path.join(OUT_DIR, 'baseline_server_meta.json'), JSON.stringify(baselineMeta, null, 2));
    try {
      const state = await captureViewer({
        serverRoot: ROOT,
        port,
        prefix: 'baseline',
        commitLabel: COMMIT,
        serverMeta: baselineMeta,
        baselineAssetDir: baselineDir,
      });
      console.log('[phase 3] Baseline capture', state.roadOnlyPixelChecksum);
    } finally {
      child.kill();
    }
  }

  if (phase === 'before' || phase === 'all') {
    const port = await findFreePort();
    console.log(`[phase 1] Broken-mirror current (before repair) port ${port}`);
    const { child } = await startServer({ launcherPath: path.join(ROOT, 'server.js'), cwd: ROOT, port });
    try {
      const state = await captureViewer({
        serverRoot: ROOT,
        port,
        prefix: 'current_before',
        commitLabel: 'working-tree-broken-mirror',
        brokenMirror: true,
      });
      console.log('[phase 1] Before capture', state.roadOnlyPixelChecksum);
    } finally {
      child.kill();
    }
  }

  if (phase === 'current' || phase === 'after' || phase === 'all') {
    const port = await findFreePort();
    const prefix = phase === 'current' ? (process.argv[3] || 'current_after') : 'current_after';
    console.log(`[phase 8] Current (after repair) port ${port} prefix ${prefix}`);
    const { child } = await startServer({ launcherPath: path.join(ROOT, 'server.js'), cwd: ROOT, port });
    try {
      const state = await captureViewer({
        serverRoot: ROOT,
        port,
        prefix,
        commitLabel: 'working-tree-fixed-mirror',
      });
      console.log(`[phase 8] ${prefix} capture`, state.roadOnlyPixelChecksum);
    } finally {
      child.kill();
    }
  }

  if (phase === 'compare' || phase === 'all') {
    await runComparePhase();
  }

  console.log(`[done] runtime ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
