# Endpoint Coverage Diagnosis & Fix — Constructed Fragments / Joined Polylines

**Status:** DIAGNOSED + FIXED (conservative one-sided endpoint extension).
**Date:** 2026-08-11
**Scope:** Recover valid route-start boundary observations excluded at the sequence
boundary; refuse to bridge noisy/unreliable end tails. No joining thresholds retuned.
No mirror change. No tracking-identity change. No commit/merge/push.

---

## 1. Diagnosis (Section A)

### 1.1 Endpoint coverage per physical boundary (before fix)

| Segment | Boundary | first dot s | first frag s | START gap | last dot s | last frag s | END gap |
|---------|----------|-------------|--------------|-----------|------------|-------------|---------|
| 14 | L0 | 0.042 m | 42.226 m | **42.18 m** | 1345.25 m | 1344.27 m | 0.98 m |
| 14 | L1 | 0.018 m | 42.201 m | **42.18 m** | 1345.25 m | 1344.26 m | 0.99 m |
| 14 | L2 | 0.000 m | 42.174 m | **42.17 m** | 1345.25 m | 1344.24 m | 1.01 m |
| 16 | L0 | 0.009 m | 42.197 m | **42.19 m** | 1377.19 m | 1355.65 m | **21.55 m** |
| 16 | L1 | 0.003 m | 42.191 m | **42.19 m** | 1377.19 m | 1355.66 m | **21.54 m** |
| 16 | L2 | 0.000 m | 42.185 m | **42.19 m** | 1377.19 m | 1355.67 m | **21.53 m** |

Full records: `reports/constructed_fragments_validation/endpoint_coverage_diagnosis.json`.

### 1.2 Excluded endpoint points (Section A2)

**Start (all boundaries, both segments):** 15 points, all from the **first temporal
frame** (frame index 0, e.g. frameId 16843 on seg14, 19243 on seg16), spanning
s = 0..42. Each has `supportFrameCount = 1` and a consistent confidence
(prob 0.663 on seg14, 0.858 on seg16). **Rejection stage: `groupObservations`
(minSupportCount gate).**

**End (seg16):** the last fragment ends at s≈1355.65; dots extend to s≈1377.19 across
8 unique along-track positions, but their lateral values **alternate** between
≈ −5.1 and ≈ −3.9 (and at s=1377.19 the same-position observations span d from −3.66
to −8.84) — a cross-lane / oscillating tail. Rejection: a mix of `orderAndDedupe`
(same-position multi-frame dedup) and `fragment-construction` (sub-minObservations
run). **Seg14 end** has only 2 unique positions (s=1344.3, 1345.2) below
`minObservations`.

### 1.3 Loss mechanism trace (Section A3)

| Gate | Effect at endpoints |
|------|---------------------|
| `minSupportCount` (groupObservations) | **PRIMARY start-loss**: frame-0-only points have support=1 → dropped. Not global noise (the dots show a clean monotonic boundary) |
| `orderAndDedupe` | End-only: same along-track position observed by several frames is deduped |
| `minObservations` (flush) | End-only: a tail run of <3 unique points is dropped |
| `smoothPoints` window | keeps endpoints (start/end raw) — not a loss source |
| `minFragmentLengthM`, tangent estimation, temporal filtering | not a loss source |
| causal / observation-isolation rebuild | not a loss source (full-route maps used) |

### 1.4 Classification (Section A4)

- **Start gap = valid points discarded at a sequence boundary.** The frame-0 dots are
  a clean, monotonic, geometrically-consistent continuation of the boundary: seg14 L0
  frame-0 dot at s=42.23 has d=−3.74, exactly the first fragment's first point; the
  frame-0 d sweep (−4.32 → −3.74) follows the same boundary. They are rejected only
  because no earlier temporal frame exists to raise support to 2.
- **End gap (seg16) = noisy/cross-lane observations correctly excluded**, not accidental
  removal. The alternating-d tail and the s=1377.19 (d −3.66..−8.84) cluster are not a
  reliable boundary continuation.
- **Seg14 end = sparse (2 unique points) below minObservations**, correctly excluded.
- **Rendering-only omissions: none** — the dots are drawn by the same accumulation
  layer; the gap is in the constructed-fragment pipeline.

---

## 2. Full-route extent (Section B)

Full-route coverage per boundary (all segments, complete route extent — not playback
position) in `reports/constructed_fragments_validation/route_extent_endpoint_coverage.json`.
Zoomed endpoint screenshots (dots + fragments + joined) in
`screenshots/endpoint_coverage/*.png` for Segments 14 and 16.

Key regression-segment endpoint coverage (report-only, no tuning):

| Segment | Boundary | START gap (pre) | END gap (pre) |
|---------|----------|-----------------|---------------|
| 2 | L0 / L1 / L2 | 31.6 / 0.04 / 378.26 m | 0 / 0 / 11.92 m |
| 6 | L0 | 4.1 m | 1.68 m |
| 54 | L0..L3 | 9.04..9.18 m | 2.35 / 1.1 / 0 / 0 m |
| 58 | L0 / L1 / L2 | 18.75 / 27 / 27 m | 0.58 / 294.88 / 20.25 m |
| 99 | L0 / L1 / L2 | 116.09 / 115.94 / 489.62 m | 0 / 0 / 4.3 m |

The large gaps on 58/99 are dominated by low-support sparse points (e.g. seg99 L2
start 489 m, 61/62 low-support) — genuine sparse/isolated data, not dense continuations.

---

## 3. Fix (Section C)

### 3.1 Mechanism

A one-sided **endpoint-extension** pass in `lib/constructed_fragments.js`
(`extendEndpoints` / `applyEndpointExtensions`, invoked inside
`buildConstructedFragments`). For each physical boundary, the FIRST fragment is
extended backward and the LAST fragment (by max end s) forward, using the **raw
accumulated points** (before the `minSupportCount` gate) on the exterior side.

### 3.2 Strict acceptance rules

- **Same physical boundary** (chunk/pass/groupTrackId) — no cross-boundary.
- **Monotonic along-track ordering** (no reversal) — prepended in ascending s.
- **Several consecutive observations** (`minEndpointExtensionObs` = 3).
- **Consecutive gaps bounded** (`maxEndpointExtensionGapM` = 14 m), including the
  fragment→first-extension-point gap (no bridging).
- **Lateral continuity** with the fragment's first/last point
  (`maxEndpointLateralDevM` = 3 m).
- **Tight per-step lateral step** (`maxEndpointStepLateralM` = 1 m) — stops an
  oscillating / cross-lane tail.
- **Lateral monotonicity** — the extension must trend steadily away from the anchor
  (deviation non-decreasing); a snap-back stops the walk.
- **Confidence floor** (`minEndpointProb` = 0.5).
- **Span cap** (`maxEndpointExtensionSpanM` = 120 m).
- **No extrapolation**: every extended point is an exact observed accumulated dot
  (verified byte-identical); no interpolation, no new coordinates beyond observed
  evidence.
- **Interior fragments untouched**; only the first/last fragment of a boundary gain
  points, only on the exterior side.
- `minSupportCount` is **not** lowered globally.

### 3.3 New configuration (in `DEFAULTS`, `lib/constructed_fragments.js`)

`endpointExtensionEnabled`, `minEndpointExtensionObs`, `maxEndpointExtensionGapM`,
`maxEndpointLateralDevM`, `maxEndpointExtensionSpanM`, `minEndpointProb`,
`maxEndpointStepLateralM`.

---

## 4. Output & verification (Section D)

### 4.1 Start/end coverage before and after

| Segment | Boundary | START gap before → after | END gap before → after | start excluded before → after |
|---------|----------|--------------------------|-------------------------|-------------------------------|
| 14 | L0/L1/L2 | 42.18 m → **0 m** | ~1 m → ~1 m | 15 → **0** |
| 16 | L0/L1/L2 | 42.19 m → **0 m** | 21.5 m → 21.5 m | 15 → **0** |
| 2 | L2 | 378.26 → 351.37 m (partial) | 11.92 → **0 m** | 12 → 3 |
| 6 | L0 | 4.1 → 4.1 m | 1.68 → 1.68 m | 2 → 2 |
| 54 | L0..L3 | 9.0..9.2 → **~0 m** | 2.35/1.1/0/0 → 2.35/0/0/0 | 7 → 0..1 |
| 58 | L0/L1/L2 | 18.75/27/27 → **0/0/0 m** | 0.58/294.88/20.25 → 0.58/288.71/20.25 | 10/12/12 → 0/0/0 |
| 99 | L0/L1/L2 | 116/116/490 → 100/116/490 m | 0/0/4.3 → 0/0/4.3 m | 54/46/62 → 45/46/62 |

Full table: `reports/constructed_fragments_validation/endpoint_coverage_before_after.json`.

### 4.2 Points recovered / still rejected

- **Recovered (start):** 15 points per boundary on Segments 14, 16 (all frame-0
  route-start). Also clean start runs recovered on 54 (7 each) and 58 (10-12 each).
- **Still rejected:** sparse/isolated or oscillating endpoint points — e.g. seg16 end
  tail (48), seg99 sparse starts, seg58 L1 end (294.88 m gap), seg6 (2 points below
  minObservations). **Reason each remains excluded**: low support and non-monotonic /
  oscillating lateral, or fewer than 3 consecutive points, or a large gap from the
  fragment.

### 4.3 Proofs

- **Recovered lines follow existing dots:** every extended point has an exact
  byte-identical source accumulated dot (`scripts/compare_endpoint_coverage.js`;
  verified for seg14 L0 — all 15 extended points match dots exactly).
- **No line extends outside accumulated evidence:** extension only copies observed
  points; no interpolation.
- **No new boundary crossing / reversal / unsupported bridge:** all 10 constructed-
  fragment validation checks PASS on seg14/16; joined-polylines show 0 cross-boundary
  connections, 0 along-track reversals (verified on seg14/16/6/99).
- **Seg6 and Seg99 hard splits intact:** seg6 = 4 fragments, 0 joined; seg99 =
  9 fragments, 0 joined; 0 cross-boundary in both.
- **Canonical + mirrored coords stay paired:** extended points carry
  `mirroredEast/mirroredNorth` (verified; mirror path unchanged).

### 4.4 Constructed-fragment and joining statistics before → after

| Metric | Seg 14 | Seg 16 |
|--------|--------|--------|
| constructed fragments | 37 → 37 | 17 → 17 |
| accepted connections (joined) | 19 → 19 | 13 → 13 |
| joined polylines | 6 → 6 | 4 → 4 |
| unjoined fragments | 12 → 12 | 0 → 0 |

Joining thresholds and decisions unchanged; the extended first fragments now make the
joined polylines start at the route start (seg16 JP1 begins at s≈0.01 instead of ≈42).

### 4.5 Test baseline before → after

| Suite | Before | After |
|-------|--------|-------|
| Full suite | 1,532 tests, 1,505 pass / 27 fail | **1,538 tests, 1,512 pass / 26 fail** (6 new tests pass; failure set identical — the 27→26 delta is the flaky Stage 19 concurrent-publication test passing this run) |
| New endpoint-extension tests | — | 6/6 pass |

**No new failure added.** The failing set is byte-identical to the pre-fix baseline
(verified leaf-by-leaf; no endpoint-extension failure).

### 4.6 Files changed

- `lib/constructed_fragments.js` — endpoint extension (`extendEndpoints`,
  `applyEndpointExtensions`), new `DEFAULTS` entries, wiring in
  `buildConstructedFragments`
- `public/constructed_fragments.js` — regenerated browser mirror
- `public/lane_joining.js` — regenerated (canonical; unaffected)
- `tests/constructed_fragments.test.js` — 6 new endpoint-extension tests (17→23)
- `scripts/diagnose_endpoint_coverage.js`, `scripts/diagnose_route_extent_coverage.js`,
  `scripts/compare_endpoint_coverage.js`, `scripts/summary_endpoint_coverage.js`,
  `scripts/capture_endpoint_coverage.js` — diagnostic + capture tooling
- `reports/constructed_fragments_validation/{endpoint_coverage_diagnosis,
  route_extent_endpoint_coverage,endpoint_coverage_before_after}.json`
- `screenshots/endpoint_coverage/*.png` — zoomed endpoint views (14, 16)

---

## Constraints honoured

- No joining threshold retuned; no mirror change; no tracking identity change.
- No lane topology inferred.
- Canonical and precomputed mirrored coordinates stay paired through the existing
  mirror path (extended points carry both).
- No commit, merge or push.
