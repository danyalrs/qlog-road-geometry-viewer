/** Canvas renderer — draws each route chunk and polygon fragment independently. */

const LANE_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#4f46e5'];
const CHUNK_COLORS = [
  '#e11d48', '#2563eb', '#16a34a', '#ca8a04', '#7c3aed', '#0891b2',
  '#ea580c', '#db2777', '#4f46e5', '#65a30d', '#0d9488', '#c026d3',
];
const PASS_COLORS = ['#3b82f688', '#f59e0b88', '#10b98188', '#ec489988', '#8b5cf688', '#06b6d488'];
const PHYSICAL_BOUNDARY_COLORS = {
  PB0: '#2563eb',
  PB1: '#16a34a',
  PB2: '#7c3aed',
  PB3: '#ca8a04',
};
const TRACK_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#7c3aed', '#0891b2',
  '#ea580c', '#db2777', '#4f46e5', '#65a30d', '#0d9488', '#c026d3',
];

class RoadRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.data = null;
    this.layers = {};
    this.frameIndex = 0;
    this.hoverPoint = null;
    this.displayMode = 'global';
    this.playbackPose = null;
    this.localAnchorFrameIndex = 0;
    this.localElapsedIdx = 0;
    this.localGeometryMode = 'fused';
    this.localGeometryDisplay = null;
    this.stationaryLocalMap = null;
    this.geometryDiagnostics = null;
    this._localViewportBounds = null;
    this._localMapBuildCount = 0;
    this._localMapCacheState = 'empty';
    this._lastValidLocalGeometry = null;
    this.movementAnchor = null;
    this.movementDisplay = null;
    this._pulseRaf = null;
    this._pulsePhase = 0;
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    this._localArrowDebug = urlParams?.get('arrowDebug') === '1';
    this._laneTransformDebug = urlParams?.get('laneTransformDebug') === '1';
    this._outlierDebug = urlParams?.get('outlierDebug') === '1';
    this._polygonDebug = urlParams?.get('polygonDebug') === '1';
    this._fusionBinDebug = urlParams?.get('fusionBinDebug') === '1';
    this._laneRelativeArrow = urlParams?.get('laneRelativeArrow') === '1';
    this._lastLocalArrowTangent = null;
    this._roadSurfaceDrawStats = null;
    this.localRoadSurfacePathRadiusM = 15;
    this.localRoadSurfaceRibbonFallbackHalfWidthM = 7.5;
    this.localRoadSurfaceRibbonMinHalfWidthM = 3;
    this.localRoadSurfaceRibbonMaxHalfWidthM = 15;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this.draw();
  }

  setData(data, layers, displayMode = 'global') {
    this.data = data;
    this.layers = layers;
    this.displayMode = displayMode;
    this._lastLocalArrowTangent = null;
    if (displayMode !== 'vehicle' && displayMode !== 'local') {
      this.setMovementDisplay(null);
      this.playbackPose = null;
    }
    this.draw();
  }

  setPlaybackPose(pose) {
    this.playbackPose = pose;
    if (this.displayMode === 'local') this.draw();
  }

  setLocalAnchorFrameIndex(index) {
    this.localAnchorFrameIndex = index;
  }

  setLocalElapsedIdx(index) {
    this.localElapsedIdx = index;
  }

  setLocalGeometryMode(mode) {
    const SLM = window.SegmentLocalMap;
    if (SLM?.normalizeGeometrySource) {
      this.localGeometryMode = SLM.normalizeGeometrySource(mode);
    } else if (mode === 'fused') {
      this.localGeometryMode = 'fused';
    } else if (mode === 'diagnostic') {
      this.localGeometryMode = 'diagnostic';
    } else {
      this.localGeometryMode = mode || 'fused';
    }
  }

  setGeometryDiagnostics(diag) {
    this.geometryDiagnostics = diag;
  }

  setStationaryLocalMap(map, meta = {}) {
    this.stationaryLocalMap = map;
    if (meta.buildCount != null) this._localMapBuildCount = meta.buildCount;
    if (meta.cacheState) this._localMapCacheState = meta.cacheState;
  }

  clearLocalViewportBounds() {
    this._localViewportBounds = null;
  }

  getLocalViewportBounds() {
    return this._localViewportBounds;
  }

  setLocalGeometryDisplay(display) {
    this.localGeometryDisplay = display;
    if (display?.geometryState === 'current' && display?.frame) {
      this._lastValidLocalGeometry = display;
    }
  }

  setLaneRelativeArrow(enabled) {
    this._laneRelativeArrow = !!enabled;
  }

  setMovementAnchor(anchor) {
    this.movementAnchor = anchor;
  }

  setMovementDisplay(display, anchor = null) {
    this.movementDisplay = display;
    this.movementAnchor = anchor;
    this._syncPulseLoop();
  }

  _syncPulseLoop() {
    const anchor = this.movementAnchor || { east: 0, north: 0 };
    const shouldPulse = (this.displayMode === 'vehicle' || this.displayMode === 'local')
      && this.movementDisplay
      && (this.movementDisplay.displayState === 'MOVING' || this.movementDisplay.displayState === 'CREEPING');
    if (shouldPulse) {
      if (!this._pulseRaf) {
        const tick = () => {
          this._pulsePhase = performance.now() / 1000;
          if ((this.displayMode === 'vehicle' || this.displayMode === 'local') && this.movementDisplay
            && (this.movementDisplay.displayState === 'MOVING' || this.movementDisplay.displayState === 'CREEPING')) {
            this.draw();
            this._pulseRaf = requestAnimationFrame(tick);
          } else {
            this._pulseRaf = null;
          }
        };
        this._pulseRaf = requestAnimationFrame(tick);
      }
    } else if (this._pulseRaf) {
      cancelAnimationFrame(this._pulseRaf);
      this._pulseRaf = null;
      this.draw();
    }
  }

  setFrameIndex(i, options = {}) {
    this.frameIndex = i;
    if (options.redraw !== false) this.draw();
  }

  chunkColor(chunkId) {
    return CHUNK_COLORS[chunkId % CHUNK_COLORS.length];
  }

  passColor(passId) {
    return PASS_COLORS[passId % PASS_COLORS.length];
  }

  trackColor(trackId) {
    return TRACK_COLORS[trackId % TRACK_COLORS.length];
  }

  physicalBoundaryColor(physicalBoundaryId) {
    return PHYSICAL_BOUNDARY_COLORS[physicalBoundaryId]
      || TRACK_COLORS[(parseInt(String(physicalBoundaryId).replace(/\D/g, ''), 10) || 0) % TRACK_COLORS.length];
  }

  worldToScreen(east, north) {
    const cx = this.w / 2 + this.offsetX;
    const cy = this.h / 2 + this.offsetY;
    return { x: cx + east * this.scale, y: cy - north * this.scale };
  }

  fitToView(boundsOverride = null) {
    const bounds = boundsOverride || this._computeBounds();
    if (!bounds) return;
    const pad = 40;
    const rangeE = bounds.maxE - bounds.minE || 1;
    const rangeN = bounds.maxN - bounds.minN || 1;
    const sx = (this.w - pad * 2) / rangeE;
    const sy = (this.h - pad * 2) / rangeN;
    this.scale = Math.min(sx, sy);
    const midE = (bounds.minE + bounds.maxE) / 2;
    const midN = (bounds.minN + bounds.maxN) / 2;
    this.offsetX = -midE * this.scale;
    this.offsetY = midN * this.scale;
    this.draw();
  }

  fitToLocalView() {
    const LP = window.LocalPlayback;
    if (this.localGeometryMode === 'diagnostic') {
      const display = this.localGeometryDisplay;
      const frame = display?.frame ?? this.data?.frames?.[this.localElapsedIdx];
      const bounds = LP?.computeVehicleFrameBounds(frame, this.playbackPose) || this._computeBounds();
      this._localViewportBounds = bounds;
      this.fitToView(bounds);
      return;
    }
    const mapBounds = this.stationaryLocalMap?.fitBounds
      || this.stationaryLocalMap?.bounds;
    if (mapBounds) {
      this._localViewportBounds = mapBounds;
      this.fitToView(mapBounds);
      return;
    }
    if (this._localViewportBounds) {
      this.fitToView(this._localViewportBounds);
      return;
    }
    const display = this.localGeometryDisplay;
    const frame = display?.frame ?? this.data?.frames?.[this.localElapsedIdx];
    const fallback = LP?.computeVehicleFrameBounds(frame, this.playbackPose) || this._computeBounds();
    this._localViewportBounds = fallback;
    this.fitToView(fallback);
  }

  resetView() {
    this.scale = this.displayMode === 'vehicle' ? 8 : (this.displayMode === 'local' ? 8 : 1);
    this.offsetX = 0;
    this.offsetY = 0;
    if (this.displayMode === 'local') {
      this.clearLocalViewportBounds();
      this.fitToLocalView();
    } else this.fitToView();
  }

  _computeBounds() {
    const pts = [];
    const d = this.data;
    if (!d) return null;
    const add = (e, n) => { if (Number.isFinite(e) && Number.isFinite(n)) pts.push({ e, n }); };

    if (d.routeChunks?.length) {
      for (const chunk of d.routeChunks) {
        if (this.layers.gps) chunk.gpsTrajectory?.forEach((p) => add(p.east, p.north));
        if (this.layers.fused) chunk.fusedLaneLines?.forEach((l) => l.points.forEach((p) => add(p.east, p.north)));
        if (this.layers.edges) chunk.fusedRoadEdges?.forEach((e) => e.points.forEach((p) => add(p.east, p.north)));
      }
    }
    if (this.displayMode === 'vehicle' && d.frames?.[this.frameIndex]) {
      const f = d.frames[this.frameIndex];
      (f.lanes || []).forEach((l) => (l.points || []).forEach((p) => add(p.east, p.north)));
      (f.edges || []).forEach((e) => (e.points || []).forEach((p) => add(p.east, p.north)));
    }

    if (!pts.length) return { minE: -50, maxE: 50, minN: -10, maxN: 100 };
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const p of pts) {
      minE = Math.min(minE, p.e); maxE = Math.max(maxE, p.e);
      minN = Math.min(minN, p.n); maxN = Math.max(maxN, p.n);
    }
    return { minE, maxE, minN, maxN };
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(0, 0, this.w, this.h);

    const d = this.data;
    if (!d) {
      ctx.fillStyle = '#888';
      ctx.font = '14px sans-serif';
      ctx.fillText('Process qlog segments to render road geometry', 20, 30);
      return;
    }

    if (this.displayMode === 'vehicle') {
      this._drawVehicleFrame(d.frames?.[this.frameIndex]);
    } else if (this.displayMode === 'local') {
      this._drawLocalPlayback(d);
    } else {
      this._drawGlobal(d);
    }

    this._drawScaleBar();
    if (this.displayMode === 'global') this._drawNorthArrow();
    if (this.hoverPoint) this._drawHover(this.hoverPoint);
  }

  _drawGlobal(d, options = {}) {
    const { skipRawFrame = false, skipVehicleMarker = false } = options;
    const ctx = this.ctx;
    const chunks = d.routeChunks || [];

    for (const chunk of chunks) {
      const cc = this.chunkColor(chunk.chunkId);
      const useChunkColor = this.layers.colorByChunk;

      if (this.layers.roadSurface && chunk.roadSurfacePolygons) {
        for (const poly of chunk.roadSurfacePolygons) {
          if (poly.stats?.maxVertexJump > 15 || poly.stats?.maxWidth > 30) continue;
          let fill;
          if (this.layers.colorByPass && poly.passId != null) {
            fill = this.passColor(poly.passId);
          } else if (useChunkColor) {
            fill = cc + '55';
          } else {
            fill = 'rgba(60,60,60,0.35)';
          }
          this._fillPolygon(poly.ring, fill, poly.passId);
        }
      }

      if (this.layers.laneOnly && chunk.laneOnlyCandidates?.length) {
        for (const lane of chunk.laneOnlyCandidates) {
          this._drawPolyline(lane.points, '#f97316', 2, true, 12);
        }
      }

      if (this.layers.fused && chunk.fusedLaneLines) {
        chunk.fusedLaneLines.forEach((lane, i) => {
          const color = useChunkColor ? cc : LANE_COLORS[i % LANE_COLORS.length];
          this._drawPolyline(lane.points, color, 2, false, 12);
        });
      }

      if (this.layers.fusedTracks && d.laneTracks?.length) {
        for (const track of d.laneTracks) {
          const color = this.layers.colorByTrack ? this.trackColor(track.trackId) : '#1d4ed8';
          this._drawPolyline(track.points, color, 2.5, false, 20);
          if (this.layers.trackIds && track.points?.length) {
            const mid = track.points[Math.floor(track.points.length / 2)];
            this._drawLabel(mid.east, mid.north, `T${track.trackId}`);
          }
        }
      }

      if (this.layers.trackConnections && d.laneConnections?.length) {
        const ctx = this.ctx;
        ctx.strokeStyle = 'rgba(99,102,241,0.55)';
        ctx.lineWidth = 1;
        for (const conn of d.laneConnections) {
          const a = this.worldToScreen(conn.from.east, conn.from.north);
          const b = this.worldToScreen(conn.to.east, conn.to.north);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      if (this.layers.edges && chunk.fusedRoadEdges) {
        chunk.fusedRoadEdges.forEach((edge) => {
          this._drawPolyline(edge.points, useChunkColor ? cc : '#16a34a', 3, false, 12);
        });
      }

      if (this.layers.centre && chunk.centreLine) {
        for (const cl of chunk.centreLine) {
          this._drawPolyline(cl.points, '#ffffff', 2, true, 12);
        }
      }

      if (this.layers.gps && chunk.gpsTrajectory) {
        this._drawPolyline(chunk.gpsTrajectory, useChunkColor ? cc : '#6366f1', 2, false);
      }

      if (this.layers.vehicle) {
        const segments = chunk.trajectorySegments?.length
          ? chunk.trajectorySegments
          : (chunk.vehiclePath?.length ? [chunk.vehiclePath] : []);
        for (const seg of segments) {
          if (seg?.length >= 2) this._drawPolyline(seg, '#f59e0b', 1.5, false);
        }
      }

      if (this.layers.markers && chunk.gpsTrajectory?.length) {
        const s = chunk.gpsTrajectory[0];
        const e = chunk.gpsTrajectory[chunk.gpsTrajectory.length - 1];
        this._drawMarker(s.east, s.north, '#16a34a', `S${chunk.chunkId}`);
        this._drawMarker(e.east, e.north, '#dc2626', `E${chunk.chunkId}`);
      }

      if (this.layers.passBoundaries && chunk.passDiagnostics?.splitEvents?.length) {
        for (const ev of chunk.passDiagnostics.splitEvents) {
          const pt = chunk.vehiclePath?.find((p) => p.frameId === ev.frameId)
            || (d.frames || []).find((f) => f.frameId === ev.frameId && f.chunkId === chunk.chunkId);
          if (pt?.pose) {
            this._drawMarker(pt.pose.east, pt.pose.north, '#9333ea', `P${ev.passId}`);
          } else if (pt?.east != null) {
            this._drawMarker(pt.east, pt.north, '#9333ea', `P${ev.passId}`);
          }
        }
      }

      if (this.layers.suspiciousGps && chunk.passCoverage) {
        const suspicious = new Set(
          (chunk.passCoverage || []).filter((p) => p.suspiciousGps).map((p) => p.passId)
        );
        if (suspicious.size && chunk.vehiclePath?.length) {
          let run = [];
          for (const pt of chunk.vehiclePath) {
            const passId = pt.passId ?? 0;
            if (suspicious.has(passId)) run.push(pt);
            else if (run.length) {
              this._drawPolyline(run, '#ef4444', 4, false);
              run = [];
            }
          }
          if (run.length) this._drawPolyline(run, '#ef4444', 4, false);
        }
      }

      if (this.layers.rejectedObs && d.frames) {
        const rctx = this.ctx;
        rctx.globalAlpha = 0.35;
        for (const f of d.frames) {
          if (f.chunkId !== chunk.chunkId) continue;
          for (const edge of f.edges || []) {
            for (const pt of edge.points || []) {
              const sp = this.worldToScreen(pt.east, pt.north);
              rctx.fillStyle = '#dc2626';
              rctx.fillRect(sp.x - 2, sp.y - 2, 4, 4);
            }
          }
        }
        rctx.globalAlpha = 1;
      }

      if (this.layers.colorByChunk && chunk.gpsTrajectory?.length) {
        const mid = chunk.gpsTrajectory[Math.floor(chunk.gpsTrajectory.length / 2)];
        const p = this.worldToScreen(mid.east, mid.north);
        ctx.fillStyle = cc;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(`chunk ${chunk.chunkId}`, p.x + 8, p.y - 8);
      }
    }

    if (this.layers.raw && d.frames) {
      ctx.globalAlpha = 0.12;
      for (const f of d.frames) {
        for (const lane of f.lanes || []) {
          this._drawPolyline(lane.points, '#94a3b8', 1, false);
        }
      }
      ctx.globalAlpha = 1;
    }

    if (!skipRawFrame && this.layers.rawFrame && d.frames?.[this.frameIndex]) {
      const f = d.frames[this.frameIndex];
      for (const lane of f.lanes || []) {
        const color = this.layers.colorByTrack && lane.laneTrackId != null
          ? this.trackColor(lane.laneTrackId)
          : LANE_COLORS[(lane.laneIndex ?? 0) % LANE_COLORS.length];
        this._drawPolyline(lane.points, color, 2.5, false);
        if (lane.anchors?.length) {
          for (const a of lane.anchors) {
            const sp = this.worldToScreen(a.east, a.north);
            this.ctx.fillStyle = color;
            this.ctx.beginPath();
            this.ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2);
            this.ctx.fill();
          }
        }
        if (this.layers.trackIds && lane.laneTrackId != null && lane.points?.length) {
          const mid = lane.points[Math.floor(lane.points.length / 2)];
          this._drawLabel(mid.east, mid.north, `T${lane.laneTrackId}`);
        }
      }
      for (const edge of f.edges || []) {
        this._drawPolyline(edge.points, '#16a34a', 2, false);
      }
    }

    if (!skipVehicleMarker && this.layers.markers && d.timeline?.[this.frameIndex]) {
      const t = d.timeline[this.frameIndex];
      const vp = d.vehiclePath?.find((p) => p.logMonoTime === t.logMonoTime);
      if (vp) this._drawVehicleIcon(vp.east, vp.north, t.bearingDeg || 0);
    }
  }

  _drawLocalPlayback(d) {
    const LP = window.LocalPlayback;
    const elapsedIdx = this.localElapsedIdx ?? this.frameIndex ?? 0;

    if (this.localGeometryMode === 'diagnostic') {
      const display = this.localGeometryDisplay
        || (LP?.resolveLocalGeometryFrame(
          d.frames,
          d.timeline,
          elapsedIdx,
          this._lastValidLocalGeometry,
        ) ?? { frame: null, geometryState: 'unavailable' });

      if (display.geometryState === 'current' && display.frame) {
        this._lastValidLocalGeometry = display;
      }

      if (display.frame) {
        const stale = display.geometryState === 'retained';
        this._drawVehicleFrameGeometry(display.frame, {
          arrowPose: this.playbackPose,
          showMovementAtArrow: true,
          useScreenPathHeading: true,
          geometryStale: stale,
          retainedFromElapsedIdx: display.retainedFromElapsedIdx,
        });
      } else if (this.playbackPose) {
        this._drawAxes();
        this._drawLocalPlaybackArrow(null, this.playbackPose);
      }
    } else {
      this._drawStationaryLocalMap(d, elapsedIdx);
    }

    if (this._laneTransformDebug) {
      this._drawLocalPlaybackDebugOverlay(d, elapsedIdx);
    }
  }

  _selectStationaryRoadSurfaceDrawables(map) {
    const SLM = window.SegmentLocalMap;
    const polygons = map?.roadSurfacePolygons || [];
    let base;
    if (!SLM?.selectStationaryRoadSurfacePolygons) {
      base = {
        drawables: polygons.map((poly) => ({ poly, displayRing: poly.ring, clipped: false, sourceIndex: null })),
        skipped: [],
        sourceCount: polygons.length,
        drawableCount: polygons.length,
      };
    } else {
      const result = SLM.selectStationaryRoadSurfacePolygons(polygons, {
        polygonDebug: this._polygonDebug,
        fusionBinDebug: this._fusionBinDebug,
      });
      base = {
        drawables: result.selected.map((poly, idx) => ({
          poly,
          displayRing: poly.ring,
          clipped: false,
          sourceIndex: idx,
        })),
        skipped: result.skipped,
        sourceCount: polygons.length,
        drawableCount: result.selectedCount,
      };
    }

    const LRSP = typeof window !== 'undefined' ? window.LocalRoadSurfacePathFilter : null;
    const trajectory = map?.trajectory;
    if (!LRSP?.filterRoadSurfacePolygonsForTrajectory || !trajectory?.length) {
      return base;
    }

    const radiusM = this.localRoadSurfacePathRadiusM ?? LRSP.LOCAL_ROAD_SURFACE_PATH_RADIUS_M;
    const filtered = LRSP.filterRoadSurfacePolygonsForTrajectory(
      base.drawables.map((entry) => entry.poly),
      trajectory,
      { radiusM },
    );

    return {
      drawables: filtered.drawables,
      skipped: [...base.skipped, ...filtered.skipped],
      sourceCount: base.sourceCount,
      drawableCount: filtered.stats.drawableCount,
      pathFilterStats: filtered.stats,
      corridorSections: filtered.corridor.sections.length,
    };
  }

  _drawStationaryLocalMap(d, elapsedIdx) {
    const map = this.stationaryLocalMap;
    if (!map?.valid) {
      this._drawStationaryUnavailable(map);
      this._drawAxes();
      this._drawLocalVehiclePathOverlay(map);
      if (this.playbackPose) {
        this._drawLocalPlaybackArrow(null, this.playbackPose);
      }
      this._roadSurfaceDrawStats = null;
      return;
    }

    this._drawAxes();

    if (this.layers.roadSurface) {
      const LRR = typeof window !== 'undefined' ? window.LocalRoadSurfaceRibbon : null;
      const trajectory = map?.trajectory;
      const edgeFragments = map?.edgeFragments;
      const ribbonOptions = {
        fallbackHalfWidthM: this.localRoadSurfaceRibbonFallbackHalfWidthM
          ?? LRR?.LOCAL_ROAD_SURFACE_RIBBON_FALLBACK_HALF_WIDTH_M ?? 7.5,
        minHalfWidthM: this.localRoadSurfaceRibbonMinHalfWidthM
          ?? LRR?.LOCAL_ROAD_SURFACE_RIBBON_MIN_HALF_WIDTH_M ?? 3,
        maxHalfWidthM: this.localRoadSurfaceRibbonMaxHalfWidthM
          ?? LRR?.LOCAL_ROAD_SURFACE_RIBBON_MAX_HALF_WIDTH_M ?? 15,
      };
      const ribbonFill = 'rgba(100,116,139,0.42)';
      let ribbonResult = null;
      if (LRR?.buildTrajectoryRoadSurfaceRibbons && trajectory?.length >= 2) {
        ribbonResult = LRR.buildTrajectoryRoadSurfaceRibbons(trajectory, edgeFragments, ribbonOptions);
        for (const ribbon of ribbonResult.ribbons) {
          LRR.drawRoadSurfaceRibbon(
            this.ctx,
            ribbon,
            (east, north) => this.worldToScreen(east, north),
            ribbonFill,
          );
        }
      }

      let storedDiagnostics = null;
      if (this._polygonDebug || this._fusionBinDebug) {
        const surfaceSelection = this._selectStationaryRoadSurfaceDrawables(map);
        storedDiagnostics = surfaceSelection;
        const polyColors = [
          'rgba(96,165,250,0.35)',
          'rgba(74,222,128,0.35)',
          'rgba(251,191,36,0.35)',
          'rgba(244,114,182,0.35)',
          'rgba(167,139,250,0.35)',
          'rgba(45,212,191,0.35)',
          'rgba(248,113,113,0.35)',
        ];
        for (let pi = 0; pi < surfaceSelection.drawables.length; pi++) {
          const entry = surfaceSelection.drawables[pi];
          const poly = entry.poly;
          const drawRing = entry.displayRing || poly.ring;
          const surfaceType = poly.surfaceType ?? 'egoLaneCorridor';
          let fill = 'rgba(120,120,120,0.38)';
          if (surfaceType === 'fullRoadSurface') fill = 'rgba(100,116,139,0.42)';
          else if (surfaceType === 'multiLaneCorridor') fill = 'rgba(134,163,120,0.38)';
          else if (surfaceType === 'egoLaneCorridor') fill = 'rgba(120,120,120,0.38)';
          if (poly.syntheticForSurface && this._fusionBinDebug) fill = 'rgba(251,191,36,0.25)';
          if (this._polygonDebug) {
            fill = polyColors[pi % polyColors.length];
          } else if (this._fusionBinDebug && this.layers.colorByPass && poly.passId != null) {
            fill = this.passColor(poly.passId);
          }
          this._fillPolygon(drawRing, fill, null, {
            outline: this._polygonDebug || this._fusionBinDebug ? '#1e293b' : 'rgba(80,80,80,0.65)',
            outlineWidth: this._polygonDebug ? 2 : 1,
            dashed: poly.syntheticForSurface && this._fusionBinDebug,
          });
          if ((this._polygonDebug || this._fusionBinDebug) && drawRing?.length) {
            const mid = drawRing[Math.floor(drawRing.length / 2)];
            const label = [
              this._polygonDebug ? `poly ${poly.fragmentIndex ?? pi}` : null,
              this._fusionBinDebug ? surfaceType.replace('Corridor', '') : null,
              poly.sourceLeftTrackId != null ? `L${poly.sourceLeftTrackId}` : null,
              poly.sourceRightTrackId != null ? `R${poly.sourceRightTrackId}` : null,
            ].filter(Boolean).join(' ');
            this._drawLabel(mid.east, mid.north, label, '#0f172a');
          }
        }
        if (this._fusionBinDebug && surfaceSelection.skipped.length) {
          for (const skip of surfaceSelection.skipped) {
            const poly = map.roadSurfacePolygons[skip.index];
            const mid = poly?.ring?.[0];
            if (mid) {
              this._drawLabel(mid.east, mid.north, `skip ${skip.reason}`, '#dc2626');
            }
          }
        }
      }

      this._roadSurfaceDrawStats = {
        elapsedIdx,
        surfaceDisplaySource: 'trajectoryRibbon',
        ribbonStats: ribbonResult?.stats ?? null,
        ribbonCount: ribbonResult?.ribbons?.length ?? 0,
        sectionCount: ribbonResult?.sections?.length ?? 0,
        selfIntersecting: ribbonResult?.ribbons?.some((r) => r.selfIntersecting) ?? false,
        sourceCount: map.roadSurfacePolygonCount ?? map.roadSurfacePolygons?.length ?? 0,
        drawableCount: ribbonResult?.ribbons?.length ?? 0,
        storedPolygonDiagnostics: storedDiagnostics,
        roadSurfaceChecksum: map.roadSurfaceChecksum ?? null,
        drawInvocation: (this._roadSurfaceDrawStats?.drawInvocation ?? 0) + 1,
      };
    } else {
      this._roadSurfaceDrawStats = {
        elapsedIdx,
        sourceCount: map.roadSurfacePolygonCount ?? 0,
        drawableCount: 0,
        skipped: [],
        layerDisabled: true,
        roadSurfaceChecksum: map.roadSurfaceChecksum ?? null,
        drawInvocation: (this._roadSurfaceDrawStats?.drawInvocation ?? 0) + 1,
      };
    }

    if (this.layers.edges) {
      for (const edge of map.edgeFragments || []) {
        if (edge.outlier && !this._outlierDebug) continue;
        const color = edge.outlier ? 'rgba(220,38,38,0.5)' : '#16a34a';
        this._drawPolyline(edge.points, color, edge.outlier ? 1.5 : 3, false);
      }
    }

    if (this.layers.fused) {
      const mode = this.localGeometryMode;
      const debugMode = mode === 'cleanedDebug';
      (map.laneFragments || []).forEach((lane, i) => {
        if (lane.outlier && !this._outlierDebug) return;
        let color;
        if (mode === 'rejected' || lane.supportStatus === 'rejected') {
          color = 'rgba(220,38,38,0.85)';
        } else if (debugMode && lane.fragmentKind === 'preservedSourcePolyline') {
          color = 'rgba(234, 179, 8, 0.95)';
        } else if (lane.physicalBoundaryId && (lane.colorByPhysicalBoundary || mode === 'cleaned' || mode === 'cleanedWithSurface' || debugMode)) {
          color = this.physicalBoundaryColor(lane.physicalBoundaryId);
        } else if (lane.laneTrackId != null && (lane.colorByTrack || mode === 'tracked' || mode === 'fused')) {
          color = this.trackColor(lane.laneTrackId);
        } else {
          color = lane.outlier
            ? 'rgba(220,38,38,0.6)'
            : LANE_COLORS[i % LANE_COLORS.length];
        }
        const width = (mode === 'cleaned' || mode === 'cleanedWithSurface' || debugMode) ? 2.5 : (lane.outlier ? 1.5 : 2);
        const dashed = debugMode && lane.fragmentKind === 'preservedSourcePolyline';
        this._drawPolyline(lane.points, color, width, dashed);

        if (debugMode && lane.points?.length) {
          const start = lane.points[0];
          const end = lane.points[lane.points.length - 1];
          const mid = lane.points[Math.floor(lane.points.length / 2)];
          const label = lane.fragmentKind === 'preservedSourcePolyline'
            ? [
              `D12 ${lane.gapId}`,
              `F${lane.sourceFrameId}`,
              lane.sMin != null ? `s${Math.round(lane.sMin)}-${Math.round(lane.sMax)}` : null,
            ].filter(Boolean).join(' ')
            : [
              `R${lane.fragmentIndex ?? i}`,
              lane.physicalBoundaryId,
              `T${lane.laneTrackId}`,
              lane.sMin != null ? `s${Math.round(lane.sMin)}-${Math.round(lane.sMax)}` : null,
            ].filter(Boolean).join(' ');
          this._drawLabel(mid.east, mid.north, label, color);
          if (lane.fragmentKind !== 'preservedSourcePolyline') {
            this._drawLabel(start.east, start.north, '●', color);
            this._drawLabel(end.east, end.north, '○', color);
          }
        }
      });

      if (debugMode && map.laneCleanup?.mergeDecisions) {
        for (const d of map.laneCleanup.mergeDecisions) {
          if (d.wasJoined || !Number.isFinite(d.gapM)) continue;
          const frag = map.laneFragments.find((f) => f.sMax != null && Math.abs(f.sMax - d.endS) < 0.5);
          if (!frag?.points?.length) continue;
          const endPt = frag.points[frag.points.length - 1];
          this._drawLabel(
            endPt.east,
            endPt.north - 2,
            `gap ${d.gapM?.toFixed(1)}m ${d.classification}`,
            '#dc2626',
          );
        }
      }

      if (debugMode && map.laneCleanup?.drawablePathAnalysis?.interRunBreaks?.length) {
        for (const brk of map.laneCleanup.drawablePathAnalysis.interRunBreaks) {
          if (brk.labelEast == null) continue;
          this._drawLabel(
            brk.labelEast,
            brk.labelNorth,
            `OPEN ${brk.gapId} ${brk.openLengthM?.toFixed(2)}m`,
            '#dc2626',
          );
        }
      }
    }

    if (this._outlierDebug) {
      for (const frag of map.outlierFragments || []) {
        this._drawPolyline(frag.points, '#dc2626', 3, true);
        const mid = frag.points?.[Math.floor((frag.points.length - 1) / 2)];
        if (mid) {
          this._drawLabel(mid.east, mid.north, (frag.outlierReasons || []).join(','), '#dc2626');
        }
      }
    }

    this._drawLocalVehiclePathOverlay(map);

    if (this.playbackPose) {
      this._drawLocalPlaybackArrow(null, this.playbackPose);
      if (this.movementDisplay) {
        this._drawVehicleMovementIndicator(
          this.playbackPose.east,
          this.playbackPose.north,
          null,
        );
      }
    }

    this._drawGeometryDiagnosticOverlays(map);
  }

  _drawLocalVehiclePathOverlay(map) {
    if (!map?.trajectory || map.trajectory.length < 2) return;
    const LTO = typeof window !== 'undefined' ? window.LocalTrajectoryOverlay : null;
    if (LTO?.drawTrajectoryOverlay) {
      LTO.drawTrajectoryOverlay(
        this.ctx,
        map.trajectory,
        (east, north) => this.worldToScreen(east, north),
      );
      return;
    }
    const runs = [map.trajectory];
    const ctx = this.ctx;
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    for (const run of runs) {
      if (run.length < 2) continue;
      ctx.beginPath();
      const p0 = this.worldToScreen(run[0].east, run[0].north);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < run.length; i++) {
        const p = this.worldToScreen(run[i].east, run[i].north);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  _drawGeometryDiagnosticOverlays(map) {
    const diag = this.geometryDiagnostics;
    const frags = map.laneFragments || [];

    if (this.layers.diagPhysicalBoundary) {
      for (const lane of frags) {
        if (!lane.points?.length || !lane.physicalBoundaryId) continue;
        const mid = lane.points[Math.floor(lane.points.length / 2)];
        this._drawLabel(mid.east, mid.north, lane.physicalBoundaryId, this.physicalBoundaryColor(lane.physicalBoundaryId));
      }
    }

    if (this.layers.diagTrackIds) {
      for (const lane of frags) {
        if (lane.laneTrackId == null || !lane.points?.length) continue;
        const mid = lane.points[Math.floor(lane.points.length / 2)];
        this._drawLabel(mid.east, mid.north + 2, `T${lane.laneTrackId}`, '#0f172a');
      }
    }

    if (this.layers.diagFragmentIds) {
      frags.forEach((lane, i) => {
        if (!lane.points?.length) return;
        const start = lane.points[0];
        this._drawLabel(start.east, start.north, `R${lane.fragmentIndex ?? i}`, '#334155');
      });
    }

    if (this.layers.diagDisconnections) {
      const breaks = map.laneCleanup?.drawablePathAnalysis?.interRunBreaks || [];
      for (const brk of breaks) {
        if (brk.labelEast == null) continue;
        this._drawLabel(brk.labelEast, brk.labelNorth, `OPEN ${brk.gapId}`, '#dc2626');
        if (brk.gapStartEast != null && brk.gapEndEast != null) {
          this._drawPolyline(
            [{ east: brk.gapStartEast, north: brk.gapStartNorth }, { east: brk.gapEndEast, north: brk.gapEndNorth }],
            '#dc2626',
            2,
            true,
          );
        }
      }
      if (!breaks.length && diag?.openPhysicalGaps) {
        for (const g of diag.openPhysicalGaps) {
          const near = frags.find((f) => f.physicalBoundaryId === g.physicalBoundaryId
            && Math.abs(f.sMax - g.routeS0) < 2);
          if (!near?.points?.length) continue;
          const end = near.points[near.points.length - 1];
          this._drawLabel(end.east, end.north, `GAP ${g.alongTrackGapM.toFixed(1)}m`, '#dc2626');
        }
      }
    }

    if (this.layers.diagRepairedGaps && diag?.repairAnalysis) {
      for (const r of diag.repairAnalysis) {
        if (!r.structurallyRepaired || !r.coordinateJump) continue;
        const { pointBefore, pointAfter } = r.coordinateJump;
        const mx = (pointBefore.east + pointAfter.east) / 2;
        const my = (pointBefore.north + pointAfter.north) / 2;
        const color = r.verdict === 'rendered_continuity' ? '#0891b2' : '#ea580c';
        this._drawLabel(mx, my, `${r.id} ${r.verdict === 'rendered_continuity' ? 'RENDERED' : 'STRUCTURAL'}`, color);
      }
    }

    if (this.layers.diagStructuralBridges && diag?.structuralBridgeSegments) {
      for (const seg of diag.structuralBridgeSegments) {
        if (!seg.pointBefore || !seg.pointAfter) continue;
        const color = seg.renderedContinuity ? 'rgba(8,145,178,0.9)' : 'rgba(234,88,12,0.95)';
        this._drawPolyline(
          [seg.pointBefore, seg.pointAfter],
          color,
          seg.renderedContinuity ? 2.5 : 2,
          !seg.renderedContinuity,
        );
        const mx = (seg.pointBefore.east + seg.pointAfter.east) / 2;
        const my = (seg.pointBefore.north + seg.pointAfter.north) / 2;
        this._drawLabel(mx, my - 2, `${seg.id} ${seg.jumpM?.toFixed(1)}m`, color);
      }
    }

    if (this.layers.diagInterpolatedBridges) {
      for (const lane of frags) {
        const pts = lane.points || [];
        const interp = [];
        for (let i = 0; i < pts.length; i++) {
          if (pts[i].generated || pts[i].interpolationProvenance?.generated) {
            interp.push(pts[i]);
          }
        }
        if (interp.length < 2) continue;
        this._drawPolyline(interp, '#c026d3', 2.5, true);
        const mid = interp[Math.floor(interp.length / 2)];
        const method = interp[0].interpolationProvenance?.interpolationMethod || 'interp';
        this._drawLabel(mid.east, mid.north, `${method} conf=${interp[0].interpolationProvenance?.confidence?.toFixed(2)}`, '#a21caf');
      }
    }
  }

  _drawStationaryUnavailable(map) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 1;
    ctx.font = '13px sans-serif';
    const reason = map?.reason || 'unavailable';
    const lines = [
      'Stationary local map unavailable',
      `reason: ${reason}`,
      `mode: ${this.localGeometryMode}`,
    ];
    if (map?.chunkId != null) lines.push(`chunk: ${map.chunkId}  pass: ${map.passId ?? '—'}`);
    const boxW = 320;
    const boxH = 24 + lines.length * 18;
    ctx.fillRect(20, 20, boxW, boxH);
    ctx.strokeRect(20, 20, boxW, boxH);
    ctx.fillStyle = '#111';
    lines.forEach((line, i) => ctx.fillText(line, 32, 42 + i * 18));
    ctx.restore();
  }

  _drawLocalPlaybackDebugOverlay(d, elapsedIdx) {
    const frame = d.frames?.[elapsedIdx];
    const pose = this.playbackPose;
    const LP = window.LocalPlayback;
    const map = this.stationaryLocalMap;
    const modeLabel = {
      observations: 'Raw mapped observations',
      tracked: 'Tracked observations',
      fused: 'Fused lane lines',
      rejected: 'Rejected observations',
      cleaned: 'Cleaned fused lane map',
      cleanedWithSurface: 'Cleaned lanes + road surface',
      cleanedWithStage1Surface: 'Road-surface prototype (Stage 1)',
      cleanedDebug: 'Cleaned-run debug',
      diagnostic: 'Current observation (diagnostic)',
    }[this.localGeometryMode] || this.localGeometryMode;
    const lines = [
      `geometry mode: ${modeLabel}`,
      `geometry source: ${this.localGeometryMode}`,
      `elapsedIdx: ${elapsedIdx}`,
      `frameId: ${frame?.frameId ?? '—'}`,
      `logMonoTime: ${d.timeline?.[elapsedIdx]?.logMonoTime ?? '—'}`,
      `reference frame idx: ${map?.referencePose?.frameIndex ?? '—'}`,
      `reference heading: ${map?.referencePose?.headingDeg?.toFixed?.(1) ?? '—'}°`,
      `active chunk: ${map?.chunkId ?? frame?.chunkId ?? '—'}`,
      `active pass: ${map?.passId ?? frame?.passId ?? '—'}`,
      `lane fragments: ${map?.laneFragmentCount ?? 0}`,
      `lane checksum: ${map?.laneChecksum ?? map?.checksum ?? '—'}`,
      `edge fragments: ${map?.edgeFragmentCount ?? 0}`,
      `road polygons: ${map?.roadSurfacePolygonCount ?? 0}`,
      `road poly checksum: ${map?.roadSurfaceChecksum ?? '—'}`,
      `road poly drawn: ${this._roadSurfaceDrawStats?.drawableCount ?? '—'}/${this._roadSurfaceDrawStats?.sourceCount ?? '—'}`,
      `road poly skipped: ${this._roadSurfaceDrawStats?.skipped?.length ?? 0}`,
      `outlier fragments: ${map?.outlierFragmentCount ?? 0}`,
      `trajectory points: ${map?.trajectoryPointCount ?? 0}`,
      `map checksum: ${map?.checksum ?? '—'}`,
      `map build count: ${this._localMapBuildCount}`,
      `map cache: ${this._localMapCacheState}`,
      `arrow local x/y: ${pose?.east?.toFixed?.(2) ?? '—'}, ${pose?.north?.toFixed?.(2) ?? '—'}`,
      `arrow heading: ${pose?.headingDeg?.toFixed?.(1) ?? '—'}° (${pose?.headingSource ?? '—'})`,
    ];
    if (this.localGeometryMode === 'diagnostic') {
      const display = this.localGeometryDisplay;
      lines.splice(6, 0, `geometry source idx: ${display?.geometrySourceIndex ?? '—'}`);
      lines.splice(7, 0, `geometry state: ${display?.geometryState ?? '—'}`);
      const corridor = frame ? LP?.computeCorridorOffsetFromFrame(frame) : null;
      lines.push(`lane count: ${frame?.lanes?.length ?? 0}`);
      lines.push(`corridor offset: ${corridor?.valid ? `${corridor.vehicleOffsetFromCorridorCenterM.toFixed(2)} m` : '—'}`);
    }
    if (this._laneRelativeArrow && pose?.laneRelativeApplied) {
      lines.push(`lane-relative offset: ${pose.laneRelativeOffsetM?.toFixed?.(2)} m`);
    }
    const vb = this._localViewportBounds;
    if (vb) {
      lines.push(`viewport E: ${vb.minE?.toFixed?.(1)}..${vb.maxE?.toFixed?.(1)}`);
      lines.push(`viewport N: ${vb.minN?.toFixed?.(1)}..${vb.maxN?.toFixed?.(1)}`);
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    ctx.font = '11px monospace';
    const pad = 8;
    const lineH = 14;
    const boxH = lines.length * lineH + pad * 2;
    const boxW = 280;
    ctx.fillRect(10, 10, boxW, boxH);
    ctx.strokeRect(10, 10, boxW, boxH);
    ctx.fillStyle = '#111';
    lines.forEach((line, i) => {
      ctx.fillText(line, 18, 24 + i * lineH);
    });
    ctx.restore();
  }

  _drawVehicleFrame(frame) {
    this._drawVehicleFrameGeometry(frame, {
      fixedOriginArrow: true,
      showMovementAtArrow: true,
    });
  }

  _drawVehicleFrameGeometry(frame, options = {}) {
    if (!frame) return;
    const {
      fixedOriginArrow = false,
      arrowPose = null,
      showMovementAtArrow = false,
      useScreenPathHeading = false,
      geometryStale = false,
      retainedFromElapsedIdx = null,
    } = options;

    this._drawAxes();

    const laneAlpha = geometryStale ? 0.35 : 1;
    const pathAlpha = geometryStale ? 0.35 : 1;

    if (this.layers.edges && frame.edges) {
      frame.edges.forEach((e) => this._drawPolyline(e.points, `rgba(22,163,74,${laneAlpha})`, 3, false));
    }
    if (frame.lanes) {
      frame.lanes.forEach((lane, i) => {
        const base = LANE_COLORS[i % LANE_COLORS.length];
        const color = geometryStale ? `${base}59` : base;
        this._drawPolyline(lane.points, color, geometryStale ? 1.5 : 2, false);
      });
    }
    if (frame.path) {
      this._drawPolyline(
        frame.path.points,
        `rgba(148,163,184,${pathAlpha})`,
        1.5,
        true,
      );
    }

    if (geometryStale && retainedFromElapsedIdx != null && this._laneTransformDebug) {
      this._drawLabel(0, -8, `retained obs @${retainedFromElapsedIdx}`, '#b45309');
    }

    if (fixedOriginArrow) {
      if (showMovementAtArrow && this.movementDisplay) {
        this._drawVehicleMovementIndicator(0, 0, 'Fixed vehicle origin');
      }
      this._drawVehicleIcon(0, 0, 0);
    } else if (arrowPose && Number.isFinite(arrowPose.east) && Number.isFinite(arrowPose.north)) {
      if (showMovementAtArrow && this.movementDisplay) {
        this._drawVehicleMovementIndicator(arrowPose.east, arrowPose.north, null);
      }
      if (useScreenPathHeading) {
        this._drawLocalPlaybackArrow(frame.path?.points, arrowPose);
      } else {
        this._drawVehicleIcon(arrowPose.east, arrowPose.north, arrowPose.headingDeg || 0);
      }
    }
  }

  _drawAxes() {
    const ctx = this.ctx;
    const o = this.worldToScreen(0, 0);
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(o.x - 2000, o.y);
    ctx.lineTo(o.x + 2000, o.y);
    ctx.moveTo(o.x, o.y - 2000);
    ctx.lineTo(o.x, o.y + 2000);
    ctx.stroke();
  }

  _drawPolyline(points, color, width, dashed, maxGapM = 15) {
    if (!points?.length) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [8, 6] : []);

    const drawRun = (run) => {
      if (run.length < 2) return;
      ctx.beginPath();
      const p0 = this.worldToScreen(run[0].east, run[0].north);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < run.length; i++) {
        const p = this.worldToScreen(run[i].east, run[i].north);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    };

    let run = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const jump = Math.hypot(curr.east - prev.east, curr.north - prev.north);
      if (jump > maxGapM) {
        drawRun(run);
        run = [curr];
      } else {
        run.push(curr);
      }
    }
    drawRun(run);
    ctx.setLineDash([]);
  }

  _fillPolygon(ring, fillStyle, labelPassId = null, options = {}) {
    if (!ring?.length || ring.length < 3) return;
    const ctx = this.ctx;
    ctx.fillStyle = fillStyle;
    ctx.beginPath();
    const p0 = this.worldToScreen(ring[0].east, ring[0].north);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < ring.length; i++) {
      const p = this.worldToScreen(ring[i].east, ring[i].north);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();
    if (options.outline) {
      ctx.strokeStyle = options.outline;
      ctx.lineWidth = options.outlineWidth ?? 1;
      if (options.dashed) ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const showPassLabel = labelPassId != null && this.layers.colorByPass && this._polygonDebug;
    if (showPassLabel) {
      const mid = ring[Math.floor(ring.length / 4)];
      this._drawLabel(mid.east, mid.north, `pass ${labelPassId}`, '#111');
    }
  }

  _drawLabel(east, north, text, color = '#111') {
    const p = this.worldToScreen(east, north);
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, p.x, p.y);
    ctx.textAlign = 'left';
  }

  _drawMarker(east, north, color, label) {
    const p = this.worldToScreen(east, north);
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, p.x, p.y + 3);
    ctx.textAlign = 'left';
  }

  _resolveLocalPlaybackScreenTangent(pathPoints, arrowPose) {
    const PAS = window.PlaybackArrowScreen;
    if (!PAS || !pathPoints?.length || !arrowPose) return null;
    if (arrowPose.frozen && this._lastLocalArrowTangent) return this._lastLocalArrowTangent;
    const screenPoints = PAS.projectPathPoints(pathPoints, (east, north) => this.worldToScreen(east, north));
    const tangent = PAS.resolveScreenPathTangent(screenPoints, arrowPose.pathIndex ?? 0, {
      lastValidDirection: this._lastLocalArrowTangent,
    });
    if (!tangent) return this._lastLocalArrowTangent;
    this._lastLocalArrowTangent = tangent;
    return tangent;
  }

  _canvasLogicalTransform() {
    const dpr = window.devicePixelRatio || 1;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _drawArrowShapeAtOrigin() {
    const ctx = this.ctx;
    ctx.fillStyle = '#1d4ed8';
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
  }

  _drawLocalPlaybackArrow(pathPoints, arrowPose) {
    const PAS = window.PlaybackArrowScreen;
    const LP = window.LocalPlayback;
    if (!PAS || !arrowPose) return;
    const screen = this.worldToScreen(arrowPose.east, arrowPose.north);
    const centerX = screen.x;
    const centerY = screen.y;

    let ux;
    let uy;
    let tangent = null;
    if (pathPoints?.length >= 2) {
      tangent = this._resolveLocalPlaybackScreenTangent(pathPoints, arrowPose);
      if (!tangent) return;
      ux = tangent.ux;
      uy = tangent.uy;
    } else if (Number.isFinite(arrowPose.headingDeg)) {
      const headingRad = arrowPose.headingDeg * Math.PI / 180;
      const dx = Math.sin(headingRad);
      const dy = Math.cos(headingRad);
      const len = Math.hypot(dx, dy) || 1;
      ux = dx / len;
      uy = -dy / len;
    } else {
      return;
    }

    const arrow = PAS.buildScreenSpaceArrow(centerX, centerY, ux, uy);
    const ctx = this.ctx;

    ctx.save();
    this._canvasLogicalTransform();

    if (this._localArrowDebug) {
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + ux * 30, centerY + uy * 30);
      ctx.stroke();
      const dot = PAS.renderedTipDot(centerX, centerY, arrow.tipX, arrow.tipY, ux, uy);
      // eslint-disable-next-line no-console
      console.debug('[local-arrow]', {
        previous: tangent.previous,
        next: tangent.next,
        centerX,
        centerY,
        tipX: arrow.tipX,
        tipY: arrow.tipY,
        ux,
        uy,
        dot,
      });
    }

    ctx.fillStyle = '#1d4ed8';
    ctx.strokeStyle = '#1e40af';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(arrow.tipX, arrow.tipY);
    ctx.lineTo(arrow.leftX, arrow.leftY);
    ctx.lineTo(arrow.rightX, arrow.rightY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  _drawVehicleIcon(east, north, bearingDeg) {
    const p = this.worldToScreen(east, north);
    const ctx = this.ctx;
    const rad = (bearingDeg || 0) * Math.PI / 180;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-rad);
    this._drawArrowShapeAtOrigin();
    ctx.restore();
  }

  _drawVehicleMovementIndicator(east = 0, north = 0, subtitle = 'Fixed vehicle origin') {
    const display = this.movementDisplay;
    if (!display) return;
    const p = this.worldToScreen(east, north);
    const ctx = this.ctx;
    const baseRadius = 22;
    const state = display.displayState || 'UNCERTAIN';
    const t = this._pulsePhase;

    ctx.save();
    ctx.translate(p.x, p.y);

    if (state === 'MOVING') {
      const pulse = 0.55 + 0.45 * Math.sin(t * 4.5);
      ctx.strokeStyle = `rgba(22, 163, 74, ${0.35 + pulse * 0.45})`;
      ctx.lineWidth = 2 + pulse * 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius + pulse * 4, 0, Math.PI * 2);
      ctx.stroke();
    } else if (state === 'CREEPING') {
      const pulse = 0.55 + 0.45 * Math.sin(t * 2.2);
      ctx.strokeStyle = `rgba(217, 119, 6, ${0.35 + pulse * 0.45})`;
      ctx.lineWidth = 2 + pulse * 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius + pulse * 3, 0, Math.PI * 2);
      ctx.stroke();
    } else if (state === 'STOPPED') {
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = '#111827';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(display.labelText || state, 0, -baseRadius - 14);

    if (subtitle) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText(subtitle, 0, baseRadius + 16);
    }
    ctx.textAlign = 'left';
    ctx.restore();
  }

  _drawScaleBar() {
    const ctx = this.ctx;
    const targetPx = 100;
    const metres = niceRound(targetPx / this.scale);
    const px = metres * this.scale;
    const x = 20, y = this.h - 24;
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.stroke();
    ctx.fillStyle = '#333';
    ctx.font = '11px sans-serif';
    ctx.fillText(`${metres} m`, x, y - 4);
  }

  _drawNorthArrow() {
    const ctx = this.ctx;
    const x = this.w - 36, y = 36;
    ctx.fillStyle = '#333';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', x, y - 14);
    ctx.beginPath();
    ctx.moveTo(x, y - 10);
    ctx.lineTo(x - 6, y + 4);
    ctx.lineTo(x + 6, y + 4);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'left';
  }

  _drawHover(pt) {
    const p = this.worldToScreen(pt.east, pt.north);
    const ctx = this.ctx;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  exportPng() {
    const link = document.createElement('a');
    link.download = 'road_geometry.png';
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }

  findNearestPoint(sx, sy, thresholdPx = 12) {
    const d = this.data;
    if (!d) return null;
    let best = null;
    let bestDist = thresholdPx;

    const check = (points, meta) => {
      for (const pt of points || []) {
        const sp = this.worldToScreen(pt.east, pt.north);
        const dist = Math.hypot(sp.x - sx, sp.y - sy);
        if (dist < bestDist) { bestDist = dist; best = { ...pt, ...meta }; }
      }
    };

    if (this.displayMode === 'vehicle' && d.frames?.[this.frameIndex]) {
      const f = d.frames[this.frameIndex];
      for (const lane of f.lanes || []) {
        check(lane.points, { laneIndex: lane.laneIndex, prob: lane.prob, frameId: f.frameId, logMonoTime: f.logMonoTime, sourceFile: f.sourceFile });
      }
    } else if (d.routeChunks) {
      for (const chunk of d.routeChunks) {
        for (const lane of chunk.fusedLaneLines || []) {
          check(lane.points, { laneIndex: lane.laneIndex, chunkId: chunk.chunkId, fused: true });
        }
        for (const edge of chunk.fusedRoadEdges || []) {
          check(edge.points, { edgeIndex: edge.edgeIndex, chunkId: chunk.chunkId, roadEdge: true });
        }
      }
    }
    return best;
  }
}

function niceRound(m) {
  const pow = Math.pow(10, Math.floor(Math.log10(m)));
  const n = m / pow;
  const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return nice * pow;
}

window.RoadRenderer = RoadRenderer;
