'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function commandAvailable(command) {
  const check = spawnSync(command, ['-version'], { stdio: 'ignore' });
  return check.status === 0;
}

function resolveCacheDir(rootDir) {
  const configured = process.env.VIDEO_CACHE_DIR || path.join(rootDir, '.video_cache');
  return path.resolve(configured);
}

function cacheKeyForSource(sourcePath) {
  const stat = fs.statSync(sourcePath);
  const hash = crypto.createHash('sha256')
    .update(path.basename(sourcePath))
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
    .digest('hex')
    .slice(0, 16);
  return `${path.basename(sourcePath, path.extname(sourcePath))}.${hash}.mp4`;
}

function probeMedia(filePath, ffprobePath = 'ffprobe') {
  if (!commandAvailable(ffprobePath)) {
    return { available: false, error: 'ffprobe_not_available' };
  }
  const result = spawnSync(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,avg_frame_rate',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8' });

  if (result.status !== 0) {
    return { available: false, error: (result.stderr || '').trim() || 'ffprobe_failed' };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch {
    return { available: false, error: 'ffprobe_invalid_json' };
  }

  const streams = parsed.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const durationSec = Number(parsed.format?.duration);

  return {
    available: true,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    videoCodec: videoStream?.codec_name || null,
    audioCodec: audioStream?.codec_name || null,
    width: videoStream?.width || null,
    height: videoStream?.height || null,
    frameRate: videoStream?.avg_frame_rate || null,
  };
}

function runFfmpeg(args, ffmpegPath = 'ffmpeg') {
  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: result.stderr || '',
    stdout: result.stdout || '',
  };
}

function remuxTsToMp4(sourcePath, outputPath, options = {}) {
  const ffmpegPath = options.ffmpegPath || 'ffmpeg';
  if (!commandAvailable(ffmpegPath)) {
    return { ok: false, error: 'ffmpeg_not_available' };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const copyArgs = ['-y', '-i', sourcePath, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', outputPath];
  let result = runFfmpeg(copyArgs, ffmpegPath);
  if (result.ok) {
    return { ok: true, method: 'copy', outputPath };
  }

  const transcodeArgs = [
    '-y', '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    outputPath,
  ];
  result = runFfmpeg(transcodeArgs, ffmpegPath);
  if (result.ok) {
    return { ok: true, method: 'transcode', outputPath, transcodeRequired: true };
  }

  return {
    ok: false,
    error: 'ffmpeg_remux_failed',
    detail: (result.stderr || '').trim(),
  };
}

function ensureBrowserMp4(sourcePath, rootDir, options = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, error: 'source_not_found' };
  }

  const cacheDir = resolveCacheDir(rootDir);
  const cacheFile = path.join(cacheDir, cacheKeyForSource(sourcePath));
  const probe = probeMedia(sourcePath, options.ffprobePath);

  if (fs.existsSync(cacheFile)) {
    const cachedProbe = probeMedia(cacheFile, options.ffprobePath);
    return {
      ok: true,
      outputPath: cacheFile,
      cacheHit: true,
      method: 'cache',
      sourceProbe: probe,
      outputProbe: cachedProbe,
    };
  }

  const remux = remuxTsToMp4(sourcePath, cacheFile, options);
  if (!remux.ok) {
    return { ok: false, error: remux.error, detail: remux.detail, sourceProbe: probe };
  }

  return {
    ok: true,
    outputPath: cacheFile,
    cacheHit: false,
    method: remux.method,
    transcodeRequired: !!remux.transcodeRequired,
    sourceProbe: probe,
    outputProbe: probeMedia(cacheFile, options.ffprobePath),
  };
}

module.exports = {
  commandAvailable,
  resolveCacheDir,
  cacheKeyForSource,
  probeMedia,
  remuxTsToMp4,
  ensureBrowserMp4,
};
