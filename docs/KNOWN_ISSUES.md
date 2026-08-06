# Known Issues

**Last updated:** 2026-07-28

Issues are classified: **Open**, **Resolved**, or **Accepted** (known limitation, no immediate fix planned).

---

## Open Issues

### KI-001: 12 m spatial cap vs ~33 m median displacement

| Field | Detail |
|-------|--------|
| **Status** | **Open** |
| **Evidence** | Median consecutive spatial separation 32.984 m; approved cap 12 m (`lib/stage19_spec/config.js`); 81.39% first-failure `spatial_distance` (`reports/stage19_dataset_sensitivity_investigation.json`) |
| **Impact** | All 5,809 real-dataset observations form singleton chains; zero multi-observation Stage 19 chains |
| **Proposed next investigation** | Stage 20 read-only design: distinguish motion-aware linking from static spatial cap; do **not** treat experimental 50 m overlay as approved fix |
| **Note** | No threshold correction approved |

---

### KI-002: Missing explicit pass and chunk metadata on supported runs

| Field | Detail |
|-------|--------|
| **Status** | **Implemented (v1 artifact)** — cross-pass blocked pending validated linkage records |
| **Evidence** | 878/878 `supportedRuns` lack `temporalPassId` and `chunkId` (`reports/stage19_dataset_sensitivity_investigation.json` → `dataAlignment`) |
| **Impact** | Zero genuine cross-pass candidates; cross-pass conflict evidence unavailable |
| **Proposed next investigation** | Review `deliverables/stage20-amendment-a-specification.md` (v3); implement v1 emission after approval |
| **Note** | Metadata fix alone may not create multi-obs chains under 12 m cap |

---

### KI-003: Zero real multi-observation Stage 19 chains

| Field | Detail |
|-------|--------|
| **Status** | **Open** |
| **Evidence** | Baseline audit: 5,809 singleton, 0 multi-obs; 573 Stage 17 multi-obs tracks upstream |
| **Impact** | P3 path untested on real data (0/0/0); sensitivity table records zero deltas |
| **Proposed next investigation** | Root cause attributed to matching/filtering logic per investigation conclusion; Stage 20 design to scope remediation options without premature implementation |

---

### KI-004: Zero genuine cross-pass evidence

| Field | Detail |
|-------|--------|
| **Status** | **Open** |
| **Evidence** | crossPassCandidates: 0; conflictEvidenceAvailable: false (`audit_stage19_dataset_sensitivity.json`) |
| **Impact** | Cross-pass conflict detection, promotion, and BEV cross-pass paths unvalidated on real data |
| **Proposed next investigation** | Metadata propagation (KI-002) plus multi-obs chain formation (KI-003) |

---

### KI-005: Segment-specific limitations

| Field | Detail |
|-------|--------|
| **Status** | **Open** |
| **Evidence** | Stage 15 coverage outliers {57, 62, 65, 66, 96}; 13 zero-polygon segments (Stage 13); segment-specific diagnostics in `lib/stage14_delivery_readiness.js` |
| **Impact** | Uneven evidence density across 92 segments; some segments contribute no v11 polygons |
| **Proposed next investigation** | Document per-segment exclusion in Stage 20 design; no geometry reopen without separate approval |

---

### KI-006: Production lane counting disabled

| Field | Detail |
|-------|--------|
| **Status** | **Open** (by design, pending future stage) |
| **Evidence** | `productionLaneCountImplemented: false` in all Stage 19 audits and reports |
| **Impact** | Same-direction lane counts remain prototype/unknown; 5 intervals assessed as insufficient_evidence |
| **Proposed next investigation** | Stage 20+ specification; depends on resolving KI-001–KI-004 |

---

### KI-007: HD-map output incomplete

| Field | Detail |
|-------|--------|
| **Status** | **Open** |
| **Evidence** | `hdMapSystemComplete: false`; Stage 14 status: baseline delivery-ready for conservative polygons, not completed HD-map (`lib/stage14_delivery_readiness.js`) |
| **Impact** | No production HD-map deployment authorized |
| **Proposed next investigation** | Out of Stage 19 scope; Stage 20 design may define boundaries |

---

### KI-008: Stage 12B camera validation blocked

| Field | Detail |
|-------|--------|
| **Status** | **Open** |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` § Stage 12B — blocked pending imagery acquisition |
| **Impact** | Cannot independently verify physical-road alignment; BEV consistency ≠ physical accuracy |
| **Proposed next investigation** | Imagery acquisition track; do not guess calibration |

---

### KI-009: Qlog files may be absent from workspace

| Field | Detail |
|-------|--------|
| **Status** | **Open** (environment) |
| **Evidence** | `server.js` lists segments from project root; workspace check found 0 `qlog_f449c_*.bz2` files |
| **Impact** | Live extraction/processing and segment-dependent audits cannot run without data files |
| **Proposed next investigation** | Place qlog segments in project root per `RUN_GUIDE.md` |

---

### KI-010: Amendment B threshold evidence insufficient

| Field | Detail |
|-------|--------|
| **Status** | **Open** |
| **Evidence** | Only 20 no-boundary pairs; 0 Rev37-valid continuations in automated sample; need ≥ 200 reviewed pairs (`reports/stage20_design_investigation.json`) |
| **Impact** | Cannot approve motion-aware residual cap or precision/recall targets |
| **Proposed next investigation** | Expand ground-truth with qlog video; manual review of valid continuations |

---

## Resolved Issues

### KI-R001: Stage 19 v4 partial verification gaps (D1, D2, D3, D6)

| Field | Detail |
|-------|--------|
| **Status** | **Resolved** in v5 |
| **Evidence** | `reports/stage19_v5_corrective_checkpoint_report.json` → all VERIFIED |
| **Resolution** | v5 corrective checkpoint closed P3-through-bundle, same-pass conflict, fencing trace, rejected partition paths |

---

### KI-R002: v7→v8 pose-section regression (zero-polygon increase)

| Field | Detail |
|-------|--------|
| **Status** | **Resolved** |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` — pose continuity v10 fix |
| **Resolution** | Circular-speed fix in `lib/pose_continuity.js` v10 |

---

### KI-R003: modelV2 lane slot misidentification

| Field | Detail |
|-------|--------|
| **Status** | **Resolved** |
| **Evidence** | `checkpoints/admiral-investigation-2026-07-23.md` — right ego index 0→1 |
| **Resolution** | Corrected slot semantics in decoder/extraction |

---

### KI-R004: Publication lifecycle staging residue / overlap races

| Field | Detail |
|-------|--------|
| **Status** | **Resolved** in v4/v5 |
| **Evidence** | `reports/stage19_v4_corrective_checkpoint_report.json`; 30/30 repeat in v5 |
| **Resolution** | `lib/stage19_publication_fs.js` heartbeat/rename fencing; overlap test suite |

---

## Accepted Limitations

### KI-A001: modelV2 ~0.5 Hz sampling rate

| Field | Detail |
|-------|--------|
| **Status** | **Accepted** |
| **Evidence** | Median temporal separation ~2.0 s; ~31 frames/segment typical (`checkpoints/admiral-investigation-2026-07-23.md`) |
| **Impact** | Vehicle motion between frames contributes to spatial separation at fixed time gaps |
| **Note** | Structural limit; not a bug — informs Stage 20 motion-aware linking design |

---

### KI-A002: Stage 18 prototype thresholds

| Field | Detail |
|-------|--------|
| **Status** | **Accepted** |
| **Evidence** | `lib/stage18_lane_interval_schema.js` — "Prototype assessment settings — not validated production thresholds" |
| **Impact** | Interval assessments are exploratory, not production lane counts |

---

### KI-A003: Rev 37 spec document header stale

| Field | Detail |
|-------|--------|
| **Status** | **Accepted** (protected file) |
| **Evidence** | `docs/stage19_revision37_specification.md` header says "pending final review"; implementation bound to `deliverables/stage19-revision37/` |
| **Impact** | Documentation discrepancy only; normative package verified by hash |

---

### KI-010: Amendment B threshold evidence insufficient

| Field | Detail |
|-------|--------|
| **Status** | **Open** |
| **Evidence** | 220-pair review manifest prepared; **0** manual `reviewerLabel` values; 20 rule-derived `valid_same_track_continuation` (not ground truth) |
| **Impact** | Cannot approve `RESIDUAL_CAP_M` or precision/recall targets |
| **Proposed next investigation** | Manual qlog video review per `deliverables/stage20-b-motion-evidence-review-spec.md` |
| **Note** | 92 qlog files present in workspace — video review may proceed; labels still required |

---

### KI-011: Amendment A rejection codes without direct unit tests

| Field | Detail |
|-------|--------|
| **Status** | **Resolved** (2026-07-28) |
| **Codes** | `A-ART-001`, `A-ART-002`, `A-LNK-004` — tests T-A-054, T-A-055, T-A-056 |
| **Impact** | Coverage gap closed |

---

### KI-012: Stage 19 concurrent-publication flaky test

| Field | Detail |
|-------|--------|
| **Status** | **Open** (intermittent) |
| **Test** | `Stage 19 v4 overlapping publication` — child process concurrent publication |
| **Impact** | Occasional full-regression failure; passes on rerun |
| **Note** | Pre-existing; unrelated to Amendment A/B |

---

## Issue Tracking Rule

When an issue changes status, update this file and append to [DEVELOPMENT_LOG.md](./DEVELOPMENT_LOG.md). Do not describe proposed solutions as approved until explicitly authorized.
