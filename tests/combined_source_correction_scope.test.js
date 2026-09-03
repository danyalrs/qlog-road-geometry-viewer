'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('combined source correction scope rollback', () => {
  it('rejects per-source renderer reflection from Candidate B', () => {
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.doesNotMatch(renderSrc, /_mapIsMultiSource/);
    assert.doesNotMatch(renderSrc, /_isExactCorrectionActiveForSource/);
    assert.doesNotMatch(renderSrc, /resolveMapSourceMetadata/);
  });

  it('routes combined orientation through boundary anchoring module', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'lib/combined_boundary_anchored_orientation.js')));
    assert.ok(fs.existsSync(path.join(ROOT, 'public/combined_boundary_anchored_orientation.js')));
    const indexSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.match(indexSrc, /combined_boundary_anchored_orientation\.js/);
  });
});
