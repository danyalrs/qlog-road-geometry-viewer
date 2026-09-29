'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { friendlyStatus } = require('../lib/map_status');
const { getMapConfig } = require('../lib/map_config');

const ROOT = path.join(__dirname, '..');
const GEO = path.join(ROOT, 'public', 'geographic_map.js');

describe('map unavailable diagnosis', () => {
  it('configRequestFailed message mentions server restart', () => {
    const msg = friendlyStatus('configRequestFailed', 'HTTP 404');
    assert.match(msg, /restart/i);
    assert.match(msg, /404/);
  });

  it('street map config schema', () => {
    const cfg = getMapConfig();
    assert.equal(cfg.street.available, true);
    assert.match(cfg.street.tileUrl, /^https:\/\//);
    assert.ok(cfg.street.attribution);
  });

  it('geographic map exposes diagnostic codes', () => {
    const src = fs.readFileSync(GEO, 'utf8');
    assert.match(src, /configRequestFailed/);
    assert.match(src, /\[map-diagnostic\]/);
    assert.match(src, /getDiagnostics/);
  });

  it('maplibre vendor files exist', () => {
    const js = path.join(ROOT, 'public', 'vendor', 'maplibre-gl', 'maplibre-gl.js');
    const css = path.join(ROOT, 'public', 'vendor', 'maplibre-gl', 'maplibre-gl.css');
    assert.ok(fs.statSync(js).size > 100000);
    assert.ok(fs.statSync(css).size > 1000);
  });

  it('seg14 raw geo inventory present', () => {
    const p = path.join(ROOT, 'reports', 'ui', 'map_unavailable_diagnosis', 'seg14_raw_geo.json');
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(raw.finiteLatLonCount > 0);
    assert.ok(raw.gpsMessageCount > 0);
  });
});
