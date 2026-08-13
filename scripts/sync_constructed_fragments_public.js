'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../lib/constructed_fragments.js'), 'utf8');
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
  : ['buildConstructedFragments'];

const exportBlock = `window.ConstructedFragments = {\n${exportNames.map((n) => `  ${n},`).join('\n')}\n};`;

const out = `'use strict';

/**
 * Browser mirror of lib/constructed_fragments.js.
 * Regenerate with: node scripts/sync_constructed_fragments_public.js
 */

(function initConstructedFragments(global) {
${body
  .split('\n')
  .map((l) => (l ? `  ${l}` : l))
  .join('\n')}
  ${exportBlock.replace(/window\.ConstructedFragments/, 'global.ConstructedFragments')}
}(typeof window !== 'undefined' ? window : globalThis));
`;

fs.writeFileSync(path.join(__dirname, '../public/constructed_fragments.js'), out);
console.log('synced public/constructed_fragments.js', out.length, 'bytes');
