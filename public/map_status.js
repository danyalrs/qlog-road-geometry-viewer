'use strict';
(function (global) {
  const FRIENDLY = {
    configRequestFailed: 'Map config unavailable — restart the viewer server, then reload',
    configInvalid: 'Map configuration invalid — using Grey',
    libraryMissing: 'Map library failed to load — using Grey',
    containerMissing: 'Map container missing — using Grey',
    containerZeroSize: 'Map container has zero size — open Debug diagnostics',
    containerUnavailable: 'Map container unavailable — open Debug diagnostics',
    waitingForLayout: 'Waiting for map layout…',
    noGeographicOrigin: 'Geographic origin not ready yet',
    noGeographicPoints: 'No geographic route points converted',
    conversionFailed: 'Geographic conversion failed',
    mapInitFailed: 'Map initialization failed — using Grey',
    styleLoadFailed: 'Map style failed to load — using Grey',
    tileRequestFailed: 'Street tiles unavailable — using Grey',
    networkBlocked: 'Street tiles unavailable (network) — using Grey',
    webglUnavailable: 'WebGL unavailable — using Grey',
    mapReady: 'Map ready',
    mapReadyPending: 'Loading map tiles…',
    mapReadyGrey: 'Grey',
    loading: 'Loading street map…',
  };
  function friendlyStatus(code, extra) {
    const base = FRIENDLY[code] || 'Map unavailable — using Grey';
    if (!extra) return base;
    return `${base} (${extra})`;
  }
  global.MapStatus = { FRIENDLY, friendlyStatus };
})(typeof window !== 'undefined' ? window : global);
