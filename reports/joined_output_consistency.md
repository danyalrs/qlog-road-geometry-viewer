# Joined-Output Consistency & Lane-Colour Diagnosis — Report

**Status:** DIAGNOSED + FIXED.
**Date:** 2026-08-12
**Scope:** (1) every valid constructed fragment must appear in the solid "Joined lane
polylines" layer; (2) establish the meaning of orange lane geometry. No joining
thresholds retuned. No mirror change. No tracking identity change. No commit/merge/push.

---

## 1. Root cause of incomplete solid-line coverage

`joinConstructedFragments` (`lib/lane_joining.js`) built joined polylines **only** from
accepted-connection chains (`chainJoins`). Fragments with no accepted connection were
omitted entirely — there was **no singleton treatment**. Specifically:

- A **chain head** (first fragment of a boundary) that has no accepted *successor* was
  dropped (e.g. `CF0@0.0` on Segments 14/16/20 — the very fragment carrying the
  endpoint-extension recovery).
- An **isolated fragment** with neither predecessor nor successor was dropped.
- A fragment whose only candidates were ambiguous/rejected was dropped.

Measured (before fix):

| Segment | constructed fragments | in joined | missing |
|---------|----------------------|-----------|---------|
| 14 | 37 | 25 | **12** |
| 16 | 17 | 17 | 0 |
| 20 | 80 | 35 | **45** |

The missing fragments included the route-start first fragments (CF0 on every boundary),
which is why "solid lines begin later" than the dashed fragments.

### 1.1 Exact code path

`joinConstructedFragments` → `generateCandidates` (bounded spatial search) →
`evaluateCandidate` (10 checks) → `selectJoins` (mutual-best, margin, no branching) →
`chainJoins` (paths from accepted connections) → `buildPathPolyline`. The omission was
in the **chain→polyline step**: fragments not in any `chosen` connection never entered
`paths`, so they never became polylines.

### 1.2 Fix (Part B)

Every valid constructed fragment is now treated as a graph node; accepted connections
are edges; disjoint components are built. A component with accepted connections becomes
a multi-fragment polyline; a component with no connections becomes a **one-fragment
singleton**. The ordered joined geometry is:

```
complete first fragment → accepted connector → complete second fragment → ...
```

Added to `joinConstructedFragments`: after `chainJoins`, every fragment not already in a
chain is pushed as a `[fragment]` singleton path. `buildPathPolyline` handles the
singleton case (full geometry, zero connectors, `groupTrackId` carried for colouring).

**Integrity invariant (Part B) — every valid constructed fragment appears exactly once:**

| Segment | constructed | represented | missing | duplicates |
|---------|-------------|-------------|---------|------------|
| 14 | 37 | 37 | **0** | **0** |
| 16 | 17 | 17 | **0** | **0** |
| 20 | 80 | 80 | **0** | **0** |
| 2 | 33 | 33 | **0** | **0** |
| 6 | 4 | 4 | **0** | **0** |
| 54 | 24 | 24 | **0** | **0** |
| 58 | 18 | 18 | **0** | **0** |
| 99 | 9 | 9 | **0** | **0** |

---

## 2. Exact meaning of the orange geometry (Part D/E)

### 2.1 Identity fields (Part D)

| Field | Meaning | Colour selector |
|-------|---------|-----------------|
| `modelX/modelY` | raw model detection in the vehicle-relative frame | — |
| `laneIndex` | the model's **lane slot in one frame** (0=outer-right, 1=inner-right ego, 2=inner-left ego, 3=outer-left) | was: fragments/joined hard-coded `laneColors[laneIndex]` |
| `laneTrackId` | the per-frame **track id** assigned by lane tracking (frame-to-frame) | dots partially (diagnostic) |
| `groupTrackId` | the **grouped physical boundary** identity in the accumulated map (stable per chunk/pass) | **dots + (now) fragments/joined** via `trackColor(groupTrackId)` |
| `physicalBoundaryId` | `chunkId:passId:groupTrackId:laneIndex` (joined output) | not the primary colour key |

### 2.2 The orange geometry

Orange = `#ca8a04` = `trackColor(3)` = **`groupTrackId === 3`**, present on 40 of the
segments. On Seg20 (detailed audit):

| Property | Value |
|----------|-------|
| identity | `groupTrackId=3`, `laneIndex=3`, `side=left` |
| lateral position | d ≈ 2.98..3.76 m — **spatially separate** from gt2 (0.28..1.18 m) |
| observations | ~26 per frame, consistent confidence (0.58..0.72) |
| frames present | 0-14, 20-22, 24-29 (intermittent) |
| first-seen | frame 0 (4 boundaries present from route start) |
| separate track? | yes — own identity, own observations, own lateral position |

**Conclusion: the orange is a legitimate additional outer-left lane boundary
(groupTrackId=3)**, intermittently detected. It is **not** a colour bug, not a debug
connector, not a rendering-state leak. Per the task, it is preserved with its own
identity and colour. It appears as a separate boundary beside gt2, does not overlap or
merge with it.

### 2.3 Colour-selection inconsistency found and fixed (Part F)

The dots colour by `groupTrackId` (`trackColor`: gt0=blue, gt1=red, gt2=green,
gt3=orange). The fragments and joined polylines coloured by a **hard-coded
`laneColors[laneIndex]`** map (laneIndex 0=teal, 1=violet, 2=green), which disagreed
with the dots for L0/L1/L2 (teal vs blue, violet vs red) and fell back to
`trackColor` only for laneIndex≥3. This made the SAME physical boundary render in
different colours depending on layer.

Fix: added a shared `boundaryColor(groupTrackId)` resolver in `public/render.js` and
used it in `_drawConstructedFragments` and `_drawJoinedPolylines`. Now fragments, joined
polylines and dots all use the **same stable boundary colour**:

| groupTrackId | colour |
|--------------|--------|
| 0 | blue `#2563eb` |
| 1 | red `#dc2626` |
| 2 | green `#16a34a` |
| 3 | orange `#ca8a04` (legitimate 4th boundary) |

Missing identity returns an explicit diagnostic (orange `#f97316` + message), never a
silent fallback. Amber/red/brown decision colours remain **only** in "Join candidates
(debug)"; enabling/disabling the debug layer does not recolour normal geometry.
fragmentId/joinedPolylineId/array index do **not** determine normal boundary colour.

### 2.4 Identity/colour transitions

No false identity transitions were found in the normal joined layer — each stable
boundary keeps one colour. The gt3 boundary's intermittent appearance (frames 0-14,
20-22, 24-29) is a **detection-availability change**, not an identity switch: it keeps
`groupTrackId=3` throughout.

---

## 3. Rendering (Part C)

- Solid joined geometry follows dashed fragment geometry **exactly**: 100% of fragment
  points (1789/1749/1992 on seg14/16/20) appear verbatim in the joined geometry.
- Real gaps (ambiguous/rejected/prohibited connectors) remain visible — no stretching
  or interpolation across rejected gaps.
- Singleton fragments remain visible (not hidden for lacking a connector).
- Draw order: fragments → join-candidates (debug) → joined polylines (solid, thicker,
  drawn on top). Accepted connectors in the normal layer inherit the boundary colour.
- Labels/hover reference correct fragment + joined-polyline IDs.

---

## 4. Per-segment table (Part K)

| Segment | constructed | represented | missing | dup | singleton poly | multi poly | accepted conn | ambiguous | rejected |
|---------|-------------|-------------|---------|-----|----------------|------------|---------------|-----------|----------|
| 14 | 37 | 37 | 0 | 0 | 12 | 6 | 19 | 11 | 12 |
| 16 | 17 | 17 | 0 | 0 | 0 | 4 | 13 | 0 | 1 |
| 20 | 80 | 80 | 0 | 0 | 45 | 14 | 21 | 21 | 153 |
| 2 | 33 | 33 | 0 | 0 | — | — | 6 | 14 | 28 |
| 6 | 4 | 4 | 0 | 0 | 4 | 0 | 0 | 0 | 6 |
| 54 | 24 | 24 | 0 | 0 | 24 | 0 | 0 | 0 | 69 |
| 58 | 18 | 18 | 0 | 0 | 18 | 0 | 0 | 7 | 16 |
| 99 | 9 | 9 | 0 | 0 | 9 | 0 | 0 | 0 | 3 |

---

## 5. Before/after start coverage (Segments 14, 16, 20)

Joined polylines now begin at the supported route start for every boundary's first
fragment (previously the first fragment was omitted when it had no accepted successor):

| Segment | boundary | first fragment start s | joined polyline start s (after fix) |
|---------|----------|------------------------|-------------------------------------|
| 14 | gt0 | 0.04 | **0.04** |
| 14 | gt1 | 0.02 | **0.02** |
| 14 | gt2 | 0.00 | **0.00** |
| 16 | gt0 | 0.01 | **0.01** |
| 16 | gt1 | 0.00 | **0.00** |
| 16 | gt2 | 0.00 | **0.00** |
| 20 | gt0 | 0.00 | **0.00** |
| 20 | gt1 | 0.00 | **0.00** |
| 20 | gt2 | 0.01 | **0.01** |
| 20 | gt3 | 0.04 | **0.04** |

---

## 6. Frame-by-frame orange audit (Part E, Segment 20)

| frame | gt3 present | gt3 side | gt3 lateral (d) | # boundaries | note |
|-------|-------------|----------|-----------------|--------------|------|
| 0 | yes | left | 2.98..3.76 | 4 | first detection |
| 12 | yes | left | ~4.22 | 4 | middle |
| 15-19 | no | — | — | 3 | gt3 absent |
| 20-22 | yes | left | — | 4 | reappears |
| 24-29 | yes | left | ~4.75 | 4 | stable |
| 29 | yes | left | 4.75..4.68 | 4 | last |

gt3 remains spatially separate from gt2 throughout (d 2.98..3.76 vs 0.28..1.18 in frame
0). It does not cross, overlap or duplicate an existing boundary.

---

## 7. Tests (Part I)

Added to `tests/lane_joining.test.js` (now 24 tests, was 16):
17 every-fragment-once, 18 complete chain first/last, 19 endpoint-extension in joined,
20 ambiguous connectors don't create edges but fragments stay visible, 21 source
unchanged, 22 groupTrackId carried, 23 singleton complete geometry + zero connectors,
24 real-segment integrity.

Mirror/arrow protections (Part H) verified: fragments + joined move together on toggle
(4.3 px each), arrow shift 0.00 px, fragment-vs-joined screen distance 0.0 px.

---

## 8. Regression (unchanged thresholds, Segments 2, 6, 54, 58, 99)

All invariant checks PASS (no boundary mixing, no crossing, no reversal, no unsupported
gap, source unchanged). Segments 6/54/58/99 now show **all** valid fragments as solid
singletons (previously 0 joined polylines → now 4/24/18/9), satisfying "valid fragments
on both sides of a gap remain visible."

---

## 9. Test baseline before/after

| Suite | Before | After |
|-------|--------|-------|
| Full suite | 1,538 tests, 1,512 pass / 26-27 fail | **1,546 tests, 1,519 pass / 27 fail** |
| `tests/lane_joining.test.js` | 16 | **24** (8 new, all pass) |

Failing set identical to baseline (27 same leaf failures; the aggregate count flip is
the known-flaky Stage 19 concurrent-publication test). **No new failure added.**

---

## 10. Files changed

- `lib/lane_joining.js` — singleton components in `joinConstructedFragments`;
  `groupTrackId`/`side` on joined polyline output.
- `public/lane_joining.js` — regenerated mirror.
- `public/render.js` — shared `boundaryColor(groupTrackId)` resolver; fragments and
  joined polylines colour by stable boundary identity (not `laneColors[laneIndex]`).
- `tests/lane_joining.test.js` — 8 new integrity/colour tests.
- `scripts/capture_consistency.js` — Part J screenshots.
- `screenshots/joined_consistency/*.png` — 13 views per segment (14, 16, 20) + orange
  frame sequence.

## 11. Known limitations

- The joined/dots colour palette for L0/L1/L2 changed from (teal/violet/green) to
  (blue/red/green) to match the dots — a deliberate alignment to the stable-boundary
  resolver. This is a viewer colour change, not a geometry/identity change.
- The gt3 (orange) boundary is intermittent by detection availability; it is a genuine
  additional track and is preserved.
- No forks/merges/topology inferred; a fragment has at most one predecessor and one
  successor.

## Constraints honoured

No joining threshold retuned; no mirror change; no tracking identity change; no
lowering of support thresholds; no merging of separate tracks; no cosmetic colour
override concealing a real error; no commit/merge/push.
