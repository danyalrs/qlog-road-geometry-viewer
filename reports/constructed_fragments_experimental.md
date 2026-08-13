# Constructed Lane-Boundary Fragments — Experimental Report

**Status:** EXPERIMENTAL — display-only diagnostic. **Never feeds production lane geometry.**
**Date:** 2026-08-10
**Source module:** `lib/constructed_fragments.js` (browser mirror `public/constructed_fragments.js`)

---

## 1. Purpose

The Point-accumulated Local playback mode displays every accumulated lane observation
as a dot. The dots are raw and unstructured. This report documents an **experimental**
layer that converts the accumulated dots into **short, reliable local polylines**
(constructed fragments) so the boundary geometry can be inspected without replacing the
dots, the Raw layer, the Fused layer, Candidate D, or any tracked output.

It is a separate, toggleable layer ("Constructed fragments (experimental)") that draws
on top of the Point dots in the browser viewer. It never modifies the source points.

## 2. Design

### 2.1 Input

The same accumulated point observations used for the Point dots (from
`buildPointAccumulatedFragments` in `lib/segment_local_map.js`). Each observation carries:

- segment-local `localEast` / `localNorth` (corrected frame, matching the dots)
- reference-trajectory frame `s` (along-track) and `d` (signed lateral)
- `laneIndex`, `groupTrackId` (physical-boundary identity), `chunkId`, `passId`
- `frameIndex`, `frameId`, `logMonoTime`, `prob`, `supportFrameCount`

### 2.2 Grouping

Points are grouped by **physical boundary** = `(chunkId, passId, groupTrackId)`. This
keeps L0/L1/L2 (and L3 where present) separate and never mixes chunks or passes.
`groupTrackId` is the stable per-group colour identity assigned by the Point layer
(`lib/point_accumulation.js:420`).

### 2.3 Ordering

Points are ordered by **along-track `s`**, never by global east/north, so curves do not
zigzag. Near-identical overlapping observations are deduplicated (keep higher
confidence).

### 2.4 Connection checks

Two consecutive points connect only when **all** of these pass (`evaluateConnect`):

| Check | Threshold (default) | Purpose |
|-------|---------------------|---------|
| Same chunk / pass | exact | never cross chunk/pass boundaries |
| Forward temporal gap | `maxTimeGapSec` 6 s | catch genuine coverage holes |
| Backward temporal jump | `maxRevisitTimeSec` 8 s | tolerate normal frame-overlap interleave |
| Along-track gap | `maxJoinGapM` 12 m | spatial continuity |
| Step distance | `maxStepM` 14 m | no teleporting |
| Lateral change | `maxLateralStepM` 3 m | no lateral jumps |
| Direction change | `maxDirectionChangeDeg` 45° over `minDirectionSpanM` 5 m | sharp unsupported kinks only |

The temporal thresholds are deliberately tolerant because the observation cadence is
~2 s with occasional frame skips (4 s gaps), and adjacent frames overlap heavily in `s`
(26 dense points per frame over a ~117 m arc), producing normal small backward time
steps in `s` order. Measured: all backward jumps in the reference pass are <= ~4 s.

### 2.5 Splitting

A run splits when any connection check fails, or at the end of a group. Split reasons
are recorded per fragment (`splitReason`) and rejected connections carry the reason.
Fragments below `minObservations` (3) are dropped. Points with
`supportFrameCount < minSupportCount` (2) are excluded from fragment construction but
**still shown as dots** — single-observation outliers are the main cause of spurious
lateral jumps.

### 2.6 Smoothing

A conservative 5-point moving average smooths fragment vertices, keeping endpoints and
capping the shift at `maxSmoothShiftM` (0.8 m). Residuals (point-to-polyline distance
per source observation) are recorded.

### 2.7 Output

Per fragment: `fragmentId`, `groupTrackId`, `laneIndex`, `chunkId`, `passId`, `points`
(segment-local frame), `sourceObservations`, `distinctFrames`, start/end logMonoTime,
start/end frameIndex, `lengthM`, `maxInternalGapM`, `medianResidualM`, `maxResidualM`,
`medianProb`, `splitReason`.

## 3. Real-segment audit

Run: `node scripts/audit_constructed_fragments.js` (sample: segments 0, 7, 13, 14, 22, 50).

| Segment | Points | Groups | Fragments | Median len (m) | Max len (m) | Med residual (m) | Source unchanged |
|---------|--------|--------|-----------|----------------|-------------|------------------|------------------|
| qlog_f449c_0 | 2054 | 4 | 36 | 44.7 | 153.4 | 0.145 | yes |
| qlog_f449c_13 | 2340 | 3 | 44 | 27.4 | 223.5 | 0.132 | yes |
| qlog_f449c_14 | 2314 | 3 | 37 | 42.8 | 502.2 | 0.179 | yes |
| qlog_f449c_22 | 910 | 4 | 27 | 7.9 | 82 | 0 | yes |
| qlog_f449c_50 | 1612 | 4 | 16 | 18.9 | 81 | 0.074 | yes |

Aggregate: 160 fragments across 5 segments; median fragment length ~27 m; median
fragment residual ~0.13 m; source points unmodified in all segments.

Segments 0/13/14 behave well (36-44 fragments, 27-45 m median). Segment 22 is a short,
sparse segment (~276 m span, one track only 33 m of coverage) so its short fragments
reflect genuinely sparse data, not a defect. Segment 50 is short overall (16 fragments).

Split-reason distribution across the sample (balanced, no single spurious cause):
`sharpDirectionChange` 75, `temporalGap` 69, `largeStep` 62, `lateralJump` 55,
`largeSpatialGap` 52, `temporalRevisit` 34.

## 4. Verification against the required design points

| Requirement | Verified by |
|-------------|-------------|
| Group by stable track/physical-boundary identity | `groupObservations`; tests 1, 14 |
| Order by along-track s (no global-east/north zigzag) | `orderAndDedupe`; test 2 |
| Connect only when all checks pass | `evaluateConnect`; tests 4-9 |
| Split on gap / temporal / direction / revisit / support | tests 5-9, 3b |
| Physical boundaries kept separate (L0/L1/L2...) | group key; tests 1, 14 (`groups >= 2`) |
| No reliance on future observations | causal rebuild in renderer (`_drawConstructedFragments`) |
| Crossed-boundary detection | `polylinesCross` / `segmentsCross` helpers |
| Conservative smoothing, no crossing splits | `smoothPoints`; test 10 |
| Residuals reported | `buildFragment`; test 11 |
| Source points never modified | tests 12, 14 (`srcOk: true`) |
| Local frame matching the dots | `buildFragment` uses `localEast/localNorth`; test 13 |
| Experimental, non-production | separate layer + module; docs classification **ES** |

## 5. Known limitations

- Cross-fragment joining (connecting two fragments of the same boundary separated by a
  gap) is out of scope; fragments are deliberately local.
- `sharpDirectionChange` splits cluster at genuine road curves (same `s` across all
  tracks, e.g. s=83/113/173/418/458/638 on segment 14). These are real geometry, and a
  curve apex is an acceptable split point for a conservative local-fragment layer.
- The `groupTrackId` identity is only stable while the Point layer keeps that group
  alive; on segments where lane tracking reassigns identity mid-pass, fragments split
  at the reassignment. That is the documented, conservative behaviour.
- The browser mirror rebuilds fragments from visible (causal / isolated) points at draw
  time, so fragment counts may differ between "complete map" and causal playback views.

## 6. Files

- `lib/constructed_fragments.js` — module (Node + browser dual)
- `public/constructed_fragments.js` — browser mirror (regenerated by
  `scripts/sync_constructed_fragments_public.js`)
- `lib/segment_local_map.js` — wires `constructedFragments` into `pointAccumulated`
- `public/render.js` — `_drawConstructedFragments` + `this.layers.constructedFragments`
- `public/index.html` — `layerConstructedFragments` checkbox + script tag
- `public/app.js` — layer state
- `scripts/audit_constructed_fragments.js` — the audit used for section 3
- `tests/constructed_fragments.test.js` — 17 tests (all passing)
- `package.json` — `bundle:browser` includes the constructed-fragments sync

## 7. Status

**EXPERIMENTAL (ES).** Does not alter production geometry. Next steps if pursued:
cross-fragment joining with explicit gap confidence, and a side-by-side video
validation of the fragment overlay.
