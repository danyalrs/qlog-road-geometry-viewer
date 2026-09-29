'use strict';
(function (global) {
  const REVIEW_PRESET = {
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
  };
  const EVIDENCE_PRESET = {
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
  };
  const MODE_DESCRIPTIONS = {
    review: 'Clean lane result',
    evidence: 'Result with supporting observations',
    debug: 'All technical controls',
  };
  function presetForUiMode(mode) {
    if (mode === 'evidence') return { ...EVIDENCE_PRESET };
    if (mode === 'review') return { ...REVIEW_PRESET };
    return null;
  }
  global.UiModePresets = {
    REVIEW_PRESET,
    EVIDENCE_PRESET,
    MODE_DESCRIPTIONS,
    presetForUiMode,
  };
})(typeof window !== 'undefined' ? window : global);
