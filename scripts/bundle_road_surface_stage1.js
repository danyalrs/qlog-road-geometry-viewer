'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function stripModuleExports(src) {
  return src
    .replace(/^'use strict';\r?\n/, '')
    .replace(/module\.exports = \{[\s\S]*$/, '');
}

function stripRequires(src) {
  return src
    .replace(/^const \{[\s\S]*?\} = require\([^)]+\);\r?\n/gm, '')
    .replace(/^const .* = require\([^)]+\);\r?\n/gm, '');
}

const geometrySanity = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/geometry_sanity.js'), 'utf8'),
));

const roadSurfaceStage1 = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/road_surface_stage1.js'), 'utf8'),
));

const browser = `'use strict';
(function initRoadSurfaceStage1(global) {
function dist2d(a, b) {
  return Math.hypot((a.east ?? 0) - (b.east ?? 0), (a.north ?? 0) - (b.north ?? 0));
}

${geometrySanity}

${roadSurfaceStage1}

global.RoadSurfaceStage1 = {
  CANDIDATE_PAIRS,
  collectOpenIntervals,
  auditBoundaryPair,
  runStage1RoadSurface,
  pointAtS,
  subtractOpenFromInterval,
  polygonCoversRouteS,
  polygonSpansOpenInterval,
  anyPolygonSpansInterval,
  getRunGeometry,
  inferWidthLimits,
};
})(typeof window !== 'undefined' ? window : global);
`;

fs.writeFileSync(path.join(ROOT, 'public/road_surface_stage1.js'), browser);
console.log('bundled public/road_surface_stage1.js', browser.length, 'bytes');
