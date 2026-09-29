'use strict';
(function (global) {
  const MS = () => global.MapStatus;
  const GJ = () => global.GeographicGeoJson;
  const GVP = () => global.GeographicVehiclePosition;

  const SRC_ROUTE_LINE = 'gps-route-line-src';
  const SRC_ROUTE_POINTS = 'gps-route-points-src';
  const SRC_VEHICLE = 'current-vehicle-src';
  const SRC_REP_LINES = 'representative-lines-src';
  const SRC_OBS_DOTS = 'observation-dots-src';
  const SRC_SOURCE_CURVES = 'source-curves-src';

  function createGeographicMapNative(options = {}) {
    const container = options.container;
    const stage = options.stage || container?.parentElement;
    const rootStage = options.rootStage || stage?.parentElement;
    const canvas = options.canvas;
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
    let tilesLoadedCount = 0;
    let routePointCount = 0;
    let resizeObserver = null;
    let layoutWaitActive = false;
    let lastSceneKey = null;
    const layerInventory = {
      gpsRoutePoints: 0,
      representativeLines: 0,
      observationDots: 0,
      sourceCurves: 0,
    };
    let overlaysInstalled = false;
    let pendingScene = null;
    let lastSetDataAt = null;
    let lastFitCacheKey = null;
    let lastVehicleLngLat = null;
    let lastVehicleHeading = null;
    let currentPositionUnavailable = false;
    let routeBoundsCache = null;
    let domVehicleMarker = null;
    let domVehicleArrowEl = null;
    let lastAppliedUiMode = 'review';
    let lastVehicleSegmentKey = null;
    let vehicleMarkerDiag = {
      available: false,
      matchMethod: 'unavailable',
      visible: false,
    };
    const OVERLAY_LAYER_IDS = [
      'source-curves',
      'observation-dots',
      'representative-lines-casing',
      'representative-lines',
      'gps-route-line-casing',
      'gps-route-line',
      'gps-route-end',
      'gps-route-start',
      'gps-route-points',
    ];

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

    function isActive() {
      return mode === 'street' || mode === 'satellite';
    }

    function isNativeActive() {
      return isActive();
    }

    function setBodyRendererClass() {
      document.body?.classList?.toggle('geographic-renderer-active', isActive());
    }

    function applyStagePresentation() {
      if (rootStage) {
        rootStage.classList.remove('map-background-grey', 'map-background-street', 'map-background-satellite');
        const cls = mode === 'street' || mode === 'satellite' ? mode : 'grey';
        rootStage.classList.add(`map-background-${cls}`);
      }
      setBodyRendererClass();
      if (canvas) {
        if (isActive()) {
          canvas.style.visibility = 'hidden';
          canvas.style.pointerEvents = 'none';
          canvas.style.background = 'transparent';
        } else {
          canvas.style.visibility = '';
          canvas.style.pointerEvents = '';
          canvas.style.background = '';
        }
      }
    }

    function emitStatus(code, extra = '') {
      fallbackReason = code;
      statusDetail = friendly(code, extra);
      options.onStatus?.(code, statusDetail);
      options.onDiagnostics?.(getDiagnostics());
    }

    function evaluateMapReady() {
      if (!isActive()) {
        emitStatus('mapReadyGrey');
        return;
      }
      const layout = measureLayout();
      if (layout.mapWidth < 2 || layout.mapHeight < 2) {
        emitStatus('waitingForLayout');
        return;
      }
      if (!mapCreated || !styleLoaded) {
        emitStatus('loading');
        return;
      }
      if (tileErrorCount > 0 && tilesLoadedCount < 1) {
        emitStatus('tileRequestFailed', `errors=${tileErrorCount}`);
        return;
      }
      if (tilesLoadedCount < 1) {
        emitStatus('mapReadyPending', 'awaiting tiles');
        return;
      }
      if (routePointCount < 2) {
        emitStatus('noGeographicPoints');
        return;
      }
      if (!lastVehicleLngLat) {
        emitStatus('mapReadyPending', 'awaiting vehicle position');
        return;
      }
      emitStatus('mapReady');
    }

    function getRasterLayerId() {
      const layers = map?.getStyle?.()?.layers || [];
      const raster = layers.find((l) => l.type === 'raster');
      return raster?.id || null;
    }

    function moveOverlaysAboveRaster() {
      if (!map) return false;
      const rasterId = getRasterLayerId();
      if (!rasterId) return false;
      let ok = true;
      for (const id of OVERLAY_LAYER_IDS) {
        if (!map.getLayer(id)) continue;
        try {
          map.moveLayer(id);
        } catch (_) {
          ok = false;
        }
      }
      return ok;
    }

    function disconnectLayoutObserver() {
      resizeObserver?.disconnect();
      resizeObserver = null;
      layoutWaitActive = false;
    }

    function destroyMap() {
      if (domVehicleMarker) {
        domVehicleMarker.remove();
        domVehicleMarker = null;
        domVehicleArrowEl = null;
      }
      if (map) {
        map.remove();
        map = null;
      }
      mapCreated = false;
      styleLoaded = false;
      tilesLoadedCount = 0;
      tileErrorCount = 0;
      routePointCount = 0;
      overlaysInstalled = false;
      pendingScene = null;
      lastFitCacheKey = null;
    }

    async function loadConfig() {
      const res = await fetch('/api/map-config', { cache: 'no-store' });
      if (!res.ok) {
        const err = new Error('configRequestFailed');
        err.httpStatus = res.status;
        throw err;
      }
      mapConfig = await res.json();
      if (!mapConfig?.street) throw new Error('configInvalid');
      return mapConfig;
    }

    function ensureMapLibre() {
      if (!global.maplibregl) throw new Error('libraryMissing');
    }

    function hasPositiveMapSize() {
      const { mapWidth, mapHeight } = measureLayout();
      return mapWidth >= 2 && mapHeight >= 2;
    }

    function waitForLayout() {
      applyStagePresentation();
      if (hasPositiveMapSize()) return Promise.resolve(true);
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
          resizeObserver = new ResizeObserver(() => tryResolve());
          if (stage) resizeObserver.observe(stage);
          if (container && container !== stage) resizeObserver.observe(container);
        }
        requestAnimationFrame(() => {
          if (tryResolve()) return;
          requestAnimationFrame(() => {
            if (!tryResolve() && !resizeObserver) finish(false);
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

    function ensureSource(id, geojson) {
      if (!map) return;
      const data = geojson || { type: 'FeatureCollection', features: [] };
      if (map.getSource(id)) {
        map.getSource(id).setData(data);
      } else {
        map.addSource(id, { type: 'geojson', data });
      }
    }

    function removeLayerIfExists(id) {
      if (map?.getLayer(id)) map.removeLayer(id);
    }

    function removeSourceIfExists(id) {
      if (map?.getSource(id)) map.removeSource(id);
    }

    function ensureOverlayLayers() {
      if (!map || !styleLoaded || overlaysInstalled) return;
      const addLine = (id, src, paint, layout = {}, filter = null) => {
        if (map.getLayer(id)) return;
        map.addLayer({
          id,
          type: 'line',
          source: src,
          paint,
          filter,
          layout: { 'line-join': 'round', 'line-cap': 'round', ...layout },
        });
      };
      const addCircle = (id, src, paint, filter = null) => {
        if (map.getLayer(id)) return;
        map.addLayer({
          id,
          type: 'circle',
          source: src,
          paint,
          filter,
        });
      };
      const addSymbol = (id, src, layout, paint = {}) => {
        if (map.getLayer(id)) return;
        map.addLayer({
          id,
          type: 'symbol',
          source: src,
          layout,
          paint,
        });
      };

      ensureSource(SRC_ROUTE_LINE, { type: 'FeatureCollection', features: [] });
      ensureSource(SRC_ROUTE_POINTS, { type: 'FeatureCollection', features: [] });
      ensureSource(SRC_VEHICLE, { type: 'FeatureCollection', features: [] });
      ensureSource(SRC_REP_LINES, { type: 'FeatureCollection', features: [] });
      ensureSource(SRC_OBS_DOTS, { type: 'FeatureCollection', features: [] });
      ensureSource(SRC_SOURCE_CURVES, { type: 'FeatureCollection', features: [] });

      addLine('source-curves', SRC_SOURCE_CURVES, {
        'line-color': '#94a3b8',
        'line-width': 1.5,
        'line-opacity': 0.45,
      });
      addCircle('observation-dots', SRC_OBS_DOTS, {
        'circle-radius': 3,
        'circle-color': ['coalesce', ['get', 'colour'], '#6366f1'],
        'circle-opacity': 0.75,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
      });
      addLine('representative-lines-casing', SRC_REP_LINES, {
        'line-color': '#0f172a',
        'line-width': 8,
        'line-opacity': 0.65,
      });
      addLine('representative-lines', SRC_REP_LINES, {
        'line-color': ['coalesce', ['get', 'colour'], '#0f766e'],
        'line-width': 5,
        'line-opacity': 1,
      });
      addLine('gps-route-line-casing', SRC_ROUTE_LINE, {
        'line-color': '#0f172a',
        'line-width': 8,
        'line-opacity': 0.85,
      });
      addLine('gps-route-line', SRC_ROUTE_LINE, {
        'line-color': '#06b6d4',
        'line-width': 4,
        'line-opacity': 1,
      });
      addCircle('gps-route-points', SRC_ROUTE_POINTS, {
        'circle-radius': 3,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#1e293b',
        'circle-stroke-width': 1,
      }, ['==', ['get', 'role'], 'sample']);
      addCircle('gps-route-start', SRC_ROUTE_POINTS, {
        'circle-radius': 7,
        'circle-color': '#22c55e',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      }, ['==', ['get', 'role'], 'start']);
      addCircle('gps-route-end', SRC_ROUTE_POINTS, {
        'circle-radius': 7,
        'circle-color': '#ef4444',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      }, ['==', ['get', 'role'], 'end']);
      overlaysInstalled = true;
      moveOverlaysAboveRaster();
    }

    function setLayerVisibility(layerId, visible) {
      if (!map?.getLayer(layerId)) return;
      map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
    }

    function applyDebugLayerIsolation(flags = {}) {
      if (!map) return;
      const show = (id, on) => setLayerVisibility(id, on !== false);
      const rasterId = getRasterLayerId();
      if (rasterId) setLayerVisibility(rasterId, flags.baseTiles !== false);
      show('gps-route-line-casing', flags.gpsRoute);
      show('gps-route-line', flags.gpsRoute);
      show('gps-route-start', flags.gpsRoute);
      show('gps-route-end', flags.gpsRoute);
      show('gps-route-points', flags.gpsRoute);
      show('representative-lines-casing', flags.laneLines);
      show('representative-lines', flags.laneLines);
      show('observation-dots', flags.observationDots);
      show('source-curves', flags.sourceCurves);
    }

    function applyUiVisibility(uiMode, flags, debugIsolation = null) {
      lastAppliedUiMode = uiMode;
      if (debugIsolation && uiMode === 'debug') {
        applyDebugLayerIsolation(debugIsolation);
        return;
      }
      const evidence = uiMode === 'evidence';
      const rasterId = getRasterLayerId();
      if (rasterId) setLayerVisibility(rasterId, true);
      setLayerVisibility('gps-route-line-casing', true);
      setLayerVisibility('gps-route-line', true);
      setLayerVisibility('gps-route-start', true);
      setLayerVisibility('gps-route-end', true);
      setLayerVisibility('gps-route-points', evidence);
      setLayerVisibility('representative-lines-casing', !!flags.representativeLaneLines);
      setLayerVisibility('representative-lines', !!flags.representativeLaneLines);
      setLayerVisibility('observation-dots', evidence && flags.observationDots);
      setLayerVisibility('source-curves', evidence && flags.sourceCurves);
      if (domVehicleMarker) {
        domVehicleMarker.getElement().style.display = vehicleMarkerDiag.visible ? '' : 'none';
      }
    }

    function enrichRoutePoints(routePoints, lineFeature) {
      const features = (routePoints?.features || []).map((f) => ({
        ...f,
        properties: { ...(f.properties || {}), role: 'sample' },
      }));
      const coords = lineFeature?.geometry?.coordinates;
      if (coords?.length >= 1) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: coords[0] },
          properties: { role: 'start' },
        });
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: coords[coords.length - 1] },
          properties: { role: 'end' },
        });
      }
      return { type: 'FeatureCollection', features };
    }

    function computeBoundsFromCoords(coords) {
      if (!coords?.length) return null;
      let minLon = coords[0][0];
      let maxLon = coords[0][0];
      let minLat = coords[0][1];
      let maxLat = coords[0][1];
      for (const c of coords) {
        if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
        minLon = Math.min(minLon, c[0]);
        maxLon = Math.max(maxLon, c[0]);
        minLat = Math.min(minLat, c[1]);
        maxLat = Math.max(maxLat, c[1]);
      }
      return { minLon, maxLon, minLat, maxLat };
    }

    function attachMapHandlers() {
      if (!map) return;
      map.on('load', () => {
        styleLoaded = true;
        overlaysInstalled = false;
        map.resize();
        ensureOverlayLayers();
        options.onRedraw?.();
        evaluateMapReady();
        applyStagePresentation();
      });
      map.on('data', (e) => {
        if (e.dataType === 'source' && e.isSourceLoaded && e.sourceId?.includes('raster')) {
          tilesLoadedCount += 1;
          evaluateMapReady();
        }
      });
      map.on('error', (e) => {
        tileErrorCount += 1;
        const msg = e?.error?.message || e?.message || 'tile';
        if (String(msg).toLowerCase().includes('webgl')) {
          emitStatus('webglUnavailable', msg);
        } else {
          emitStatus('tileRequestFailed', `errors=${tileErrorCount}`);
        }
        evaluateMapReady();
      });
    }

    async function ensureMapInstance(layerCfg) {
      ensureMapLibre();
      if (map) {
        map.resize();
        return;
      }
      emitStatus('loading');
      const rasterId = `${mode}-raster`;
      map = new global.maplibregl.Map({
        container,
        style: buildRasterStyle(rasterId, layerCfg.tileUrl, layerCfg.attribution, layerCfg.maxZoom),
        center: [103.8, 1.35],
        zoom: 16,
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

    async function initStreetOrSatellite({ config } = {}) {
      applyStagePresentation();
      const layoutOk = await waitForLayout();
      if (!layoutOk) {
        emitStatus('containerUnavailable');
        return;
      }
      if (!mapConfig) {
        try {
          await loadConfig();
        } catch (err) {
          mode = 'grey';
          emitStatus(err.message === 'configInvalid' ? 'configInvalid' : 'configRequestFailed');
          applyStagePresentation();
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
        evaluateMapReady();
        return;
      }
      disconnectLayoutObserver();
      if (want === 'grey') {
        mode = 'grey';
        destroyMap();
        applyStagePresentation();
        evaluateMapReady();
        return;
      }
      if (mode !== want) {
        destroyMap();
      }
      mode = want;
      await initStreetOrSatellite({ config });
    }

    function collectGpsTrajectory(playbackData, stationaryMap) {
      const chunks = playbackData?.routeChunks || [];
      const merged = [];
      for (const c of chunks) {
        if (c.gpsTrajectory?.length) merged.push(...c.gpsTrajectory);
      }
      if (merged.length) return merged;
      return stationaryMap?.gpsTrajectory || null;
    }

    function polylinesToGeoJson(polylines, referencePose, origin, colourFromTrack) {
      const G = GJ();
      if (!G?.buildRepresentativeLinesGeoJson) {
        return { type: 'FeatureCollection', features: [], stats: {} };
      }
      const withColour = (polylines || []).map((pl) => ({
        ...pl,
        colour: pl.colour || colourFromTrack?.(pl.groupTrackId) || '#0f766e',
      }));
      return G.buildRepresentativeLinesGeoJson(withColour, referencePose, origin);
    }

    function perFrameCurvesToGeoJson(polylines, referencePose, origin) {
      const features = [];
      let converted = 0;
      let missing = 0;
      const GP = global.GeographicProjection;
      for (const poly of polylines || []) {
        const coords = [];
        for (const pt of poly.points || []) {
          const le = pt.localEast;
          const ln = pt.localNorth;
          if (!Number.isFinite(le) || !Number.isFinite(ln)) { missing += 1; continue; }
          const ll = GP?.canonicalLocalToLngLat?.(le, ln, referencePose, origin);
          if (!Number.isFinite(ll?.longitude) || !Number.isFinite(ll?.latitude)) { missing += 1; continue; }
          coords.push([ll.longitude, ll.latitude]);
          converted += 1;
        }
        if (coords.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { groupTrackId: poly.groupTrackId ?? null },
        });
      }
      return {
        type: 'FeatureCollection',
        features,
        stats: { converted, missing, lineCount: features.length },
      };
    }

    function ensureDomVehicleMarker() {
      if (!map || !global.maplibregl || domVehicleMarker) return;
      const root = document.createElement('div');
      root.className = 'geo-vehicle-marker-root';
      root.setAttribute('role', 'img');
      root.setAttribute('aria-label', 'Current vehicle position');
      const pulse = document.createElement('div');
      pulse.className = 'geo-vehicle-pulse';
      const arrow = document.createElement('div');
      arrow.className = 'geo-vehicle-arrow';
      root.appendChild(pulse);
      root.appendChild(arrow);
      domVehicleArrowEl = arrow;
      domVehicleMarker = new global.maplibregl.Marker({
        element: root,
        anchor: 'center',
        pitchAlignment: 'map',
        rotationAlignment: 'map',
      });
      domVehicleMarker.setLngLat([0, 0]);
      domVehicleMarker.addTo(map);
      root.style.display = 'none';
    }

    function positionDomVehicleMarker(resolved) {
      ensureDomVehicleMarker();
      if (!domVehicleMarker || !resolved?.available) {
        vehicleMarkerDiag = {
          available: false,
          visible: false,
          matchMethod: resolved?.reason || 'unavailable',
        };
        currentPositionUnavailable = true;
        if (domVehicleMarker) domVehicleMarker.getElement().style.display = 'none';
        return;
      }
      const { longitude, latitude, headingDeg } = resolved;
      lastVehicleLngLat = { longitude, latitude };
      lastVehicleHeading = headingDeg;
      currentPositionUnavailable = false;
      domVehicleMarker.setLngLat([longitude, latitude]);
      if (domVehicleArrowEl && Number.isFinite(headingDeg)) {
        domVehicleArrowEl.style.transform = `rotate(${headingDeg - 90}deg)`;
      }
      domVehicleMarker.getElement().style.display = '';
      vehicleMarkerDiag = {
        available: true,
        visible: true,
        longitude,
        latitude,
        headingDeg,
        matchMethod: resolved.matchMethod || 'segmentTrajectory',
        logMonoTime: resolved.logMonoTime ?? null,
        timelineIndex: resolved.timelineIndex ?? null,
      };
    }

    function updateGeographicVehicleMarker(playbackPose, refOverride = null) {
      if (!isActive() || !map || !styleLoaded) return;
      const ref = refOverride || referencePose;
      const resolved = GVP()?.resolveVehicleGeographicFromPlaybackPose?.(playbackPose, ref, origin);
      if (!resolved?.available) {
        currentPositionUnavailable = true;
        vehicleMarkerDiag = {
          available: false,
          visible: !!lastVehicleLngLat,
          matchMethod: resolved?.reason || 'unavailable',
        };
        if (lastVehicleLngLat && domVehicleMarker) {
          domVehicleMarker.setLngLat([lastVehicleLngLat.longitude, lastVehicleLngLat.latitude]);
          domVehicleMarker.getElement().style.display = '';
        }
        return;
      }
      positionDomVehicleMarker(resolved);
      evaluateMapReady();
      options.onDiagnostics?.();
    }

    function refreshGeographicMapData(scene = null) {
      if (scene) pendingScene = scene;
      if (!isActive() || !map) return { ok: false, reason: 'mapInactive' };
      if (!styleLoaded) return { ok: false, reason: 'styleNotLoaded' };
      const activeScene = pendingScene;
      if (!activeScene?.stationaryMap) return { ok: false, reason: 'noProcessedMap' };
      if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) {
        return { ok: false, reason: 'noOrigin' };
      }

      ensureOverlayLayers();
      moveOverlaysAboveRaster();

      const stationaryMap = activeScene.stationaryMap;
      const playbackData = activeScene.playbackData;
      const playbackPose = activeScene.playbackPose;
      const uiMode = activeScene.uiMode || 'review';
      const flags = activeScene.layerFlags || {};
      const ref = stationaryMap?.referencePose || referencePose;
      const segKey = activeScene.cacheKey || stationaryMap?.cacheKey || null;
      if (segKey && segKey !== lastVehicleSegmentKey) {
        lastVehicleLngLat = null;
        lastVehicleSegmentKey = segKey;
      }
      const traj = stationaryMap?.trajectory || [];
      const gpsTrajectory = collectGpsTrajectory(playbackData, stationaryMap);
      const routeBuilt = GJ()?.buildGpsRouteGeoJson?.({
        origin,
        trajectory: traj,
        gpsTrajectory,
        referencePose: ref,
      }) || { line: null, points: { features: [] }, pointCount: 0 };
      routePointCount = routeBuilt.pointCount || 0;
      const lineFc = routeBuilt.line
        ? { type: 'FeatureCollection', features: [routeBuilt.line] }
        : { type: 'FeatureCollection', features: [] };
      routeBoundsCache = computeBoundsFromCoords(routeBuilt.line?.geometry?.coordinates);
      ensureSource(SRC_ROUTE_LINE, lineFc);
      ensureSource(SRC_ROUTE_POINTS, enrichRoutePoints(routeBuilt.points, routeBuilt.line));

      updateGeographicVehicleMarker(playbackPose, ref);

      let repGeo = { type: 'FeatureCollection', features: [], stats: {} };
      if (flags.representativeLaneLines && activeScene.representativePolylines?.length) {
        repGeo = polylinesToGeoJson(activeScene.representativePolylines, ref, origin);
      }
      ensureSource(SRC_REP_LINES, repGeo);

      let obsGeo = { type: 'FeatureCollection', features: [], stats: {} };
      if (flags.observationDots && stationaryMap?.pointAccumulated?.points) {
        obsGeo = GJ()?.buildObservationPointsGeoJson?.(
          stationaryMap.pointAccumulated.points,
          ref,
          origin,
          { maxPoints: uiMode === 'evidence' ? 12000 : 8000 },
        ) || obsGeo;
      }
      ensureSource(SRC_OBS_DOTS, obsGeo);

      let curvesGeo = { type: 'FeatureCollection', features: [], stats: {} };
      if (flags.sourceCurves && activeScene.perFramePolylines?.length) {
        curvesGeo = perFrameCurvesToGeoJson(activeScene.perFramePolylines, ref, origin);
      }
      ensureSource(SRC_SOURCE_CURVES, curvesGeo);

      layerInventory.gpsRoutePoints = routePointCount;
      layerInventory.representativeLines = repGeo.features?.length || 0;
      layerInventory.observationDots = obsGeo.features?.length || 0;
      layerInventory.sourceCurves = curvesGeo.features?.length || 0;
      layerInventory.repStats = repGeo.stats || {};

      lastSetDataAt = new Date().toISOString();
      moveOverlaysAboveRaster();

      applyUiVisibility(uiMode, flags, uiMode === 'debug' ? debugLayerIsolation : null);
      evaluateMapReady();
      lastSceneKey = activeScene.cacheKey || null;

      const fitKey = activeScene.cacheKey || stationaryMap?.cacheKey;
      if (fitKey && fitKey !== lastFitCacheKey && routePointCount >= 2 && routeBoundsCache) {
        const pad = { top: 56, bottom: 56, left: 280, right: 300 };
        map.fitBounds(
          [[routeBoundsCache.minLon, routeBoundsCache.minLat],
            [routeBoundsCache.maxLon, routeBoundsCache.maxLat]],
          { padding: pad, duration: 0 },
        );
        lastFitCacheKey = fitKey;
      }

      pendingScene = null;
      options.onDiagnostics?.();
      return { ok: true, routePointCount, representativeLines: layerInventory.representativeLines };
    }

    function syncScene(scene = {}) {
      pendingScene = scene;
      return refreshGeographicMapData();
    }

    function updateVehicleOnly(playbackPose) {
      if (!isActive() || !map) {
        if (pendingScene) pendingScene.playbackPose = playbackPose;
        return;
      }
      if (!styleLoaded) {
        if (pendingScene) pendingScene.playbackPose = playbackPose;
        return;
      }
      updateGeographicVehicleMarker(playbackPose);
    }

    let debugLayerIsolation = null;

    function setDebugLayerIsolation(isolation) {
      debugLayerIsolation = isolation || null;
      const mode = options.getUiMode?.() || lastAppliedUiMode;
      if (styleLoaded && map && mode === 'debug') {
        applyUiVisibility('debug', {}, debugLayerIsolation);
      }
    }

    function setGeographicContext({ processOrigin, mapReferencePose, stationaryMap } = {}) {
      origin = processOrigin || null;
      referencePose = mapReferencePose || null;
      if (!origin && isActive()) {
        emitStatus('noGeographicOrigin');
      }
    }

    function fitRouteBounds(stationaryMap, padding = 48) {
      if (!isActive() || !map || !styleLoaded) return false;
      const traj = stationaryMap?.trajectory || [];
      const routeBuilt = GJ()?.buildGpsRouteGeoJson?.({
        origin,
        trajectory: traj,
        referencePose: stationaryMap?.referencePose || referencePose,
      });
      const coords = routeBuilt?.line?.geometry?.coordinates;
      if (!coords || coords.length < 2) {
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
      const pad = typeof padding === 'object' ? padding : { top: padding, bottom: padding, left: padding, right: padding };
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: pad, duration: 0 });
      map.resize();
      return true;
    }

    function followLngLat(longitude, latitude) {
      if (!isActive() || !map || !styleLoaded) return;
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
      map.easeTo({ center: [longitude, latitude], duration: 0 });
    }

    function resize() {
      map?.resize?.();
      evaluateMapReady();
    }

    function countRendered(layerIds) {
      if (!map || !styleLoaded) return 0;
      try {
        const feats = map.queryRenderedFeatures(undefined, { layers: layerIds.filter((id) => map.getLayer(id)) });
        return feats?.length || 0;
      } catch (_) {
        return 0;
      }
    }

    function getDiagnostics() {
      const layout = measureLayout();
      const bounds = map?.getBounds?.();
      const mapBounds = bounds ? {
        minLon: bounds.getWest(),
        minLat: bounds.getSouth(),
        maxLon: bounds.getEast(),
        maxLat: bounds.getNorth(),
      } : null;
      const rasterId = getRasterLayerId();
      const styleLayers = map?.getStyle?.()?.layers || [];
      const rasterIndex = rasterId ? styleLayers.findIndex((l) => l.id === rasterId) : -1;
      const routeIndex = styleLayers.findIndex((l) => l.id === 'gps-route-line');
      return {
        requestedBackground: requestedMode,
        activeBackground: mode,
        activeRenderer: isActive() ? 'geographicMap' : 'localCanvas',
        localCanvasVisible: isActive() ? false : true,
        fallbackReason,
        configLoaded: !!mapConfig,
        maplibreLoaded: !!global.maplibregl,
        geographicOriginPresent: !!(origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)),
        mapCreated,
        styleLoaded,
        baseTilesLoaded: tilesLoadedCount > 0,
        tilesLoadedCount,
        tileErrors: tileErrorCount,
        gpsRoutePoints: routePointCount,
        routeFeatureCount: routePointCount >= 2 ? 1 : 0,
        routeRenderedCount: countRendered(['gps-route-line', 'gps-route-line-casing']),
        vehiclePosition: lastVehicleLngLat,
        vehicleHeadingDeg: lastVehicleHeading,
        vehicleMarker: vehicleMarkerDiag,
        markerUsesDom: true,
        markerUsesGlyphs: false,
        currentPositionUnavailable,
        laneLines: layerInventory.representativeLines,
        representativeRenderedCount: countRendered(['representative-lines', 'representative-lines-casing']),
        observationDots: layerInventory.observationDots,
        sourceCurves: layerInventory.sourceCurves,
        lastSetDataAt,
        mapBounds,
        routeBounds: routeBoundsCache,
        overlaysAboveRaster: rasterIndex >= 0 && routeIndex > rasterIndex,
        rasterLayerIndex: rasterIndex,
        routeLayerIndex: routeIndex,
        sourceIds: [
          SRC_ROUTE_LINE, SRC_ROUTE_POINTS, SRC_VEHICLE, SRC_REP_LINES, SRC_OBS_DOTS, SRC_SOURCE_CURVES,
        ].map((id) => ({ id, exists: !!map?.getSource?.(id) })),
        lastSceneKey,
        resizeObserverActive: layoutWaitActive,
        statusDetail,
        ...layout,
      };
    }

    return {
      setBackground,
      loadConfig,
      setGeographicContext,
      syncScene,
      refreshGeographicMapData,
      setDebugLayerIsolation,
      updateGeographicVehicleMarker,
      updateVehicleOnly,
      isActive,
      isNativeActive,
      fitRouteBounds,
      followLngLat,
      resize,
      getDiagnostics,
      getStatus: () => ({ fallbackReason, detail: statusDetail, mode, active: isActive() }),
      destroy: () => {
        disconnectLayoutObserver();
        destroyMap();
        mode = 'grey';
        applyStagePresentation();
      },
    };
  }

  global.createGeographicMapNative = createGeographicMapNative;
})(typeof window !== 'undefined' ? window : global);
