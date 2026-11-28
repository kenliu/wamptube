// Webamp's media engine replaced by one backed by a <video> element and MSE
// (webamp option `__customMediaClass`, private in 2.3.1; the interface is
// IMedia in webamp/built/types/js/media/index.d.ts). Audio plays straight from
// the element, so the equalizer, preamp and balance do nothing while this
// engine is in use; volume works. The visualizers read pcm.ts instead.
import { invoke } from '@tauri-apps/api/core';
import { MseSession } from './mse';
import { isVideoOpen } from './videowindow';
import { setBuffering } from './throbber';
import { pcmAnalyser, pcmSource } from './pcm';

type Cb = (...a: unknown[]) => void;
const STOPPED = 0, PLAYING = 1, PAUSED = 2;
const statusEl = document.getElementById('status');

/** The element the picture shows on; main.ts puts it on screen. */
export const videoEl = document.createElement('video');
videoEl.id = 'video-pane';
videoEl.playsInline = true;

export class MseMedia {
  private handlers = new Map<string, Cb[]>();
  private session = new MseSession(videoEl);
  private status = STOPPED;
  private loadGeneration = 0;
  private off: Array<() => void> = [];

  constructor() {
    const listen = (ev: string, fn: () => void) => {
      videoEl.addEventListener(ev, fn);
      this.off.push(() => videoEl.removeEventListener(ev, fn));
    };
    // Stalled mid-stream (or after a seek): throb until the element can play again.
    listen('waiting', () => setBuffering('stall', true));
    for (const ev of ['playing', 'canplay', 'pause', 'emptied', 'error']) {
      listen(ev, () => setBuffering('stall', false));
    }
    listen('timeupdate', () => this.emit('timeupdate'));
    listen('durationchange', () => this.emit('fileLoaded'));
    listen('ended', () => this.endTrack());
    listen('error', () => {
      console.error('[mse] element error', videoEl.error?.code, videoEl.error?.message);
      this.endTrack();
    });
  }

  private endTrack() {
    statusEl?.removeAttribute('data-live');
    this.setStatus(STOPPED);
    this.emit('ended');
  }

  private emit(ev: string) { this.handlers.get(ev)?.forEach((cb) => cb()); }
  private setStatus(s: number) {
    this.status = s;
    if (s === PLAYING) this.emit('playing');
    this.emit('timeupdate');
  }

  on(event: string, cb: Cb) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }

  duration() { const d = videoEl.duration; return !this.session.isLive && Number.isFinite(d) ? d : 0; }
  timeElapsed() { return videoEl.currentTime; }

  async play() {
    if (this.status !== PAUSED) this.seekToTime(0);
    const generation = this.loadGeneration;
    try {
      await videoEl.play();
    } catch {
      return; // A failed load is reported by the element's error event.
    }
    if (generation === this.loadGeneration && !videoEl.paused) this.setStatus(PLAYING);
  }
  pause() { videoEl.pause(); this.setStatus(PAUSED); }
  stop() { videoEl.pause(); if (!this.session.isLive) videoEl.currentTime = 0; this.setStatus(STOPPED); }
  seekToTime(t: number) {
    if (this.session.isLive) return;
    videoEl.currentTime = Math.min(Math.max(t, 0), this.duration());
    this.emit('timeupdate');
  }
  seekToPercentComplete(percent: number) { this.seekToTime(this.duration() * (percent / 100)); }

  setVolume(v: number) { videoEl.volume = Math.min(Math.max(v / 100, 0), 1); }
  setBalance(_: number) {}
  setPreamp(_: number) {}
  setEqBand(_band: number, _value: number) {}
  disableEq() {}
  enableEq() {}
  /** A stand-in fed from pcm.ts; it moves only while the FX pane is on. */
  getAnalyser(): AnalyserNode { return (this.analyser ??= pcmAnalyser(videoEl)); }
  private analyser: AnalyserNode | undefined;

  async loadFromUrl(url: string, autoPlay: boolean) {
    const m = /^(https?:\/\/127\.0\.0\.1:\d+)\/v\/([A-Za-z0-9_-]{11})$/.exec(url);
    if (!m) { console.error('[mse] not a proxy /v/ url:', url); return; }
    console.warn(`[mse] load ${m[2]} autoPlay=${autoPlay}`);
    this.emit('waiting');
    // Resolving + fetching the first chunks takes seconds: the start-of-track buffering.
    setBuffering('load', true);
    this.status = STOPPED;
    const generation = ++this.loadGeneration;
    statusEl?.removeAttribute('data-live');
    let current: boolean;
    try {
      current = await this.session.load(m[1], m[2], isVideoOpen());
    } catch (e) {
      if (generation !== this.loadGeneration) return;
      console.error('[mse] load failed', String((e as Error)?.message ?? e));
      setBuffering('load', false);
      this.emit('stopWaiting');
      this.emit('ended');
      return;
    }
    console.warn(`[mse] ${m[2]} ${current ? 'ready' : 'superseded'}`);
    if (!current || generation !== this.loadGeneration) return; // a newer track was requested meanwhile; it owns the UI state now
    statusEl?.toggleAttribute('data-live', this.session.isLive);
    this.emit('stopWaiting');
    if (autoPlay) {
      // Data is appended but playback hasn't started: keep throbbing until 'playing'.
      setBuffering('load', false);
      setBuffering('stall', videoEl.readyState < 3);
      void this.play();
    } else {
      setBuffering('load', false);
    }
  }

  dispose() {
    this.loadGeneration++;
    statusEl?.removeAttribute('data-live');
    this.session.dispose();
    this.off.forEach((f) => f());
    this.pause();
  }
}

/** Audio numbers for the FX pane: decoded separately from playback, see pcm.ts. */
export const fxAudio = pcmSource(videoEl);

/** Proxy origin, kept so other modules can use it. */
export const proxyBase = () => invoke<string>('proxy_base');
