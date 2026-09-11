'use strict';
const fs = require('fs');
const path = require('path');
let body = fs.readFileSync(path.join(__dirname, '../lib/combined_visible_lane_projection.js'), 'utf8');
body = body.replace(/^'use strict';\r?\n/, '');
body = body.replace(/\r?\nconst api = \{[\s\S]*$/, '');
const out = `'use strict';
(function (global) {
${body}
const CombinedVisibleLaneProjectionApi = {
  QUERY_PARAM,
  APPROVED_LAYER_KINDS,
  parseCombinedVisibleLaneProjectionCandidate,
  isCandidateEligible,
  projectCombinedSourceLanePoint,
  resetDrawDiagnostics,
  getBrowserDiagnostics,
  emptyDiagnostics,
  noteLaneFragmentPass,
  markCandidateActiveOnMap,
  resolveCanonicalCoords,
  standaloneDisplay,
  rotatePlacementOffset,
  findTrajectoryAnchorPair,
  resolveSourceFileForPoint,
};
if (typeof module !== 'undefined' && module.exports) module.exports = CombinedVisibleLaneProjectionApi;
global.CombinedVisibleLaneProjection = CombinedVisibleLaneProjectionApi;
})(typeof window !== 'undefined' ? window : global);
`;
fs.writeFileSync(path.join(__dirname, '../public/combined_visible_lane_projection.js'), out);
console.log('wrote public/combined_visible_lane_projection.js', out.length);
