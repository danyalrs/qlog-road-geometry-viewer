/**
 * Tolerant loader for optional legacy JSON extracts (modelV2_extracted.json, etc.).
 * Malformed files are reported and ignored — live SHA-keyed .bz2 extracts remain authoritative.
 */
const fs = require('fs');
const path = require('path');

/**
 * @returns {{ data: object|null, status: 'missing'|'ok'|'malformed', path: string, error?: string }}
 */
function loadJsonExtract(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { data: null, status: 'missing', path: resolved };
  }
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const data = JSON.parse(raw);
    return { data, status: 'ok', path: resolved };
  } catch (err) {
    return {
      data: null,
      status: 'malformed',
      path: resolved,
      error: err.message,
    };
  }
}

module.exports = { loadJsonExtract };
