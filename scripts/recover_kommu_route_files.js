'use strict';

/**
 * Staged recovery from Kommu depot URLs.
 * Usage:
 *   node scripts/recover_kommu_route_files.js --test 37 --type qcamera
 *   node scripts/recover_kommu_route_files.js --all
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseQlogBuffer } = require('../lib/qlog_parse_once');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, '.recovery', 'route_f449c322f59e6943', '2026-08-05');
const DONGLE = 'f449c322f59e6943';
const ROUTE_TS = '2026-07-20--09-34-13';
const BASE = `http://web.kommu.ai/depot/upload/${DONGLE}`;

const SCOPE = {
  missingVideo: [37, 64, 67, 72, 73, 94],
  missingQlog: [52, 70],
  missingBoth: [21, 38, 76, 77, 78, 79, 80],
};

const MANIFEST_PATH = path.join(STAGE, 'recovery_manifest.json');

function remoteQlogName(segment) {
  return `${DONGLE}---${ROUTE_TS}--${segment}---qlog.bz2`;
}

function remoteQcameraName(segment) {
  return `${DONGLE}---${ROUTE_TS}--${segment}---qcamera.ts`;
}

function localQlogName(segment) {
  return `qlog_f449c_${segment}.bz2`;
}

function depotUrl(filename) {
  return `${BASE}/${filename}`;
}

async function fetchWithRedirects(url, maxRedirects = 10) {
  let current = url;
  const chain = [];
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(current, { redirect: 'manual' });
    chain.push({ url: current, status: res.status });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`redirect without location from ${current}`);
      current = new URL(loc, current).href;
      continue;
    }
    const contentType = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      requestedUrl: url,
      finalUrl: current,
      status: res.status,
      contentType,
      bytes: buf.length,
      body: buf,
      redirectChain: chain,
    };
  }
  throw new Error(`too many redirects for ${url}`);
}

function looksLikeHtml(buf) {
  const head = buf.slice(0, 256).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

async function downloadFile(url, destPath) {
  const result = await fetchWithRedirects(url);
  const record = {
    requestedUrl: url,
    finalUrl: result.finalUrl,
    httpStatus: result.status,
    contentType: result.contentType,
    downloadedSize: result.bytes,
    redirectChain: result.redirectChain,
    destPath,
    ok: false,
    error: null,
  };

  if (result.status !== 200) {
    record.error = result.status === 404 ? 'sourceUnavailable' : `http_${result.status}`;
    return record;
  }
  if (result.bytes === 0) {
    record.error = 'zeroByte';
    return record;
  }
  if (looksLikeHtml(result.body)) {
    record.error = 'htmlErrorPage';
    return record;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, result.body);
  record.ok = true;
  record.downloadedSize = fs.statSync(destPath).size;
  return record;
}

function runFfprobe(filePath) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size,format_name',
    '-show_entries', 'stream=codec_name,codec_type,width,height,r_frame_rate',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || '').trim() };
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch (e) {
    return { ok: false, error: e.message };
  }
  const format = parsed.format || {};
  const video = (parsed.streams || []).find((s) => s.codec_type === 'video') || {};
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', filePath, '-f', 'null', '-'], { encoding: 'utf8' });
  const duration = Number(format.duration);
  const fpsParts = String(video.r_frame_rate || '0/1').split('/').map(Number);
  const fps = fpsParts[1] ? fpsParts[0] / fpsParts[1] : null;
  const checks = {
    containerMpegts: String(format.format_name || '').includes('mpegts'),
    codecH264: video.codec_name === 'h264',
    width526: video.width === 526,
    height330: video.height === 330,
    fpsNear20: fps != null && Math.abs(fps - 20) < 2,
    durationNear60: Number.isFinite(duration) && Math.abs(duration - 60) < 2,
    decodeOk: decode.status === 0,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    format,
    video,
    durationSec: duration,
    fps,
    checks,
    decodeError: decode.status === 0 ? null : (decode.stderr || '').trim().slice(0, 500),
    raw: parsed,
  };
}

function decompressBz2(filePath) {
  try {
    const Reader = require('@commaai/log_reader');
    const fs = require('fs');
    const chunks = [];
    const input = fs.createReadStream(filePath);
    return new Promise((resolve, reject) => {
      const stream = Reader(input);
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  } catch (e) {
    return Promise.reject(e);
  }
}

async function runBzip2OrParseTest(filePath) {
  const head = fs.readFileSync(filePath).slice(0, 3).toString('ascii');
  if (head === 'BZh') {
    try {
      const decompressed = await decompressBz2(filePath);
      return { ok: true, method: 'bzip2', decompressedSize: decompressed.length };
    } catch (e) {
      return { ok: false, method: 'bzip2', error: e.message };
    }
  }
  return { ok: true, method: 'rawCapnp', decompressedSize: fs.statSync(filePath).size };
}

async function verifyQlog(filePath, segment) {
  const bz = await runBzip2OrParseTest(filePath);
  if (!bz.ok) return { ok: false, stage: 'decompress', bz };

  let buf;
  try {
    if (bz.method === 'bzip2') {
      buf = await decompressBz2(filePath);
    } else {
      buf = fs.readFileSync(filePath);
    }
  } catch (e) {
    return { ok: false, stage: 'read', error: e.message, bz };
  }

  let parsed;
  try {
    parsed = parseQlogBuffer(buf, localQlogName(segment));
  } catch (e) {
    return { ok: false, stage: 'parse', error: e.message, bz };
  }

  const modelV2 = parsed.modelEvents?.length || 0;
  const gps = parsed.gpsEvents?.length || 0;
  const ok = modelV2 > 0 && gps > 0;
  return {
    ok,
    bz,
    modelV2Count: modelV2,
    gpsCount: gps,
    initDongle: parsed.audit?.initData?.dongleId || null,
    expectedSegment: segment,
    routeMatch: !parsed.audit?.initData?.dongleId || parsed.audit.initData.dongleId === DONGLE,
  };
}

function projectFileExists(kind, segment) {
  if (kind === 'qcamera') {
    const suffix = `--${segment}---qcamera.ts`;
    return fs.readdirSync(ROOT).some((f) => f.endsWith(suffix));
  }
  return fs.existsSync(path.join(ROOT, localQlogName(segment)));
}

async function recoverOne(segment, kind, manifest, options = {}) {
  const remoteName = kind === 'qcamera' ? remoteQcameraName(segment) : remoteQlogName(segment);
  const url = depotUrl(remoteName);
  const destPath = path.join(STAGE, remoteName);

  if (projectFileExists(kind, segment) && !options.force) {
    const skip = { segment, kind, skipped: true, reason: 'projectFileAlreadyExists' };
    manifest.files.push(skip);
    return skip;
  }

  console.log(`Downloading ${kind} segment ${segment}...`);
  const dl = await downloadFile(url, destPath);
  const entry = { segment, kind, ...dl };

  if (!dl.ok) {
    manifest.files.push(entry);
    return entry;
  }

  if (kind === 'qcamera') {
    entry.verification = runFfprobe(destPath);
    entry.verified = entry.verification.ok;
  } else {
    entry.verification = await verifyQlog(destPath, segment);
    entry.verified = entry.verification.ok;
  }

  if (entry.verified && options.copy !== false) {
    if (kind === 'qcamera') {
      const target = path.join(ROOT, remoteName);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(destPath, target);
        entry.copiedTo = target;
      } else {
        entry.copySkipped = 'targetExists';
      }
    } else {
      const target = path.join(ROOT, localQlogName(segment));
      if (!fs.existsSync(target)) {
        fs.copyFileSync(destPath, target);
        entry.copiedTo = target;
        entry.localName = localQlogName(segment);
      } else {
        entry.copySkipped = 'targetExists';
      }
    }
  }

  manifest.files.push(entry);
  return entry;
}

function loadManifest() {
  if (fs.existsSync(MANIFEST_PATH)) {
    try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch { /* fresh */ }
  }
  return { startedAt: new Date().toISOString(), files: [] };
}

function saveManifest(manifest) {
  fs.mkdirSync(STAGE, { recursive: true });
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

function buildRecoveryList() {
  const items = [];
  for (const segment of SCOPE.missingVideo) items.push({ segment, kind: 'qcamera' });
  for (const segment of SCOPE.missingQlog) items.push({ segment, kind: 'qlog' });
  for (const segment of SCOPE.missingBoth) {
    items.push({ segment, kind: 'qlog' });
    items.push({ segment, kind: 'qcamera' });
  }
  return items;
}

async function main() {
  fs.mkdirSync(STAGE, { recursive: true });
  const manifest = loadManifest();
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    const idx = args.indexOf('--test');
    const segment = Number(args[idx + 1]);
    const typeIdx = args.indexOf('--type');
    const kind = typeIdx >= 0 ? args[typeIdx + 1] : 'qcamera';
    const entry = await recoverOne(segment, kind, manifest, { copy: false });
    saveManifest(manifest);
    console.log(JSON.stringify(entry, null, 2));
    process.exit(entry.verified ? 0 : 1);
  }

  if (args.includes('--all')) {
    const list = buildRecoveryList();
    for (const item of list) {
      await recoverOne(item.segment, item.kind, manifest);
      saveManifest(manifest);
    }
    console.log(JSON.stringify({
      total: manifest.files.length,
      recovered: manifest.files.filter((f) => f.verified).length,
      unavailable: manifest.files.filter((f) => f.error === 'sourceUnavailable').length,
      failed: manifest.files.filter((f) => f.error && f.error !== 'sourceUnavailable').length,
      skipped: manifest.files.filter((f) => f.skipped).length,
    }, null, 2));
    return;
  }

  console.log('Usage: --test <segment> [--type qcamera|qlog] | --all');
}

main().catch((e) => { console.error(e); process.exit(1); });
