'use strict';

const fs = require('fs');

function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
  const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
  let start = startStr ? parseInt(startStr, 10) : NaN;
  let end = endStr ? parseInt(endStr, 10) : NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else if (Number.isNaN(end)) {
    end = fileSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
    return null;
  }
  end = Math.min(end, fileSize - 1);
  return { start, end };
}

function serveFileWithRanges(req, res, filePath, contentType = 'video/mp4') {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const rawRange = req.headers.range;
  const range = parseRangeHeader(rawRange, fileSize);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');

  // A present-but-unsatisfiable Range (start >= size, reversed, non-bytes, or
  // zero-length suffix) must be answered with 416, not a 200 full-body reply.
  if (rawRange != null && !range) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    res.setHeader('Content-Length', '0');
    res.end();
    return;
  }

  if (!range) {
    res.setHeader('Content-Length', fileSize);
    res.status(200);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const { start, end } = range;
  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.setHeader('Content-Length', chunkSize);
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

module.exports = {
  parseRangeHeader,
  serveFileWithRanges,
};
