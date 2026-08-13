'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../lib/lane_joining.js'), 'utf8');
const body = src
  .replace(/^'use strict';\s*/m, '')
  .replace(/const DEFAULTS = require\('\.\/constructed_fragments'\)\.DEFAULTS;[\s\S]*?\n\n/m, '')
  .replace(/module\.exports = \{[\s\S]*?\n\};[\s\S]*$/, '')
  .replace(/if \(typeof window[\s\S]*?\}\s*$/m, '');

const exportsMatch = src.match(/module\.exports = \{([\s\S]*?)\n\};/);
const exportNames = exportsMatch
  ? exportsMatch[1]
    .split(',')
    .map((line) => line.trim())
    .filter((line) => line && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(line))
  : ['joinConstructedFragments'];

const exportBlock = `global.LaneJoining = {\n${exportNames.map((n) => `  ${n},`).join('\n')}\n};`;

const out = `'use strict';

/**
 * Browser mirror of lib/lane_joining.js.
 * Regenerate with: node scripts/sync_lane_joining_public.js
 */

(function initLaneJoining(global) {
  const DEFAULTS = global.ConstructedFragments ? global.ConstructedFragments.DEFAULTS : {};
${body
  .split('\n')
  .map((l) => (l ? `  ${l}` : l))
  .join('\n')}
  ${exportBlock}
}(typeof window !== 'undefined' ? window : globalThis));
`;

fs.writeFileSync(path.join(__dirname, '../public/lane_joining.js'), out);
console.log('synced public/lane_joining.js', out.length, 'bytes');
