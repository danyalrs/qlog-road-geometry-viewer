'use strict';

const path = require('path');

const MAX_DECODE_PASSES = 2;

function safeDecodeURIComponent(input) {
  try {
    return decodeURIComponent(String(input).replace(/\+/g, ' '));
  } catch {
    throw new Error('malformed_path_encoding');
  }
}

function boundedDecode(input) {
  let cur = String(input);
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    if (!/%(?:[0-9a-fA-F]{2}|$)/.test(cur)) break;
    const next = safeDecodeURIComponent(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function containsNullByte(s) {
  return s.includes('\0') || /%00/i.test(s);
}

function rejectAbsoluteOrSpecialRoots(s) {
  if (path.isAbsolute(s)) throw new Error('path_traversal');
  if (/^[a-zA-Z]:[\\/]/.test(s) || /^[a-zA-Z]:$/.test(s)) throw new Error('path_traversal');
  if (/^[\\/]{2,}/.test(s)) throw new Error('path_traversal');
  if (/^\\\\/.test(s)) throw new Error('path_traversal');
  if (s.startsWith('/etc/') || s.startsWith('/etc')) throw new Error('path_traversal');
}

function hasInvalidPercentEncoding(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '%') continue;
    const hex = s.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return true;
  }
  return false;
}

function validateSafePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('path_traversal');
  if (containsNullByte(rel)) throw new Error('path_traversal');
  if (hasInvalidPercentEncoding(rel)) throw new Error('malformed_path_encoding');

  const decoded = boundedDecode(rel);
  if (containsNullByte(decoded)) throw new Error('path_traversal');

  const unified = decoded.replace(/\\/g, '/');
  rejectAbsoluteOrSpecialRoots(unified);

  const norm = path.posix.normalize(unified);
  if (norm === '..' || norm.startsWith('../') || path.posix.isAbsolute(norm)) {
    throw new Error('path_traversal');
  }
  if (norm.split('/').some((seg) => seg === '..')) throw new Error('path_traversal');

  return norm;
}

function resolveBundlePath(publicationRoot, runId, relPath) {
  const norm = validateSafePath(relPath);
  if (typeof runId !== 'string' || !runId.length || runId.includes('..') || runId.includes('/') || runId.includes('\\')) {
    throw new Error('path_traversal');
  }
  const base = path.resolve(publicationRoot, 'runs', runId);
  const resolved = path.resolve(base, ...norm.split('/'));
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  if (resolved !== base && !resolved.startsWith(prefix)) throw new Error('path_traversal');
  return resolved;
}

module.exports = {
  validateSafePath,
  resolveBundlePath,
  boundedDecode,
  safeDecodeURIComponent,
  MAX_DECODE_PASSES,
};
