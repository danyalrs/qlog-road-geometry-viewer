'use strict';
const fs = require('fs');
const path = require('path');
let body = fs.readFileSync(path.join(__dirname, '../lib/point_accumulated_lane_polylines.js'), 'utf8');
body = body.replace(/^'use strict';\r?\n/, '');
body = body.replace(/\r?\nconst api = \{[\s\S]*$/, '');
const out = `'use strict';
(function (global) {
${body}
const PointAccumulatedLanePolylinesApi = {
  QUERY_PARAM,
  DEFAULTS,
  parsePointAccumulatedLanePolylineCandidate,
  identityKey,
  groupPoints,
  orderAndDedupe,
  shouldSplit,
  buildPointAccumulatedLanePolylines,
  emptyDiagnostics,
  auditPolylineSet,
};
if (typeof module !== 'undefined' && module.exports) module.exports = PointAccumulatedLanePolylinesApi;
global.PointAccumulatedLanePolylines = PointAccumulatedLanePolylinesApi;
})(typeof window !== 'undefined' ? window : global);
`;
fs.writeFileSync(path.join(__dirname, '../public/point_accumulated_lane_polylines.js'), out);
console.log('wrote public/point_accumulated_lane_polylines.js', out.length);
