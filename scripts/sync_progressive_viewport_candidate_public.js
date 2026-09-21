#!/usr/bin/env node
'use strict';

const fs = require('fs');

let c = fs.readFileSync('lib/progressive_viewport_candidate.js', 'utf8');
c = c.replace(/^'use strict';\n\nconst PCP = require\('\.\/progressive_combined_playback'\);\n\n/, "'use strict';\n\n");
c = c.replace(
  /const PCP = require\('\.\/progressive_combined_playback'\);\n/g,
  "const PCP = (typeof require !== 'undefined') ? require('./progressive_combined_playback') : global.ProgressiveCombinedPlayback;\n",
);
c = c.replace('module.exports = {', 'const api = {');
const out = `'use strict';
(function (global) {
const PCP = global.ProgressiveCombinedPlayback;
${c}
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.ProgressiveViewportCandidate = api;
})(typeof window !== 'undefined' ? window : global);
`;
fs.writeFileSync('public/progressive_viewport_candidate.js', out);
