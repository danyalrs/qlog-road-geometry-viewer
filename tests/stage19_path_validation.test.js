'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateSafePath, resolveBundlePath, boundedDecode } = require('../lib/stage19_path_validation');
const path = require('path');
const os = require('os');
const fs = require('fs');

describe('Stage 19 v3 path validation', () => {
  const rejects = [
    '../secret',
    '..\\secret',
    '%2e%2e/secret',
    '%252e%252e%252fsecret',
    '..%2fsecret',
    '%2e%2e%5csecret',
    'payloads/../../secret',
    'payloads%2f..%2f..%2fsecret',
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    '\\\\server\\share',
    '%00',
    'x%00y',
    '%',
    '%2',
    '%GG',
  ];

  for (const p of rejects) {
    it(`rejects ${p}`, () => {
      assert.throws(() => validateSafePath(p), /path_traversal|malformed_path_encoding/);
    });
  }

  it('accepts valid payload path', () => {
    assert.equal(validateSafePath('payloads/stage18_bev_stable_one_lane_interval.png'), 'payloads/stage18_bev_stable_one_lane_interval.png');
  });

  it('boundedDecode decodes double-encoded traversal', () => {
    const d = boundedDecode('%252e%252e%252fsecret');
    assert.match(d, /\.\./);
    assert.throws(() => validateSafePath('%252e%252e%252fsecret'));
  });

  it('resolveBundlePath stays inside run directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-path-'));
    const runId = 'test-run';
    const base = path.join(root, 'runs', runId, 'payloads');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'ok.png'), 'x');
    const resolved = resolveBundlePath(root, runId, 'payloads/ok.png');
    assert.equal(fs.existsSync(resolved), true);
    assert.throws(() => resolveBundlePath(root, runId, '../outside'));
  });
});
