'use strict';

const fs = require('fs');
const path = require('path');

const QLOG_SEGMENT_RE = /^qlog_f449c_(\d+)\.bz2$/i;
const QCAMERA_SEGMENT_RE = /--(\d+)---qcamera\.ts$/i;

const DRIFT_NONE_MAX_SEC = 0.10;
const DRIFT_RATE_MAX_SEC = 0.40;
const PLAYBACK_RATE_MIN = 0.95;
const PLAYBACK_RATE_MAX = 1.05;
const LOG_MONO_TIME_NS_PER_SEC = 1_000_000_000n;

function parseSegmentIdFromQlogFilename(filename) {
  if (!filename) return null;
  const base = path.basename(String(filename));
  const match = base.match(QLOG_SEGMENT_RE);
  return match ? match[1] : null;
}

function parseSegmentIdFromQcameraFilename(filename) {
  if (!filename) return null;
  const base = path.basename(String(filename));
  const match = base.match(QCAMERA_SEGMENT_RE);
  return match ? match[1] : null;
}

function isValidSegmentId(segmentId) {
  return typeof segmentId === 'string' && /^\d+$/.test(segmentId);
}

function resolveVideoDirectory(rootDir, overrideDir = null) {
  const configured = overrideDir || process.env.VIDEO_DIR || rootDir;
  return path.resolve(configured);
}

function findQcameraTsForSegment(segmentId, videoDir) {
  if (!isValidSegmentId(segmentId) || !videoDir || !fs.existsSync(videoDir)) return null;
  const suffix = `--${segmentId}---qcamera.ts`;
  const entries = fs.readdirSync(videoDir);
  const match = entries.find((name) => name.toLowerCase().endsWith(suffix.toLowerCase()));
  if (!match) return null;
  const resolved = path.resolve(videoDir, match);
  const safeRoot = path.resolve(videoDir);
  if (!resolved.startsWith(safeRoot + path.sep) && resolved !== safeRoot) return null;
  return resolved;
}

function listAvailableSegmentVideos(videoDir) {
  if (!videoDir || !fs.existsSync(videoDir)) return [];
  const bySegment = new Map();
  for (const name of fs.readdirSync(videoDir)) {
    const segmentId = parseSegmentIdFromQcameraFilename(name);
    if (!segmentId) continue;
    const fullPath = path.resolve(videoDir, name);
    if (!fs.statSync(fullPath).isFile()) continue;
    bySegment.set(segmentId, {
      segmentId,
      filename: name,
      path: fullPath,
      sizeBytes: fs.statSync(fullPath).size,
    });
  }
  return [...bySegment.values()].sort((a, b) => Number(a.segmentId) - Number(b.segmentId));
}

function loadVideoOffsets(configPath) {
  const fallback = { defaultVideoStartOffsetSeconds: 0, segments: {} };
  if (!configPath || !fs.existsSync(configPath)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      defaultVideoStartOffsetSeconds: Number(parsed.defaultVideoStartOffsetSeconds) || 0,
      segments: parsed.segments && typeof parsed.segments === 'object' ? parsed.segments : {},
    };
  } catch {
    return fallback;
  }
}

function getVideoStartOffsetSeconds(segmentId, offsetsConfig) {
  const config = offsetsConfig || { defaultVideoStartOffsetSeconds: 0, segments: {} };
  const entry = config.segments?.[String(segmentId)];
  if (entry && Number.isFinite(entry.videoStartOffsetSeconds)) {
    return entry.videoStartOffsetSeconds;
  }
  return Number(config.defaultVideoStartOffsetSeconds) || 0;
}

function logMonoTimeToBigInt(logMonoTime) {
  if (logMonoTime == null) return null;
  try {
    return BigInt(String(logMonoTime));
  } catch {
    return null;
  }
}

function logMonoTimeToSeconds(logMonoTime) {
  const ns = logMonoTimeToBigInt(logMonoTime);
  if (ns == null) return null;
  return Number(ns) / Number(LOG_MONO_TIME_NS_PER_SEC);
}

function computeLocalElapsedSeconds(currentLogMonoTime, timelineStartLogMonoTime) {
  const currentNs = logMonoTimeToBigInt(currentLogMonoTime);
  const startNs = logMonoTimeToBigInt(timelineStartLogMonoTime);
  if (currentNs == null || startNs == null) return null;
  const deltaNs = currentNs >= startNs ? currentNs - startNs : 0n;
  return Number(deltaNs) / Number(LOG_MONO_TIME_NS_PER_SEC);
}

function computeExpectedVideoTime(localElapsedSeconds, videoStartOffsetSeconds = 0) {
  if (!Number.isFinite(localElapsedSeconds)) return null;
  const offset = Number(videoStartOffsetSeconds) || 0;
  return Math.max(0, localElapsedSeconds + offset);
}

function computeSyncAction(driftSeconds, options = {}) {
  const drift = Number(driftSeconds);
  if (!Number.isFinite(drift)) return { action: 'none' };
  const abs = Math.abs(drift);
  const noneMax = options.noneMax ?? DRIFT_NONE_MAX_SEC;
  const rateMax = options.rateMax ?? DRIFT_RATE_MAX_SEC;
  const rateMin = options.rateMin ?? PLAYBACK_RATE_MIN;
  const rateMaxValue = options.rateMaxValue ?? PLAYBACK_RATE_MAX;

  if (abs < noneMax) {
    return { action: 'none', playbackRate: 1 };
  }
  if (abs <= rateMax) {
    const playbackRate = drift > 0
      ? Math.max(rateMin, 1 - Math.min(0.05, abs * 0.15))
      : Math.min(rateMaxValue, 1 + Math.min(0.05, abs * 0.15));
    return { action: 'rate', playbackRate, drift };
  }
  return { action: 'seek', seekDelta: -drift, drift };
}

module.exports = {
  QLOG_SEGMENT_RE,
  QCAMERA_SEGMENT_RE,
  DRIFT_NONE_MAX_SEC,
  DRIFT_RATE_MAX_SEC,
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_MAX,
  LOG_MONO_TIME_NS_PER_SEC,
  parseSegmentIdFromQlogFilename,
  parseSegmentIdFromQcameraFilename,
  isValidSegmentId,
  resolveVideoDirectory,
  findQcameraTsForSegment,
  listAvailableSegmentVideos,
  loadVideoOffsets,
  getVideoStartOffsetSeconds,
  logMonoTimeToBigInt,
  logMonoTimeToSeconds,
  computeLocalElapsedSeconds,
  computeExpectedVideoTime,
  computeSyncAction,
};
