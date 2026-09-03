#!/usr/bin/env node
'use strict';

const fs = require('fs');

let c = fs.readFileSync('lib/boundary_bridge_playback.js', 'utf8');
c = c.replace(/^'use strict';\n\n\/\*\*[\s\S]*?\*\/\n\n/, '');
c = c.replace('module.exports = {', 'const api = {');
const out = `'use strict';
(function (global) {
${c}
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.BoundaryBridgePlayback = api;
})(typeof window !== 'undefined' ? window : global);
`;
fs.writeFileSync('public/boundary_bridge_playback.js', out);
