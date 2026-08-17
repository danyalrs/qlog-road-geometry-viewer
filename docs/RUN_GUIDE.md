# Run Guide

**Last updated:** 2026-08-17

Verified commands from `package.json`, scripts, and specification docs. Mark **(uncertain)** where environment-specific or data-dependent.

---

## Prerequisites

| Requirement | Source |
|-------------|--------|
| Node.js | Required; `--expose-gc` needed for tests and evidence |
| npm | `package.json` scripts |
| Qlog segments | `qlog_f449c_{N}.bz2` in project root — **required for full-dataset processing** |
| Upstream artifacts | `projected_lane_observations_v0.json`, Stage 17/18 audit JSON for Stage 19 |

**Note:** If qlog files are absent, segment listing and extraction will return empty; Stage 19 audit may still run against committed upstream JSON artifacts.

---

## Install Dependencies

```bash
npm install
```

Source: `package.json`, `docs/stage19_revision37_specification.md`.

---

## Start the Webpage Viewer

```bash
npm start
```

Equivalent:

```bash
node server.js
```

- Default port: **3847**
- Override: `PORT=8080 npm start` **(uncertain on Windows — use `set PORT=8080` in cmd or `$env:PORT=8080` in PowerShell)**

Open browser to `http://localhost:3847`.

### Experimental fitted layer (`?fit=1`)

Path 1 graph fitting is **off by default**. To enable the experimental fitted-layer overlay in the viewer:

```
http://localhost:3847/?fit=1
```

Or use the **Hybrid fitted lane map (experimental)** checkbox in the viewer UI after load (requires `?fit=1`). Fitting runs on the complete local map only (not during causal playback).

**Hybrid layer (recommended when exploring fits):**

- Viewer path: **Local playback** → **Point-accumulated geometry**
- Checkbox: **Hybrid fitted lane map (experimental)** (off by default)
- Solid cyan 4 px = accepted graph fit (`acceptedFit`)
- Coloured dashed 2 px = original constructed-fragment fallback (`fragmentFallback`)
- Unsupported gaps remain open; exactly one hybrid boundary per fragment
- Constructed-fragment layer is visually suppressed while hybrid is active (checkbox state unchanged)
- Fitted endpoints: separate diagnostic toggle

Fitted and hybrid output does **not** feed polygons. Processing version remains `2026-07-24-fusion-v16`.

**Accepted counts (viewer-authoritative, fusion-v16):** Seg2 **4**, Seg3 **11**, Seg9 **0**, Seg14 **7**, Seg16 **9**, Seg54 **0**, Seg58 **0**, Seg95 **0**, Seg99 **0**.

Source: `server.js`, `package.json`, `reports/hybrid_validation/HYBRID_VALIDATION_REPORT.md`.

---

## Run Tests

Full test suite (requires `--expose-gc`):

```bash
npm test
```

Equivalent:

```bash
node --expose-gc --test tests
```

**Verified result (2026-08-17):** 1723 tests, 1695 pass, 28 fail (27 documented baseline + 1 environmental Stage 7 OneDrive write flake; passes in isolation), 0 skipped. Requires `--expose-gc` for Stage 19 memory-oracle tests. Full output: `.cache/hybrid_full_suite.txt`.

Focused graph-fit + hybrid validation:

```bash
node --expose-gc --test tests/graph_fit.test.js tests/viewer_probe_parity.test.js
```

**Verified result (2026-08-17):** 86 tests, 86 pass, 0 fail (~6 min). Includes hybrid boundary tests 70–74.

Focused graph-fit validation (graph_fit only):

```bash
node --expose-gc --test tests/graph_fit.test.js
node --expose-gc --test tests/viewer_probe_parity.test.js
node --expose-gc --test tests/video_restore.test.js
```

**Historical result (Stage 19 v5):** 432 pass, 0 fail (`reports/stage19_v5_corrective_checkpoint_report.json`).

### Stage 19–focused test files

```bash
node --expose-gc --test tests/stage19_partition_matrix.test.js
node --expose-gc --test tests/stage19_conflict_bundle.test.js
node --expose-gc --test tests/stage19_publication_fencing.test.js
node --expose-gc --test tests/stage19_api.test.js
node --expose-gc --test tests/stage19_api_http.test.js
node --expose-gc --test tests/stage19_dataset_sensitivity.test.js
```

Source: `reports/stage19_v5_corrective_checkpoint_report.json` → `changedFiles`.

---

## Stage 19 Evidence and Review

Normative evidence runner:

```bash
npm run stage19:evidence
```

Equivalent:

```bash
node --expose-gc scripts/stage19_evidence_runner.js
```

Independent normative review:

```bash
node scripts/stage19_independent_review.js
```

Source: `package.json`, `docs/stage19_revision37_specification.md`.

---

## Run Stage 19 Dataset-Sensitivity Audit

Publish audit and bundle (uses current implementation checkpoint):

```bash
npm run stage19:audit
```

Equivalent:

```bash
node stage19_dataset_sensitivity_audit.js
```

### Options

```bash
node stage19_dataset_sensitivity_audit.js --out audit_stage19_dataset_sensitivity.json --bundle-dir stage19_bundle --run-id 2026-07-27-stage19-v5
```

Source: `stage19_dataset_sensitivity_audit.js` → `parseArgs()`.

**Output:** `audit_stage19_dataset_sensitivity.json`, bundle under `stage19_bundle/runs/{runId}/`.

---

## Reproduce Dataset-Sensitivity Investigation (Read-Only)

```bash
node reports/stage19_dataset_sensitivity_investigation_runner.js
```

**Does not modify** production code, published bundles, or `current.json`.

**Output:**

- `reports/stage19_dataset_sensitivity_investigation.json`
- `reports/stage19_dataset_sensitivity_investigation.md`

Source: `reports/stage19_dataset_sensitivity_investigation_runner.js` header.

---

## Constructed-Fragments Audit (Experimental, Display-Only)

```bash
node scripts/audit_constructed_fragments.js
```

Runs the constructed lane-boundary fragment layer across a sample of segments
(default: 0, 7, 13, 14, 22, 50) and reports fragment counts, lengths, residuals,
split reasons, and source-point preservation. Specify a custom sample with filenames
or indices, e.g. `node scripts/audit_constructed_fragments.js qlog_f449c_14.bz2` or
`node scripts/audit_constructed_fragments.js 2 13 22`.

**Experimental output only** — the constructed-fragment layer is a display-only
diagnostic and never feeds production lane geometry. See
`reports/constructed_fragments_experimental.md`.

---

## Lane-Joining Validation (Experimental, Display-Only)

```bash
node scripts/validate_lane_joining.js      # Segments 14, 16 — all K-checks
node scripts/regression_lane_joining.js    # Segments 2, 6, 54, 58, 99
node scripts/capture_lane_joining.js       # before/after + video screenshots
node --test tests/lane_joining.test.js     # 16 unit tests
```

The joining stage (`lib/lane_joining.js`) joins only compatible constructed fragments
(same chunk/pass/physical boundary, forward in s, evidence corridor, mutual-best, no
branching). Thresholds are fixed in `JOINING_DEFAULTS` and were derived from Segments
14/16 only. Output is experimental and never feeds production geometry. See
`reports/lane_joining_stage.md`.

---

## Publication Repeat Validation

```bash
node scripts/stage19_rerun_publication_repeat.js
```

Default: 30 repetitions. Override:

```bash
STAGE19_RERUN_REPEAT=10 node scripts/stage19_rerun_publication_repeat.js
```

**(uncertain on Windows — use `$env:STAGE19_RERUN_REPEAT=10` in PowerShell)**

Source: `scripts/stage19_rerun_publication_repeat.js`.

---

## Extract modelV2 and GPS

```bash
npm run extract
```

Or individually:

```bash
npm run extract-modelv2
npm run extract-gps
```

Source: `package.json`.

**(uncertain)** Extraction requires qlog files in project root and may write `modelV2_extracted.json` / `gps_extracted.json` — confirm paths in `extract_modelv2.js` / `extract_gps.js` before running in production environments.

---

## Verify modelV2 Event Frequency

```bash
node verify_model_frequency.js qlog_f449c_0.bz2
```

Source: `verify_model_frequency.js`.

---

## Build Stage 19 Deliverable Package

```bash
npm run stage19:build
```

Equivalent:

```bash
node scripts/build_stage19_deliverable.js
```

Source: `package.json`. Builds `deliverables/stage19-revision37.zip`.

**Note:** Building deliverables modifies `deliverables/` — not required for routine validation.

---

## v11 Dataset Audit (uncertain — data required)

Full dataset audit is referenced in Stage 14 documentation:

```bash
node dataset_audit.js
```

Movement-only regression:

```bash
node dataset_audit.js --movement-only
```

Source: `checkpoints/admiral-investigation-2026-07-23.md`. **(uncertain)** — confirm `dataset_audit.js` CLI flags match current file; requires all 92 qlog segments.

---

## Reproduce Stage 20 Design Investigation (Read-Only)

```bash
node reports/stage20_design_investigation_runner.js
```

**Does not modify** production code, bundles, or `current.json`.

**Output:**

- `reports/stage20_design_investigation.json`
- `reports/stage20_link_ground_truth_sample.json`

Source: `reports/stage20_design_investigation_runner.js`.

### Amendment A v1 artifact build

```bash
node stage20_amendment_a_build.js
```

Optional fixed timestamp for deterministic reruns:

```bash
# PowerShell
$env:AMENDMENT_A_FIXED_TIMESTAMP='2026-07-28T04:00:00.000Z'; node stage20_amendment_a_build.js
```

Writes `lane_divider_supported_runs_v1.json`. Does not modify `lane_divider_supported_runs_v0.json` or `stage19_bundle/current.json`.

---

## Report and Checkpoint Locations

| Artifact | Path |
|----------|------|
| v5 corrective report | `reports/stage19_v5_corrective_checkpoint_report.json` |
| Dataset sensitivity audit | `audit_stage19_dataset_sensitivity.json` |
| Investigation report | `reports/stage19_dataset_sensitivity_investigation.json` |
| Stage 20 design investigation | `reports/stage20_design_investigation.json` |
| Stage 20 metadata provenance | `reports/stage20_metadata_provenance.md` |
| Stage 20 ground-truth sample | `reports/stage20_link_ground_truth_sample.json` (historical — **rule-derived, not manual ground truth**) |
| Candidate pair terminology | `reports/stage20_link_candidate_pair_sample_v1.terminology.md` |
| B-MOTION evidence manifest | `deliverables/stage20-b-motion-evidence-review-manifest.json` |
| Amendment A draft | `deliverables/stage20-amendment-a-draft.md` |
| Amendment B draft | `deliverables/stage20-amendment-b-draft.md` |
| Amendment B specification v1 | `deliverables/stage20-amendment-b-specification.md` |
| Amendment B investigation | `deliverables/stage20-amendment-b-investigation.md` |
| Stage 20 combined draft spec | `deliverables/stage20-draft-specification.md` |
| Amendment A specification | `deliverables/stage20-amendment-a-specification.md` |
| Amendment A schema | `deliverables/stage20-amendment-a-schema.md` |
| Amendment A test matrix | `deliverables/stage20-amendment-a-test-matrix.md` |
| Amendment A compatibility | `deliverables/stage20-amendment-a-compatibility.md` |
| Amendment A v1 artifact | `lane_divider_supported_runs_v1.json` |
| Amendment A checkpoint | `checkpoints/stage20-amendment-a-implementation-2026-07-28.json` |
| Implementation checkpoint | `checkpoints/stage19-implementation-2026-07-27-stage19-v5.json` |
| Published bundle | `stage19_bundle/runs/2026-07-27-stage19-v5/` |
| Current pointer | `stage19_bundle/current.json` |

---

## What Not to Run Without Authorization

| Action | Reason |
|--------|--------|
| Modify `lib/stage19_spec/config.js` | Protected; no threshold correction approved |
| Publish new bundle to production | Not authorized |
| Experimental overlay in production | Investigation overlays are read-only |
| Stage 20 Amendment A implementation | Implemented — not production-approved |

---

## Environment Notes (Windows)

This project was developed on Windows 10. Path validation tests cover Windows-specific separators (`tests/stage19_api_http.test.js`). For shell environment variable syntax, prefer PowerShell `$env:VAR=value` over Unix `VAR=value` unless using Git Bash or WSL.
