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

const fusionBins = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/fusion_bins.js'), 'utf8'),
))
  .replace(/^\s*const \{ fuseLaneTrackSdFragments \} = require\('\.\/sd_fusion'\);\r?\n/gm, '')
  .replace(/^\s*const \{ collectEdgeObservations, fuseSideBoundary \} = require\('\.\/sd_fusion'\);\r?\n/gm, '');

const laneAudit = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/lane_run_audit.js'), 'utf8'),
));

const coverageAccounting = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/coverage_accounting.js'), 'utf8'),
));

const drawablePath = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/drawable_path.js'), 'utf8'),
));

const trajectory = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/trajectory.js'), 'utf8'),
));

const temporalProjection = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/temporal_projection.js'), 'utf8'),
));

const preservation = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/source_polyline_preservation.js'), 'utf8'),
));

const sdFusion = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/sd_fusion.js'), 'utf8'),
));

const visibleGap = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/visible_gap_reconstruction.js'), 'utf8'),
));

const cleanup = stripRequires(stripModuleExports(
  fs.readFileSync(path.join(ROOT, 'lib/lane_map_cleanup.js'), 'utf8'),
))
  .replace(/const \{ buildReferenceTrajectory \} = require\('\.\/trajectory'\);\r?\n/, '');

const browser = `'use strict';
(function initLaneMapCleanup(global) {
function dist2d(a, b) {
  return Math.hypot((a.east ?? 0) - (b.east ?? 0), (a.north ?? 0) - (b.north ?? 0));
}
function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < (points?.length || 0); i++) {
    len += Math.hypot(points[i].east - points[i - 1].east, points[i].north - points[i - 1].north);
  }
  return len;
}
function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < (points?.length || 0); i++) {
    len += Math.hypot(points[i].east - points[i - 1].east, points[i].north - points[i - 1].north);
  }
  return len;
}

${trajectory}

global.Trajectory = { buildReferenceTrajectory };

${temporalProjection}

${fusionBins}

${laneAudit}

${coverageAccounting}

${drawablePath}

${preservation}

${sdFusion}

${visibleGap}

${cleanup}

global.SdFusion = {
  collectLaneObservations,
  fuseLaneTrackSdFragments,
  canBridgeTrackerContinuousFusionGap,
  trackerContinuityBridgeEligibility,
  DEFAULT_TRACKER_CONTINUITY_BRIDGE,
};

global.LaneMapCleanup = {
  DEFAULT_OPTS,
  buildCleanedLaneMap,
  buildTrackedPolylines,
  computeLaneChecksum,
  computeCoordinateChecksum,
  filterRoadSurfaceForCleanedLanes,
  physicalBoundaryColorIndex,
  trackSdStats,
  removeLateralSpikes,
  trimUnsupportedEndpoints,
  segmentCrosses,
  maxSdLateralJump,
  evaluateFragment,
  enrichFragmentFromFrames,
  PROVENANCE_TYPE,
  SEGMENT2_D12_GAPS,
  preserveSourcePolylinesForGaps,
  extendPartialTailPreservation,
  auditPartialTails,
  analyzeDrawablePaths,
  computeCoverageAccounting,
};
})(typeof window !== 'undefined' ? window : global);
`;

fs.writeFileSync(path.join(ROOT, 'public/lane_map_cleanup.js'), browser);
console.log('bundled public/lane_map_cleanup.js', browser.length, 'bytes');
