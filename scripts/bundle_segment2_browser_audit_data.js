'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function main() {
  const classDGaps = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json'), 'utf8',
  )).gaps;
  const separations = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'audit_segment2_cleaned_runs.json'), 'utf8',
  )).separations;

  const out = `'use strict';
(function initSegment2BrowserAuditData(global) {
  global.Segment2BrowserAuditData = {
    classDGaps: ${JSON.stringify(classDGaps)},
    separations: ${JSON.stringify(separations)},
  };
})(typeof window !== 'undefined' ? window : globalThis);
`;

  fs.writeFileSync(path.join(ROOT, 'public/segment2_browser_audit_data.js'), out);
  console.log('bundled public/segment2_browser_audit_data.js', out.length, 'bytes');
}

main();
