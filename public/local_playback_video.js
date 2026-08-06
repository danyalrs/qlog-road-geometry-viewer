'use strict';

class LocalPlaybackVideoPanel {
  constructor(rootEl) {
    this.rootEl = rootEl;
    this.videoEl = rootEl.querySelector('video');
    this.statusEl = rootEl.querySelector('[data-video-status]');
    this.timeEl = rootEl.querySelector('[data-video-time]');
    this.syncEl = rootEl.querySelector('[data-video-sync]');
    this.messageEl = rootEl.querySelector('[data-video-message]');
    this.bodyEl = rootEl.querySelector('[data-video-body]');
    this.toggleBtn = rootEl.querySelector('[data-video-toggle]');
    this.collapseBtn = rootEl.querySelector('[data-video-collapse]');

    this.segmentId = null;
    this.timelineStartLogMonoTime = null;
    this.videoStartOffsetSeconds = 0;
    this.state = 'idle';
    this.isPlayingMaster = false;
    this.isSeeking = false;
    this.isBuffering = false;
    this.lastSeekWallMs = 0;
    this.lastSyncWallMs = 0;
    this.pendingSeekTime = null;
    this.durationSec = null;

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
    this.videoEl.addEventListener('loadedmetadata', () => {
      this.durationSec = Number.isFinite(this.videoEl.duration) ? this.videoEl.duration : null;
      this.updateTimeDisplay();
    });
    this.videoEl.addEventListener('timeupdate', () => this.updateTimeDisplay());

    this.collapseBtn?.addEventListener('click', () => {
      this.rootEl.classList.toggle('collapsed');
      this.collapseBtn.textContent = this.rootEl.classList.contains('collapsed') ? '▸' : '▾';
    });
  }

  setVisible(visible) {
    this.rootEl.classList.toggle('hidden', !visible);
  }

  setTimelineStart(logMonoTime) {
    this.timelineStartLogMonoTime = logMonoTime != null ? String(logMonoTime) : null;
  }

  async loadSegment(segmentId) {
    this.unload({ keepVisible: true });
    this.segmentId = segmentId ? String(segmentId) : null;
    if (!this.segmentId) {
      this.showMessage('No matching video for this segment');
      return;
    }

    this.setState('loading');
    this.showMessage('Loading synchronized road video…');
    try {
      const res = await fetch(`/api/video/segment/${encodeURIComponent(this.segmentId)}/info`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`info_http_${res.status}`);
      const info = await res.json();
      if (!info.hasVideo || !info.streamUrl) {
        this.showMessage('No matching video for this segment');
        this.setState('missing');
        return;
      }

      this.videoStartOffsetSeconds = Number(info.videoStartOffsetSeconds) || 0;
      this.durationSec = info.remux?.durationSec ?? info.sourceProbe?.durationSec ?? null;
      this.videoEl.src = `${info.streamUrl}?_=${Date.now()}`;
      this.videoEl.load();
      this.bodyEl?.classList.remove('hidden');
      this.messageEl?.classList.add('hidden');
      this.setState('ready');
      this.updateSyncIndicator('ready');
    } catch (err) {
      this.showMessage('No matching video for this segment');
      this.setState('error');
      // eslint-disable-next-line no-console
      console.warn('[local-video] load failed', err);
    }
  }

  unload({ keepVisible = false } = {}) {
    this.pause();
    this.videoEl.removeAttribute('src');
    this.videoEl.load();
    this.segmentId = null;
    this.durationSec = null;
    this.pendingSeekTime = null;
    this.isSeeking = false;
    this.isBuffering = false;
    if (!keepVisible) this.setVisible(false);
    this.setState('idle');
    this.showMessage('No matching video for this segment');
    this.bodyEl?.classList.add('hidden');
    this.messageEl?.classList.remove('hidden');
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

  getExpectedVideoTime(currentLogMonoTime) {
    const timing = window.SegmentVideoTiming;
    if (!timing || !this.timelineStartLogMonoTime) return null;
    const localElapsed = timing.computeLocalElapsedSeconds(
      currentLogMonoTime,
      this.timelineStartLogMonoTime,
    );
    return timing.computeExpectedVideoTime(localElapsed, this.videoStartOffsetSeconds);
  }

  seekToExpectedTime(expectedVideoTime, { force = false } = {}) {
    if (!Number.isFinite(expectedVideoTime) || this.state !== 'ready' && this.state !== 'playing' && this.state !== 'paused') {
      return false;
    }
    const now = performance.now();
    if (!force && (this.isSeeking || this.isBuffering)) return false;
    if (!force && now - this.lastSeekWallMs < 250) return false;
    if (!force && this.pendingSeekTime != null && Math.abs(this.pendingSeekTime - expectedVideoTime) < 0.05) {
      return false;
    }

    const clamped = Math.max(0, expectedVideoTime);
    if (Number.isFinite(this.durationSec)) {
      const maxTime = Math.max(0, this.durationSec - 0.05);
      if (clamped > maxTime) return false;
    }

    this.pendingSeekTime = clamped;
    this.lastSeekWallMs = now;
    this.videoEl.currentTime = clamped;
    this.updateSyncIndicator('seek');
    return true;
  }

  syncToLogMonoTime(currentLogMonoTime, { forceSeek = false, allowRateCorrection = true } = {}) {
    if (this.state !== 'ready' && this.state !== 'playing' && this.state !== 'paused') return;
    const expected = this.getExpectedVideoTime(currentLogMonoTime);
    if (!Number.isFinite(expected)) return;

    if (forceSeek) {
      this.videoEl.playbackRate = 1;
      this.seekToExpectedTime(expected, { force: true });
      this.updateTimeDisplay();
      return;
    }

    if (this.isSeeking || this.isBuffering) return;

    const drift = this.videoEl.currentTime - expected;
    const action = window.SegmentVideoTiming.computeSyncAction(drift);
    if (action.action === 'none') {
      if (this.videoEl.playbackRate !== 1) this.videoEl.playbackRate = 1;
      this.updateSyncIndicator(this.isPlayingMaster ? 'synced' : 'ready');
      return;
    }
    if (action.action === 'rate' && allowRateCorrection && this.isPlayingMaster) {
      this.videoEl.playbackRate = action.playbackRate;
      this.updateSyncIndicator('correcting');
      return;
    }
    if (action.action === 'seek') {
      this.videoEl.playbackRate = 1;
      this.seekToExpectedTime(expected);
    }
  }

  tickSync(currentLogMonoTime) {
    const now = performance.now();
    if (now - this.lastSyncWallMs < 100) return;
    this.lastSyncWallMs = now;
    this.syncToLogMonoTime(currentLogMonoTime, { allowRateCorrection: this.isPlayingMaster });
  }

  async playFromLogMonoTime(currentLogMonoTime) {
    if (this.state !== 'ready' && this.state !== 'paused' && this.state !== 'playing') return;
    this.isPlayingMaster = true;
    this.syncToLogMonoTime(currentLogMonoTime, { forceSeek: true });
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

  onMasterPaused(currentLogMonoTime) {
    this.pause();
    this.syncToLogMonoTime(currentLogMonoTime, { forceSeek: true, allowRateCorrection: false });
  }

  onTimelineScrub(currentLogMonoTime) {
    this.pause();
    this.syncToLogMonoTime(currentLogMonoTime, { forceSeek: true, allowRateCorrection: false });
  }

  onSegmentProcessed(segmentId, timelineStartLogMonoTime) {
    this.setTimelineStart(timelineStartLogMonoTime);
    return this.loadSegment(segmentId);
  }
}

window.LocalPlaybackVideoPanel = LocalPlaybackVideoPanel;
