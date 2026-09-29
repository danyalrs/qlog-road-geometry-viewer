'use strict';
(function (global) {
  function segmentLocalPoseToLngLat(localEast, localNorth, referencePose, origin) {
    const GP = global.GeographicProjection;
    const SLM = global.SegmentLocalMap;
    if (!GP?.localToLatLon || !SLM?.segmentLocalToGlobal || !referencePose || !origin) return null;
    if (!Number.isFinite(localEast) || !Number.isFinite(localNorth)) return null;
    const g = SLM.segmentLocalToGlobal(localEast, localNorth, referencePose);
    const ll = GP.localToLatLon(g.east, g.north, origin);
    if (!Number.isFinite(ll.latitude) || !Number.isFinite(ll.longitude)) return null;
    if (ll.longitude === 0 && ll.latitude === 0) return null;
    return { longitude: ll.longitude, latitude: ll.latitude };
  }

  function resolveVehicleGeographicFromPlaybackPose(pose, referencePose, origin) {
    if (!pose || !referencePose || !origin) {
      return { available: false, reason: 'missingContext' };
    }
    const ll = segmentLocalPoseToLngLat(pose.east, pose.north, referencePose, origin);
    if (!ll) return { available: false, reason: 'conversionFailed' };
    return {
      available: true,
      longitude: ll.longitude,
      latitude: ll.latitude,
      headingDeg: Number.isFinite(pose.headingDeg) ? pose.headingDeg : null,
      matchMethod: pose.matchMethod || pose.headingSource || 'segmentTrajectory',
      logMonoTime: pose.logMonoTime ?? null,
      timelineIndex: pose.timelineIndex ?? null,
    };
  }

  global.GeographicVehiclePosition = {
    segmentLocalPoseToLngLat,
    resolveVehicleGeographicFromPlaybackPose,
  };
})(typeof window !== 'undefined' ? window : global);
