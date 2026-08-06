const state = {
  reviewerId: localStorage.getItem('bMotionReviewerId') || '',
  batchId: localStorage.getItem('bMotionBatchId') || '',
  currentPair: null,
  qlogPayload: null,
  frameIndex: 0,
  evidenceLoaded: false,
  hasDrawable: false,
  targetMapped: false,
  pairMapping: null,
  activeTarget: null,
  lastDrawStats: null,
};

const els = {
  reviewerId: document.getElementById('reviewerId'),
  batchSelect: document.getElementById('batchSelect'),
  btnStart: document.getElementById('btnStart'),
  progressPanel: document.getElementById('progressPanel'),
  progressText: document.getElementById('progressText'),
  progressFill: document.getElementById('progressFill'),
  reviewPanel: document.getElementById('reviewPanel'),
  pairId: document.getElementById('pairId'),
  pairIdentityLine: document.getElementById('pairIdentityLine'),
  reviewPairId: document.getElementById('reviewPairId'),
  evidenceStatus: document.getElementById('evidenceStatus'),
  segmentId: document.getElementById('segmentId'),
  obsA: document.getElementById('obsA'),
  obsB: document.getElementById('obsB'),
  slotA: document.getElementById('slotA'),
  slotB: document.getElementById('slotB'),
  timeA: document.getElementById('timeA'),
  timeB: document.getElementById('timeB'),
  deltaTime: document.getElementById('deltaTime'),
  spatialM: document.getElementById('spatialM'),
  speedMps: document.getElementById('speedMps'),
  headingDiff: document.getElementById('headingDiff'),
  chunkIds: document.getElementById('chunkIds'),
  passIds: document.getElementById('passIds'),
  poseSections: document.getElementById('poseSections'),
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

function updateProgress(progress) {
  const p = pb().normalizeProgress(progress);
  const pct = p.totalPairs ? (p.completed / p.totalPairs) * 100 : 0;
  els.progressText.textContent = `Progress: ${p.completed} / ${p.totalPairs} (pending ${p.pending}, +${p.positive} −${p.negative} ?${p.unresolved})`;
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
    btn.title = allowed
      ? ''
      : 'Requires loaded playback with both Observation A and B target dividers mapped';
  }
}

function renderPair(pair) {
  state.currentPair = pair;
  state.evidenceLoaded = false;
  state.hasDrawable = false;
  state.targetMapped = false;
  state.pairMapping = null;
  state.activeTarget = null;
  state.lastDrawStats = null;
  const identity = pb().formatPairIdentity(pair);
  els.pairId.textContent = pb().formatPairTitle(pair);
  els.pairIdentityLine.textContent = `Pair ${identity.reviewPairId} | A=${identity.observationIdA} (slot ${identity.sourceSlotIndexA}) | B=${identity.observationIdB} (slot ${identity.sourceSlotIndexB})`;
  els.reviewPairId.textContent = identity.reviewPairId;
  const avail = pair.evidenceAvailability || {};
  els.evidenceStatus.textContent = avail.qlogInWorkspace ? 'qlog available' : 'qlog missing in workspace';
  els.segmentId.textContent = pair.segmentId;
  els.obsA.textContent = identity.observationIdA;
  els.obsB.textContent = identity.observationIdB;
  els.slotA.textContent = identity.sourceSlotIndexA;
  els.slotB.textContent = identity.sourceSlotIndexB;
  els.timeA.textContent = pair.logMonoTimeA;
  els.timeB.textContent = pair.logMonoTimeB;
  els.deltaTime.textContent = pair.deltaTimeS;
  els.spatialM.textContent = pair.spatialM;
  els.speedMps.textContent = pair.speedMps;
  els.headingDiff.textContent = pair.headingDiffDeg;
  els.chunkIds.textContent = `${pair.chunkIdA} / ${pair.chunkIdB}`;
  els.passIds.textContent = `${pair.temporalPassIdA} / ${pair.temporalPassIdB}`;
  els.poseSections.textContent = `${pair.poseSectionIdA} / ${pair.poseSectionIdB}`;
  els.qlogRef.textContent = `${pair.qlogReference} | ${pair.videoReference}`;
  els.reviewerNotes.value = '';
  els.submitStatus.textContent = '';
  els.revealPanel.hidden = true;
  els.targetInfo.textContent = 'Target: load qlog to map Observation A/B dividers';
  setErrorBanner(null);
  state.qlogPayload = null;
  state.frameIndex = 0;
  drawFrame();
  updateSubmitButtons();
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
  state.lastDrawStats = plan.stats;
  state.hasDrawable = plan.hasDrawable;

  els.frameInfo.textContent = `Frame ${state.frameIndex + 1}/${state.qlogPayload.frames.length} | logMonoTime ${frame.logMonoTime}`;

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

  const targetPaths = plan.paths.filter((p) => p.role === 'target').length;
  const mutedPaths = plan.paths.filter((p) => p.role === 'non_target').length;
  els.renderStatus.textContent = `Rendered target ${targetPaths} | muted lanes ${mutedPaths} | edges ${plan.paths.filter((p) => p.role === 'road_edge').length} | points ${plan.stats.pointCount}`;

  if (state.pairMapping && !state.pairMapping.ok) {
    setErrorBanner(`Target mapping failed: ${state.pairMapping.issues.map((i) => `${i.endpoint}:${i.error}`).join('; ')}. Positive/negative submission blocked.`);
  } else if (active.error === 'target_lane_not_found_in_frame') {
    setErrorBanner(active.message);
  } else if (state.pairMapping?.ok) {
    setErrorBanner(null);
  }

  updateSubmitButtons();
}

async function loadBatches() {
  const data = await api('/api/batches');
  els.batchSelect.innerHTML = '<option value="">All pairs</option>';
  for (const b of data.batches) {
    const opt = document.createElement('option');
    opt.value = b.batchId;
    opt.textContent = `${b.batchId} (${b.pairCount} pairs)`;
    els.batchSelect.appendChild(opt);
  }
  if (state.batchId) els.batchSelect.value = state.batchId;
}

async function loadNextPair() {
  const params = new URLSearchParams({ reviewerId: state.reviewerId });
  if (state.batchId) params.set('batchId', state.batchId);
  const next = await api(`/api/pair/next?${params}`);
  if (next.done) {
    els.submitStatus.textContent = 'Batch complete for this reviewer.';
    return;
  }
  const detail = await api(`/api/pair/${encodeURIComponent(next.reviewPairId)}?reviewerId=${encodeURIComponent(state.reviewerId)}`);
  renderPair(detail.pair);
  if (detail.existingReview) {
    els.submitStatus.textContent = `Already reviewed: ${detail.existingReview.reviewerLabel}`;
    if (detail.ruleDerivedReveal) showReveal(detail.ruleDerivedReveal);
  }
  updateProgress(next.progress);
}

function showReveal(reveal) {
  els.revealPanel.hidden = false;
  els.revealText.textContent = JSON.stringify(reveal, null, 2);
}

async function submitReview(label) {
  if (!state.currentPair) return;
  if (!pb().canSubmitReviewLabel({
    evidenceLoaded: state.evidenceLoaded,
    hasDrawable: state.hasDrawable,
    targetMapped: state.targetMapped,
    label,
    evidenceMode: els.evidenceMode.value,
  })) {
    els.submitStatus.textContent = 'Submission blocked: map Observation A and B target dividers first (or use unresolved with insufficient evidence).';
    return;
  }
  const body = {
    reviewPairId: state.currentPair.reviewPairId,
    reviewerId: state.reviewerId,
    reviewerLabel: label,
    evidenceMode: els.evidenceMode.value,
    reviewerNotes: els.reviewerNotes.value,
    reviewedAt: new Date().toISOString(),
  };
  try {
    const result = await api('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    els.submitStatus.textContent = `Saved: ${label}`;
    showReveal(result.ruleDerivedReveal);
    updateProgress(result.progress);
    setTimeout(loadNextPair, 600);
  } catch (err) {
    els.submitStatus.textContent = `Error: ${err.message}`;
  }
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
  state.reviewerId = els.reviewerId.value.trim();
  state.batchId = els.batchSelect.value;
  if (!state.reviewerId) {
    alert('Reviewer ID required');
    return;
  }
  localStorage.setItem('bMotionReviewerId', state.reviewerId);
  localStorage.setItem('bMotionBatchId', state.batchId);
  els.progressPanel.hidden = false;
  els.reviewPanel.hidden = false;
  const progress = await api('/api/progress');
  updateProgress(progress);
  await loadNextPair();
});

els.evidenceMode.addEventListener('change', updateSubmitButtons);
els.btnLoadQlog.addEventListener('click', () => loadQlog().catch((e) => { els.submitStatus.textContent = e.message; }));
els.btnFrameA.addEventListener('click', () => navigate('frameA'));
els.btnFrameB.addEventListener('click', () => navigate('frameB'));
els.btnPrev.addEventListener('click', () => navigate('prev'));
els.btnNext.addEventListener('click', () => navigate('next'));
els.btnPositive.addEventListener('click', () => submitReview('positive_continuation'));
els.btnNegative.addEventListener('click', () => submitReview('negative_non_continuation'));
els.btnUnresolved.addEventListener('click', () => submitReview('unresolved'));

window.addEventListener('resize', () => drawFrame());

els.reviewerId.value = state.reviewerId;
loadBatches().catch(console.error);
updateSubmitButtons();
