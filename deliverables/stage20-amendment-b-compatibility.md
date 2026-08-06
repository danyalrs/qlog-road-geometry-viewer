# Amendment B — Compatibility and Impact Analysis

**Status:** DRAFT — NOT APPROVED  
**Specification version:** `stage20-amendment-b-spec-v1`  
**Parent:** [stage20-amendment-b-specification.md](./stage20-amendment-b-specification.md)

---

## 1. Relationship to Amendment A v3

| Amendment A component | Amendment B impact |
|----------------------|-------------------|
| `lane_divider_supported_runs_v1.json` | **Consumer** (B-TRAV); B-MOTION does not modify v1 emission |
| `dividerCorridorId` | Comparison key only — B-TRAV must not treat as corridor proof |
| Corridor linkage schema | **Prerequisite** for validated traversal linkage |
| `evaluateCrossPassPair()` | **Consumer** of `traversalLinkageByPair` — B-TRAV defines artifact that populates this |
| Amendment A error codes | Unchanged; B-TRAV adds `B-TRV-*` and `B-MOT-*` namespaces |
| Amendment A checkpoint | Additive reference only — no rewrite |

### Amendment A hardening (separate patch)

| Code | Recommendation |
|------|----------------|
| `A-ART-001` | Add envelope test before B-MOTION |
| `A-ART-002` | Add count mismatch test |
| `A-LNK-004` | Add endpoint FK mismatch test |

Not part of Amendment B semantics.

---

## 2. Relationship to Stage 19 v5

| Component | B-MOTION | B-TRAV |
|-----------|----------|--------|
| `lib/stage19_spec/geometry.js` | **No in-place edit** — new module | No change |
| `lib/stage19_spec/config.js` | **Protected** — `maxSpatialJumpM: 12` when disabled | No change |
| Published v5 bundle | **Immutable** | No change |
| `stage19_bundle/current.json` | **No change** | No change |
| Partition production | Optional future consumer of motion module | No change |
| P3 path selection | May increase eligible branches when B-MOTION enabled on **new** runs | No direct change |

---

## 3. Relationship to frozen v11 geometry

| Item | Impact |
|------|--------|
| `lib/version.js` `PROCESSING_VERSION` | Unchanged |
| `audit_reference_v11.json` | Unchanged |
| `audit_dataset_v11_full.json` | Unchanged |
| v11 frame fields (`chunkId`, `temporalPassId`, etc.) | Upstream source only |

B-MOTION consumes Stage 16 pose fields derived from v11 processing — does not alter geometry.

---

## 4. Relationship to Stage 16 / 17

| Module | B-MOTION | B-TRAV |
|--------|----------|--------|
| `projected_lane_observations_v0.json` | Reads pose, speed, route-s | Reads motion evidence |
| `lane_divider_tracks_v0.json` | Indirect via matches | FK for endpoints |
| `stage17_supported_run_fusion.js` | No change to `flushRun()` | No change |
| `movement_state.js` | Ephemeral — optional export to audit | Optional in evidence records |
| `pose_continuity.js` | Upstream only | Upstream only |

---

## 5. Consumer matrix

| Consumer | B-MOTION enabled | B-TRAV artifacts present |
|----------|------------------|-------------------------|
| Stage 19 partition (new runs) | Different chain counts possible | No effect |
| Stage 19 v5 bundle (frozen) | No effect | No effect |
| Amendment A cross-pass | No effect | Enables `genuine` when corridor also validated |
| Lane counting / P3 | Indirect via chains | No effect until cross-pass promoted |
| Production deployment | **Not authorized** | **Not authorized** |

---

## 6. Versioning and checkpoints (planned)

| Checkpoint | When | Rollback |
|------------|------|----------|
| `stage20-amendment-b-motion-pre` | Before motion module | Disable module |
| `stage20-amendment-b-motion-post` | After motion validation | Revert to Rev 37 linking |
| `stage20-amendment-b-trav-pre` | Before traversal validators | No traversal artifacts |
| `stage20-amendment-b-trav-post` | After traversal validation | Remove traversal artifacts |

**Not created during specification phase.**

---

## 7. Files that must remain immutable during B specification

- `lane_divider_supported_runs_v0.json`
- `lane_divider_supported_runs_v1.json` (approved baseline)
- `stage19_bundle/current.json`
- `stage19_bundle/runs/2026-07-27-stage19-v{1..5}/**`
- `lib/stage19_spec/**` (Rev 37 protected set)
- `lib/version.js`
- v11 audit artifacts
- Amendment A checkpoint (additive reference only)

---

## 8. Known issues (retained)

| ID | Issue | Amendment B relation |
|----|-------|---------------------|
| KI-001 | 12 m spatial cap vs ~33 m displacement | B-MOTION addresses |
| KI-010 | Insufficient ground truth for motion threshold | Blocks B-MOTION approval |
| KI-009 | No qlog video | Blocks precision/recall targets |
| Flaky concurrent publication | Stage 19 v4 test | Unrelated — retain as separate issue |

---

## 9. Deployment boundaries

| Action | Authorized by this spec? |
|--------|-------------------------|
| Implement B-MOTION | No |
| Implement B-TRAV validators | No |
| Publish new Stage 19 bundle | No |
| Change `current.json` | No |
| Enable P3 on real data | No |
| Enable lane counting | No |
| Promote Amendment A v1 to production | No |

---

*Compatibility analysis v1 — specification only.*
