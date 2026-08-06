'use strict';

const fs = require('fs');
const path = require('path');

const lib = fs.readFileSync(path.join(__dirname, '../lib/segment_local_map.js'), 'utf8');
let body = lib
  .replace(/^'use strict';\s*/m, '')
  .replace(/const LP =[\s\S]*?MIN_HEADING_DISPLACEMENT_M = LP\.MIN_HEADING_DISPLACEMENT_M;\s*/m, '')
  .replace(/const LMC =[\s\S]*?;\s*/m, '')
  .replace(/if \(typeof module[\s\S]*$/m, '')
  .replace(/if \(typeof window[\s\S]*?\}\s*$/m, '')
  .replace(
    /const RSS = typeof require[\s\S]*?;\r?\n/,
    'const RSS = global.RoadSurfaceStage1;\n',
  )
  .replace(/function loadD12ClassGaps\(\) \{[\s\S]*?\}\r?\n\r?\nfunction loadAllClassDGaps/, `function loadD12ClassGaps() {
  if (global.Segment2BrowserAuditData?.classDGaps) {
    return global.Segment2BrowserAuditData.classDGaps.filter((g) => g.primaryMechanism === 'D12');
  }
  return null;
}

function loadAllClassDGaps`)
  .replace(/function loadAllClassDGaps\(\) \{[\s\S]*?\}\r?\n\r?\nfunction loadSegment2Separations/, `function loadAllClassDGaps() {
  return global.Segment2BrowserAuditData?.classDGaps || [];
}

function loadSegment2Separations`)
  .replace(/function loadSegment2Separations\(\) \{[\s\S]*?\}\r?\n\r?\nfunction buildCleanupFragments/, `function loadSegment2Separations() {
  return global.Segment2BrowserAuditData?.separations || [];
}

function buildCleanupFragments`);

const out = `'use strict';

(function initSegmentLocalMap(global) {
  const LP = global.LocalPlayback;
  const LMC = global.LaneMapCleanup;
  if (!LP) {
    console.error('SegmentLocalMap: LocalPlayback not loaded');
    return;
  }
  const globalToVehicleDisplay = (...args) => LP.globalToVehicleDisplay(...args);
  const interpolateTimedPath = (...args) => LP.interpolateTimedPath(...args);
  const MIN_HEADING_DISPLACEMENT_M = LP.MIN_HEADING_DISPLACEMENT_M;
${body}
  global.SegmentLocalMap = api;
}(typeof window !== 'undefined' ? window : globalThis));
`;

fs.writeFileSync(path.join(__dirname, '../public/segment_local_map.js'), out);
console.log('synced public/segment_local_map.js', out.length, 'bytes');
