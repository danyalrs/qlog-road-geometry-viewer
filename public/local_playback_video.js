'use strict';

class LocalPlaybackVideoPanel {
  constructor(rootEl) {
    this.rootEl = rootEl;
    this.videoEl = rootEl.querySelector('video');
    this.statusEl = rootEl.querySelector('[data-video-status]');
    this.timeEl = rootEl.querySelector('[data-video-time]');
    this.segmentEl = rootEl.querySelector('[data-video-segment]');
    this.syncEl = rootEl.querySelector('[data-video-sync]');
    this.messageEl = rootEl.querySelector('[data-video-message]');
    this.bodyEl = rootEl.querySelector('[data-video-body]');
    this.collapseBtn = rootEl.querySelector('[data-video-collapse]');

    this.segmentId = null;
    this.activeVideoSegmentId = null;
    this.requestedVideoSegmentId = null;
    this.videoSwitchToken = 0;
    this.pendingLocalTimeS = 0;
    this.wasPlayingBeforeSwitch = false;
    this.segmentTimeline = [];
    this.segmentStartLogMonoTime = null;
    this.timelineStartLogMonoTime = null;
    this.videoStartOffsetSeconds = 0;
    this.state = 'idle';
    this.isPlayingMaster = false;
    this.isSeeking = false;
    this.isBuffering = false;
    this.isSwitching = false;
    this.lastSeekWallMs = 0;
    this.lastSyncWallMs = 0;
    this.pendingSeekTime = null;
    this.durationSec = null;
    this._metadataHandler = null;
    this.sourceSwitchCount = 0;
    this.staleSwitchIgnoredCount = 0;
    this.boundaryLoadToken = 0;
    this.boundaryLoadInProgress = false;
    this.boundaryPendingLocalTimeS = 0;
    this.boundarySrcChangeCount = 0;
    this._boundaryReadyCallback = null;
    this._boundaryMissingCallback = null;
    this._boundaryStaleCallback = null;
    this._boundaryFrameHandlers = null;

    this.videoEl.muted = true;
    this.videoEl.playsInline = true;
    this.videoEl.preload = 'metadata';

    this.videoEl.addEventListener('seeking', () => { this.isSeeking = true; });
    this.videoEl.addEventListener('seeked', () => {
      this.isSeeking = false;
      this.pendingSeekTime = null;
      this.updateSyncIndicator('synced');
    });
    this.videoEl.addEventListener('waiting', () => { this.isBuffering = true; this.updateSyncIndicator('buffering'); });
    this.videoEl.addEventListener('playing', () => { this.isBuffering = false; });
    this.videoEl.addEventListener('canplay', () => { this.isBuffering = false; });
    this.videoEl.addEventListener('timeupdate', () => {
      this.updateTimeDisplay();
      this.updateActiveSegmentIndicator();
    });

    this.collapseBtn?.addEventListener('click', () => {
      this.rootEl.classList.toggle('collapsed');
      this.collapseBtn.textContent = this.rootEl.classList.contains('collapsed') ? '▸' : '▾';
    });
  }

  setVisible(visible) {
    this.rootEl.classList.toggle('hidden', !visible);
  }

  setSegmentTimeline(entries) {
    this.segmentTimeline = Array.isArray(entries) ? entries : [];
  }

  setTimelineStart(logMonoTime) {
    this.timelineStartLogMonoTime = logMonoTime != null ? String(logMonoTime) : null;
  }

  getDiagnostics() {
    return {
      activeVideoSegmentId: this.activeVideoSegmentId,
      requestedVideoSegmentId: this.requestedVideoSegmentId,
      videoSwitchToken: this.videoSwitchToken,
      sourceSwitchCount: this.sourceSwitchCount,
      staleSwitchIgnoredCount: this.staleSwitchIgnoredCount,
      videoLocalTimeS: Number.isFinite(this.videoEl.currentTime) ? this.videoEl.currentTime : null,
      durationSec: this.durationSec,
      boundaryLoadInProgress: this.boundaryLoadInProgress,
      boundaryLoadToken: this.boundaryLoadToken,
      boundarySrcChangeCount: this.boundarySrcChangeCount,
      videoReadyState: this.videoEl.readyState,
      videoNetworkState: this.videoEl.networkState,
    };
  }

  _cancelBoundaryFrameWait() {
    if (!this._boundaryFrameHandlers) return;
    const { types, handler, errorHandler } = this._boundaryFrameHandlers;
    for (const type of types) {
      if (type === 'error') this.videoEl.removeEventListener(type, errorHandler);
      else this.videoEl.removeEventListener(type, handler);
    }
    this._boundaryFrameHandlers = null;
  }

  _isBoundaryFrameReady(targetTimeS) {
    const HAVE_CURRENT_DATA = 2;
    const tolerance = 0.10;
    if (this.videoEl.readyState < HAVE_CURRENT_DATA) return false;
    if (this.isSeeking || this.videoEl.seeking) return false;
    const current = Number(this.videoEl.currentTime);
    if (!Number.isFinite(current) || !Number.isFinite(targetTimeS)) return false;
    return Math.abs(current - targetTimeS) <= tolerance;
  }

  _finishBoundaryLoadIfReady(token, targetTimeS) {
    if (token !== this.boundaryLoadToken) {
      this.staleSwitchIgnoredCount += 1;
      this._boundaryStaleCallback?.();
      return false;
    }
    if (!this._isBoundaryFrameReady(targetTimeS)) return false;
    this._cancelBoundaryFrameWait();
    this.boundaryLoadInProgress = false;
    this.isSwitching = false;
    this.bodyEl?.classList.remove('hidden');
    this.messageEl?.classList.add('hidden');
    this.setState('ready');
    this.updateActiveSegmentIndicator({ segmentId: this.activeVideoSegmentId });
    this.updateTimeDisplay();
    const cb = this._boundaryReadyCallback;
    this._boundaryReadyCallback = null;
    this._boundaryMissingCallback = null;
    this._boundaryStaleCallback = null;
    cb?.();
    return true;
  }

  _waitForBoundaryFrame(token, targetTimeS) {
    this._cancelBoundaryFrameWait();
    const types = ['loadeddata', 'seeked', 'canplay'];
    const handler = () => {
      this._finishBoundaryLoadIfReady(token, targetTimeS);
    };
    for (const type of types) {
      this.videoEl.addEventListener(type, handler);
    }
    const errorHandler = () => {
      if (token !== this.boundaryLoadToken) return;
      this._cancelBoundaryFrameWait();
      this.boundaryLoadInProgress = false;
      this.isSwitching = false;
      const seg = this.activeVideoSegmentId;
      this._clearVideoDisplay(seg, `Segment ${seg} — video unavailable`);
      const cb = this._boundaryMissingCallback;
      this._boundaryReadyCallback = null;
      this._boundaryMissingCallback = null;
      this._boundaryStaleCallback = null;
      cb?.();
    };
    this.videoEl.addEventListener('error', errorHandler, { once: true });
    this._boundaryFrameHandlers = { types: [...types, 'error'], handler, errorHandler };
    this._finishBoundaryLoadIfReady(token, targetTimeS);
  }

  cancelBoundaryLoad() {
    this.boundaryLoadToken += 1;
    this._cancelBoundaryFrameWait();
    this.boundaryLoadInProgress = false;
    this._boundaryReadyCallback = null;
    this._boundaryMissingCallback = null;
    this._boundaryStaleCallback = null;
  }

  async beginBoundaryLoad(provenance, {
    token,
    onReady,
    onMissing,
    onStale,
  } = {}) {
    const segmentId = provenance?.sourceSegmentId ? String(provenance.sourceSegmentId) : null;
    const localTimeS = Number(provenance?.sourceLocalTimeS) || 0;
    this.cancelBoundaryLoad();
    this.boundaryLoadToken = token;
    this.boundaryLoadInProgress = true;
    this.boundaryPendingLocalTimeS = localTimeS;
    this._boundaryReadyCallback = onReady;
    this._boundaryMissingCallback = onMissing;
    this._boundaryStaleCallback = onStale;
    this.isSwitching = true;
    this.requestedVideoSegmentId = segmentId;
    this.pendingLocalTimeS = localTimeS;
    this.updateActiveSegmentIndicator({ loading: true, segmentId });

    if (!segmentId) {
      this._clearVideoDisplay(null, 'Video unavailable for active segment');
      this.boundaryLoadInProgress = false;
      onMissing?.();
      return;
    }

    this._removeMetadataHandler();
    this.setState('loading');
    this.showMessage(`Loading Segment ${segmentId} video…`);
    this.videoEl.pause();
    this.isPlayingMaster = false;

    try {
      const res = await fetch(`/api/video/segment/${encodeURIComponent(segmentId)}/info`, { cache: 'no-store' });
      if (token !== this.boundaryLoadToken) {
        this.staleSwitchIgnoredCount += 1;
        onStale?.();
        return;
      }
      if (!res.ok) throw new Error(`info_http_${res.status}`);
      const info = await res.json();
      if (token !== this.boundaryLoadToken) {
        this.staleSwitchIgnoredCount += 1;
        onStale?.();
        return;
      }

      if (!info.hasVideo || !info.streamUrl) {
        this._clearVideoDisplay(segmentId, `Segment ${segmentId} — video unavailable`);
        this.boundaryLoadInProgress = false;
        onMissing?.();
        return;
      }

      this.segmentId = segmentId;
      this.activeVideoSegmentId = segmentId;
      this.segmentStartLogMonoTime = provenance.segmentStartLogMonoTime != null
        ? String(provenance.segmentStartLogMonoTime)
        : null;
      this.videoStartOffsetSeconds = Number(info.videoStartOffsetSeconds) || 0;
      this.durationSec = info.remux?.durationSec ?? info.sourceProbe?.durationSec ?? null;

      const entry = this.segmentTimeline.find((e) => e.sourceSegmentId === segmentId);
      if (entry) {
        entry.videoUrl = info.streamUrl;
        entry.videoStartOffsetSeconds = this.videoStartOffsetSeconds;
        entry.durationSec = this.durationSec;
      }

      const expected = this._localTimeToVideoTime(localTimeS);
      const targetTimeS = this._clampVideoTime(expected);

      this._metadataHandler = () => {
        if (token !== this.boundaryLoadToken) {
          this.staleSwitchIgnoredCount += 1;
          onStale?.();
          return;
        }
        this._removeMetadataHandler();
        this.durationSec = Number.isFinite(this.videoEl.duration) ? this.videoEl.duration : this.durationSec;
        this.pendingSeekTime = targetTimeS;
        this.lastSeekWallMs = performance.now();
        this.videoEl.currentTime = targetTimeS;
        this.sourceSwitchCount += 1;
        this._waitForBoundaryFrame(token, targetTimeS);
      };
      this.videoEl.addEventListener('loadedmetadata', this._metadataHandler, { once: true });

      this.boundarySrcChangeCount += 1;
      this.videoEl.src = `${info.streamUrl}?_=${Date.now()}`;
      this.videoEl.load();
      this.updateSyncIndicator('buffering');
    } catch (err) {
      if (token !== this.boundaryLoadToken) {
        this.staleSwitchIgnoredCount += 1;
        onStale?.();
        return;
      }
      this._clearVideoDisplay(segmentId, `Segment ${segmentId} — video unavailable`);
      this.boundaryLoadInProgress = false;
      onMissing?.();
      // eslint-disable-next-line no-console
      console.warn('[local-video] boundary load failed', err);
    }
  }

  pollBoundaryFrameReady() {
    if (!this.boundaryLoadInProgress) return false;
    return this._finishBoundaryLoadIfReady(this.boundaryLoadToken, this._clampVideoTime(
      this._localTimeToVideoTime(this.boundaryPendingLocalTimeS),
    ));
  }

  _removeMetadataHandler() {
    if (this._metadataHandler) {
      this.videoEl.removeEventListener('loadedmetadata', this._metadataHandler);
      this._metadataHandler = null;
    }
  }

  _localTimeToVideoTime(localTimeS) {
    const timing = window.SegmentVideoTiming;
    if (!timing) return null;
    return timing.computeExpectedVideoTime(localTimeS, this.videoStartOffsetSeconds);
  }

  _clampVideoTime(videoTimeS) {
    if (!Number.isFinite(videoTimeS)) return 0;
    let clamped = Math.max(0, videoTimeS);
    const duration = Number.isFinite(this.videoEl.duration) ? this.videoEl.duration : this.durationSec;
    if (Number.isFinite(duration)) {
      clamped = Math.min(clamped, Math.max(0, duration - 0.05));
    }
    return clamped;
  }

  updateActiveSegmentIndicator({ loading = false, unavailable = false, segmentId = null } = {}) {
    if (!this.segmentEl) return;
    const seg = segmentId ?? this.activeVideoSegmentId;
    if (loading && seg != null) {
      this.segmentEl.textContent = `Loading Segment ${seg} video…`;
      return;
    }
    if (unavailable || this.state === 'missing') {
      this.segmentEl.textContent = seg != null
        ? `Segment ${seg} — video unavailable`
        : 'Video unavailable for active segment';
      return;
    }
    if (seg == null) {
      this.segmentEl.textContent = '—';
      return;
    }
    const current = Number.isFinite(this.videoEl.currentTime) ? this.videoEl.currentTime : 0;
    const duration = Number.isFinite(this.videoEl.duration) ? this.videoEl.duration : this.durationSec;
    const durationText = Number.isFinite(duration) ? duration.toFixed(1) : '—';
    this.segmentEl.textContent = `Segment ${seg} — ${current.toFixed(1)} s / ${durationText} s`;
  }

  showMessage(text) {
    if (this.messageEl) {
      this.messageEl.textContent = text;
      this.messageEl.classList.remove('hidden');
    }
  }

  setState(state) {
    this.state = state;
    if (this.statusEl) {
      const labels = {
        idle: 'Idle',
        loading: 'Loading',
        ready: 'Ready',
        missing: 'No video',
        error: 'Unavailable',
        playing: 'Playing',
        paused: 'Paused',
      };
      this.statusEl.textContent = labels[state] || state;
    }
  }

  updateSyncIndicator(mode) {
    if (!this.syncEl) return;
    const labels = {
      ready: '● ready',
      synced: '● synced',
      correcting: '● correcting',
      buffering: '● buffering',
      seek: '● seek',
    };
    this.syncEl.textContent = labels[mode] || '● —';
    this.syncEl.dataset.mode = mode;
  }

  updateTimeDisplay() {
    if (!this.timeEl) return;
    const current = Number.isFinite(this.videoEl.currentTime) ? this.videoEl.currentTime : 0;
    const duration = Number.isFinite(this.videoEl.duration) ? this.videoEl.duration : this.durationSec;
    const durationText = Number.isFinite(duration) ? duration.toFixed(1) : '—';
    this.timeEl.textContent = `${current.toFixed(1)}s / ${durationText}s`;
  }

  _clearVideoDisplay(segmentId, message) {
    this.pause();
    this._removeMetadataHandler();
    this.videoEl.removeAttribute('src');
    this.videoEl.load();
    this.segmentId = null;
    this.durationSec = null;
    this.pendingSeekTime = null;
    this.isSeeking = false;
    this.isBuffering = false;
    this.isSwitching = false;
    this.activeVideoSegmentId = segmentId != null ? String(segmentId) : null;
    this.bodyEl?.classList.add('hidden');
    this.messageEl?.classList.remove('hidden');
    this.setState('missing');
    this.showMessage(message || 'Video unavailable for active segment');
    this.updateActiveSegmentIndicator({ unavailable: true, segmentId });
  }

  async _switchToSegment(provenance, { resumePlayback = false } = {}) {
    const segmentId = provenance?.sourceSegmentId ? String(provenance.sourceSegmentId) : null;
    const token = ++this.videoSwitchToken;
    this.requestedVideoSegmentId = segmentId;
    this.pendingLocalTimeS = Number(provenance?.sourceLocalTimeS) || 0;
    this.wasPlayingBeforeSwitch = resumePlayback;
    this.isSwitching = true;

    this.updateActiveSegmentIndicator({ loading: true, segmentId });

    if (!segmentId) {
      this._clearVideoDisplay(null, 'Video unavailable for active segment');
      return;
    }

    this._removeMetadataHandler();
    this.setState('loading');
    this.showMessage(`Loading Segment ${segmentId} video…`);

    try {
      const res = await fetch(`/api/video/segment/${encodeURIComponent(segmentId)}/info`, { cache: 'no-store' });
      if (token !== this.videoSwitchToken) {
        this.staleSwitchIgnoredCount += 1;
        return;
      }
      if (!res.ok) throw new Error(`info_http_${res.status}`);
      const info = await res.json();
      if (token !== this.videoSwitchToken) {
        this.staleSwitchIgnoredCount += 1;
        return;
      }

      if (!info.hasVideo || !info.streamUrl) {
        this._clearVideoDisplay(segmentId, `Segment ${segmentId} — video unavailable`);
        return;
      }

      this.segmentId = segmentId;
      this.activeVideoSegmentId = segmentId;
      this.segmentStartLogMonoTime = provenance.segmentStartLogMonoTime != null
        ? String(provenance.segmentStartLogMonoTime)
        : null;
      this.videoStartOffsetSeconds = Number(info.videoStartOffsetSeconds) || 0;
      this.durationSec = info.remux?.durationSec ?? info.sourceProbe?.durationSec ?? null;

      const entry = this.segmentTimeline.find((e) => e.sourceSegmentId === segmentId);
      if (entry) {
        entry.videoUrl = info.streamUrl;
        entry.videoStartOffsetSeconds = this.videoStartOffsetSeconds;
        entry.durationSec = this.durationSec;
      }

      this._metadataHandler = () => {
        if (token !== this.videoSwitchToken) {
          this.staleSwitchIgnoredCount += 1;
          return;
        }
        this._removeMetadataHandler();
        this.durationSec = Number.isFinite(this.videoEl.duration) ? this.videoEl.duration : this.durationSec;
        const expected = this._localTimeToVideoTime(this.pendingLocalTimeS);
        const clamped = this._clampVideoTime(expected);
        this.pendingSeekTime = clamped;
        this.lastSeekWallMs = performance.now();
        this.videoEl.currentTime = clamped;
        this.bodyEl?.classList.remove('hidden');
        this.messageEl?.classList.add('hidden');
        this.isSwitching = false;
        this.sourceSwitchCount += 1;
        this.setState(this.wasPlayingBeforeSwitch ? 'playing' : 'ready');
        this.updateActiveSegmentIndicator({ segmentId });
        this.updateTimeDisplay();
        if (this.wasPlayingBeforeSwitch) {
          this.isPlayingMaster = true;
          this.videoEl.play().catch(() => {
            this.isPlayingMaster = false;
            this.setState('paused');
          });
        }
      };
      this.videoEl.addEventListener('loadedmetadata', this._metadataHandler, { once: true });

      this.videoEl.src = `${info.streamUrl}?_=${Date.now()}`;
      this.videoEl.load();
      this.updateSyncIndicator('ready');
    } catch (err) {
      if (token !== this.videoSwitchToken) {
        this.staleSwitchIgnoredCount += 1;
        return;
      }
      this._clearVideoDisplay(segmentId, `Segment ${segmentId} — video unavailable`);
      // eslint-disable-next-line no-console
      console.warn('[local-video] switch failed', err);
    }
  }

  seekToVideoTime(expectedVideoTime, { force = false } = {}) {
    if (!Number.isFinite(expectedVideoTime)) return false;
    if (this.state !== 'ready' && this.state !== 'playing' && this.state !== 'paused') return false;
    const now = performance.now();
    if (!force && (this.isSeeking || this.isBuffering || this.isSwitching)) return false;
    if (!force && now - this.lastSeekWallMs < 250) return false;
    if (!force && this.pendingSeekTime != null && Math.abs(this.pendingSeekTime - expectedVideoTime) < 0.05) {
      return false;
    }

    const clamped = this._clampVideoTime(expectedVideoTime);
    this.pendingSeekTime = clamped;
    this.lastSeekWallMs = now;
    this.videoEl.currentTime = clamped;
    this.updateSyncIndicator('seek');
    return true;
  }

  syncToLocalTime(provenance, { forceSeek = false, allowRateCorrection = true } = {}) {
    if (this.isSwitching) return;
    if (this.state !== 'ready' && this.state !== 'playing' && this.state !== 'paused') return;
    const expected = this._localTimeToVideoTime(provenance?.sourceLocalTimeS);
    if (!Number.isFinite(expected)) return;

    if (forceSeek) {
      this.videoEl.playbackRate = 1;
      this.seekToVideoTime(expected, { force: true });
      this.updateTimeDisplay();
      this.updateActiveSegmentIndicator();
      return;
    }

    if (this.isSeeking || this.isBuffering) return;

    const drift = this.videoEl.currentTime - expected;
    const action = window.SegmentVideoTiming.computeSyncAction(drift);
    if (action.action === 'none') {
      if (this.videoEl.playbackRate !== 1) this.videoEl.playbackRate = 1;
      this.updateSyncIndicator(this.isPlayingMaster ? 'synced' : 'ready');
      this.updateActiveSegmentIndicator();
      return;
    }
    if (action.action === 'rate' && allowRateCorrection && this.isPlayingMaster) {
      this.videoEl.playbackRate = action.playbackRate;
      this.updateSyncIndicator('correcting');
      return;
    }
    if (action.action === 'seek') {
      this.videoEl.playbackRate = 1;
      this.seekToVideoTime(expected);
    }
    this.updateActiveSegmentIndicator();
  }

  async syncToActivePose(provenance, {
    isPlaying = false,
    forceSeek = false,
    allowRateCorrection = true,
    boundaryLoad = false,
  } = {}) {
    if (!provenance) return;

    const segmentId = provenance.sourceSegmentId ? String(provenance.sourceSegmentId) : null;
    const segmentChanged = segmentId !== this.activeVideoSegmentId;

    if (segmentChanged && boundaryLoad) {
      return;
    }

    if (segmentChanged) {
      await this._switchToSegment(provenance, { resumePlayback: isPlaying });
      return;
    }

    if (this.state === 'missing') {
      this.updateActiveSegmentIndicator({ unavailable: true, segmentId });
      return;
    }

    this.syncToLocalTime(provenance, { forceSeek, allowRateCorrection });
  }

  getExpectedVideoTime(currentLogMonoTime) {
    const timing = window.SegmentVideoTiming;
    const start = this.segmentStartLogMonoTime || this.timelineStartLogMonoTime;
    if (!timing || !start) return null;
    const localElapsed = timing.computeLocalElapsedSeconds(currentLogMonoTime, start);
    return timing.computeExpectedVideoTime(localElapsed, this.videoStartOffsetSeconds);
  }

  syncToLogMonoTime(currentLogMonoTime, { forceSeek = false, allowRateCorrection = true } = {}) {
    if (this.isSwitching) return;
    const provenance = {
      sourceSegmentId: this.activeVideoSegmentId,
      sourceLocalTimeS: window.SegmentVideoTiming?.computeLocalElapsedSeconds(
        currentLogMonoTime,
        this.segmentStartLogMonoTime || this.timelineStartLogMonoTime,
      ) ?? 0,
      segmentStartLogMonoTime: this.segmentStartLogMonoTime || this.timelineStartLogMonoTime,
    };
    this.syncToLocalTime(provenance, { forceSeek, allowRateCorrection });
  }

  tickSync(provenanceOrLogMonoTime, options = {}) {
    const now = performance.now();
    if (now - this.lastSyncWallMs < 100) return;
    this.lastSyncWallMs = now;

    let provenance = provenanceOrLogMonoTime;
    let isPlaying = options.isPlaying ?? this.isPlayingMaster;
    if (provenanceOrLogMonoTime != null
      && typeof provenanceOrLogMonoTime !== 'object'
      && !Array.isArray(provenanceOrLogMonoTime)) {
      provenance = {
        sourceSegmentId: this.activeVideoSegmentId,
        sourceLocalTimeS: window.SegmentVideoTiming?.computeLocalElapsedSeconds(
          provenanceOrLogMonoTime,
          this.segmentStartLogMonoTime || this.timelineStartLogMonoTime,
        ) ?? 0,
        segmentStartLogMonoTime: this.segmentStartLogMonoTime || this.timelineStartLogMonoTime,
      };
    } else if (provenanceOrLogMonoTime && typeof provenanceOrLogMonoTime === 'object') {
      isPlaying = options.isPlaying ?? this.isPlayingMaster;
    } else {
      return;
    }

    if (provenance.sourceSegmentId !== this.activeVideoSegmentId) {
      if (this.boundaryLoadInProgress) return;
      this.syncToActivePose(provenance, { isPlaying, allowRateCorrection: isPlaying });
      return;
    }
    this.syncToLocalTime(provenance, { allowRateCorrection: isPlaying });
  }

  async playFromLogMonoTime(provenance, isPlaying = true) {
    if (!provenance) return;
    await this.syncToActivePose(provenance, {
      isPlaying,
      forceSeek: true,
      allowRateCorrection: false,
    });
    if (this.state !== 'ready' && this.state !== 'playing' && this.state !== 'paused') return;
    this.isPlayingMaster = true;
    this.setState('playing');
    try {
      await this.videoEl.play();
    } catch {
      this.setState('paused');
      this.isPlayingMaster = false;
    }
  }

  pause() {
    this.isPlayingMaster = false;
    if (!this.videoEl.paused) this.videoEl.pause();
    this.videoEl.playbackRate = 1;
    if (this.state === 'playing') this.setState('paused');
  }

  onMasterPaused(provenance) {
    this.pause();
    if (!provenance) return;
    this.syncToActivePose(provenance, {
      isPlaying: false,
      forceSeek: true,
      allowRateCorrection: false,
    });
  }

  onTimelineScrub(provenance) {
    this.pause();
    if (!provenance) return;
    this.syncToActivePose(provenance, {
      isPlaying: false,
      forceSeek: true,
      allowRateCorrection: false,
    });
  }

  async onSegmentProcessed(segmentId, timelineStartLogMonoTime) {
    this.setTimelineStart(timelineStartLogMonoTime);
    this.segmentStartLogMonoTime = timelineStartLogMonoTime != null
      ? String(timelineStartLogMonoTime)
      : null;
    const provenance = {
      sourceSegmentId: segmentId ? String(segmentId) : null,
      sourceLocalTimeS: 0,
      segmentStartLogMonoTime: this.segmentStartLogMonoTime,
    };
    await this.syncToActivePose(provenance, { isPlaying: false, forceSeek: true });
  }

  unload({ keepVisible = false } = {}) {
    this.pause();
    this._removeMetadataHandler();
    this.videoEl.removeAttribute('src');
    this.videoEl.load();
    this.segmentId = null;
    this.activeVideoSegmentId = null;
    this.requestedVideoSegmentId = null;
    this.segmentStartLogMonoTime = null;
    this.durationSec = null;
    this.pendingSeekTime = null;
    this.isSeeking = false;
    this.isBuffering = false;
    this.isSwitching = false;
    this.segmentTimeline = [];
    if (!keepVisible) this.setVisible(false);
    this.setState('idle');
    this.showMessage('No matching video for this segment');
    this.bodyEl?.classList.add('hidden');
    this.messageEl?.classList.remove('hidden');
    this.updateActiveSegmentIndicator();
  }

  async loadSegment(segmentId) {
    await this.onSegmentProcessed(segmentId, this.timelineStartLogMonoTime);
  }
}

window.LocalPlaybackVideoPanel = LocalPlaybackVideoPanel;
