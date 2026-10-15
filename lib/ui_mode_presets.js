'use strict';

/**
 * Layer checkbox presets for supervisor UI modes.
 * Values are DOM control ids → desired checked state or select value.
 */

const REVIEW_PRESET = Object.freeze({
  layerFusedLanes: false,
  layerConnectedAccumulated: false,
  layerRepresentativeLaneLines: true,
  layerRoadSurface: true,
  layerRawFrame: false,
  layerRawLanes: false,
  layerConstructedFragments: false,
  layerJoinedPolylines: false,
  layerFittedPolylines: false,
  layerUnconfirmedCandidates: false,
  connectedAccumulatedMode: 'perFrame',
});

const EVIDENCE_PRESET = Object.freeze({
  layerFusedLanes: true,
  layerConnectedAccumulated: true,
  layerRepresentativeLaneLines: true,
  layerRoadSurface: true,
  layerRawFrame: false,
  layerRawLanes: false,
  layerConstructedFragments: false,
  layerJoinedPolylines: false,
  layerFittedPolylines: false,
  layerUnconfirmedCandidates: false,
  connectedAccumulatedMode: 'perFrame',
});

const MODE_DESCRIPTIONS = Object.freeze({
  review: 'Simplified view — lane lines and road surface only',
  evidence: 'Same result plus observation dots and source curves',
  debug: 'Full controls for engineers (layers, exports, diagnostics)',
});

function presetForUiMode(mode) {
  if (mode === 'evidence') return { ...EVIDENCE_PRESET };
  if (mode === 'review') return { ...REVIEW_PRESET };
  return null;
}

function layersDifferBetweenReviewAndEvidence() {
  const keys = Object.keys(REVIEW_PRESET);
  return keys.some((k) => REVIEW_PRESET[k] !== EVIDENCE_PRESET[k]);
}

module.exports = {
  REVIEW_PRESET,
  EVIDENCE_PRESET,
  MODE_DESCRIPTIONS,
  presetForUiMode,
  layersDifferBetweenReviewAndEvidence,
};
