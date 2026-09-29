'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDER = path.join(ROOT, 'public', 'render.js');
const APP = path.join(ROOT, 'public', 'app.js');
const NATIVE = path.join(ROOT, 'public', 'geographic_map_native.js');
const GEOJSON_LIB = path.join(ROOT, 'lib', 'geographic_geojson.js');
const STYLE = path.join(ROOT, 'public', 'style_supervisor_ui.css');

const { buildGpsRouteGeoJson, buildRepresentativeLinesGeoJson } = require('../lib/geographic_geojson');
const { localToLatLon } = require('../lib/projection');
const SLM = require('../lib/segment_local_map');

describe('map-native geographic view', () => {
  it('geographic mode hides local canvas via CSS and renderer skip', () => {
    const css = fs.readFileSync(STYLE, 'utf8');
    assert.match(css, /geographic-renderer-active.*#canvas/);
    const render = fs.readFileSync(RENDER, 'utf8');
    assert.match(render, /_mapNativeActive && this\.displayMode === 'local'/);
    assert.match(render, /setMapNativeActive/);
  });

  it('grey mode restores canvas when native map inactive', () => {
    const native = fs.readFileSync(NATIVE, 'utf8');
    assert.match(native, /mapReadyGrey/);
    assert.match(native, /canvas\.style\.visibility/);
  });

  it('native map defines raster base and GPS GeoJSON sources', () => {
    const native = fs.readFileSync(NATIVE, 'utf8');
    assert.match(native, /type: 'raster'/);
    assert.match(native, /gps-route-line-src/);
    assert.match(native, /current-vehicle-src/);
    assert.match(native, /representative-lines-src/);
  });

  it('GPS route GeoJSON preserves lat/lon from gpsTrajectory', () => {
    const origin = { lat: 1.35, lon: 103.8 };
    const gpsTrajectory = [
      { latitude: 1.351, longitude: 103.801 },
      { latitude: 1.352, longitude: 103.802 },
    ];
    const built = buildGpsRouteGeoJson({ origin, gpsTrajectory });
    assert.equal(built.pointCount, 2);
    assert.deepEqual(built.line.geometry.coordinates[0], [103.801, 1.351]);
  });

  it('GPS route from segment-local trajectory uses reference pose', () => {
    const origin = { lat: 1.35, lon: 103.8 };
    const referencePose = { east: 100, north: 200, headingDeg: 10 };
    const g0 = SLM.segmentLocalToGlobal(0, 0, referencePose);
    const ll0 = localToLatLon(g0.east, g0.north, origin);
    const trajectory = [
      { east: 0, north: 0 },
      { east: 20, north: 2 },
    ];
    const built = buildGpsRouteGeoJson({ origin, trajectory, referencePose });
    assert.equal(built.source, 'trajectorySegmentLocal');
    assert.equal(built.pointCount, 2);
    assert.ok(Math.abs(built.line.geometry.coordinates[0][0] - ll0.longitude) < 1e-7);
  });

  it('representative lines become LineStrings in lng/lat', () => {
    const origin = { lat: 1.35, lon: 103.8 };
    const referencePose = { east: 100, north: 200, headingDeg: 45 };
    const polylines = [{
      groupTrackId: 1,
      points: [
        { localEast: 0, localNorth: 0 },
        { localEast: 5, localNorth: 1 },
      ],
    }];
    const geo = buildRepresentativeLinesGeoJson(polylines, referencePose, origin);
    assert.equal(geo.features.length, 1);
    assert.equal(geo.features[0].geometry.type, 'LineString');
    for (const c of geo.features[0].geometry.coordinates) {
      assert.ok(Number.isFinite(c[0]) && Number.isFinite(c[1]));
      assert.ok(Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90);
    }
  });

  it('app wires native map not screen projector overlay', () => {
    const app = fs.readFileSync(APP, 'utf8');
    assert.match(app, /createGeographicMapNative/);
    assert.match(app, /syncGeographicMapScene/);
    assert.match(app, /setGeographicMapController/);
    assert.doesNotMatch(app, /setGeographicScreenProjector\(geographicMap\)/);
  });

  it('playback updates vehicle via geographic marker API', () => {
    const render = fs.readFileSync(RENDER, 'utf8');
    assert.match(render, /updateGeographicVehicleMarker/);
    const native = fs.readFileSync(NATIVE, 'utf8');
    assert.match(native, /function updateGeographicVehicleMarker/);
    assert.match(native, /function updateVehicleOnly/);
  });

  it('map ready requires tiles and route points in native diagnostics', () => {
    const native = fs.readFileSync(NATIVE, 'utf8');
    assert.match(native, /baseTilesLoaded/);
    assert.match(native, /evaluateMapReady/);
    assert.match(native, /mapReadyPending/);
  });

  it('no credentials in map config module', () => {
    const cfg = fs.readFileSync(path.join(ROOT, 'lib', 'map_config.js'), 'utf8');
    assert.doesNotMatch(cfg, /api[_-]?key\s*=\s*['"][^'"]{8,}/i);
    assert.match(cfg, /MAP_SATELLITE_TILE_URL/);
  });

  it('UTF-8 scan on new geographic modules', () => {
    for (const rel of [
      'lib/geographic_geojson.js',
      'public/geographic_geojson.js',
      'public/geographic_map_native.js',
    ]) {
      const buf = fs.readFileSync(path.join(ROOT, rel));
      const text = buf.toString('utf8');
      assert.ok(!text.includes('\uFFFD'));
    }
  });
});
