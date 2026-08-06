'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../server');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'stage19_bundle');

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

describe('Stage 19 v3 HTTP API', () => {
  let savedCurrent;

  before(() => {
    const cur = path.join(PUB, 'current.json');
    if (fs.existsSync(cur)) savedCurrent = fs.readFileSync(cur, 'utf8');
    fs.mkdirSync(path.join(PUB, 'runs', '2026-07-27-stage19-v4-http-test'), { recursive: true });
    fs.writeFileSync(path.join(PUB, 'runs', '2026-07-27-stage19-v4-http-test', 'bev_v0.json'), '{}');
    fs.writeFileSync(cur, JSON.stringify({ runId: '2026-07-27-stage19-v4-http-test' }));
  });

  after(() => {
    const cur = path.join(PUB, 'current.json');
    if (savedCurrent) fs.writeFileSync(cur, savedCurrent);
    else if (fs.existsSync(cur)) fs.unlinkSync(cur);
    fs.rmSync(path.join(PUB, 'runs', '2026-07-27-stage19-v4-http-test'), { recursive: true, force: true });
  });

  const traversalPaths = [
    '/api/stage19/bundle/../secret',
    '/api/stage19/bundle/..%2fsecret',
    '/api/stage19/bundle/%2e%2e/secret',
    '/api/stage19/bundle/%252e%252e%252fsecret',
    '/api/stage19/bundle/payloads/../../secret',
    '/api/stage19/bundle/payloads%2f..%2f..%2fsecret',
    '/api/stage19/bundle/%00',
    '/api/stage19/bundle/%25',
  ];

  for (const p of traversalPaths) {
    it(`blocks traversal ${p}`, async () => {
      const r = await httpGet(p);
      assert.ok(r.status === 400 || r.status === 404, `expected block, got ${r.status}`);
      if (r.status === 400) {
        assert.match(r.body, /path_traversal|malformed_path_encoding/);
      }
    });
  }

  it('serves file from current run only', async () => {
    const r = await httpGet('/api/stage19/bundle/bev_v0.json');
    assert.equal(r.status, 200);
  });

  it('summary reports v3 checkpoint and preservation', async () => {
    const r = await httpGet('/api/stage19/summary');
    assert.equal(r.status, 200);
    const data = JSON.parse(r.body);
    assert.equal(data.implementationCheckpoint, '2026-07-27-stage19-v5');
    assert.equal(data.checkpointPreservation?.v0?.preservation, 'checkpoint-only');
    assert.equal(data.checkpointPreservation?.v1?.preservation, 'immutable-run');
  });

  it('returns 404 when current.json missing', async () => {
    const cur = path.join(PUB, 'current.json');
    const backup = cur + '.bak2';
    fs.renameSync(cur, backup);
    try {
      const r = await httpGet('/api/stage19/bundle/bev_v0.json');
      assert.equal(r.status, 404);
    } finally {
      fs.renameSync(backup, cur);
    }
  });
});
