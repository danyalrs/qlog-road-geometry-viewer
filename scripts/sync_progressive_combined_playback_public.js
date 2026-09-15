#!/usr/bin/env node
'use strict';

const fs = require('fs');

let c = fs.readFileSync('lib/progressive_combined_playback.js', 'utf8');
c = c.replace(/^'use strict';\n\nconst crypto = require\('crypto'\);\nconst VDC = require\('\.\/viewer_display_corrections'\);\nconst CBAO = require\('\.\/combined_boundary_anchored_orientation'\);\nconst CST = require\('\.\/combined_source_transform'\);\nconst CRB = require\('\.\/combined_route_boundary_bridge'\);\n\n\/\*\*[\s\S]*?\*\/\n\n/, "'use strict';\n\n");
c = c.replace(/const VDC = require\('\.\/viewer_display_corrections'\);\n/g, "const VDC = (typeof require !== 'undefined') ? require('./viewer_display_corrections') : global.ViewerDisplayCorrections;\n");
c = c.replace(/const CBAO = require\('\.\/combined_boundary_anchored_orientation'\);\n/g, "const CBAO = (typeof require !== 'undefined') ? require('./combined_boundary_anchored_orientation') : global.CombinedBoundaryAnchoredOrientation;\n");
c = c.replace(/const CST = require\('\.\/combined_source_transform'\);\n/g, "const CST = (typeof require !== 'undefined') ? require('./combined_source_transform') : global.CombinedSourceTransform;\n");
c = c.replace(/const CRB = require\('\.\/combined_route_boundary_bridge'\);\n/g, "const CRB = (typeof require !== 'undefined') ? require('./combined_route_boundary_bridge') : global.CombinedRouteBoundaryBridge;\n");
c = c.replace(
  /function perSourcePlacedChecksums\(map, sourceFiles\) \{[\s\S]*?\n\}/,
  'function perSourcePlacedChecksums(map, sourceFiles) {\n  return perSourcePlacedPayloads(map, sourceFiles);\n}',
);
c = c.replace('module.exports = {', 'const api = {');
const out = `'use strict';
(function (global) {
const VDC = global.ViewerDisplayCorrections;
const CBAO = global.CombinedBoundaryAnchoredOrientation;
const CST = global.CombinedSourceTransform;
const CRB = global.CombinedRouteBoundaryBridge;
${c}
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.ProgressiveCombinedPlayback = api;
})(typeof window !== 'undefined' ? window : global);
`;
fs.writeFileSync('public/progressive_combined_playback.js', out);
