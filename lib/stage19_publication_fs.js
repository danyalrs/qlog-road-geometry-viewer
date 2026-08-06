'use strict';

const fs = require('fs');

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

function isTransientFsError(err) {
  return err && TRANSIENT_RENAME_CODES.has(err.code);
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function retryFsOperation(label, fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 8;
  const baseDelayMs = options.baseDelayMs ?? 30;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientFsError(err)) throw err;
      lastErr = err;
      if (attempt < maxAttempts) await sleep(baseDelayMs * attempt);
    }
  }
  const wrapped = new Error(`${label}_transient_fs_exhausted:${lastErr.code}`);
  wrapped.cause = lastErr;
  throw wrapped;
}

async function removeDirectoryRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  await fs.promises.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
}

module.exports = {
  TRANSIENT_RENAME_CODES,
  isTransientFsError,
  retryFsOperation,
  removeDirectoryRecursive,
};
