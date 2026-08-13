'use strict';

/** Visible Local playback geometry modes (hidden modes remain in segment_local_map). */
const LOCAL_GEOMETRY_VISIBLE_MODES = Object.freeze(['observations', 'fused', 'pointAccumulated']);
const LOCAL_GEOMETRY_DEFAULT_MODE = 'fused';
const LOCAL_GEOMETRY_STORAGE_KEY = 'qlogLocalGeometryMode';

const HIDDEN_GEOMETRY_SOURCES = Object.freeze([
  'tracked',
  'rejected',
  'cleaned',
  'cleanedWithSurface',
  'cleanedWithStage1Surface',
  'cleanedDebug',
  'diagnostic',
]);

function isVisibleLocalGeometryMode(value) {
  return value === 'observations' || value === 'fused' || value === 'pointAccumulated';
}

function normalizeLocalGeometrySelection(value) {
  if (isVisibleLocalGeometryMode(value)) return value;
  return LOCAL_GEOMETRY_DEFAULT_MODE;
}

function localGeometryDropdownOptions() {
  return [
    { value: 'observations', label: 'Raw mapped observations' },
    { value: 'fused', label: 'Fused lane lines' },
    { value: 'pointAccumulated', label: 'Point-accumulated geometry' },
  ];
}

module.exports = {
  LOCAL_GEOMETRY_VISIBLE_MODES,
  LOCAL_GEOMETRY_DEFAULT_MODE,
  LOCAL_GEOMETRY_STORAGE_KEY,
  HIDDEN_GEOMETRY_SOURCES,
  isVisibleLocalGeometryMode,
  normalizeLocalGeometrySelection,
  localGeometryDropdownOptions,
};
