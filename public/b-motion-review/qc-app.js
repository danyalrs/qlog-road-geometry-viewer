const state = {
  qcReviewer: localStorage.getItem('bMotionQcReviewer') || '',
  recordIndex: null,
  currentPair: null,
  existingReview: null,
  qlogPayload: null,
  frameIndex: 0,
  evidenceLoaded: false,
  hasDrawable: false,
  targetMapped: false,
  pairMapping: null,
  activeTarget: null,
};

const els = {
  qcReviewer: document.getElementById('qcReviewer'),
  btnStart: document.getElementById('btnStart'),
  progressPanel: document.getElementById('progressPanel'),
  progressText: document.getElementById('progressText'),
  progressFill: document.getElementById('progressFill'),
  reviewPanel: document.getElementById('reviewPanel'),
  pairId: document.getElementById('pairId'),
  pairIdentityLine: document.getElementById('pairIdentityLine'),
  recordIndexBadge: document.getElementById('recordIndexBadge'),
  evidenceStatus: document.getElementById('evidenceStatus'),
  recordIndex: document.getElementById('recordIndex'),
  reviewPairId: document.getElementById('reviewPairId'),
  existingLabel: document.getElementById('existingLabel'),
  originalReviewer: document.getElementById('originalReviewer'),
  existingNote: document.getElementById('existingNote'),
  segmentId: document.getElementById('segmentId'),
  obsA: document.getElementById('obsA'),
  obsB: document.getElementById('obsB'),
  slotA: document.getElementById('slotA'),
  slotB: document.getElementById('slotB'),
  requestedTimeA: document.getElementById('requestedTimeA'),
  requestedTimeB: document.getElementById('requestedTimeB'),
  displayedLogMonoTime: document.getElementById('displayedLogMonoTime'),
  deltaTime: document.getElementById('deltaTime'),
  spatialM: document.getElementById('spatialM'),
  speedMps: document.getElementById('speedMps'),
  headingDiff: document.getElementById('headingDiff'),
  qlogRef: document.getElementById('qlogRef'),
  btnLoadQlog: document.getElementById('btnLoadQlog'),
  btnFrameA: document.getElementById('btnFrameA'),
  btnFrameB: document.getElementById('btnFrameB'),
  btnPrev: document.getElementById('btnPrev'),
  btnNext: document.getElementById('btnNext'),
  frameInfo: document.getElementById('frameInfo'),
  targetInfo: document.getElementById('targetInfo'),
  renderStatus: document.getElementById('renderStatus'),
  errorBanner: document.getElementById('errorBanner'),
  frameCanvas: document.getElementById('frameCanvas'),
  evidenceMode: document.getElementById('evidenceMode'),
  reviewerNotes: document.getElementById('reviewerNotes'),
  btnPositive: document.getElementById('btnPositive'),
  btnNegative: document.getElementById('btnNegative'),
  btnUnresolved: document.getElementById('btnUnresolved'),
  btnConfirm: document.getElementById('btnConfirm'),
  submitStatus: document.getElementById('submitStatus'),
  revealPanel: document.getElementById('revealPanel'),
  revealText: document.getElementById('revealText'),
};

function pb() {
  return window.BMotionPlayback;
}

function canvasSize() {
  const rect = els.frameCanvas.getBoundingClientRect();
  const w = Math.max(320, Math.floor(rect.width || els.frameCanvas.width || 960));
  const h = Math.max(180, Math.floor(rect.height || els.frameCanvas.height || 540));
  if (els.frameCanvas.width !== w) els.frameCanvas.width = w;
  if (els.frameCanvas.height !== h) els.frameCanvas.height = h;
  return { w, h };
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
}

function updateQcProgress(progress) {
  const reviewed = progress.qcReviewed ?? 0;
  const total = progress.qcTargetCount ?? 26;
  const remaining = progress.qcRemaining ?? (total - reviewed);
  const pct = total ? (reviewed / total) * 100 : 0;
  els.progressText.textContent = `QC: ${reviewed} / ${total} reviewed (${remaining} remaining)`;
  els.progressFill.style.width = `${pct}%`;
}

function setErrorBanner(message) {
  if (!message) {
    els.errorBanner.classList.remove('visible');
    els.errorBanner.textContent = '';
    return;
  }
  els.errorBanner.textContent = message;
  els.errorBanner.classList.add('visible');
}

function updateSubmitButtons() {
  const mode = els.evidenceMode.value;
  const labels = [
    ['positive_continuation', els.btnPositive],
    ['negative_non_continuation', els.btnNegative],
    ['unresolved', els.btnUnresolved],
  ];
  for (const [label, btn] of labels) {
    const allowed = pb().canSubmitReviewLabel({
      evidenceLoaded: state.evidenceLoaded,
      hasDrawable: state.hasDrawable,
      targetMapped: state.targetMapped,
      label,
      evidenceMode: mode,
    });
    btn.disabled = !allowed;
  }
  els.btnConfirm.disabled = false;
}

function renderQcRecord(detail) {
  const { pair, existingReview, recordIndex } = detail;
  state.recordIndex = recordIndex;
  state.currentPair = pair;
  state.existingReview = existingReview;
  state.evidenceLoaded = false;
  state.hasDrawable = false;
  state.targetMapped = false;
  state.pairMapping = null;
  state.activeTarget = null;
  state.qlogPayload = null;
  state.frameIndex = 0;

  const identity = pb().formatPairIdentity(pair);
  els.pairId.textContent = pb().formatPairTitle(pair);
  els.pairIdentityLine.textContent = `Record ${recordIndex} | Pair ${identity.reviewPairId} | A=${identity.observationIdA} (slot ${identity.sourceSlotIndexA}) | B=${identity.observationIdB} (slot ${identity.sourceSlotIndexB})`;
  els.recordIndexBadge.textContent = `Record ${recordIndex}`;
  els.recordIndex.textContent = recordIndex;
  els.reviewPairId.textContent = identity.reviewPairId;
  els.existingLabel.textContent = existingReview.reviewerLabel;
  els.originalReviewer.textContent = existingReview.reviewerId;
  els.existingNote.textContent = existingReview.reviewerNotes || '(none)';

  const avail = pair.evidenceAvailability || {};
  els.evidenceStatus.textContent = avail.qlogInWorkspace ? 'qlog available' : 'qlog missing in workspace';
  els.segmentId.textContent = pair.segmentId;
  els.obsA.textContent = identity.observationIdA;
  els.obsB.textContent = identity.observationIdB;
  els.slotA.textContent = identity.sourceSlotIndexA;
  els.slotB.textContent = identity.sourceSlotIndexB;
  els.requestedTimeA.textContent = pair.logMonoTimeA;
  els.requestedTimeB.textContent = pair.logMonoTimeB;
  els.displayedLogMonoTime.textContent = '—';
  els.deltaTime.textContent = pair.deltaTimeS;
  els.spatialM.textContent = pair.spatialM;
  els.speedMps.textContent = pair.speedMps;
  els.headingDiff.textContent = pair.headingDiffDeg;
  els.qlogRef.textContent = `${pair.qlogReference} | ${pair.videoReference}`;

  els.evidenceMode.value = existingReview.evidenceMode || 'qlog_playback';
  els.reviewerNotes.value = existingReview.reviewerNotes || '';
  els.submitStatus.textContent = existingReview.qcReviewed
    ? `Previously QC-reviewed at ${existingReview.qcReviewedAt} by ${existingReview.qcReviewer}`
    : '';
  els.revealPanel.hidden = true;
  els.targetInfo.textContent = 'Target: load qlog to map Observation A/B dividers';
  setErrorBanner(null);
  drawFrame();
  updateSubmitButtons();
  updateQcProgress(detail.progress);
}

function drawFrame() {
  const { w, h } = canvasSize();
  const ctx = els.frameCanvas.getContext('2d');
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);

  if (!state.qlogPayload?.frames?.length) {
    els.frameInfo.textContent = 'Frame: —';
    els.renderStatus.textContent = 'Load qlog segment to preview lane-model frames';
    els.targetInfo.textContent = 'Target: —';
    els.displayedLogMonoTime.textContent = '—';
    state.hasDrawable = false;
    updateSubmitButtons();
    return;
  }

  const frame = state.qlogPayload.frames[state.frameIndex];
  const active = pb().resolveActiveTarget(state.currentPair, state.qlogPayload, state.frameIndex);
  state.activeTarget = active;
  const plan = pb().buildDrawPlan(frame, w, h, {
    targetLaneIndex: active.ok ? active.sourceSlotIndex : null,
  });
  state.hasDrawable = plan.hasDrawable;

  const requestedA = state.currentPair.logMonoTimeA;
  const requestedB = state.currentPair.logMonoTimeB;
  const displayed = frame.logMonoTime;
  const frameRole = state.frameIndex === state.qlogPayload.suggestedFrameIndexA
    ? 'A'
    : state.frameIndex === state.qlogPayload.suggestedFrameIndexB
      ? 'B'
      : 'nav';
  const requestedForFrame = frameRole === 'A' ? requestedA : frameRole === 'B' ? requestedB : '—';

  els.frameInfo.textContent = `Frame ${state.frameIndex + 1}/${state.qlogPayload.frames.length} | role ${frameRole}`;
  els.displayedLogMonoTime.textContent = `${displayed} (requested ${requestedForFrame})`;

  if (active.ok) {
    els.targetInfo.textContent = `Target Observation ${active.endpoint}: ${active.observationId} → laneIndex/slot ${active.sourceSlotIndex}`;
  } else {
    els.targetInfo.textContent = `Target: ${active.message || active.error || 'unavailable'}`;
  }

  if (!plan.hasDrawable) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(plan.message || 'No drawable geometry', w / 2, h / 2);
    els.renderStatus.textContent = `${plan.message || 'No drawable geometry'} | lines ${plan.stats.drawableLineCount} | points ${plan.stats.pointCount}`;
    updateSubmitButtons();
    return;
  }

  for (const pathLine of plan.paths) {
    ctx.strokeStyle = pathLine.color;
    ctx.lineWidth = pathLine.width;
    ctx.globalAlpha = pathLine.muted ? 0.55 : 1;
    ctx.beginPath();
    for (let i = 0; i < pathLine.points.length; i++) {
      const p = pathLine.points[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  els.renderStatus.textContent = `Rendered frame ${state.frameIndex + 1} | displayed logMonoTime ${displayed}`;

  if (state.pairMapping && !state.pairMapping.ok) {
    setErrorBanner(`Target mapping failed: ${state.pairMapping.issues.map((i) => `${i.endpoint}:${i.error}`).join('; ')}. Positive/negative submission blocked.`);
  } else if (active.error === 'target_lane_not_found_in_frame') {
    setErrorBanner(active.message);
  } else if (state.pairMapping?.ok) {
    setErrorBanner(null);
  }

  updateSubmitButtons();
}

async function loadNextQcRecord() {
  const next = await api(`/api/qc/next?qcReviewer=${encodeURIComponent(state.qcReviewer)}`);
  if (next.done) {
    els.submitStatus.textContent = 'QC recheck complete for all target records.';
    if (next.changeReport) {
      console.log('QC change report', next.changeReport);
    }
    updateQcProgress(next.progress);
    return;
  }
  const detail = await api(`/api/qc/record/${next.recordIndex}?qcReviewer=${encodeURIComponent(state.qcReviewer)}`);
  renderQcRecord(detail);
  if (detail.ruleDerivedReveal) {
    els.revealPanel.hidden = false;
    els.revealText.textContent = JSON.stringify(detail.ruleDerivedReveal, null, 2);
  }
}

async function submitQcReview(label) {
  if (state.recordIndex == null || !state.existingReview) return;

  const body = {
    recordIndex: state.recordIndex,
    qcReviewer: state.qcReviewer,
    reviewerLabel: label,
    evidenceMode: els.evidenceMode.value,
    reviewerNotes: els.reviewerNotes.value,
    qcReviewedAt: new Date().toISOString(),
  };

  if (label !== 'unresolved') {
    const allowed = pb().canSubmitReviewLabel({
      evidenceLoaded: state.evidenceLoaded,
      hasDrawable: state.hasDrawable,
      targetMapped: state.targetMapped,
      label,
      evidenceMode: els.evidenceMode.value,
    });
    if (!allowed) {
      els.submitStatus.textContent = 'Submission blocked: map Observation A and B target dividers first (or use unresolved / confirm unchanged).';
      return;
    }
  }

  try {
    const result = await api('/api/qc/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    els.submitStatus.textContent = `QC saved: ${label} (record ${state.recordIndex})`;
    if (result.ruleDerivedReveal) {
      els.revealPanel.hidden = false;
      els.revealText.textContent = JSON.stringify(result.ruleDerivedReveal, null, 2);
    }
    updateQcProgress(result.progress);
    setTimeout(loadNextQcRecord, 600);
  } catch (err) {
    els.submitStatus.textContent = `Error: ${err.message}`;
  }
}

function confirmUnchanged() {
  if (!state.existingReview) return;
  submitQcReview(state.existingReview.reviewerLabel);
}

async function loadQlog() {
  if (!state.currentPair?.qlogReference) return;
  const payload = await api('/api/qlog/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      qlogReference: state.currentPair.qlogReference,
      logMonoTimeA: state.currentPair.logMonoTimeA,
      logMonoTimeB: state.currentPair.logMonoTimeB,
      observationIdA: state.currentPair.observationIdA,
      observationIdB: state.currentPair.observationIdB,
    }),
  });
  state.qlogPayload = payload;
  state.evidenceLoaded = true;
  state.pairMapping = pb().resolvePairTargetMapping(state.currentPair, payload);
  state.targetMapped = Boolean(state.pairMapping?.ok);
  if (!state.targetMapped) {
    setErrorBanner(`Target mapping failed: ${(state.pairMapping?.issues || []).map((i) => `${i.endpoint}:${i.error}`).join('; ')}. Positive/negative submission blocked.`);
  } else {
    setErrorBanner(null);
  }
  state.frameIndex = pb().navigationFrameIndex('frameA', 0, payload);
  drawFrame();
}

function navigate(action) {
  if (!state.qlogPayload) return;
  state.frameIndex = pb().navigationFrameIndex(action, state.frameIndex, state.qlogPayload);
  drawFrame();
}

els.btnStart.addEventListener('click', async () => {
  state.qcReviewer = els.qcReviewer.value.trim();
  if (!state.qcReviewer) {
    alert('QC Reviewer ID required');
    return;
  }
  localStorage.setItem('bMotionQcReviewer', state.qcReviewer);
  els.progressPanel.hidden = false;
  els.reviewPanel.hidden = false;
  const progress = await api('/api/qc/progress');
  updateQcProgress(progress);
  await loadNextQcRecord();
});

els.evidenceMode.addEventListener('change', updateSubmitButtons);
els.btnLoadQlog.addEventListener('click', () => loadQlog().catch((e) => { els.submitStatus.textContent = e.message; }));
els.btnFrameA.addEventListener('click', () => navigate('frameA'));
els.btnFrameB.addEventListener('click', () => navigate('frameB'));
els.btnPrev.addEventListener('click', () => navigate('prev'));
els.btnNext.addEventListener('click', () => navigate('next'));
els.btnPositive.addEventListener('click', () => submitQcReview('positive_continuation'));
els.btnNegative.addEventListener('click', () => submitQcReview('negative_non_continuation'));
els.btnUnresolved.addEventListener('click', () => submitQcReview('unresolved'));
els.btnConfirm.addEventListener('click', confirmUnchanged);

window.addEventListener('resize', () => drawFrame());

els.qcReviewer.value = state.qcReviewer;
updateSubmitButtons();
