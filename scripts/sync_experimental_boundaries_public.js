'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../lib/experimental_boundaries.js'), 'utf8');
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
  : ['buildExperimentalBoundaries'];

const exportBlock = `window.ExperimentalBoundaries = {\n${exportNames.map((n) => `  ${n},`).join('\n')}\n};`;

const out = `'use strict';

/**
 * Browser mirror of lib/experimental_boundaries.js.
 * Regenerate with: node scripts/sync_experimental_boundaries_public.js
 */

${body}
${exportBlock}
`;

fs.writeFileSync(path.join(__dirname, '../public/experimental_boundaries.js'), out);
console.log('synced public/experimental_boundaries.js', out.length, 'bytes');
