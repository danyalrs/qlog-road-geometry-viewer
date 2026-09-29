'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { friendlyStatus } = require('../lib/map_status');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'public', 'index.html');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8')
  + fs.readFileSync(path.join(ROOT, 'public', 'style_supervisor_ui.css'), 'utf8');
const GEO = path.join(ROOT, 'public', 'geographic_map_native.js');

describe('map container size fix', () => {
  it('shared geometry stage wraps map and canvas', () => {
    const html = fs.readFileSync(INDEX, 'utf8');
    assert.match(html, /id="geometryStage"/);
    assert.match(html, /id="geographicMapContainer"/);
    assert.match(html, /id="canvas"/);
    const stagePos = html.indexOf('id="geometryStage"');
    const mapPos = html.indexOf('id="geographicMapContainer"');
    const canvasPos = html.indexOf('id="canvas"');
    assert.ok(stagePos < mapPos && mapPos < canvasPos);
  });

  it('stage CSS provides measurable dimensions', () => {
    assert.match(CSS, /\.geometry-stage/);
    assert.match(CSS, /min-height:\s*0/);
    assert.match(CSS, /min-width:\s*0/);
    assert.match(CSS, /position:\s*relative/);
  });

  it('map container avoids display:none before measure', () => {
    assert.doesNotMatch(CSS, /\.geographic-map-container\s*\{[^}]*display:\s*none/s);
    assert.match(CSS, /visibility:\s*hidden/);
  });

  it('geographic map waits with ResizeObserver and does not force grey on zero size', () => {
    const src = fs.readFileSync(GEO, 'utf8');
    assert.match(src, /ResizeObserver/);
    assert.match(src, /waitingForLayout/);
    assert.match(src, /applyStagePresentation/);
    assert.doesNotMatch(src, /containerZeroSize[\s\S]{0,120}mode = 'grey'/);
  });

  it('waiting status is distinct from grey fallback', () => {
    assert.match(friendlyStatus('waitingForLayout'), /Waiting for map layout/i);
    assert.doesNotMatch(friendlyStatus('waitingForLayout'), /using Grey/i);
  });

  it('canvas pan/zoom skipped when geographic map active', () => {
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(app, /geographicMap\?\.isActive/);
  });
});
