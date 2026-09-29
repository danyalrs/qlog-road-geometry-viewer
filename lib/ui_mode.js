'use strict';

const UI_MODE_VALUES = Object.freeze(['review', 'evidence', 'debug']);
const MAP_BACKGROUND_VALUES = Object.freeze(['grey', 'street', 'satellite']);

function parseUiMode(search) {
  const raw = typeof search === 'string' ? search : '';
  const query = raw.startsWith('?') ? raw.slice(1) : raw;
  const params = new URLSearchParams(query);
  const first = params.getAll('uiMode')[0];
  if (!first) return 'review';
  const v = String(first).toLowerCase();
  if (UI_MODE_VALUES.includes(v)) return v;
  return 'review';
}

function parseMapBackground(search, { streetAvailable = true } = {}) {
  const raw = typeof search === 'string' ? search : '';
  const query = raw.startsWith('?') ? raw.slice(1) : raw;
  const params = new URLSearchParams(query);
  const first = params.getAll('mapBackground')[0];
  const fallback = streetAvailable ? 'street' : 'grey';
  if (!first) return fallback;
  const v = String(first).toLowerCase();
  if (MAP_BACKGROUND_VALUES.includes(v)) return v;
  return fallback;
}

function resolveDefaultMapBackground(streetAvailable = true) {
  return streetAvailable ? 'street' : 'grey';
}

module.exports = {
  UI_MODE_VALUES,
  MAP_BACKGROUND_VALUES,
  parseUiMode,
  parseMapBackground,
  resolveDefaultMapBackground,
};
