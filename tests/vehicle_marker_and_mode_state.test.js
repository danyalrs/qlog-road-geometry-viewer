'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  resolveVehicleGeographicFromPlaybackPose,
} = require('../lib/geographic_vehicle_position');

const ROOT = path.join(__dirname, '..');
const NATIVE = path.join(ROOT, 'public', 'geographic_map_native.js');
const APP = path.join(ROOT, 'public', 'app.js');

describe('vehicle marker and mode state', () => {
  it('marker uses DOM not MapLibre glyphs', () => {
    const src = fs.readFileSync(NATIVE, 'utf8');
    assert.match(src, /maplibregl\.Marker/);
    assert.match(src, /geo-vehicle-arrow/);
    assert.doesNotMatch(src, /text-field:\s*'▲'/);
    assert.match(src, /markerUsesGlyphs:\s*false/);
  });

  it('segment-local pose converts to finite lng/lat', () => {
    const origin = { lat: 1.35, lon: 103.8 };
    const referencePose = { east: 100, north: 200, headingDeg: 45 };
    const pose = { east: 12, north: 3, headingDeg: 90, matchMethod: 'segmentTrajectoryInterpolation' };
    const r = resolveVehicleGeographicFromPlaybackPose(pose, referencePose, origin);
    assert.equal(r.available, true);
    assert.ok(Math.abs(r.longitude) > 1);
    assert.ok(Math.abs(r.latitude) > 0.5);
    assert.notEqual(r.longitude, 0);
    assert.notEqual(r.latitude, 0);
  });

  it('missing pose does not emit zero coordinate', () => {
    const origin = { lat: 1.35, lon: 103.8 };
    const referencePose = { east: 0, north: 0, headingDeg: 0 };
    const r = resolveVehicleGeographicFromPlaybackPose({ east: NaN, north: 0 }, referencePose, origin);
    assert.equal(r.available, false);
  });

  it('evidence preset syncs toggles and keeps base layers visible', () => {
    const app = fs.readFileSync(APP, 'utf8');
    assert.match(app, /syncEvidenceTogglesFromLayers/);
    const native = fs.readFileSync(NATIVE, 'utf8');
    assert.match(native, /setLayerVisibility\('gps-route-line', true\)/);
    assert.match(native, /setLayerVisibility\('gps-route-points', evidence\)/);
  });

  it('pending segment selection does not clear loaded map', () => {
    const app = fs.readFileSync(APP, 'utf8');
    assert.match(app, /updatePendingSegmentSelectionStatus/);
    assert.match(app, /currently showing Seg/);
    assert.doesNotMatch(app, /segmentSelect'\)\.onchange[\s\S]*clearProcessState/);
  });

  it('representative diag respects checked layer', () => {
    const app = fs.readFileSync(APP, 'utf8');
    assert.match(app, /Detected lane overlay unavailable/);
    assert.doesNotMatch(app, /Representative lines: off[\s\S]*repOn/);
  });
});
