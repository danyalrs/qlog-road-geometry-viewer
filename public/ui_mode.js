'use strict';
(function (global) {
  const UI_MODE_VALUES = ['review', 'evidence', 'debug'];
  const MAP_BACKGROUND_VALUES = ['grey', 'street', 'satellite'];

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

  function parseMapBackground(search, options) {
    const streetAvailable = options?.streetAvailable !== false;
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

  function resolveDefaultMapBackground(streetAvailable) {
    return streetAvailable ? 'street' : 'grey';
  }

  global.UiMode = {
    UI_MODE_VALUES,
    MAP_BACKGROUND_VALUES,
    parseUiMode,
    parseMapBackground,
    resolveDefaultMapBackground,
  };
})(typeof window !== 'undefined' ? window : global);
