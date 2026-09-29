'use strict';

const { localToLatLon } = require('./projection');
const { segmentLocalToGlobal } = require('./segment_local_map');

function segmentLocalPoseToLngLat(localEast, localNorth, referencePose, origin) {
  if (!referencePose || !origin) return null;
  if (!Number.isFinite(localEast) || !Number.isFinite(localNorth)) return null;
  const g = segmentLocalToGlobal(localEast, localNorth, referencePose);
  const ll = localToLatLon(g.east, g.north, origin);
  if (!Number.isFinite(ll.latitude) || !Number.isFinite(ll.longitude)) return null;
  if (ll.longitude === 0 && ll.latitude === 0) return null;
  return { longitude: ll.longitude, latitude: ll.latitude };
}

function resolveVehicleGeographicFromPlaybackPose(pose, referencePose, origin) {
  if (!pose || !referencePose || !origin) {
    return { available: false, reason: 'missingContext' };
  }
  const ll = segmentLocalPoseToLngLat(pose.east, pose.north, referencePose, origin);
  if (!ll) {
    return { available: false, reason: 'conversionFailed' };
  }
  const headingDeg = Number.isFinite(pose.headingDeg) ? pose.headingDeg : null;
  return {
    available: true,
    longitude: ll.longitude,
    latitude: ll.latitude,
    headingDeg,
    matchMethod: pose.matchMethod || pose.headingSource || 'segmentTrajectory',
    logMonoTime: pose.logMonoTime ?? null,
    timelineIndex: pose.timelineIndex ?? null,
    sourceFile: pose.sourceFile ?? null,
  };
}

module.exports = {
  segmentLocalPoseToLngLat,
  resolveVehicleGeographicFromPlaybackPose,
};
