/** Processing pipeline build identifier — bump when fusion/rendering logic changes. */
const PROCESSING_VERSION = '2026-07-24-fusion-v15';
/** Movement-state only (Stage 6) — used for regression audits without pose-section fusion. */
const MOVEMENT_ONLY_VERSION = '2026-07-24-fusion-v12-movement';

module.exports = { PROCESSING_VERSION, MOVEMENT_ONLY_VERSION };
