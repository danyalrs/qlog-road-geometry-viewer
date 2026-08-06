'use strict';

/**
 * Lane cleanup screenshot plan for Segment 2 (qlog_f449c_2.bz2).
 * Run in browser devtools after processing segment 2 in Local playback mode.
 *
 * Modes A–F map to localGeometryMode values:
 * A observations, B tracked, C rejected, D fused, E cleaned, F cleanedWithSurface
 */

(function initLaneCleanupScreenshots() {
  const MODES = {
    A_raw_observations: 'observations',
    B_tracked_observations: 'tracked',
    C_rejected_observations: 'rejected',
    D_fused_before_cleanup: 'fused',
    E_cleaned_lane_map: 'cleaned',
    F_cleaned_with_surface: 'cleanedWithSurface',
  };
  const INDICES = [0, 8, 16, 29];
  const OUT_PREFIX = 'screenshots/segment2_lane_cleanup';

  async function captureLaneCleanupScreenshots() {
    document.getElementById('vizMode').value = 'local';
    document.getElementById('vizMode').dispatchEvent(new Event('change'));
    document.getElementById('layerRoadSurface').checked = true;
    document.getElementById('layerFusedLanes').checked = true;
    document.getElementById('layerRoadSurface').dispatchEvent(new Event('change'));
    document.getElementById('btnFit').click();
    await new Promise((r) => setTimeout(r, 500));

    const plan = [];
    for (const [label, mode] of Object.entries(MODES)) {
      document.getElementById('localGeometryMode').value = mode;
      document.getElementById('localGeometryMode').dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 400));
      document.getElementById('btnFit').click();
      for (const idx of INDICES) {
        const tl = document.getElementById('timeline');
        tl.value = String(idx);
        tl.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 200));
        const name = `${OUT_PREFIX}/${label}_idx${idx}.png`;
        plan.push(name);
        console.log(`capture ${name} checksum=${window.renderer?.stationaryLocalMap?.laneChecksum}`);
      }
    }
    return { outPrefix: OUT_PREFIX, plan };
  }

  window.captureLaneCleanupScreenshots = captureLaneCleanupScreenshots;
})();
