# Amendment A — Compatibility Assessment

**Status:** DRAFT — NOT APPROVED  
**Specification version:** `stage20-amendment-a-spec-v3` (scope correction)

---

## v3 correction summary

| Item | v2 (withdrawn) | v3 (corrected) |
|------|----------------|----------------|
| `dividerCorridorId` semantics | Authoritative corridor identity | **Within-segment comparison key only** |
| Equal key text | Corridor-matched | **Comparison-key match** (same segment) or **key collision** (cross-segment) |
| Cross-pass promotion | Key equality sufficient | Requires **validated corridor linkage record** |
| Authoritative corridor ID | `dividerCorridorId` | **`roadCorridorId`** on linkage artifact |
| Real-data triplets | Corridor-matched provisional | **Cross-segment key-collision linkage hypotheses** |
| New artifact | — | `lane_divider_corridor_linkage_v0.json` (Stage 20 draft schema) |

---

## Selected model

**Option A + C:** No upstream authoritative cross-pass corridor mapping exists. Stage 20 evidence layer must create and validate corridor linkage records before structural promotion.

---

## Stage 19 v5 cross-pass consumer (documented defect)

`lib/stage19_cross_pass_production.js` groups by `parentTrackId|chunkId|poseSectionId` — broken because `parentTrackId` embeds pass.

**v3 consumer requirements:**

1. Index runs by `(segmentId, dividerCorridorId)` for comparison-key discovery
2. Promote only via `roadCorridorId` from validated linkage records
3. Never treat key text equality as corridor identity

| Classification | Component |
|----------------|-----------|
| **INV** | `lib/stage19_cross_pass_production.js` |
| **NC** | Published v5 bundle |

---

## Schema and artifacts

| Component | Classification | v3 notes |
|-----------|----------------|----------|
| `lane_divider_supported_runs_v0.json` | **NC** | Immutable |
| `lane_divider_supported_runs_v1.json` | **ADD** | Comparison key on runs |
| `lane_divider_corridor_linkage_v0.json` | **ADD** (Stage 20) | Authoritative corridor grouping |
| Stage 19 v5 bundle | **NC** | Immutable |

---

## Production modules

| Module | Classification | v3 notes |
|--------|----------------|----------|
| `lib/stage17_supported_run_fusion.js` | **MIG** | `flushRun()` emission only |
| `lib/stage19_cross_pass_production.js` | **VER** | Linkage-aware rewrite |
| Stage 20 linkage validator | **ADD** (future) | Not Amendment A implementation |
| `lib/stage19_spec/*` | **NC** | Protected |

---

## Independent validation boundary

Amendment A metadata propagation (v1 runs) validates **independently** of corridor linkage availability. Zero structural candidates from missing linkage is expected and valid.

| Boundary | Status |
|----------|--------|
| Rev 37 `maxSpatialJumpM: 12` | **NC** |
| Stage 19 v5 | **NC** |
| Frozen v11 | **NC** |
| `current.json` | **NC** |

---

## Risk summary (v3)

| Risk | Mitigation |
|------|------------|
| Comparison key mistaken for corridor identity | `A-XPS-012`; explicit evidence states |
| Cross-segment numeric coincidence | `A-XPS-013`; alignment record required |
| Zero candidates misread as spec failure | SAT-5; linkage unavailable is valid |
| Amendment A blocked on linkage | Propagation independent; linkage is Stage 20 layer |

---

*v3 compatibility assessment — not implementation.*
