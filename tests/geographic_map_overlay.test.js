'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDER = path.join(ROOT, 'public', 'render.js');
const GEO = path.join(ROOT, 'public', 'geographic_map.js');

const NATIVE = path.join(ROOT, 'public', 'geographic_map_native.js');
const APP = path.join(ROOT, 'public', 'app.js');

describe('geographic map overlay wiring', () => {
  it('renderer skips local canvas draw when map-native active', () => {
    const src = fs.readFileSync(RENDER, 'utf8');
    assert.match(src, /setMapNativeActive/);
    assert.match(src, /_mapNativeActive && this\.displayMode === 'local'/);
    assert.match(src, /fitRouteBounds/);
  });

  it('native map does not call process API', () => {
    const src = fs.readFileSync(NATIVE, 'utf8');
    assert.doesNotMatch(src, /\/api\/process/);
    assert.match(src, /syncScene/);
  });

  it('grey mode uses local worldToScreen path when map-native inactive', () => {
    const src = fs.readFileSync(RENDER, 'utf8');
    const block = src.slice(src.indexOf('worldToScreen(east, north)'), src.indexOf('roadGeometryToScreen'));
    assert.match(block, /const cx = this\.w \/ 2 \+ this\.offsetX/);
    const app = fs.readFileSync(APP, 'utf8');
    assert.match(app, /setMapNativeActive\?\.\(false\)/);
  });
});
