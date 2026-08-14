'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../lib/graph_fit.js'), 'utf8');
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
  : ['fitConstructedRuns', 'fitRun'];

const exportBlock = `window.GraphFit = {\n${exportNames.map((n) => `  ${n},`).join('\n')}\n};`;

const out = `'use strict';

/**
 * Browser mirror of lib/graph_fit.js.
 * Regenerate with: node scripts/sync_graph_fit_public.js
 */

(function initGraphFit(global) {
${body
  .split('\n')
  .map((l) => (l ? `  ${l}` : l))
  .join('\n')}
  ${exportBlock.replace(/window\.GraphFit/, 'global.GraphFit')}
}(typeof window !== 'undefined' ? window : globalThis));
`;

fs.writeFileSync(path.join(__dirname, '../public/graph_fit.js'), out);
console.log('synced public/graph_fit.js', out.length, 'bytes');
