'use strict';
const fs = require('fs');
const path = require('path');
let body = fs.readFileSync(path.join(__dirname, '../lib/local_geometry_ui.js'), 'utf8');
body = body.replace(/^'use strict';\r?\n/, '');
body = body.replace(/\r?\nmodule\.exports[\s\S]*$/, '');
const out = `'use strict';
(function (global) {
${body}
const LocalGeometryUiApi = {
  LOCAL_GEOMETRY_VISIBLE_MODES,
  LOCAL_GEOMETRY_DEFAULT_MODE,
  LOCAL_GEOMETRY_STORAGE_KEY,
  LOCAL_GEOMETRY_SESSION_KEY,
  VIZ_MODE_DEFAULT,
  VIZ_MODE_SESSION_KEY,
  VIZ_MODE_VISIBLE,
  CONNECTED_ACCUMULATED_DEFAULT_ENABLED,
  CONNECTED_ACCUMULATED_DEFAULT_MODE,
  CONNECTED_ACCUMULATED_SESSION_ENABLED_KEY,
  CONNECTED_ACCUMULATED_SESSION_MODE_KEY,
  CONNECTED_ACCUMULATED_MODES,
  HIDDEN_GEOMETRY_SOURCES,
  isVisibleLocalGeometryMode,
  normalizeLocalGeometrySelection,
  isVisibleVizMode,
  normalizeVizModeSelection,
  resolveInitialLocalGeometryMode,
  resolveInitialVizMode,
  normalizeConnectedAccumulatedMode,
  resolveInitialConnectedAccumulatedEnabled,
  resolveInitialConnectedAccumulatedMode,
  localGeometryDropdownOptions,
};
if (typeof module !== 'undefined' && module.exports) module.exports = LocalGeometryUiApi;
global.LocalGeometryUI = LocalGeometryUiApi;
})(typeof window !== 'undefined' ? window : global);
`;
fs.writeFileSync(path.join(__dirname, '../public/local_geometry_ui.js'), out);
console.log('wrote public/local_geometry_ui.js', out.length);
