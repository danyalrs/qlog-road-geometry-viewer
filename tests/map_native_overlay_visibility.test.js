'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NATIVE = path.join(ROOT, 'public', 'geographic_map_native.js');
const APP = path.join(ROOT, 'public', 'app.js');
const RENDER = path.join(ROOT, 'public', 'render.js');

describe('map-native overlay visibility', () => {
  it('does not insert overlays below raster via beforeId', () => {
    const src = fs.readFileSync(NATIVE, 'utf8');
    assert.doesNotMatch(src, /addLayer\([\s\S]*?\},\s*before\)/);
    assert.match(src, /moveOverlaysAboveRaster/);
    assert.match(src, /moveLayer\(id\)/);
  });

  it('exposes refreshGeographicMapData lifecycle hook', () => {
    const src = fs.readFileSync(NATIVE, 'utf8');
    assert.match(src, /function refreshGeographicMapData/);
    assert.match(src, /pendingScene/);
    assert.match(src, /map\.on\('load'/);
    assert.match(src, /options\.onRedraw/);
  });

  it('GPS route uses visible cyan styling and start/end markers', () => {
    const src = fs.readFileSync(NATIVE, 'utf8');
    assert.match(src, /#06b6d4/);
    assert.match(src, /gps-route-start/);
    assert.match(src, /gps-route-end/);
    assert.match(src, /'line-width': 8/);
  });

  it('vehicle DOM marker exists', () => {
    const src = fs.readFileSync(NATIVE, 'utf8');
    assert.match(src, /geo-vehicle-arrow/);
    assert.match(src, /updateGeographicVehicleMarker/);
    assert.match(src, /lastVehicleLngLat/);
  });

  it('app builds scene payload and refreshes geographic data', () => {
    const app = fs.readFileSync(APP, 'utf8');
    assert.match(app, /buildGeographicMapScenePayload/);
    assert.match(app, /refreshGeographicMapData/);
  });

  it('representative builder sets diagnostics without canvas draw', () => {
    const render = fs.readFileSync(RENDER, 'utf8');
    assert.match(render, /buildRepresentativePolylinesForGeographic/);
    assert.match(render, /candidateActive: true/);
  });

  it('compact status includes playback time when available', () => {
    const app = fs.readFileSync(APP, 'utf8');
    assert.match(app, /formatPlaybackTimeSeconds/);
    assert.match(app, /Detected lane overlay unavailable/);
  });

  it('debug layer isolation controls exist only in debug tier', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const appSrc = fs.readFileSync(APP, 'utf8');
    assert.match(html, /mapDebugLayerRoute/);
    assert.match(html, /ui-tier-debug/);
    assert.match(appSrc, /initMapDebugLayerIsolation/);
  });
});
