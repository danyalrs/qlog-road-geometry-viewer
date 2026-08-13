'use strict';

/**
 * Regression tests for the video-loading path after a project restore.
 *
 * Scope: video lookup, cache reuse across restores, range serving, MIME types,
 * frontend source reload, and isolation from the mapping pipeline. No mapping,
 * geometry, pose-lock, tracking or fusion code is touched.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  resolveCacheDir,
  cacheKeyForSource,
  findCachedMp4ForSource,
  ensureBrowserMp4,
} = require('../lib/video_remux');
const {
  resolveVideoDirectory,
  findQcameraTsForSegment,
} = require('../lib/segment_video');
const { parseRangeHeader, serveFileWithRanges } = require('../lib/video_range');

const ROOT = path.join(__dirname, '..');
const FIXTURE_VIDEO_DIR = path.join(__dirname, 'fixtures', 'video');

/** Build a throwaway project dir with a source .ts and a stale-named cached mp4. */
function makeRestoredProject({ sourceSize = 1024, cachedName } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-restore-'));
  const source = path.join(dir, 'route---2026-07-20--09-34-13--6---qcamera.ts');
  fs.writeFileSync(source, Buffer.alloc(sourceSize, 7));
  const cacheDir = path.join(dir, '.video_cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, cachedName || 'route---2026-07-20--09-34-13--6---qcamera.deadbeef.mp4');
  fs.writeFileSync(cached, Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]));
  return { dir, source, cached };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('video restore — cache reuse', () => {
  it('1. existing cached video is found by source basename when the mtime-derived key misses', () => {
    const { dir, source, cached } = makeRestoredProject();
    try {
      // The exact key is basename+size+mtime; simulate a restored source whose
      // mtime no longer matches the cached filename's hash.
      const exact = cacheKeyForSource(source);
      assert.notEqual(exact, path.basename(cached));
      const found = findCachedMp4ForSource(source, resolveCacheDir(dir));
      assert.ok(found);
      assert.equal(path.basename(found), path.basename(cached));
    } finally {
      cleanup(dir);
    }
  });

  it('2. ensureBrowserMp4 serves the restored cached mp4 without ffmpeg/ffprobe', () => {
    const { dir, source } = makeRestoredProject();
    try {
      const result = ensureBrowserMp4(source, dir);
      assert.equal(result.ok, true);
      assert.equal(result.cacheHit, true);
      assert.equal(result.method, 'cache');
      assert.equal(result.restoredFromBasename, true);
      assert.ok(fs.existsSync(result.outputPath));
      assert.equal(path.dirname(result.outputPath), resolveCacheDir(dir));
    } finally {
      cleanup(dir);
    }
  });

  it('3. cache lookup is project-relative and does not depend on a machine path', () => {
    const { dir, source, cached } = makeRestoredProject();
    try {
      // Move the "project" by resolving against a re-rooted directory.
      const relocated = path.join(dir, 'moved', 'project');
      fs.mkdirSync(relocated, { recursive: true });
      const relocatedCache = path.join(relocated, '.video_cache');
      fs.mkdirSync(relocatedCache, { recursive: true });
      const copiedSource = path.join(relocated, path.basename(source));
      fs.copyFileSync(source, copiedSource);
      const copiedCached = path.join(relocatedCache, path.basename(cached));
      fs.copyFileSync(cached, copiedCached);
      const result = ensureBrowserMp4(copiedSource, relocated);
      assert.equal(result.ok, true);
      assert.equal(result.cacheHit, true);
      assert.ok(result.outputPath.startsWith(relocated + path.sep));
      assert.ok(!/C:\\\\Users/.test(result.outputPath) || result.outputPath.includes(relocated));
    } finally {
      cleanup(dir);
    }
  });

  it('4. no cached video for a source is reported as unavailable (no ffmpeg fallback needed)', () => {
    const { dir, source, cached } = makeRestoredProject({ cachedName: 'other.mp4' });
    try {
      const found = findCachedMp4ForSource(source, resolveCacheDir(dir));
      assert.equal(found, null);
      const result = ensureBrowserMp4(source, dir);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'ffmpeg_not_available');
    } finally {
      cleanup(dir);
    }
  });
});

describe('video restore — lookup paths are project-relative', () => {
  it('5. resolveVideoDirectory resolves relative to the given root', () => {
    const { dir } = makeRestoredProject();
    try {
      const resolved = resolveVideoDirectory(dir);
      assert.equal(resolved, path.resolve(dir));
      assert.equal(findQcameraTsForSegment('6', dir), path.join(dir, 'route---2026-07-20--09-34-13--6---qcamera.ts'));
    } finally {
      cleanup(dir);
    }
  });

  it('6. video modules contain no hardcoded machine path', () => {
    for (const f of ['lib/video_remux.js', 'lib/video_range.js', 'lib/segment_video.js', 'lib/video_routes.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.doesNotMatch(src, /C:\\\\Users\\\\[^"\\]*|C:\\Users\\[^"\\]*/i, `${f} should not embed an absolute user path`);
    }
  });
});

describe('video restore — range serving', () => {
  it('7. valid range returns 206 with correct Content-Range', async () => {
    const file = path.join(FIXTURE_VIDEO_DIR, 'sample-stream.mp4');
    const { serve } = await makeRangeServer();
    try {
      const r = await serve(file, 'bytes=0-9');
      assert.equal(r.status, 206);
      assert.equal(r.headers['content-range'], `bytes 0-9/${fs.statSync(file).size}`);
      assert.equal(r.headers['accept-ranges'], 'bytes');
      assert.equal(r.body.toString('utf8'), fs.readFileSync(file, 'utf8').slice(0, 10));
    } finally {
      cleanupRangeServer();
    }
  });

  it('8. invalid range returns 416 with bytes * content-range', async () => {
    const file = path.join(FIXTURE_VIDEO_DIR, 'sample-stream.mp4');
    const { serve } = await makeRangeServer();
    try {
      const r = await serve(file, 'bytes=999999-');
      assert.equal(r.status, 416);
      assert.equal(r.headers['content-range'], `bytes */${fs.statSync(file).size}`);
      assert.equal(r.body.length, 0);
    } finally {
      cleanupRangeServer();
    }
  });
});

describe('video restore — API response', () => {
  const app = require('../server');

  function httpRequest(urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        http.get({ hostname: '127.0.0.1', port, path: urlPath, headers }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
          });
        }).on('error', (e) => { server.close(); reject(e); });
      });
    });
  }

  it('9. missing video returns explicit unavailable result (hasVideo false)', async () => {
    const prevDir = process.env.VIDEO_DIR;
    process.env.VIDEO_DIR = FIXTURE_VIDEO_DIR;
    try {
      const r = await httpRequest('/api/video/segment/9999/info');
      assert.equal(r.status, 200);
      const data = JSON.parse(r.body.toString('utf8'));
      assert.equal(data.hasVideo, false);
      assert.ok(!data.streamUrl, 'missing video must not expose a stream url');
    } finally {
      if (prevDir == null) delete process.env.VIDEO_DIR;
      else process.env.VIDEO_DIR = prevDir;
    }
  });
});

describe('video restore — frontend behaviour', () => {
  it('10. local_playback_video reloads the video element source and calls load() on segment change', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    assert.match(src, /this\.videoEl\.src =/);
    assert.match(src, /this\.videoEl\.load\(\)/);
    assert.match(src, /unload\(/);
  });

  it('11. app.js re-drives the video panel after each segment process', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(src, /refreshLocalPlaybackVideo/);
    assert.match(src, /onSegmentProcessed/);
    assert.match(src, /getActiveVideoSegmentId/);
  });

  it('12. mapping playback continues when video is unavailable (panel is non-fatal)', () => {
    const panelSrc = fs.readFileSync(path.join(ROOT, 'public', 'local_playback_video.js'), 'utf8');
    // Missing-video branch returns a message instead of throwing.
    assert.match(panelSrc, /No matching video for this segment/);
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(appSrc, /localPlaybackVideo\??\.onSegmentProcessed/);
    assert.match(appSrc, /refreshLocalPlaybackVideo/);
  });
});

describe('video restore — mapping isolation', () => {
  it('13. video fix does not change the processing version or mapping modules', () => {
    const version = require('../lib/version');
    assert.equal(version.PROCESSING_VERSION, '2026-07-24-fusion-v16');
    for (const f of ['lib/process_route.js', 'lib/segment_local_map.js', 'lib/stationary_pose_lock.js', 'lib/point_accumulation.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.doesNotMatch(src, /video_remux|video_range|segment_video/, `${f} must not import the video pipeline`);
    }
  });

  it('14. video modules do not import the mapping pipeline', () => {
    for (const f of ['lib/video_remux.js', 'lib/video_range.js', 'lib/segment_video.js', 'lib/video_routes.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.doesNotMatch(src, /process_route|segment_local_map|stationary_pose_lock|point_accumulation/, `${f} must not import mapping modules`);
    }
  });
});

// --- helpers for range tests -------------------------------------------------
let rangeServer;
function makeRangeServer() {
  return new Promise((resolve) => {
    const express = require('express');
    const app = express();
    app.get('/file', (req, res) => {
      serveFileWithRanges(req, res, req.query.p, 'video/mp4');
    });
    rangeServer = http.createServer(app);
    rangeServer.listen(0, '127.0.0.1', () => {
      const { port } = rangeServer.address();
      resolve({
        serve: (file, rangeHeader) => new Promise((res2, rej2) => {
          http.get({
            hostname: '127.0.0.1',
            port,
            path: `/file?p=${encodeURIComponent(file)}`,
            headers: rangeHeader ? { Range: rangeHeader } : {},
          }, (res3) => {
            const chunks = [];
            res3.on('data', (c) => chunks.push(c));
            res3.on('end', () => res2({ status: res3.statusCode, headers: res3.headers, body: Buffer.concat(chunks) }));
          }).on('error', rej2);
        }),
      });
    });
  });
}
function cleanupRangeServer() {
  try { rangeServer?.close(); } catch { /* ignore */ }
}
