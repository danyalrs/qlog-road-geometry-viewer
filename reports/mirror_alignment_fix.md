# Mirror Regression in Constructed-Fragment / Joined-Polyline Layers — Diagnosis & Fix

**Status:** FIXED (experimental layers aligned with the corrected default mirror).
**Date:** 2026-08-11
**Scope:** Visual mirror alignment for the constructed fragments, joined lane
polylines, join-candidate connectors and experimental-boundary overlay.
No thresholds retuned. No fragment identities rebuilt. Mirror default unchanged.
No commit/merge/push.

---

## 1. Observed behaviour

With "Mirror road lateral display" checked, the constructed fragments and joined
lane polylines appeared at the **legacy (pre-correction) lane positions**, while the
point-accumulated **dots** followed the corrected mirrored orientation. The checkbox
was enabled but the new output did not align with the corrected mirrored lane geometry.

## 2. Root cause — traced coordinate flow

### 2.1 The established (verified) mirror mechanism

The dots carry **two** coordinate sets, computed at observation time by the
accumulation layer (`lib/point_accumulation.js:212-232`):
- `localEast / localNorth` — the corrected canonical segment-local position
- `mirroredLocalEast / mirroredLocalNorth` — the **precomputed** mirrored segment-local
  position (lateral sign reversed in the vehicle-relative frame, then converted to the
  map frame; fixed, never playback-dependent)

The dot draw path (`public/render.js`) calls the mirror selector with BOTH:

```
roadGeometryToScreen(pt.localEast, pt.localNorth, pt.mirroredLocalEast, pt.mirroredLocalNorth)
```

and `roadGeometryToScreen(east, north, mirroredEast, mirroredNorth)` picks the
**precomputed mirrored** coordinates when mirror is on, falling back to `east/north`
(canonical) when off. This is the single geometry-only mirror mechanism.

### 2.2 The regression

The new layers carried **only** canonical coordinates and called the selector with two
arguments:

| Layer | coordinates carried | draw call (before fix) |
|-------|--------------------|------------------------|
| Constructed fragments | `{east, north, s, d}` = original `localEast/localNorth` | `roadGeometryToScreen(v.east, v.north)` |
| Joined lane polylines | fragment + connector `{east, north, s, d}` | `roadGeometryToScreen(v.east, v.north)` |
| Join candidate connectors | fragment endpoints `{east, north}` | `roadGeometryToScreen(Ae.east, Ae.north)` |
| Experimental-boundary overlay | `{east, north}` vertices | `roadGeometryToScreen(v.east, v.north)` |

Because `mirroredEast`/`mirroredNorth` default to `east`/`north` in
`roadGeometryToScreen`, with the mirror checkbox ON these layers rendered using the
**original** (unmirrored) coordinates → the legacy/uncorrected orientation. The dots
rendered mirrored. Hence the visual misalignment.

The previous programmatic mirror test only verified the mirror **state** (the
`_mirrorRoadLateralDisplay` flag and the dot path); it did not compare the actual
screen coordinates of the new layers, which is why it passed while the visuals were
wrong.

## 3. Fix — match the established mechanism (no new reflection formula)

Propagate the **precomputed mirrored coordinates** onto every derived-layer point and
pass them through the same `roadGeometryToScreen(e, n, mirroredE, mirroredN)` selector.

### 3.1 Files changed

| File | Change |
|------|--------|
| `lib/constructed_fragments.js` | `buildFragment` copies `mirroredLocalEast/mirroredLocalNorth` → `mirroredEast/mirroredNorth` on each fragment point; `smoothPoints` smooths the mirrored coords with the same window/shift so canonical + mirrored stay consistent |
| `lib/lane_joining.js` | `buildConnector` builds the connector in BOTH canonical and mirrored frames (cubic between the precomputed mirrored endpoints/tangents) so connector vertices carry `mirroredEast/mirroredNorth`; new `endpointTangentMirrored` helper |
| `lib/experimental_boundaries.js` | `buildSLocalIndex` carries mirrored coords; `sToLocal` interpolates them; vertices emit `mirroredEast/mirroredNorth` |
| `public/render.js` | `_drawConstructedFragments`, `_drawJoinedPolylines`, `_drawJoinCandidates`, `_drawExperimentalBoundaries`, fragment/joined labels, and both hover handlers now call `roadGeometryToScreen(..., v.mirroredEast, v.mirroredNorth)` |
| `scripts/sync_constructed_fragments_public.js`, `scripts/sync_lane_joining_public.js`, `scripts/sync_experimental_boundaries_public.js`, `scripts/sync_segment_local_map_public.js` | regenerated browser bundles |

### 3.2 Canonical joining logic untouched

- The canonical coordinates (`east/north`) on fragments, joined points and connectors
  are **unchanged** — verified byte-identical to the dots' `localEast/localNorth` at the
  same `s`.
- The join candidate decisions and thresholds are **unchanged**: Segment 14 still yields
  42 candidates → 19 accepted, 11 ambiguous, 6 polylines, 12 unjoined; Segment 16 still
  14 → 13 accepted, 4 polylines, 0 unjoined.
- No new reflection formula or moving-anchor mirror was introduced; the fix uses the
  same precomputed-coordinate mechanism as the verified dots.

## 4. Coordinate trace for one identifiable point (L0/L1/L2)

Measured on Segment 14 (timeline idx ~100, mirror on/off), one fragment midpoint per
lane and its corresponding dot (same `s`):

| Lane | fragment canonical (east,north) | fragment mirrored | dot screen (mirror on) | fragment screen (mirror on) | dot screen (mirror off) | fragment screen (mirror off) |
|------|-------------------------------|-------------------|------------------------|-----------------------------|-------------------------|------------------------------|
| L0 | (53.5, −4.54) | (53.51, 4.15) | (128.8, 360.8) | (128.5, 360.8) | (128.8, 365.1) | (128.4, 365.3) |
| L1 | (57.47, −1.99) | (57.48, 1.42) | (130.4, 362.3) | (130.5, 362.2) | (130.4, 364.1) | (130.5, 364.0) |
| L2 | (57.48, 0.86) | (57.48, −1.44) | (130.4, 363.8) | (130.5, 363.7) | (130.4, 362.6) | (130.5, 362.5) |

Dot-vs-fragment screen distance ≤ 0.4 px in both mirror states. Toggling the checkbox
moves dot AND fragment by the same amount (L0: 4.5 px, L1: 1.8 px, L2: 1.2 px) —
the whole road-geometry surface moves together.

EB (verified lane layer) vs fragment at the nearest `s` (0.4 m apart): 0.5 px.

## 5. Per-layer determination (required item 4)

| Layer | Before fix | After fix |
|-------|-----------|-----------|
| Accumulated dots | precomputed mirrored (correct) | unchanged (correct) |
| Constructed fragments | original coords, NOT mirrored | precomputed mirrored, correct |
| Joined lane polylines | original coords, NOT mirrored | precomputed mirrored, correct |
| Candidate connectors | original endpoints, NOT mirrored | precomputed mirrored endpoints, correct |
| Experimental-boundary overlay | original coords, NOT mirrored | precomputed mirrored, correct |

No layer mirrors twice (the mirrored coords are precomputed; the selector uses them
only when mirror is on). No layer mixes original fragment points with mirrored
connector points — every derived point carries both sets consistently.

## 6. Required behaviour confirmed

- **Mirror checked/default:** dots, fragments, joined polylines, connectors and EB all
  align in the corrected orientation (≤ 0.5 px).
- **Mirror unchecked:** all road-geometry layers consistently return to the legacy
  orientation together.
- **Arrow / GPS trajectory / vehicle path unchanged:** arrow shift on toggle = 0.00 px
  (arrow uses `worldToScreen`; mirror selector not applied to it).
- **Refresh restores corrected default:** fresh load with no URL param →
  `_mirrorRoadLateralDisplay = true`, checkbox checked.

## 7. Regression test added

`tests/mirror_alignment.test.js` — 10 tests comparing **actual screen coordinates**
(from the same `roadGeometryToScreen` path) between dots and each derived layer under
BOTH mirror states, plus browser-bundle end-to-end mirrored-coordinate propagation.
A Boolean mirror-state check alone is insufficient — these tests assert the derived
layers land on the same pixels as the dots and that toggling shifts them together.

## 8. Visual verification

`scripts/capture_mirror_verify.js` → `screenshots/mirror_verify/` (10 PNGs + manifest),
Segments 14 and 16, four required views plus synchronized video:

1. verified lane layer only (EB boundaries), mirror on
2. verified lane layer + constructed fragments, mirror on
3. constructed fragments + joined polylines, mirror on
4. all layers, mirror off
5. synchronized road video (fragments + joined, mirror on) — `ready(28.0s/60.1s)`

## 9. Test baseline

| Suite | Before fix | After fix |
|-------|-----------|-----------|
| Full suite (`node --expose-gc --test tests`) | 1,522 tests, 1,495 pass / 27 fail | 1,532 tests, 1,505 pass / 27 fail |
| New `tests/mirror_alignment.test.js` | — | 10/10 pass |

The 27 failures are the same pre-existing set (test-21, D12 baselines, road-surface
bundle checks, stage13–20 version checks, flaky Stage 19 concurrent publication). **No
new failure was added.**

## Constraints honoured

- Used the same geometry-only mirror mechanism as the verified road layers (precomputed
  mirrored coordinates); no new reflection formula or moving-anchor mirror.
- Constructed fragments and joining decisions remain coordinate-consistent; canonical
  joining logic and thresholds unchanged.
- No fragment identities rebuilt. No mirror default changed.
- No commit, merge or push.
