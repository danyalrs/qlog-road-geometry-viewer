'use strict';

/** Visible Local playback geometry modes (hidden modes remain in segment_local_map). */
const LOCAL_GEOMETRY_VISIBLE_MODES = Object.freeze(['observations', 'fused', 'pointAccumulated']);
const LOCAL_GEOMETRY_DEFAULT_MODE = 'pointAccumulated';
const LOCAL_GEOMETRY_STORAGE_KEY = 'qlogLocalGeometryMode';
const LOCAL_GEOMETRY_SESSION_KEY = 'qlogLocalGeometryModeSession';
const VIZ_MODE_DEFAULT = 'local';
const VIZ_MODE_SESSION_KEY = 'qlogVizModeSession';
const VIZ_MODE_VISIBLE = Object.freeze(['global', 'vehicle', 'local']);
const CONNECTED_ACCUMULATED_DEFAULT_ENABLED = true;
const CONNECTED_ACCUMULATED_DEFAULT_MODE = 'perFrame';
const CONNECTED_ACCUMULATED_SESSION_ENABLED_KEY = 'qlogConnectedAccumulatedEnabledSession';
const CONNECTED_ACCUMULATED_SESSION_MODE_KEY = 'qlogConnectedAccumulatedModeSession';
const CONNECTED_ACCUMULATED_MODES = Object.freeze([
  'currentFrame',
  'perFrame',
]);

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

function isVisibleVizMode(value) {
  return value === 'global' || value === 'vehicle' || value === 'local';
}

function normalizeVizModeSelection(value) {
  if (isVisibleVizMode(value)) return value;
  return VIZ_MODE_DEFAULT;
}

/**
 * Resolve initial local geometry for a page load.
 * Priority: explicit URL → session choice → HTML/default (pointAccumulated).
 * Does not resurrect a stale cross-session localStorage fused preference when
 * session is empty; URL/session/default own the initial selection.
 */
function resolveInitialLocalGeometryMode(search, sessionValue, htmlValue) {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const fromUrl = params?.get?.('geometry') || params?.get?.('localGeometry') || null;
  if (isVisibleLocalGeometryMode(fromUrl)) return fromUrl;
  if (isVisibleLocalGeometryMode(sessionValue)) return sessionValue;
  return normalizeLocalGeometrySelection(htmlValue ?? LOCAL_GEOMETRY_DEFAULT_MODE);
}

/**
 * Resolve initial visualization mode.
 * Priority: explicit URL (`viz`, or `local=1`) → session → HTML/default (local).
 */
function resolveInitialVizMode(search, sessionValue, htmlValue) {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const viz = params?.get?.('viz') || params?.get?.('vizMode') || null;
  if (isVisibleVizMode(viz)) return viz;
  if (params?.get?.('local') === '1') return 'local';
  if (isVisibleVizMode(sessionValue)) return sessionValue;
  return normalizeVizModeSelection(htmlValue ?? VIZ_MODE_DEFAULT);
}

function normalizeConnectedAccumulatedMode(value) {
  if (CONNECTED_ACCUMULATED_MODES.includes(value)) return value;
  return CONNECTED_ACCUMULATED_DEFAULT_MODE;
}

function resolveInitialConnectedAccumulatedEnabled(search, sessionValue, htmlChecked) {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const raw = params?.get?.('connected') ?? params?.get?.('connectedAccumulated');
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  if (sessionValue === '1' || sessionValue === true) return true;
  if (sessionValue === '0' || sessionValue === false) return false;
  if (typeof htmlChecked === 'boolean') return htmlChecked;
  return CONNECTED_ACCUMULATED_DEFAULT_ENABLED;
}

function resolveInitialConnectedAccumulatedMode(search, sessionValue, htmlValue) {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const fromUrl = params?.get?.('connectedMode') || params?.get?.('connectedAccumulatedMode') || null;
  if (fromUrl) return normalizeConnectedAccumulatedMode(fromUrl);
  if (sessionValue) return normalizeConnectedAccumulatedMode(sessionValue);
  return normalizeConnectedAccumulatedMode(htmlValue ?? CONNECTED_ACCUMULATED_DEFAULT_MODE);
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
  LOCAL_GEOMETRY_SESSION_KEY,
  VIZ_MODE_DEFAULT,
  VIZ_MODE_SESSION_KEY,
  VIZ_MODE_VISIBLE,
  CONNECTED_ACCUMULATED_DEFAULT_ENABLED,
  CONNECTED_ACCUMULATED_DEFAULT_MODE,
  CONNECTED_ACCUMULATED_SESSION_ENABLED_KEY,
  CONNECTED_ACCUMULATED_SESSION_MODE_KEY,
  CONNECTED_ACCUMULATED_MODES,
  HIDDEN_GEOMETRY_SOURCES,
  isVisibleLocalGeometryMode,
  normalizeLocalGeometrySelection,
  isVisibleVizMode,
  normalizeVizModeSelection,
  resolveInitialLocalGeometryMode,
  resolveInitialVizMode,
  normalizeConnectedAccumulatedMode,
  resolveInitialConnectedAccumulatedEnabled,
  resolveInitialConnectedAccumulatedMode,
  localGeometryDropdownOptions,
};
