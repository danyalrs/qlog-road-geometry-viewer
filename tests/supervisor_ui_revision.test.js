'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseUiMode } = require('../lib/ui_mode');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'public', 'index.html');
const APP = path.join(ROOT, 'public', 'app.js');
const STYLE = path.join(ROOT, 'public', 'style.css');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function idsInHtml(html) {
  return [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
}

describe('supervisor UI revision 1', () => {
  it('uiMode parsing defaults and validation', () => {
    assert.equal(parseUiMode(''), 'review');
    assert.equal(parseUiMode('?uiMode=review'), 'review');
    assert.equal(parseUiMode('?uiMode=evidence'), 'evidence');
    assert.equal(parseUiMode('?uiMode=debug'), 'debug');
    assert.equal(parseUiMode('?uiMode=invalid'), 'review');
    assert.equal(parseUiMode('?uiMode=debug&uiMode=review'), 'debug');
  });

  it('legacy control ids remain in index.html', () => {
    const html = read(INDEX);
    const required = [
      'segmentSelect', 'btnProcess', 'btnReprocess', 'btnProcessAll',
      'timeline', 'btnPlay', 'btnPrevFrame', 'btnNextFrame',
      'btnProgressiveAppend', 'btnProgressivePlay', 'layerRepresentativeLaneLines',
      'layerConnectedAccumulated', 'vizMode', 'localGeometryMode', 'procVersion',
    ];
    for (const id of required) assert.match(html, new RegExp(`id="${id}"`), id);
    const ids = idsInHtml(html);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dup, [], `duplicate ids: ${dup.join(', ')}`);
  });

  it('plain-language primary labels', () => {
    const html = read(INDEX);
    assert.match(html, /Load segment/);
    assert.match(html, /Reload segment/);
    assert.match(html, /Add next segment/);
    assert.match(html, /Follow vehicle/);
    assert.match(html, /Observation dots/);
    assert.match(html, /Detected lane lines/);
  });

  it('ui mode selector and tier classes present', () => {
    const html = read(INDEX);
    assert.match(html, /id="uiModeSelect"/);
    assert.match(html, /ui-tier-review/);
    assert.match(html, /ui-tier-evidence/);
    assert.match(html, /ui-tier-debug/);
    assert.match(html, /progressive-playback-duplicate/);
  });

  it('map background selector present without inline tile URLs', () => {
    const html = read(INDEX);
    assert.match(html, /id="mapBackgroundMode"/);
    assert.match(html, /id="mapBackgroundStatus"/);
    assert.doesNotMatch(html, /leaflet|mapbox|googleapis|tile\.openstreetmap/i);
  });

  it('app.js wires ui mode and shared playback', () => {
    const app = read(APP);
    assert.match(app, /initUiModeControls/);
    assert.match(app, /parseUiModeFromLocation/);
    assert.match(app, /syncProgressiveViewportBodyClass/);
    assert.match(app, /initProgressiveViewportPlaybackUI/);
    assert.match(app, /togglePlayback/);
    assert.doesNotMatch(app, /fetch\([^)]*tile/i);
  });

  it('review layout css constraints', () => {
    const css = read(STYLE) + read(path.join(ROOT, 'public', 'style_supervisor_ui.css'));
    assert.match(css, /ui-mode-review/);
    assert.match(css, /progressive-viewport-active/);
    assert.match(css, /advanced-settings-body/);
  });

  it('uiMode does not alter processing options builder', () => {
    const app = read(APP);
    const getOptionsBlock = app.slice(app.indexOf('function getOptions'), app.indexOf('function setStatus'));
    assert.doesNotMatch(getOptionsBlock, /uiMode/);
  });
});
