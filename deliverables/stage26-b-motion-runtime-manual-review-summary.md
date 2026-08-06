# Stage 26 B-MOTION Runtime Manual Review Summary

Generated: 2026-07-30T08:47:20.262Z

## Input integrity
- Manifest records: 134
- Development / runtime-only: 11 / 123
- Duplicate reviewPairIds: 0
- Missing evidence references: 0
- Manual labels preserved: **true**

### Input SHA-256 hashes
- stage25AuditPath: `391f16f3846772536661539a250c63ffe2e6d897319f927e36c97774ba2fc89b`
- stage25ResidualPath: `5e9afeb9a118e43ad1b0f2220e01e9e1234418f3a0fe731f4ecf0405b5b6e002`
- stage25ManifestPath: `a586bf7854c643c073f109f7d087537ddac097b68a584e3b337b652ce8d7bea7`
- stage25SummaryPath: `02ca8fe86c520a68120b267b2848b625e0a4b48e223a66dbc2c35910a98eb703`
- stage24DiagnosticsPath: `26312bd566d17d39aad5ec2ba9134d2c812bfd423aebfb36df171631c920592b`
- stage20ManualPath: `326e81dd0a22a6c3cb8af681bccffdbddaa7b91d271998b78478981d789d01df`

## Evidence generation
- Attempted: 134
- Success (renderable frames): 122
- Auto-unresolved (evidence failure): 12
- Evidence success rate: 91.0%

## Review progress
- Pending human visual review: **122**
- Auto-unresolved: 12
- Human completed: 0
- Runtime-only resolved labels (independent validation): **0** / 50 target

## Priority checkpoints
### priority1
- attempted: 82, completed: 0, pending human: 82
- resolved: 0, unresolved: 0, evidence unavailable: 0
- continuation (+/−/unresolved): 0/0/0
- identity swap (true/false/unresolved): 0/0/0
- geometry issue (true/false/unresolved): 0/0/0
- confidence (high/medium/low): 0/0/0
- remaining: 82

### priority2
- attempted: 12, completed: 12, pending human: 0
- resolved: 0, unresolved: 12, evidence unavailable: 12
- continuation (+/−/unresolved): 0/0/12
- identity swap (true/false/unresolved): 0/0/12
- geometry issue (true/false/unresolved): 12/0/0
- confidence (high/medium/low): 0/0/12
- remaining: 0

### priority3
- attempted: 40, completed: 0, pending human: 40
- resolved: 0, unresolved: 0, evidence unavailable: 0
- continuation (+/−/unresolved): 0/0/0
- identity swap (true/false/unresolved): 0/0/0
- geometry issue (true/false/unresolved): 0/0/0
- confidence (high/medium/low): 0/0/0
- remaining: 40

### priority4
- attempted: 4, completed: 0, pending human: 4
- resolved: 0, unresolved: 0, evidence unavailable: 0
- continuation (+/−/unresolved): 0/0/0
- identity swap (true/false/unresolved): 0/0/0
- geometry issue (true/false/unresolved): 0/0/0
- confidence (high/medium/low): 0/0/0
- remaining: 4

## Repeated physical-pair clusters
- Clusters with multiple source-slot pairings: 28
- Note: each source-slot pairing retains a separate review record; labels are not copied across pairings

## Regression-risk group (legacy+/vector−)
- Total: 82
- Pending human: 82
- Completed: 0
- Support legacy acceptance: 0
- Support vector rejection: 0
- Unresolved: 0
- Geometry issues: 0
- Identity swaps: 0

## Fallback / unavailable stratum (runtime-only)
- Reviewed (auto): 12
- Evidence available rate: 0
- Geometry issues: 12

## Vector recovery sample (legacy−/vector+)
- Total in manifest: 40
- Pending human: 40
- Displacement/heading/segment breakdown available after human review completion

## Stratified results (targeted — not combined headline accuracy)
- **A** (A_runtime_only_legacy_positive_vector_negative): reviewed=0, resolved=0, runtime-only resolved=0, independent validation=true
- **B** (B_runtime_only_legacy_negative_vector_positive_sample): reviewed=0, resolved=0, runtime-only resolved=0, independent validation=true
- **C** (C_runtime_only_fallback_unavailable): reviewed=12, resolved=0, runtime-only resolved=0, independent validation=true
- **D** (D_development_consistency_checks): reviewed=0, resolved=0, runtime-only resolved=0, independent validation=false
- **E** (E_known_damaged_development_indices): reviewed=0, resolved=0, runtime-only resolved=0, independent validation=false

## Validation sufficiency
- Runtime-only resolved: 0 / 50
- Regression-risk reviewed: 0 / 82
- Evidence integrity OK: true
- Meeting numerical minimum does not automatically approve a canary

## Recommendation
- **continue_manual_review**
- 122 cases await human visual review; 0 independent runtime-only resolved labels (target: 50)

## Review UI
- Start server: `node scripts/stage26_b_motion_runtime_review_server.js`
- Open: `http://localhost:3850/b-motion-review/stage26-runtime.html`

Visual/manual judgments require human reviewer via stage26 review UI. Automatic labels are not inferred from residuals or automatic decisions.

*Targeted manual evidence review — not general runtime performance*
