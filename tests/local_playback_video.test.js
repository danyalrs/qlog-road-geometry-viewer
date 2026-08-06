'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  parseSegmentIdFromQlogFilename,
  parseSegmentIdFromQcameraFilename,
  isValidSegmentId,
  findQcameraTsForSegment,
  listAvailableSegmentVideos,
  loadVideoOffsets,
  getVideoStartOffsetSeconds,
  computeLocalElapsedSeconds,
  computeExpectedVideoTime,
  computeSyncAction,
} = require('../lib/segment_video');
const { parseRangeHeader, serveFileWithRanges } = require('../lib/video_range');
const { createVideoRouter } = require('../lib/video_routes');

const ROOT = path.join(__dirname, '..');
const FIXTURE_VIDEO_DIR = path.join(__dirname, 'fixtures', 'video');
const OFFSETS_FIXTURE = path.join(FIXTURE_VIDEO_DIR, 'offsets.json');

describe('segment video mapping', () => {
  it('parses qlog segment id from filename', () => {
    assert.equal(parseSegmentIdFromQlogFilename('qlog_f449c_54.bz2'), '54');
    assert.equal(parseSegmentIdFromQlogFilename('qlog_f449c_0.bz2'), '0');
    assert.equal(parseSegmentIdFromQlogFilename('other.bz2'), null);
  });

  it('parses qcamera segment id from filename', () => {
    assert.equal(
      parseSegmentIdFromQcameraFilename('f449c---2026-07-20--09-34-13--54---qcamera.ts'),
      '54',
    );
    assert.equal(parseSegmentIdFromQcameraFilename('bad.ts'), null);
  });

  it('rejects invalid segment ids', () => {
    assert.equal(isValidSegmentId('54'), true);
    assert.equal(isValidSegmentId('../54'), false);
    assert.equal(isValidSegmentId('54a'), false);
  });

  it('finds matching qcamera file for segment', () => {
    const found = findQcameraTsForSegment('54', FIXTURE_VIDEO_DIR);
    assert.ok(found);
    assert.match(path.basename(found), /--54---qcamera\.ts$/i);
  });

  it('returns null when no matching video exists', () => {
    assert.equal(findQcameraTsForSegment('9999', FIXTURE_VIDEO_DIR), null);
  });

  it('lists available segment videos', () => {
    const list = listAvailableSegmentVideos(FIXTURE_VIDEO_DIR);
    assert.ok(list.some((entry) => entry.segmentId === '54'));
  });
});

describe('video offset configuration', () => {
  it('loads configured per-segment offsets', () => {
    const offsets = loadVideoOffsets(OFFSETS_FIXTURE);
    assert.equal(offsets.defaultVideoStartOffsetSeconds, 0);
    assert.equal(getVideoStartOffsetSeconds('54', offsets), 1.25);
    assert.equal(getVideoStartOffsetSeconds('99', offsets), 0);
  });
});

describe('logMonoTime playback clock', () => {
  it('converts nanosecond logMonoTime deltas to elapsed seconds', () => {
    const start = '1000000000';
    const later = '3500000000';
    assert.equal(computeLocalElapsedSeconds(later, start), 2.5);
  });

  it('applies configured video offset to expected video time', () => {
    assert.equal(computeExpectedVideoTime(12.5, 1.25), 13.75);
    assert.equal(computeExpectedVideoTime(12.5, 0), 12.5);
  });
});

describe('video drift correction', () => {
  it('does nothing for small drift', () => {
    assert.equal(computeSyncAction(0.05).action, 'none');
    assert.equal(computeSyncAction(-0.08).action, 'none');
  });

  it('uses bounded playback-rate correction for moderate drift', () => {
    const forward = computeSyncAction(0.2);
    assert.equal(forward.action, 'rate');
    assert.ok(forward.playbackRate >= 0.95 && forward.playbackRate <= 1);
    const backward = computeSyncAction(-0.25);
    assert.equal(backward.action, 'rate');
    assert.ok(backward.playbackRate >= 1 && backward.playbackRate <= 1.05);
  });

  it('seeks for large drift', () => {
    assert.equal(computeSyncAction(0.5).action, 'seek');
    assert.equal(computeSyncAction(-0.6).action, 'seek');
  });
});

describe('video range parsing', () => {
  it('parses open-ended and closed byte ranges', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRangeHeader('bytes=500-', 1000), { start: 500, end: 999 });
    assert.deepEqual(parseRangeHeader('bytes=-100', 1000), { start: 900, end: 999 });
  });
});

describe('video API security', () => {
  const app = require('../server');

  function httpRequest(urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        http.get({
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          headers,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
        }).on('error', (e) => { server.close(); reject(e); });
      });
    });
  }

  it('rejects invalid segment ids', async () => {
    const r = await httpRequest('/api/video/segment/54x/info');
    assert.equal(r.status, 400);
    const traversal = await httpRequest('/api/video/segment/%2e%2e/info');
    assert.equal(traversal.status, 400);
  });

  it('returns hasVideo false for missing segment video', async () => {
    const prevDir = process.env.VIDEO_DIR;
    process.env.VIDEO_DIR = FIXTURE_VIDEO_DIR;
    try {
      const r = await httpRequest('/api/video/segment/9999/info');
      assert.equal(r.status, 200);
      const data = JSON.parse(r.body.toString('utf8'));
      assert.equal(data.hasVideo, false);
    } finally {
      if (prevDir == null) delete process.env.VIDEO_DIR;
      else process.env.VIDEO_DIR = prevDir;
    }
  });

  it('serves mp4 with byte-range support through injected router', async () => {
    const mp4Path = path.join(FIXTURE_VIDEO_DIR, 'sample-stream.mp4');
    fs.writeFileSync(mp4Path, Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'));

    const router = createVideoRouter(ROOT, {
      videoDir: FIXTURE_VIDEO_DIR,
      ensureBrowserMp4: () => ({
        ok: true,
        outputPath: mp4Path,
        cacheHit: true,
        method: 'cache',
      }),
    });
    const app = require('express')();
    app.use('/api/video', router);

    const ranged = await new Promise((resolve, reject) => {
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        http.get({
          hostname: '127.0.0.1',
          port,
          path: '/api/video/segment/54/stream.mp4',
          headers: { Range: 'bytes=0-9' },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
        }).on('error', (e) => { server.close(); reject(e); });
      });
    });

    assert.equal(ranged.status, 206);
    assert.match(ranged.headers['content-range'], /bytes 0-9\//);
    assert.equal(ranged.body.toString('utf8'), '0123456789');
  });
});

describe('local playback client integration', () => {
  it('app.js wires the local playback video panel to the master timeline', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    assert.match(src, /LocalPlaybackVideoPanel/);
    assert.match(src, /refreshLocalPlaybackVideo/);
    assert.match(src, /getCurrentPlaybackLogMonoTime/);
    assert.match(src, /localPlaybackVideo\?\.playFromLogMonoTime/);
    assert.match(src, /localPlaybackVideo\?\.onMasterPaused/);
    assert.match(src, /localPlaybackVideo\?\.onTimelineScrub/);
    assert.match(src, /localPlaybackVideo\?\.tickSync/);
  });

  it('local playback video panel does not create its own autoplay loop', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/local_playback_video.js'), 'utf8');
    assert.doesNotMatch(src, /setInterval\(/);
    assert.doesNotMatch(src, /schedulePlaybackStep/);
    assert.match(src, /tickSync/);
  });
});

describe('local playback regression', () => {
  it('existing local playback tests remain discoverable', () => {
    assert.ok(fs.existsSync(path.join(__dirname, 'local_playback.test.js')));
  });
});
