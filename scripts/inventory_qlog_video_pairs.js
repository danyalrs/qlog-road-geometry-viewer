'use strict';

/**
 * Read-only inventory of qlog ↔ qcamera.ts pairs.
 * Usage: node scripts/inventory_qlog_video_pairs.js [--json out.json]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseSegmentIdFromQlogFilename,
  parseSegmentIdFromQcameraFilename,
  findQcameraTsForSegment,
  resolveVideoDirectory,
} = require('../lib/segment_video');

const ROOT = path.join(__dirname, '..');
const ROUTE_PREFIX = 'f449c322f59e6943---2026-07-20--09-34-13';
const QLOG_DURATION_SEC = 60; // openpilot segment convention

function ffprobeVideo(filePath) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size,format_name',
    '-show_entries', 'stream=codec_name,codec_type,width,height,r_frame_rate',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

  if (result.status !== 0) {
    return {
      decodeStatus: 'ffprobeError',
      ffprobeError: (result.stderr || result.stdout || 'ffprobe failed').trim().slice(0, 500),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return { decodeStatus: 'ffprobeParseError', ffprobeError: e.message };
  }

  const format = parsed.format || {};
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video') || streams[0] || {};

  const decodeCheck = spawnSync('ffmpeg', [
    '-v', 'error',
    '-i', filePath,
    '-f', 'null',
    '-',
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

  const duration = Number(format.duration);
  return {
    decodeStatus: decodeCheck.status === 0 ? 'ok' : 'decodeError',
    ffmpegError: decodeCheck.status === 0 ? null : (decodeCheck.stderr || '').trim().slice(0, 500),
    container: format.format_name || null,
    codec: videoStream.codec_name || null,
    width: videoStream.width != null ? Number(videoStream.width) : null,
    height: videoStream.height != null ? Number(videoStream.height) : null,
    frameRate: videoStream.r_frame_rate || null,
    durationSec: Number.isFinite(duration) ? duration : null,
    probeSizeBytes: format.size != null ? Number(format.size) : null,
  };
}

function classify(entry) {
  if (!entry.qlogExists && !entry.tsExists) return 'unknownNamingMismatch';
  if (!entry.qlogExists && entry.tsExists) return 'missingQlog';
  if (entry.qlogExists && !entry.tsExists) return 'missingVideo';
  if (entry.tsSizeBytes === 0) return 'zeroByteVideo';
  if (entry.decodeStatus === 'ffprobeError' || entry.decodeStatus === 'decodeError' || entry.decodeStatus === 'ffprobeParseError') {
    return 'corruptVideo';
  }
  if (entry.durationSec != null && Math.abs(entry.durationSec - QLOG_DURATION_SEC) > 8) {
    return 'durationMismatch';
  }
  return 'completePair';
}

function recoveryAction(status) {
  switch (status) {
    case 'completePair': return 'none';
    case 'missingVideo': return 'reDownloadVideo';
    case 'zeroByteVideo': return 'reDownloadVideo';
    case 'corruptVideo': return 'reDownloadVideo';
    case 'durationMismatch': return 'verifyAndPossiblyReDownloadVideo';
    case 'missingQlog': return 'reDownloadQlogIfNeeded';
    default: return 'manualReview';
  }
}

function main() {
  const videoDir = resolveVideoDirectory(ROOT);
  const qlogs = fs.readdirSync(ROOT)
    .filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f))
    .sort((a, b) => {
      const ai = Number(parseSegmentIdFromQlogFilename(a));
      const bi = Number(parseSegmentIdFromQlogFilename(b));
      return ai - bi;
    });

  const tsBySegment = new Map();
  for (const name of fs.readdirSync(videoDir)) {
    const seg = parseSegmentIdFromQcameraFilename(name);
    if (!seg) continue;
    const full = path.join(videoDir, name);
    if (!fs.statSync(full).isFile()) continue;
    tsBySegment.set(seg, { filename: name, path: full, sizeBytes: fs.statSync(full).size });
  }

  const allSegmentIds = new Set([
    ...qlogs.map((f) => parseSegmentIdFromQlogFilename(f)),
    ...tsBySegment.keys(),
  ]);

  const inventory = [...allSegmentIds]
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b))
    .map((segmentId) => {
      const qlogName = `qlog_f449c_${segmentId}.bz2`;
      const qlogPath = path.join(ROOT, qlogName);
      const qlogExists = fs.existsSync(qlogPath);
      const tsEntry = tsBySegment.get(segmentId) || null;
      const expectedTsName = `${ROUTE_PREFIX}--${segmentId}---qcamera.ts`;
      const tsPath = tsEntry?.path || path.join(videoDir, expectedTsName);
      const tsExists = !!tsEntry && fs.existsSync(tsEntry.path);
      const tsSizeBytes = tsExists ? tsEntry.sizeBytes : null;

      let probe = {};
      if (tsExists && tsSizeBytes > 0) {
        probe = ffprobeVideo(tsEntry.path);
      } else if (tsExists && tsSizeBytes === 0) {
        probe = { decodeStatus: 'zeroByte', durationSec: 0 };
      } else {
        probe = { decodeStatus: 'missing', durationSec: null };
      }

      const row = {
        segmentNumber: Number(segmentId),
        qlogPath: qlogExists ? qlogPath : null,
        qlogExists,
        tsVideoPath: tsExists ? tsPath : expectedTsName,
        tsExists,
        tsSizeBytes,
        expectedTsFilename: expectedTsName,
        actualTsFilename: tsEntry?.filename || null,
        videoDurationSec: probe.durationSec,
        videoDecodeStatus: probe.decodeStatus,
        container: probe.container || null,
        codec: probe.codec || null,
        width: probe.width || null,
        height: probe.height || null,
        frameRate: probe.frameRate || null,
        ffmpegDecodeOk: probe.decodeStatus === 'ok',
        ffprobeError: probe.ffprobeError || probe.ffmpegError || null,
      };
      row.status = classify({
        qlogExists: row.qlogExists,
        tsExists: row.tsExists,
        tsSizeBytes: row.tsSizeBytes || 0,
        decodeStatus: row.videoDecodeStatus,
        durationSec: row.videoDurationSec,
      });
      row.recoveryAction = recoveryAction(row.status);
      return row;
    });

  const summary = inventory.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  const affected = inventory.filter((r) => r.recoveryAction === 'reDownloadVideo' || r.recoveryAction === 'verifyAndPossiblyReDownloadVideo');

  const out = {
    generatedAt: new Date().toISOString(),
    qlogDirectory: ROOT,
    videoDirectory: videoDir,
    routePrefix: ROUTE_PREFIX,
    namingRelationship: {
      qlog: 'qlog_f449c_{N}.bz2',
      video: '{dongleId}---{routeDateTime}--{N}---qcamera.ts',
      segmentLink: 'numeric segment index N',
    },
    summary,
    affectedSegmentNumbers: affected.map((r) => r.segmentNumber),
    estimatedAffectedDownloadBytes: affected
      .filter((r) => r.tsSizeBytes > 0)
      .reduce((sum, r) => sum + r.tsSizeBytes, 0),
    inventory,
  };

  const jsonArg = process.argv.indexOf('--json');
  if (jsonArg >= 0 && process.argv[jsonArg + 1]) {
    fs.writeFileSync(process.argv[jsonArg + 1], JSON.stringify(out, null, 2));
  }

  console.log(JSON.stringify({
    summary: out.summary,
    qlogCount: qlogs.length,
    tsCount: tsBySegment.size,
    affected: out.affectedSegmentNumbers,
  }, null, 2));
}

main();
