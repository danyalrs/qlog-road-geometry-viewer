'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../lib/point_accumulation.js'), 'utf8');
const body = src
  .replace(/^'use strict';\s*/m, '')
  .replace(/module\.exports = \{[\s\S]*?\n\};[\s\S]*$/, '')
  .replace(/if \(typeof window[\s\S]*?\}\s*$/m, '');

// Derive the browser export list from the lib module.exports block so the
// mirror can never drift from the Node API.
const exportsMatch = src.match(/module\.exports = \{([\s\S]*?)\n\};/);
const exportNames = exportsMatch
  ? exportsMatch[1]
    .split(',')
    .map((line) => line.trim())
    .filter((line) => line && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(line))
  : ['POINT_ACCUMULATION_DEFAULTS'];

const exportBlock = `window.PointAccumulation = {\n${exportNames.map((n) => `  ${n},`).join('\n')}\n};`;

const out = `'use strict';

/**
 * Browser mirror of lib/point_accumulation.js.
 * Regenerate with: node scripts/sync_point_accumulation_public.js
 */

${body}
${exportBlock}
`;

fs.writeFileSync(path.join(__dirname, '../public/point_accumulation.js'), out);
console.log('synced public/point_accumulation.js', out.length, 'bytes');
