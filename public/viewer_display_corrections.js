'use strict';

(function initViewerDisplayCorrections(global) {
  const MANIFEST = {
    '9ddfc49b6061357e648a096d13749e30f9597827fd86786951241f098ea29fa5': {
      correction: 'fullSegmentLocalLateralReflection',
      scope: 'viewerDisplayOnly',
      reason: 'Segment 0 road/lane coordinate provenance mismatch confirmed against synchronized video',
    },
  };

  const CORRECTION_ID = 'fullSegmentLocalLateralReflection';
  const VMC = global.ViewerMirrorCoords;

  function normalizeSha256(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(trimmed) ? trimmed : null;
  }

  function manifestEntry(sourceQlogSha256) {
    const key = normalizeSha256(sourceQlogSha256);
    if (!key) return null;
    return MANIFEST[key] ?? null;
  }

  function isExactDisplayCorrectionActive(mirrorChecked, sourceQlogSha256) {
    if (!mirrorChecked) return false;
    const entry = manifestEntry(sourceQlogSha256);
    return entry?.correction === CORRECTION_ID;
  }

  function transformDisplayPoint(east, north) {
    if (VMC?.reflectSegmentLocalLateral) return VMC.reflectSegmentLocalLateral(east, north);
    return { east, north: -north };
  }

  function transformDisplayHeading(headingDeg) {
    if (!Number.isFinite(headingDeg)) return { headingDeg, valid: false };
    const normalized = ((headingDeg % 360) + 360) % 360;
    return { headingDeg: (180 - normalized + 360) % 360, valid: true };
  }

  function mirrorAwareBounds(bounds) {
    if (!bounds) return bounds;
    const corners = [
      { east: bounds.minE, north: bounds.minN },
      { east: bounds.minE, north: bounds.maxN },
      { east: bounds.maxE, north: bounds.minN },
      { east: bounds.maxE, north: bounds.maxN },
    ];
    let minE = Infinity;
    let maxE = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    for (const c of corners) {
      const t = transformDisplayPoint(c.east, c.north);
      if (!Number.isFinite(t.east) || !Number.isFinite(t.north)) continue;
      minE = Math.min(minE, t.east);
      maxE = Math.max(maxE, t.east);
      minN = Math.min(minN, t.north);
      maxN = Math.max(maxN, t.north);
    }
    if (!Number.isFinite(minE)) return bounds;
    return { minE, maxE, minN, maxN };
  }

  function getDiagnostics(mirrorChecked, sourceQlogSha256) {
    const key = normalizeSha256(sourceQlogSha256);
    const entry = manifestEntry(key);
    const active = isExactDisplayCorrectionActive(mirrorChecked, key);
    return {
      sourceQlogSha256: key,
      manifestMatch: entry ? 'true' : 'false',
      correctionActive: active ? 'true' : 'false',
      correction: entry?.correction ?? null,
      scope: entry?.scope ?? null,
      roadTransformSource: active ? 'canonical+fullSegmentLocalLateralReflection' : 'restoredResolver',
      laneTransformSource: active ? 'canonical+fullSegmentLocalLateralReflection' : 'restoredResolver',
      trajectoryTransformSource: active ? 'canonical+fullSegmentLocalLateralReflection' : 'canonical',
      arrowTransformSource: active ? 'canonical+fullSegmentLocalLateralReflection' : 'canonical',
    };
  }

  global.ViewerDisplayCorrections = {
    CORRECTION_ID,
    manifest: MANIFEST,
    manifestEntry,
    isExactDisplayCorrectionActive,
    transformDisplayPoint,
    transformDisplayHeading,
    mirrorAwareBounds,
    getDiagnostics,
  };
}(typeof window !== 'undefined' ? window : globalThis));
