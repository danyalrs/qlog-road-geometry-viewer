'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseUiMode, parseMapBackground } = require('../lib/ui_mode');
const { presetForUiMode, layersDifferBetweenReviewAndEvidence } = require('../lib/ui_mode_presets');
const { getMapConfig, satelliteConfigured } = require('../lib/map_config');
const { canonicalLocalToLngLat, roundTripErrorM } = require('../lib/geographic_projection');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'public', 'app.js');
const INDEX = path.join(ROOT, 'public', 'index.html');
const RENDER = path.join(ROOT, 'public', 'render.js');
const SERVER = path.join(ROOT, 'server.js');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

describe('supervisor UI revision 2', () => {
  it('review and evidence presets differ on observation layers', () => {
    assert.equal(layersDifferBetweenReviewAndEvidence(), true);
    const review = presetForUiMode('review');
    const evidence = presetForUiMode('evidence');
    assert.equal(review.layerFusedLanes, false);
    assert.equal(evidence.layerFusedLanes, true);
    assert.equal(review.layerConnectedAccumulated, false);
    assert.equal(evidence.layerConnectedAccumulated, true);
    assert.equal(review.layerRepresentativeLaneLines, true);
    assert.equal(evidence.layerRepresentativeLaneLines, true);
  });

  it('debug preset is not forced', () => {
    assert.equal(presetForUiMode('debug'), null);
  });

  it('mapBackground URL parsing and fallback', () => {
    assert.equal(parseMapBackground(''), 'street');
    assert.equal(parseMapBackground('?mapBackground=grey'), 'grey');
    assert.equal(parseMapBackground('?mapBackground=satellite'), 'satellite');
    assert.equal(parseMapBackground('?mapBackground=invalid'), 'street');
    assert.equal(parseMapBackground('?mapBackground=invalid', { streetAvailable: false }), 'grey');
  });

  it('uiMode parsing unchanged', () => {
    assert.equal(parseUiMode(''), 'review');
    assert.equal(parseUiMode('?uiMode=evidence'), 'evidence');
  });

  it('map config street enabled satellite optional', () => {
    const cfg = getMapConfig();
    assert.equal(cfg.street.available, true);
    assert.match(cfg.street.tileUrl, /openstreetmap/i);
    assert.equal(cfg.satellite.available, satelliteConfigured());
    const repo = read(path.join(ROOT, 'package.json')) + read(SERVER) + read(path.join(ROOT, 'lib', 'map_config.js'));
    assert.doesNotMatch(repo, /MAP_SATELLITE_TILE_URL\s*=\s*['"][^'"]+token/i);
  });

  it('app wires layer presets and map without reprocess hook', () => {
    const app = read(APP);
    assert.match(app, /applyUiLayerPreset/);
    assert.match(app, /replaceUrlParams/);
    assert.match(app, /initGeographicMap/);
    assert.match(app, /connectedAccumulatedCache = null/);
    const getOptionsBlock = app.slice(app.indexOf('function getOptions'), app.indexOf('function setStatus'));
    assert.doesNotMatch(getOptionsBlock, /uiMode|mapBackground/);
  });

  it('render invalidates representative per-frame cache on map key change', () => {
    const render = read(RENDER);
    assert.match(render, /_representativePerFrameMapKey/);
    assert.match(render, /mapKeyStale/);
  });

  it('index exposes map lib and geographic stack locally', () => {
    const html = read(INDEX);
    assert.match(html, /vendor\/maplibre-gl\/maplibre-gl\.js/);
    assert.match(html, /geographic_map_native\.js/);
    assert.match(html, /id="mapBackgroundMode"/);
    assert.match(html, /id="uiModeDescription"/);
    assert.doesNotMatch(html, /tile\.openstreetmap\.org/);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'vendor', 'maplibre-gl', 'maplibre-gl.js')));
  });

  it('canonical local geographic round-trip is sub-metre at sample pose', () => {
    const origin = { lat: 1.3521, lon: 103.8198 };
    const referencePose = { east: 12, north: -4, headingDeg: 15 };
    const err = roundTripErrorM(3.5, -1.2, referencePose, origin);
    assert.ok(err != null && err < 0.05);
    const ll = canonicalLocalToLngLat(3.5, -1.2, referencePose, origin);
    assert.ok(Number.isFinite(ll.latitude) && Number.isFinite(ll.longitude));
  });

  it('server exposes /api/map-config', () => {
    assert.match(read(SERVER), /\/api\/map-config/);
  });
});
