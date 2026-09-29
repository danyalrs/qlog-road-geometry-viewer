'use strict';
(function (global) {
  const GP = () => global.GeographicProjection;
  const MS = () => global.MapStatus;

  function createGeographicMap(options = {}) {
    const container = options.container;
    const stage = options.stage || container?.parentElement;
    const rootStage = options.rootStage || stage?.parentElement;
    const canvas = options.canvas;
    const onRedraw = options.onRedraw || (() => {});
    let map = null;
    let mode = 'grey';
    let requestedMode = 'grey';
    let mapConfig = null;
    let origin = null;
    let referencePose = null;
    let fallbackReason = 'mapReadyGrey';
    let statusDetail = '';
    let tileErrorCount = 0;
    let styleLoaded = false;
    let mapCreated = false;
    let geographicPointStats = { total: 0, converted: 0 };
    let resizeObserver = null;
    let layoutWaitActive = false;

    function friendly(code, extra) {
      return MS()?.friendlyStatus?.(code, extra) || statusDetail;
    }

    function measureLayout() {
      const stageRect = stage?.getBoundingClientRect?.();
      const mapRect = container?.getBoundingClientRect?.();
      const canvasRect = canvas?.getBoundingClientRect?.();
      return {
        stageWidth: stageRect ? Math.round(stageRect.width) : 0,
        stageHeight: stageRect ? Math.round(stageRect.height) : 0,
        mapWidth: mapRect ? Math.round(mapRect.width) : 0,
        mapHeight: mapRect ? Math.round(mapRect.height) : 0,
        canvasWidth: canvasRect ? Math.round(canvasRect.width) : 0,
        canvasHeight: canvasRect ? Math.round(canvasRect.height) : 0,
      };
    }

    function emitStatus(code, extra = '') {
      fallbackReason = code;
      statusDetail = friendly(code, extra);
      options.onStatus?.(code, statusDetail);
      const layout = measureLayout();
      if (global.console && typeof global.console.debug === 'function') {
        global.console.debug('[map-diagnostic]', {
          requestedBackground: requestedMode,
          activeBackground: mode,
          fallbackReason: code,
          configLoaded: !!mapConfig,
          maplibreLoaded: !!global.maplibregl,
          mapCreated,
          styleLoaded,
          tileErrors: tileErrorCount,
          geographicPoints: geographicPointStats,
          resizeObserverActive: layoutWaitActive,
          ...layout,
        });
      }
    }

    function isActive() {
      return mode === 'street' || mode === 'satellite';
    }

    function disconnectLayoutObserver() {
      resizeObserver?.disconnect();
      resizeObserver = null;
      layoutWaitActive = false;
    }

    function applyStagePresentation() {
      if (rootStage) {
        rootStage.classList.remove('map-background-grey', 'map-background-street', 'map-background-satellite');
        const cls = mode === 'street' || mode === 'satellite' ? mode : 'grey';
        rootStage.classList.add(`map-background-${cls}`);
      }
      if (canvas) {
        canvas.style.background = isActive() ? 'transparent' : '';
      }
    }

    function destroyMap() {
      if (map) {
        map.remove();
        map = null;
      }
      mapCreated = false;
      styleLoaded = false;
      tileErrorCount = 0;
    }

    async function loadConfig() {
      const res = await fetch('/api/map-config', { cache: 'no-store' });
      if (!res.ok) {
        const err = new Error('configRequestFailed');
        err.httpStatus = res.status;
        throw err;
      }
      mapConfig = await res.json();
      if (!mapConfig?.street) {
        throw new Error('configInvalid');
      }
      return mapConfig;
    }

    function ensureMapLibre() {
      if (!global.maplibregl) {
        throw new Error('libraryMissing');
      }
    }

    function hasPositiveMapSize() {
      const { mapWidth, mapHeight } = measureLayout();
      return mapWidth >= 2 && mapHeight >= 2;
    }

    function waitForLayout() {
      applyStagePresentation();
      if (hasPositiveMapSize()) return Promise.resolve(true);
      if (!container && !stage) {
        emitStatus('containerMissing');
        return Promise.resolve(false);
      }
      emitStatus('waitingForLayout');
      layoutWaitActive = true;
      return new Promise((resolve) => {
        const finish = (ok) => {
          disconnectLayoutObserver();
          resolve(ok);
        };
        const tryResolve = () => {
          if (hasPositiveMapSize()) {
            finish(true);
            return true;
          }
          return false;
        };
        if (tryResolve()) return;
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver?.disconnect();
          resizeObserver = new ResizeObserver(() => {
            tryResolve();
          });
          if (stage) resizeObserver.observe(stage);
          if (container && container !== stage) resizeObserver.observe(container);
        }
        requestAnimationFrame(() => {
          if (tryResolve()) return;
          requestAnimationFrame(() => {
            if (tryResolve()) return;
            if (!resizeObserver) {
              emitStatus('containerUnavailable');
              finish(false);
            }
          });
        });
      });
    }

    function buildRasterStyle(layerId, tileUrl, attribution, maxZoom) {
      return {
        version: 8,
        sources: {
          [layerId]: {
            type: 'raster',
            tiles: [tileUrl],
            tileSize: 256,
            maxzoom: maxZoom || 19,
            attribution,
          },
        },
        layers: [{ id: layerId, type: 'raster', source: layerId }],
      };
    }

    function attachMapHandlers() {
      if (!map) return;
      map.on('load', () => {
        styleLoaded = true;
        map.resize();
        emitStatus('mapReady');
        applyStagePresentation();
        onRedraw();
      });
      map.on('error', (e) => {
        tileErrorCount += 1;
        const msg = e?.error?.message || e?.message || 'tile';
        if (String(msg).toLowerCase().includes('webgl')) {
          emitStatus('webglUnavailable', msg);
        } else if (e?.sourceId || String(msg).toLowerCase().includes('tile')) {
          emitStatus('tileRequestFailed', `errors=${tileErrorCount}`);
        } else {
          emitStatus('styleLoadFailed', msg);
        }
      });
      const scheduleRedraw = () => onRedraw();
      map.on('move', scheduleRedraw);
      map.on('zoom', scheduleRedraw);
      map.on('resize', scheduleRedraw);
    }

    async function ensureMapInstance(layerCfg) {
      ensureMapLibre();
      if (map) {
        map.resize();
        if (styleLoaded) {
          emitStatus('mapReady');
          onRedraw();
        }
        return;
      }
      emitStatus('loading');
      map = new global.maplibregl.Map({
        container,
        style: buildRasterStyle(`${mode}-raster`, layerCfg.tileUrl, layerCfg.attribution, layerCfg.maxZoom),
        center: [103.8, 1.35],
        zoom: 16,
        pitch: 0,
        bearing: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        attributionControl: true,
      });
      mapCreated = true;
      attachMapHandlers();
      applyStagePresentation();
      requestAnimationFrame(() => map?.resize?.());
    }

    function refreshGeographicPointStats(stationaryMap) {
      const pts = stationaryMap?.trajectory || [];
      let converted = 0;
      const ref = stationaryMap?.referencePose || referencePose;
      for (const t of pts) {
        if (!Number.isFinite(t.localEast) || !Number.isFinite(t.localNorth)) continue;
        const ll = GP()?.canonicalLocalToLngLat(t.localEast, t.localNorth, ref, origin);
        if (Number.isFinite(ll?.longitude) && Number.isFinite(ll?.latitude)) converted += 1;
      }
      geographicPointStats = { total: pts.length, converted };
    }

    async function initStreetOrSatellite({ config } = {}) {
      applyStagePresentation();
      const layoutOk = await waitForLayout();
      if (!layoutOk) return;
      if (!mapConfig) {
        try {
          await loadConfig();
        } catch (err) {
          mode = 'grey';
          const code = err.message === 'configInvalid' ? 'configInvalid' : 'configRequestFailed';
          const extra = err.httpStatus ? `HTTP ${err.httpStatus}` : '';
          emitStatus(code, extra);
          applyStagePresentation();
          onRedraw();
          return;
        }
      }
      const cfg = config || mapConfig;
      const layerCfg = cfg?.[mode];
      if (!layerCfg?.available || !layerCfg.tileUrl) {
        emitStatus('configInvalid', mode === 'satellite' ? 'satelliteUnavailable' : 'streetUnavailable');
        return;
      }
      try {
        await ensureMapInstance(layerCfg);
      } catch (err) {
        mapCreated = false;
        emitStatus('mapInitFailed', err.message || '');
      }
    }

    async function setBackground(nextMode, { config } = {}) {
      requestedMode = nextMode === 'satellite' || nextMode === 'street' ? nextMode : 'grey';
      const want = requestedMode;
      if (want === mode && (want === 'grey' || (map && styleLoaded))) {
        applyStagePresentation();
        return;
      }
      disconnectLayoutObserver();
      mode = want;
      if (mode === 'grey') {
        destroyMap();
        emitStatus('mapReadyGrey');
        applyStagePresentation();
        onRedraw();
        return;
      }
      if (map && styleLoaded && map.getStyle()) {
        applyStagePresentation();
        const layoutOk = await waitForLayout();
        if (layoutOk) {
          map.resize();
          emitStatus('mapReady');
          onRedraw();
        }
        return;
      }
      await initStreetOrSatellite({ config });
    }

    function setGeographicContext({ processOrigin, mapReferencePose, stationaryMap } = {}) {
      origin = processOrigin || null;
      referencePose = mapReferencePose || null;
      if (stationaryMap) refreshGeographicPointStats(stationaryMap);
      if (!origin && isActive()) {
        emitStatus('noGeographicOrigin');
      } else if (stationaryMap && geographicPointStats.converted < 1 && isActive() && styleLoaded) {
        emitStatus('noGeographicPoints');
      }
    }

    function projectCanonicalLocal(localEast, localNorth) {
      if (!isActive() || !map || !styleLoaded) return null;
      const ll = GP()?.canonicalLocalToLngLat(localEast, localNorth, referencePose, origin);
      if (!Number.isFinite(ll.longitude) || !Number.isFinite(ll.latitude)) return null;
      const p = map.project([ll.longitude, ll.latitude]);
      return { x: p.x, y: p.y };
    }

    function projectGlobalEn(east, north) {
      if (!isActive() || !map || !styleLoaded) return null;
      const ll = GP()?.globalEnToLngLat(east, north, origin);
      if (!Number.isFinite(ll.longitude) || !Number.isFinite(ll.latitude)) return null;
      const p = map.project([ll.longitude, ll.latitude]);
      return { x: p.x, y: p.y };
    }

    function collectRouteLngLats(stationaryMap) {
      const pts = stationaryMap?.trajectory || [];
      const out = [];
      const ref = stationaryMap?.referencePose || referencePose;
      for (const t of pts) {
        if (Number.isFinite(t.localEast) && Number.isFinite(t.localNorth)) {
          const ll = GP()?.canonicalLocalToLngLat(t.localEast, t.localNorth, ref, origin);
          if (Number.isFinite(ll.longitude) && Number.isFinite(ll.latitude)) {
            out.push([ll.longitude, ll.latitude]);
          }
        } else if (Number.isFinite(t.east) && Number.isFinite(t.north)) {
          const ll = GP()?.globalEnToLngLat(t.east, t.north, origin);
          if (Number.isFinite(ll.longitude) && Number.isFinite(ll.latitude)) {
            out.push([ll.longitude, ll.latitude]);
          }
        }
      }
      return out;
    }

    function fitRouteBounds(stationaryMap, padding = 48) {
      if (!isActive() || !map || !styleLoaded) return false;
      refreshGeographicPointStats(stationaryMap);
      const coords = collectRouteLngLats(stationaryMap);
      if (coords.length < 2) {
        emitStatus('noGeographicPoints');
        return false;
      }
      let minLon = coords[0][0];
      let maxLon = coords[0][0];
      let minLat = coords[0][1];
      let maxLat = coords[0][1];
      for (const c of coords) {
        minLon = Math.min(minLon, c[0]);
        maxLon = Math.max(maxLon, c[0]);
        minLat = Math.min(minLat, c[1]);
        maxLat = Math.max(maxLat, c[1]);
      }
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding, duration: 0 });
      map.resize();
      onRedraw();
      return true;
    }

    function followLngLat(longitude, latitude) {
      if (!isActive() || !map || !styleLoaded || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
      map.easeTo({ center: [longitude, latitude], duration: 0 });
      onRedraw();
    }

    function resize() {
      map?.resize?.();
    }

    function getDiagnostics() {
      const layout = measureLayout();
      return {
        requestedBackground: requestedMode,
        activeBackground: mode,
        fallbackReason,
        configLoaded: !!mapConfig,
        maplibreLoaded: !!global.maplibregl,
        webglAvailable: typeof WebGLRenderingContext !== 'undefined',
        geographicOriginPresent: !!(origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)),
        geographicPoints: geographicPointStats,
        mapCreated,
        styleLoaded,
        tileErrors: tileErrorCount,
        resizeObserverActive: layoutWaitActive,
        statusDetail,
        ...layout,
      };
    }

    function getStatus() {
      return { fallbackReason, detail: statusDetail, mode, active: isActive() };
    }

    return {
      setBackground,
      loadConfig,
      setGeographicContext,
      isActive,
      projectCanonicalLocal,
      projectGlobalEn,
      fitRouteBounds,
      followLngLat,
      resize,
      getStatus,
      getDiagnostics,
      destroy: () => {
        disconnectLayoutObserver();
        destroyMap();
        mode = 'grey';
        applyStagePresentation();
      },
    };
  }

  global.createGeographicMap = createGeographicMap;
})(typeof window !== 'undefined' ? window : global);
