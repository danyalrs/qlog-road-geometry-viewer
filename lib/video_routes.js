'use strict';

const fs = require('fs');
const path = require('path');
const {
  isValidSegmentId,
  resolveVideoDirectory,
  findQcameraTsForSegment,
  listAvailableSegmentVideos,
  loadVideoOffsets,
  getVideoStartOffsetSeconds,
} = require('./segment_video');
const { ensureBrowserMp4, probeMedia } = require('./video_remux');
const { serveFileWithRanges } = require('./video_range');

function createVideoRouter(rootDir, options = {}) {
  const router = require('express').Router();
  const offsetsPath = options.offsetsPath || path.join(rootDir, 'config', 'video_offsets.json');
  const ensureMp4 = options.ensureBrowserMp4 || ensureBrowserMp4;
  const videoDirResolver = options.resolveVideoDirectory || (() => resolveVideoDirectory(rootDir, options.videoDir));

  function getVideoDir() {
    return videoDirResolver();
  }

  router.get('/catalog', (_req, res) => {
    const videoDir = getVideoDir();
    const offsets = loadVideoOffsets(offsetsPath);
    const segments = listAvailableSegmentVideos(videoDir).map((entry) => ({
      segmentId: entry.segmentId,
      filename: entry.filename,
      sizeBytes: entry.sizeBytes,
      videoStartOffsetSeconds: getVideoStartOffsetSeconds(entry.segmentId, offsets),
    }));
    res.json({
      videoDir,
      segments,
      ffmpegAvailable: require('./video_remux').commandAvailable('ffmpeg'),
      ffprobeAvailable: require('./video_remux').commandAvailable('ffprobe'),
    });
  });

  router.get('/segment/:segmentId/info', (req, res) => {
    const segmentId = String(req.params.segmentId || '');
    if (!isValidSegmentId(segmentId)) {
      return res.status(400).json({ error: 'invalid_segment_id' });
    }

    const videoDir = getVideoDir();
    const sourcePath = findQcameraTsForSegment(segmentId, videoDir);
    const offsets = loadVideoOffsets(offsetsPath);
    if (!sourcePath) {
      return res.json({
        segmentId,
        hasVideo: false,
        videoStartOffsetSeconds: getVideoStartOffsetSeconds(segmentId, offsets),
      });
    }

    const sourceProbe = probeMedia(sourcePath);
    const remux = ensureMp4(sourcePath, rootDir);
    res.json({
      segmentId,
      hasVideo: true,
      filename: path.basename(sourcePath),
      videoStartOffsetSeconds: getVideoStartOffsetSeconds(segmentId, offsets),
      sourceProbe,
      streamUrl: remux.ok ? `/api/video/segment/${segmentId}/stream.mp4` : null,
      remux: remux.ok
        ? {
          cacheHit: remux.cacheHit,
          method: remux.method,
          transcodeRequired: !!remux.transcodeRequired,
          durationSec: remux.outputProbe?.durationSec ?? sourceProbe.durationSec ?? null,
          videoCodec: remux.outputProbe?.videoCodec ?? sourceProbe.videoCodec ?? null,
          audioCodec: remux.outputProbe?.audioCodec ?? sourceProbe.audioCodec ?? null,
        }
        : { error: remux.error, detail: remux.detail || null },
    });
  });

  router.get('/segment/:segmentId/stream.mp4', (req, res) => {
    const segmentId = String(req.params.segmentId || '');
    if (!isValidSegmentId(segmentId)) {
      return res.status(400).json({ error: 'invalid_segment_id' });
    }

    const videoDir = getVideoDir();
    const sourcePath = findQcameraTsForSegment(segmentId, videoDir);
    if (!sourcePath) {
      return res.status(404).json({ error: 'video_not_found' });
    }

    const remux = ensureMp4(sourcePath, rootDir);
    if (!remux.ok || !remux.outputPath || !fs.existsSync(remux.outputPath)) {
      return res.status(remux.error === 'ffmpeg_not_available' ? 503 : 500).json({
        error: remux.error || 'remux_failed',
        detail: remux.detail || null,
      });
    }

    try {
      serveFileWithRanges(req, res, remux.outputPath, 'video/mp4');
    } catch (err) {
      res.status(500).json({ error: 'stream_failed', detail: err.message });
    }
  });

  return router;
}

module.exports = {
  createVideoRouter,
};
