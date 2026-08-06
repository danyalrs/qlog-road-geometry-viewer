'use strict';

const { config } = require('./stage19_spec/config');

function withPartitionConfigOverlay(overlay, fn) {
  if (!overlay || !Object.keys(overlay).length) return fn();
  const saved = {};
  for (const [key, value] of Object.entries(overlay)) {
    if (!(key in config)) throw new Error(`partition_config_overlay_unknown:${key}`);
    saved[key] = config[key];
    config[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      config[key] = value;
    }
  }
}

module.exports = { withPartitionConfigOverlay };
