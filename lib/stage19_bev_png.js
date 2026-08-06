'use strict';

const crypto = require('crypto');
const sharp = require('sharp');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CONVERSION_TOOL = 'sharp';
let conversionToolVersion = null;

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isPngSignature(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

async function decodePngMetadata(pngBytes) {
  if (!isPngSignature(pngBytes)) throw new Error('invalid_png_signature');
  const meta = await sharp(pngBytes).metadata();
  if (!meta.width || !meta.height) throw new Error('invalid_png_dimensions');
  return { widthPx: meta.width, heightPx: meta.height, format: meta.format };
}

async function convertSvgToPng(svgBytes, options = {}) {
  if (!svgBytes || svgBytes.length === 0) throw new Error('empty_svg_input');
  if (!conversionToolVersion) {
    conversionToolVersion = sharp.versions?.sharp || 'unknown';
  }
  const pngBytes = await sharp(svgBytes, { density: options.density || 96 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  if (!isPngSignature(pngBytes)) throw new Error('png_conversion_failed');
  const dims = await decodePngMetadata(pngBytes);
  if (dims.format !== 'png') throw new Error('png_decode_format_mismatch');
  return {
    pngBytes,
    widthPx: dims.widthPx,
    heightPx: dims.heightPx,
    sha256: sha256Bytes(pngBytes),
    bytes: pngBytes.length,
    provenance: {
      conversionTool: CONVERSION_TOOL,
      conversionToolVersion,
      sourceFormat: 'image/svg+xml',
      outputFormat: 'image/png',
      density: options.density || 96,
    },
  };
}

module.exports = {
  PNG_SIGNATURE,
  sha256Bytes,
  isPngSignature,
  decodePngMetadata,
  convertSvgToPng,
  CONVERSION_TOOL,
};
