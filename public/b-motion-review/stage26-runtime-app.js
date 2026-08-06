const state = {
  reviewerId: localStorage.getItem('stage26ReviewerId') || '',
  reviews: [],
  currentIndex: 0,
  qlogPayload: null,
  manifest: null,
};

const els = {
  reviewerId: document.getElementById('reviewerId'),
  priorityFilter: document.getElementById('priorityFilter'),
  btnStart: document.getElementById('btnStart'),
  progressPanel: document.getElementById('progressPanel'),
  progressText: document.getElementById('progressText'),
  progressFill: document.getElementById('progressFill'),
  reviewPanel: document.getElementById('reviewPanel'),
  pairId: document.getElementById('pairId'),
  groupBadge: document.getElementById('groupBadge'),
  segmentId: document.getElementById('segmentId'),
  obsA: document.getElementById('obsA'),
  obsB: document.getElementById('obsB'),
  slotA: document.getElementById('slotA'),
  slotB: document.getElementById('slotB'),
  legacyDecision: document.getElementById('legacyDecision'),
  vectorDecision: document.getElementById('vectorDecision'),
  legacyResidual: document.getElementById('legacyResidual'),
  vectorResidual: document.getElementById('vectorResidual'),
  btnLoadQlog: document.getElementById('btnLoadQlog'),
  btnFrameA: document.getElementById('btnFrameA'),
  btnFrameB: document.getElementById('btnFrameB'),
  renderStatus: document.getElementById('renderStatus'),
  canvasA: document.getElementById('canvasA'),
  canvasB: document.getElementById('canvasB'),
  temporalContinuation: document.getElementById('temporalContinuation'),
  identitySwap: document.getElementById('identitySwap'),
  geometryIssue: document.getElementById('geometryIssue'),
  evidenceAvailable: document.getElementById('evidenceAvailable'),
  confidence: document.getElementById('confidence'),
  reviewerNote: document.getElementById('reviewerNote'),
  btnSubmit: document.getElementById('btnSubmit'),
  btnNext: document.getElementById('btnNext'),
  submitStatus: document.getElementById('submitStatus'),
};

function pb() {
  return window.BMotionPlayback;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || JSON.stringify(data.errors || data));
  return data;
}

function pendingReviews() {
  const pf = els.priorityFilter.value;
  return state.reviews.filter((r) => {
    if (r.reviewStatus !== 'pending_human_review') return false;
    if (!pf) return true;
    if (pf === '4') return [111, 112, 120, 191].includes(r.developmentRecordIndex);
    return String(r.priority) === pf;
  });
}

function updateProgress() {
  const pending = state.reviews.filter((r) => r.reviewStatus === 'pending_human_review').length;
  const done = state.reviews.length - pending;
  const pct = state.reviews.length ? (done / state.reviews.length) * 100 : 0;
  els.progressText.textContent = `Completed ${done} / ${state.reviews.length} (pending ${pending})`;
  els.progressFill.style.width = `${pct}%`;
}

async function loadReviewAt(index) {
  const queue = pendingReviews();
  if (!queue.length) {
    els.submitStatus.textContent = 'No pending reviews in current filter.';
    return;
  }
  state.currentIndex = index % queue.length;
  const item = queue[state.currentIndex];
  const data = await api(`/api/stage26/review/${encodeURIComponent(item.reviewPairId)}`);
  state.manifest = data.manifest;
  const review = data.review;
  els.pairId.textContent = review.reviewPairId;
  els.groupBadge.textContent = `${review.reviewGroup} (P${review.priority})`;
  const ve = data.manifest.visualEvidence || {};
  els.segmentId.textContent = data.manifest.segmentId;
  els.obsA.textContent = ve.frameA?.observationId || '—';
  els.obsB.textContent = ve.frameB?.observationId || '—';
  els.slotA.textContent = ve.frameA?.sourceSlotIndex ?? '—';
  els.slotB.textContent = ve.frameB?.sourceSlotIndex ?? '—';
  els.legacyDecision.textContent = review.legacyDecision;
  els.vectorDecision.textContent = review.vectorShadowDecision;
  els.legacyResidual.textContent = data.manifest.legacyScalarResidualM ?? '—';
  els.vectorResidual.textContent = data.manifest.vectorResidualM ?? '—';
  els.temporalContinuation.value = review.temporalContinuation || '';
  els.identitySwap.value = review.identitySwap || '';
  els.geometryIssue.value = review.geometryIssue || '';
  els.evidenceAvailable.value = review.evidenceAvailable == null ? '' : String(review.evidenceAvailable);
  els.confidence.value = review.confidence || '';
  els.reviewerNote.value = review.reviewerNote || '';
  state.qlogPayload = null;
  els.renderStatus.textContent = 'Load qlog to render frames';
}

async function renderFrame(canvas, frameIndex, targetSlot) {
  if (!state.qlogPayload) return;
  const frame = state.qlogPayload.frames[frameIndex];
  if (!frame) return;
  const ctx = canvas.getContext('2d');
  const plan = pb().buildDrawPlan(frame, canvas.width, canvas.height, { targetLaneIndex: targetSlot });
  pb().renderDrawPlan(ctx, plan, { showRoadEdges: true });
}

async function loadQlog() {
  const ve = state.manifest.visualEvidence;
  const qlogReference = ve.frameA.qlogReference;
  state.qlogPayload = await api(`/api/stage26/playback?qlogReference=${encodeURIComponent(qlogReference)}`);
  const fc = state.manifest.visualEvidence;
  const idxA = state.qlogPayload.suggestedFrameIndexA ?? pb().findNearestFrameIndex(state.qlogPayload.timeline, fc.frameA.logMonoTime);
  const idxB = state.qlogPayload.suggestedFrameIndexB ?? pb().findNearestFrameIndex(state.qlogPayload.timeline, fc.frameB.logMonoTime);
  await renderFrame(els.canvasA, idxA, fc.frameA.sourceSlotIndex);
  await renderFrame(els.canvasB, idxB, fc.frameB.sourceSlotIndex);
  els.renderStatus.textContent = `Rendered frame A idx=${idxA}, frame B idx=${idxB}`;
}

els.btnStart.addEventListener('click', async () => {
  localStorage.setItem('stage26ReviewerId', els.reviewerId.value);
  const manifest = await api('/api/stage26/manifest');
  state.reviews = manifest.reviews;
  els.progressPanel.hidden = false;
  els.reviewPanel.hidden = false;
  updateProgress();
  await loadReviewAt(0);
});

els.btnLoadQlog.addEventListener('click', () => loadQlog().catch((e) => { els.renderStatus.textContent = e.message; }));
els.btnFrameA.addEventListener('click', () => loadQlog());
els.btnFrameB.addEventListener('click', () => loadQlog());

els.btnSubmit.addEventListener('click', async () => {
  const item = pendingReviews()[state.currentIndex];
  if (!item) return;
  const body = {
    temporalContinuation: els.temporalContinuation.value,
    identitySwap: els.identitySwap.value,
    geometryIssue: els.geometryIssue.value,
    evidenceAvailable: els.evidenceAvailable.value === 'true',
    confidence: els.confidence.value,
    reviewerNote: els.reviewerNote.value,
    reviewerId: els.reviewerId.value || 'human-reviewer',
  };
  try {
    await api(`/api/stage26/review/${encodeURIComponent(item.reviewPairId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const manifest = await api('/api/stage26/manifest');
    state.reviews = manifest.reviews;
    updateProgress();
    els.submitStatus.textContent = 'Saved.';
    await loadReviewAt(state.currentIndex);
  } catch (e) {
    els.submitStatus.textContent = e.message;
  }
});

els.btnNext.addEventListener('click', () => loadReviewAt(state.currentIndex + 1));
els.reviewerId.value = state.reviewerId;
