#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function browserizeBridge() {
  let c = fs.readFileSync('lib/combined_route_boundary_bridge.js', 'utf8');
  c = c.replace("const { dist2d, timeGapSec } = require('./chunking');", `function dist2d(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot((b.east ?? 0) - (a.east ?? 0), (b.north ?? 0) - (a.north ?? 0));
}
function timeGapSec(a, b) {
  return Math.abs(Number(BigInt(b.logMonoTime) - BigInt(a.logMonoTime))) / 1e9;
}`);
  c = c.replace('module.exports = {', '(function (global) {\n  const api = {');
  c += "\n  if (typeof module !== 'undefined' && module.exports) module.exports = api;\n  if (typeof global !== 'undefined') global.CombinedRouteBoundaryBridge = api;\n})(typeof window !== 'undefined' ? window : global);\n";
  fs.writeFileSync('public/combined_route_boundary_bridge.js', c);
}

function wrapBrowserBundle(c, globalName) {
  c = c.replace(/^'use strict';\n\n?/, '');
  c = c.replace('module.exports = {', 'const api = {');
  return `'use strict';
(function (global) {
${c}
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.${globalName} = api;
})(typeof window !== 'undefined' ? window : global);
`;
}

function browserizeSourceTransform() {
  let c = fs.readFileSync('lib/combined_source_transform.js', 'utf8');
  c = c.replace("const VDC = require('./viewer_display_corrections');", "const VDC = typeof window !== 'undefined' ? window.ViewerDisplayCorrections : require('./viewer_display_corrections');");
  fs.writeFileSync('public/combined_source_transform.js', wrapBrowserBundle(c, 'CombinedSourceTransform'));
}

function browserizeOrientation() {
  let c = fs.readFileSync('lib/combined_boundary_anchored_orientation.js', 'utf8');
  c = c.replace("const CRB = require('./combined_route_boundary_bridge');", "const CRB = typeof window !== 'undefined' ? window.CombinedRouteBoundaryBridge : require('./combined_route_boundary_bridge');");
  c = c.replace("const CST = require('./combined_source_transform');", "const CST = typeof window !== 'undefined' ? window.CombinedSourceTransform : require('./combined_source_transform');");
  c = c.replace(
    /const crypto = require\('crypto'\);/,
    'const crypto = null; // browser bundle: checksum uses length fallback',
  );
  c = c.replace("const VDC = require('./viewer_display_corrections');", "const VDC = typeof window !== 'undefined' ? window.ViewerDisplayCorrections : require('./viewer_display_corrections');");
  c = c.replace("const VMC = require('./viewer_mirror_coords');", "const VMC = typeof window !== 'undefined' ? window.ViewerMirrorCoords : require('./viewer_mirror_coords');");
  c = c.replace(
    "return crypto.createHash('sha256').update(payload).digest('hex');",
    "if (crypto?.createHash) return crypto.createHash('sha256').update(payload).digest('hex');\n  return 'browser-' + payload.length;",
  );
  fs.writeFileSync('public/combined_boundary_anchored_orientation.js', wrapBrowserBundle(c, 'CombinedBoundaryAnchoredOrientation'));
}

browserizeBridge();
browserizeSourceTransform();
browserizeOrientation();
