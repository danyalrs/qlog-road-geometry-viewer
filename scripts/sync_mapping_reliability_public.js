'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../lib/mapping_reliability.js'), 'utf8');
const body = src
  .replace(/^'use strict';\s*/m, '')
  .replace(/module\.exports = \{[\s\S]*?\n\};[\s\S]*$/, '')
  .replace(/if \(typeof window[\s\S]*?\}\s*$/m, '');

const exportsMatch = src.match(/module\.exports = \{([\s\S]*?)\n\};/);
const exportNames = exportsMatch
  ? exportsMatch[1]
    .split(',')
    .map((line) => line.trim())
    .filter((line) => line && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(line))
  : ['computeReliability'];

const exportBlock = `window.MappingReliability = {\n${exportNames.map((n) => `  ${n},`).join('\n')}\n};`;

const out = `'use strict';

/**
 * Browser mirror of lib/mapping_reliability.js.
 * Regenerate with: node scripts/sync_mapping_reliability_public.js
 */

${body}
${exportBlock}
`;

fs.writeFileSync(path.join(__dirname, '../public/mapping_reliability.js'), out);
console.log('synced public/mapping_reliability.js', out.length, 'bytes');
