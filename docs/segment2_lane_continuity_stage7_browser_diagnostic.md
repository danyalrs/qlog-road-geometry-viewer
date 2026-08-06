# Stage 7 browser diagnostic investigation

## Summary

Stage 7 closes DC-009–DC-012 at the **fusion-fragment / cleaned-run identity** level without generating interior coordinates. The webpage previously showed no checksum, defaulted to **Mode 1 (raw observations)**, and hid debug metrics behind `?laneTransformDebug=1`. Visual appearance unchanged for most viewing modes is **expected** for structural-only repairs.

**Continuity verdict: Mixed**
- **A (structural only):** DC-010 (18.0 m jump), DC-012 (16.3 m jump) — renderer `_drawPolyline` breaks strokes at >15 m
- **B (rendered continuity):** DC-009 (13.3 m jump), DC-011 (12.0 m jump) — a single canvas segment may span the gap **only in Mode 5 (cleaned)**

---

## Where lane checksum `10845acd` is calculated

| Step | Location |
|------|----------|
| 1 | `lib/lane_map_cleanup.js` → `computeLaneChecksum(laneFragments)` |
| 2 | `lib/segment_local_map.js` → `buildSegmentLocalMap()` attaches `laneChecksum` to Mode 5 map |
| 3 | Browser: `public/segment_local_map.js` (mirror) when `getOrBuildStationaryMap()` runs |

`processRoute()` does **not** compute the checksum; it is derived when building the cleaned stationary map.

---

## API vs browser checksum

| Path | Checksum | Notes |
|------|----------|-------|
| Node Mode 5 | `10845acd` | Authoritative post-Stage-7 |
| `/api/process` → `laneDiagnostics.laneChecksum` | `10845acd` | Added in diagnostic pass (no geometry change) |
| Browser stationary map (Mode 5) | `10845acd` | Same pipeline after reprocess |
| Pre-Stage-7 baseline | `ff6d115e` | `positiveBoundaryContinuityBridgeEnabled: false` |

**Stale cache:** Server cache key includes `PROCESSING_VERSION` (`fusion-v12`). If version was bumped but cache not busted, use **Reprocess selected** (`bustCache: true`). Diagnostics panel shows `API cache hit`.

---

## Why the webpage looked unchanged

1. **Default geometry mode is Mode 1 (observations)** — per-frame raw detections; Stage 7 merges fused fragments and cleaned runs, not raw observations.
2. **Debug overlay was URL-gated** — `lane checksum` only appeared with `?laneTransformDebug=1`.
3. **`setLocalGeometryMode` bug (fixed)** — Mode 5 was stored as `observations` in the renderer, breaking PB colours and debug labels even when the map was built correctly.
4. **Structural merge without interior points** — merged runs concatenate existing endpoints; coordinate jumps at gap boundaries are unchanged.

---

## Renderer behaviour

Mode 5 draws **one polyline per cleaned run** via `_drawPolyline(points, …, maxGapM=15)`:

- Consecutive points with Euclidean jump **≤ 15 m** → one visible segment
- Jump **> 15 m** → stroke break (visual gap remains)

| Gap | Jump (m) | Structural repair | Rendered line spans gap? |
|-----|----------|-------------------|--------------------------|
| DC-009 | 13.32 | Yes | **Yes** (Mode 5 only) |
| DC-010 | 18.00 | Yes | **No** |
| DC-011 | 12.00 | Yes | **Yes** (Mode 5 only) |
| DC-012 | 16.31 | Yes | **No** |

Generated interior geometry: **0 m** for all four.

---

## Coordinate evidence (PB1, cleaned runs)

**Before Stage 7 (DC-009 example):**
- Pre-run end: `(-57.582, 147.054)` at s=554.04
- Post-run start: `(-57.729, 160.373)` at s=567.35
- Euclidean jump: **13.32 m**
- Two fragments: s 527.6–554.0 and 567.3–572.0

**After Stage 7:**
- One merged run s 527.6–696.8, 28 points
- Same endpoint pair at gap boundary; jump still **13.32 m**
- No new points between endpoints

Maximum coordinate displacement inside repaired intervals: **0 m** (endpoints unchanged).  
PB0 / PB2 displacement: **0 m**.

---

## UI changes (diagnostic only — no geometry change)

- **Geometry diagnostics** sidebar panel (checksum, counts, Stage 7 verdict table)
- **`laneDiagnostics`** field on `/api/process` response
- Optional overlay layers: PB labels, track IDs, fragment IDs, open gaps, repaired-gap markers, structural bridge segments
- Fixed `setLocalGeometryMode` to preserve Mode 5/cleaned in renderer

**To verify:** Local playback → Mode 5 → Reprocess → check diagnostics panel for `10845acd` and repair table.

---

## Final verdict

| Question | Answer |
|----------|--------|
| Is Stage 7 only metadata? | **No** — fused fragment count 22→18, cleaned runs 21→17, physical gaps closed |
| Should webpage look unchanged on Mode 1? | **Yes** |
| Are DC-009–DC-012 “visibly closed” on Mode 5? | **Only DC-009 and DC-011** may show a connecting segment; **DC-010 and DC-012 remain visually gapped** |
| Overall | **Mixed A/B** — do not describe all four as visibly closed |
