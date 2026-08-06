/** Stage 19 implementation checkpoint — separate from frozen v11. */
const STAGE19_PROCESSING_VERSION = '2026-07-24-dataset-sensitivity-bev-audit-v0';
const STAGE19_IMPLEMENTATION_CHECKPOINT = '2026-07-27-stage19-v5';

/** Checkpoint preservation status (truthful; v0 was never published as an immutable run). */
const STAGE19_CHECKPOINT_PRESERVATION = {
  v0: { checkpoint: '2026-07-27-stage19-v0', approved: false, preservation: 'checkpoint-only' },
  v1: { checkpoint: '2026-07-27-stage19-v1', approved: false, preservation: 'immutable-run' },
  v2: { checkpoint: '2026-07-27-stage19-v2', approved: false, preservation: 'immutable-run-superseded' },
  v3: { checkpoint: '2026-07-27-stage19-v3', approved: false, preservation: 'immutable-run-superseded' },
  v4: { checkpoint: '2026-07-27-stage19-v4', approved: false, preservation: 'immutable-run-superseded' },
  v5: { checkpoint: '2026-07-27-stage19-v5', approved: false, preservation: 'current-implementation' },
};

const STAGE19_SCHEMA_VERSION = 'stage19_catalog_v0';

module.exports = {
  STAGE19_PROCESSING_VERSION,
  STAGE19_IMPLEMENTATION_CHECKPOINT,
  STAGE19_CHECKPOINT_PRESERVATION,
  STAGE19_SCHEMA_VERSION,
};
