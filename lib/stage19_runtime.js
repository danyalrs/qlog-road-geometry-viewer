/**
 * Stage 19 production runtime — inject Stage 17 gaps into normative config without
 * modifying lib/stage19_spec/ source files.
 */
const { config, stage17Gaps } = require('./stage19_spec/config');

let gapsInjected = false;

function mapStage17Gap(g) {
  const sLoUm = Math.round((g.routeSStart ?? 0) * 1e6);
  const sHiUm = Math.round((g.routeSEnd ?? g.routeSStart ?? 0) * 1e6);
  return {
    gapId: g.gapId,
    parentTrackId: g.parentTrackId,
    sLoUm,
    sHiUm,
    intersectsLoOrHi(lo, hi) {
      return !(hi < this.sLoUm || lo > this.sHiUm);
    },
  };
}

function injectStage17Gaps(gaps) {
  stage17Gaps.length = 0;
  for (const g of gaps || []) {
    stage17Gaps.push(mapStage17Gap(g));
  }
  gapsInjected = true;
  return stage17Gaps.length;
}

function clearStage17Gaps() {
  stage17Gaps.length = 0;
  gapsInjected = false;
}

function validateStage19RuntimeConfig() {
  const required = [
    'spatialEqualityToleranceM', 'N_obs', 'P_cp', 'O_max', 'B_partition',
  ];
  for (const key of required) {
    if (config[key] == null) {
      throw new Error(`configurationValidationError: missing ${key}`);
    }
  }
  if (!(config.spatialEqualityToleranceM > 0)) {
    throw new Error('configurationValidationError: spatialEqualityToleranceM');
  }
  if (!(config.O_max >= 1)) {
    throw new Error('configurationValidationError: O_max');
  }
  return { ok: true, gapsInjected, gapCount: stage17Gaps.length };
}

module.exports = {
  injectStage17Gaps,
  clearStage17Gaps,
  validateStage19RuntimeConfig,
  mapStage17Gap,
};
