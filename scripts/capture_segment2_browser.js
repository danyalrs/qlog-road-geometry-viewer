// Browser-console helper: paste into devtools on Segment 2 local fused view,
// then run captureSegment2Screenshots() after processing qlog_f449c_2.bz2.
(function () {
  const VIEWS = {
    A_fused_lanes: { layerFusedLanes: 1, layerRoadSurface: 0, layerEdges: 0, layerRawFrame: 0, layerGps: 0, layerCentre: 0, layerVehicle: 0, layerMarkers: 0 },
    B_fusion_bin_debug: { layerFusedLanes: 1, layerRoadSurface: 1, layerEdges: 0, layerRawFrame: 0, layerGps: 0, layerCentre: 0, layerVehicle: 0, layerMarkers: 0 },
    C_road_edges: { layerFusedLanes: 0, layerRoadSurface: 0, layerEdges: 1, layerRawFrame: 0, layerGps: 0, layerCentre: 0, layerVehicle: 0, layerMarkers: 0 },
    D_ego_lane_surface: { layerFusedLanes: 0, layerRoadSurface: 1, layerEdges: 0, layerRawFrame: 0, layerGps: 0, layerCentre: 0, layerVehicle: 1, layerMarkers: 0 },
    E_full_road_surface: { layerFusedLanes: 0, layerRoadSurface: 1, layerEdges: 1, layerRawFrame: 0, layerGps: 0, layerCentre: 0, layerVehicle: 0, layerMarkers: 0 },
    F_combined_local: { layerFusedLanes: 1, layerRoadSurface: 1, layerEdges: 1, layerRawFrame: 0, layerGps: 0, layerCentre: 0, layerVehicle: 1, layerMarkers: 1 },
  };
  const INDICES = [0, 8, 16, 29];

  function setView(viewKey, idx) {
    const cfg = VIEWS[viewKey];
    for (const [id, on] of Object.entries(cfg)) {
      const el = document.getElementById(id);
      if (el) {
        el.checked = !!on;
        el.dispatchEvent(new Event('change'));
      }
    }
    const tl = document.getElementById('timeline');
    tl.value = String(idx);
    tl.dispatchEvent(new Event('input'));
  }

  window.captureSegment2Screenshots = async function captureSegment2Screenshots() {
    document.getElementById('vizMode').value = 'local';
    document.getElementById('vizMode').dispatchEvent(new Event('change'));
    document.getElementById('localGeometryMode').value = 'fused';
    document.getElementById('localGeometryMode').dispatchEvent(new Event('change'));
    document.getElementById('btnFit').click();
    await new Promise((r) => setTimeout(r, 400));
    const plan = [];
    for (const view of Object.keys(VIEWS)) {
      for (const idx of INDICES) {
        setView(view, idx);
        await new Promise((r) => setTimeout(r, 200));
        plan.push(`${view}_idx${idx}`);
      }
    }
    return plan;
  };
})();
