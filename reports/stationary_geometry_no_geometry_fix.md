# Stationary Segment 9 `noGeometry` — root-cause and fix

**Date:** 2026-08-12
**Status:** EXPERIMENTAL (ES) — no commit/merge/push
**Scope:** Diagnose why fully-stationary Segment 9 (qlog_f449c_9.bz2) displayed `Stationary local map unavailable / reason: noGeometry` in Point-accumulated mode after the fusion-v16 two-pass pose-lock correction, then restore partial stationary lane geometry without inventing road polygons or artificial vehicle motion.

---

## 1. Exact first pipeline stage where Segment 9 geometry becomes empty

Traced every stage with frame-by-frame counts (see `tests/stationary_geometry.test.js`, `.cache/diag_seg9.json`).

| # | Stage | Count for Segment 9 | Non-zero? |
|---|-------|--------------------|-----------|
| 1 | modelV2 extraction (`extractModelGeometry`) | 35 raw lane lines; 910 valid lane-line points | ✅ |
| 2 | canonical lane observations (frame.lanes) | 35 lane lines across 30 frames | ✅ |
| 3 | pose transformation (through locked anchor) | 910 transformed map points | ✅ |
| 4 | lane tracking (`sd_fusion` / tracker) | 4 tracks created, 31 continued, 1 terminated, 0 rejected | ✅ |
| 5 | point accumulation (`accumulatePointObservations`) | 910 observations; 910 displayed; 0 invalid excluded | ✅ |
| 6 | fusion/dedup (`buildPointDisplay`) | 910 points; 3 boundary groups; 907 repeated-support | ✅ |
| 7 | fragment construction | 3 constructed fragments (CF0 lane1 60.8 m, CF1 lane2 75 m, CF2 lane0 99.2 m) | ✅ |
| 8 | polygon construction | 0 road polygons (expected — no vehicle travel) | ⚠️ expected |
| 9 | **map validity gate (`buildSegmentLocalMap`)** | **`valid=false`, `reason='noGeometry'` despite 910 drawable points** | ❌ **FIRST LOSS** |
| 10 | playback-frame serialization / renderer (`render.js:_drawStationaryLocalMap`) | `if (!map?.valid) { _drawStationaryUnavailable(); return; }` → blank box | ❌ |

**Root cause.** The map validity gate in `buildSegmentLocalMap` (lib/segment_local_map.js:1034 and the synced public mirror) computed `valid`/`reason` from **only**:

```js
(laneFragments.length + edgeFragments.length > 0)
  || roadSurfacePolygons.length > 0
  || trajectory.length >= 2
```

In Point-accumulated mode `laneFragments`/`edgeFragments` are **empty by design** (the viewer draws dots directly from `pointAccumulated.points`). For a fully stationary segment `roadSurfacePolygons` is empty and `trajectory.length === 1` (all 30 poses locked to one anchor dedupe to a single point), so `trajectory.length >= 2` is false. The gate **never counted the 910-point accumulated cloud**, the actual drawable geometry. Result: `valid=false, reason='noGeometry'` and the renderer short-circuited to the "Stationary local map unavailable" overlay.

**Secondary contributor.** `buildPointAccumulatedFragments` built a reference trajectory from `chunk.vehiclePath` (30 poses, all identical). `projectPoint` against a zero-length path collapses **every** observation onto `s=0,d=0`. That zeroed the along-track/fused frame and (a) prevented constructed fragments from forming and (b) discarded the lane geometry's forward/lateral extent even in the s/d metadata.

**Fix applied (no thresholds changed):**
1. `hasDrawableGeometry` now also includes `accumulatedPointCloud.length > 0`. `noGeometry` is returned only when **every** drawable layer (lane fragments, edge fragments, road polygons, trajectory, point cloud) is empty.
2. A degenerate (zero-length) reference trajectory is treated as absent (guard in `buildPointAccumulatedFragments` and in `accumulatePointObservations`), so `s`/`d` fall back to the fixed-anchor forward/lateral frame — `s = forward distance`, `d = lateral offset` — preserving observed road extent.

## 2. Four created tracks vs zero displayed tracks

These are **two different numbers**, not a contradiction:

- **4 created / 31 continued / 1 terminated / 0 rejected** is the segment-wide **tracker diagnostic** (`chunk.laneTrackingSummary.passes[0].lane`) — 4 track identities created across all 30 frames: track 0 (30 frames), track 1 (1 frame), track 2 (2 frames), track 3 (2 frames).
- **`Lane tracks` at elapsed index 0** in the timeline info panel (`app.js:914`) is `frame.lanes[].laneTrackId` **joined as a string**. Frame 0 has one lane line with `laneTrackId = 0`, so the panel renders `"0"` — the track **ID value 0**, not "zero tracks". `Lane lines: 1` is the frame's lane count. Both are correct.

The real discrepancy was the playback geometry (0 lane fragments / `noGeometry`), which is the map gate bug in §1 — the tracker itself produced and preserved all 4 tracks.

## 3. Frame-by-frame source and rejection counts

All 30 frames, full trace:

| fi | sec | raw lines | valid lanes (prob≥0.5) | laneIndex | probs | edges | trackIds | pts/frame |
|----|-----|-----------|------------------------|-----------|-------|-------|----------|-----------|
| 0–3 | 0–6 | 4 | 1 | [1] | 0.57–0.63 | 2 | [0] | 26 |
| 4 | 8 | 4 | 2 | [1,2] | 0.70, 0.58 | 2 | [0,1] | 52 |
| 5–27 | 10–54 | 4 | 1 | [1] | 0.57–0.65 | 2 | [0] | 26 |
| 28 | 56 | 4 | 3 | [0,1,2] | 0.53, 0.80, 0.65 | 2 | [2,0,3] | 78 |
| 29 | 58 | 4 | 3 | [0,1,2] | 0.57, 0.88, 0.67 | 2 | [2,0,3] | 78 |

**Rejections:** 0 invalid points excluded (`invalidExcluded = 0`); tracker `rejectedMatches = 0`. Full source/accumulated parity: 910 source → 910 displayed → 100% coverage parity.

**Causal playback counts by elapsed index:** 0→26, 5→182, 15→442, 29→910 (of 910 total). Causal playback exposes only observations with `frameIndex <= elapsedIdx` (frame-0 set is exactly frame-0 observations, 26 points). Complete-map mode (default) shows all 910 accepted stationary observations at any elapsed index.

## 4. Car-ahead effect (video + frame-level model output)

- Video file `.video_cache/f449c322f59e6943---2026-07-20--09-34-13--9---qcamera.61dbb336b17208a6.mp4` exists; stills extracted at 0/10/30/55 s to `%TEMP%\opencode\seg9\`.
- **Frame-level model output** (objective evidence): lane 1 (ego boundary, modelY −1.4…+0.2) is detected in **all 30 frames** at prob 0.58–0.88 with full 0–117 m forward extent. Lane 2 (left boundary, +1.2…+3.0) appears only in frames 4, 28–29. Lane 0 (outer right, −4.5…−2.6) appears only in frames 28–29. **Every frame has usable lane evidence** (`frames with no usable evidence = []`).
- Conclusion: the foreground vehicle **reduces** the visible boundary set (left/outer boundaries are frequently occluded), but the ego boundary (lane 1, 780 of 910 points) is continuously visible. The model **does** output sufficient lane evidence — the blank map was caused by the pipeline gate in §1, not by occlusion. Usable evidence is now rendered as partial geometry.

## 5. Results at 0, 10, 30, 60 seconds

| elapsed | frame idx | raw lanes | mode result | displayed points (complete) | causal points | constructed fragments |
|---------|-----------|-----------|-------------|-----------------------------|---------------|------------------------|
| 0.0 s | 0 | 4 | valid, reason=null | 910 | 26 | 3 |
| 10.0 s | 5 | 4 | valid, reason=null | 910 | 182 | 3 |
| 30.0 s | 15 | 4 | valid, reason=null | 910 | 442 | 3 |
| 58.0 s (final) | 29 | 4 | valid, reason=null | 910 | 910 | 3 |

All frames now draw the point cloud; the `noGeometry` unavailable overlay is gone. Complete-map view shows all accepted stationary observations; causal view shows only observations up to the current elapsed index.

## 6. Partial geometry counts before / after

| Layer | Before (fusion-v16, broken) | After (this fix) |
|-------|------------------------------|-------------------|
| Point-accumulated dots | 910 accumulated but **not drawable** (`noGeometry`) | 910 drawn |
| Constructed fragments | 0 | 3 (CF0 lane1 60.8 m, CF1 lane2 75 m, CF2 lane0 99.2 m) |
| Experimental boundary lanes | 3 | 3 |
| Joined polylines | 0 | 0 (each boundary is one continuous fragment — no compatible pairs to join; correct) |
| Road polygons | 0 | 0 (unchanged, no vehicle travel) |
| Trajectory points | 1 | 1 (unchanged, pose stays anchored) |
| Map `valid` / `reason` | false / `noGeometry` | true / null |

## 7. Screenshots

`screenshots/point_accumulated_modes/` for `qlog_f449c_9` at idx 0, 5, 15, 29:
- `A_raw_observations_*` — raw mapped observations
- `B_fused_lane_lines_*` — fused lane lines (no fused lanes expected for stationary)
- `C_point_complete_*` — point-accumulated, complete-map mode (910 dots)
- `D_point_causal_*` — point-accumulated, causal playback (frameIndex ≤ elapsed)

## 8. Full dataset regression results

Full suite: **1,610 tests (1,596 baseline + 14 new), 1,583 pass, 27 fail**. All 14 new stationary-geometry tests pass. The 27 failing leaves are the **known pre-existing baseline** (Stage 19 checksum/completeness tests, `browser and Node checksum` parity, the flaky Stage 19 concurrent-publication test, and three `v11 processing version unchanged` pins). **No new failure introduced** by this change.

Segment-level spot check after fix:

| Segment | class | map.valid | reason | point cloud | constructed fragments | trajectory pts |
|---------|-------|-----------|--------|-------------|------------------------|----------------|
| 9 | fully-stationary | true | null | 910 | 3 | 1 |
| 6 | stop-and-go | true | null | 208 | 3 | 10 |
| 2 (reference) | moving | true | null | unchanged (parity test passes) | — | — |

## 9. Test totals before / after

| Metric | Before | After |
|--------|--------|-------|
| Test files | 1596 tests in suite | 1610 tests in suite |
| New tests | — | `tests/stationary_geometry.test.js`: 14 subtests |
| Related-suite result | — | point_accumulation, stationary_pose_lock, local_playback_geometry_modes, constructed_fragments, lane_joining, experimental_boundaries, stage8 continuity, stationary_geometry: 232 tests, 231 pass, 1 fail = pre-existing "21. Fused mode remains unchanged" (render.js source-shape assertion on 1174 pre-existing uncommitted render.js lines, unrelated to this fix) |

## 10. Files changed

- `lib/segment_local_map.js` — `hasDrawableGeometry` includes the accumulated point cloud; degenerate-trajectory guard in `buildPointAccumulatedFragments`.
- `lib/point_accumulation.js` — `accumulatePointObservations` treats a zero-length reference trajectory as absent (s/d fall back to forward/lateral).
- `public/segment_local_map.js`, `public/point_accumulation.js` — regenerated mirrors (`scripts/sync_segment_local_map_public.js`, `scripts/sync_point_accumulation_public.js`).
- `tests/stationary_geometry.test.js` — new regression tests (14).
- `reports/stationary_geometry_validation.json` — validation snapshot.
- `screenshots/point_accumulated_modes/*_qlog_f449c_9_*.png` — capture evidence.

## 11. Confirmations

- **No artificial vehicle motion introduced** — mapping pose stays at the stationary anchor (east −0.262, north 1.849, heading 57.29°); trajectory travel is 0 m; pose-lock tests unchanged.
- **No segment-specific conditions** — both fixes are general (any fully-stationary or degenerate-trajectory segment; Seg 6 verified unchanged).
- **Mapping pose remains stationary** — the anchor is never altered.
- **No GPS drift reintroduced** — pose-lock logic untouched.
- **No requirement of vehicle travel to display observed lane geometry** — 0 m travel now renders 910 points.
- **No manufactured missing lane boundaries or road polygons** — partial boundaries only; polygons remain 0.
- **No threshold changes** — gates are structural (any drawable layer non-empty), not new numeric thresholds.
- **No final graph fitting started** — raw stationary observations are confirmed present (910 points) and exposed; fitting remains future work.
- **No commit, merge or push.**

## Files (diagnostic artifacts)
- `.cache/diag_seg9.js`, `.cache/diag_seg9.json` — frame-by-frame pipeline trace.
- `.cache/full_suite_stationary_geom.txt` — full-suite TAP output.
