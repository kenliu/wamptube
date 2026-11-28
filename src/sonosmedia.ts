// Sonos output. Webamp gets one media object (`RoutedMedia`, its
// `__customMediaClass`) that forwards to the local MSE engine or, while a Sonos
// room is picked in the Output device menu, to `SonosMedia`. The speaker fetches
// the audio itself from a LAN proxy (src-tauri/src/sonos.rs); this side sends
// commands and polls the position once a second. While a room is playing, the
// equalizer and the visualizers have nothing to work on.
import { invoke } from '@tauri-apps/api/core';
import { MseMedia, videoEl } from './msemedia';
import { setBuffering } from './throbber';
import { setVideoNote } from './videowindow';
import type { Room } from './output';

export type { Room };


type Cb = (...a: unknown[]) => void;
const STOPPED = 0, PLAYING = 1, PAUSED = 2;
const VIDEO_URL = /\/v\/([A-Za-z0-9_-]{11})$/;
/** After a command, the speaker may report STOPPED or TRANSITIONING for a moment. */
const SETTLE_MS = 5000;

class SonosMedia {
  room: Room | null = null;
  private handlers = new Map<string, Cb[]>();
  private status = STOPPED;
  private videoId = ''; // what Webamp loaded
  private onSpeaker = ''; // what the speaker has
  private dur = 0;
  private pos = 0;
  private posAt = 0;
  private lastCmd = 0;
  private gen = 0;
  private poller: number | undefined;
  private volTimer: number | undefined;

  on(event: string, cb: Cb) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  private emit(ev: string) { this.handlers.get(ev)?.forEach((cb) => cb()); }

  private async ctl(action: string, value?: number) {
    if (!this.room) return;
    this.lastCmd = performance.now();
    try {
      await invoke('sonos_control', { ip: this.room.ip, action, value: value ?? null });
    } catch (e) {
      console.error(`[sonos] ${action} failed:`, String(e));
    }
  }

  private setPos(s: number) { this.pos = s; this.posAt = performance.now(); }
  private setStatus(s: number) {
    this.status = s;
    if (s === PLAYING) this.emit('playing');
    this.emit('timeupdate');
    clearInterval(this.poller);
    this.poller = s === PLAYING ? window.setInterval(() => void this.poll(), 1000) : undefined;
  }

  isPlaying() { return this.status === PLAYING; }
  duration() { return this.dur; }
  timeElapsed() {
    const t = this.status === PLAYING ? this.pos + (performance.now() - this.posAt) / 1000 : this.pos;
    return this.dur ? Math.min(t, this.dur) : t;
  }

  /** Nothing reaches the speaker until play: loading track 1 at launch, or
   * browsing the playlist, must not interrupt what the room is playing. */
  async loadFromUrl(url: string, autoPlay: boolean) {
    const m = VIDEO_URL.exec(url);
    if (!m) { console.error('[sonos] not a proxy /v/ url:', url); return; }
    this.gen++;
    this.videoId = m[1];
    this.dur = 0;
    this.setPos(0);
    this.setStatus(STOPPED);
    this.emit('fileLoaded');
    if (autoPlay) await this.play();
  }

  async play() {
    if (!this.room || !this.videoId) return;
    if (this.onSpeaker === this.videoId) {
      if (this.status === PLAYING) { await this.ctl('seek', 0); this.setPos(0); }
      if (this.status === STOPPED) this.setPos(0);
      await this.ctl('play');
      this.setPos(this.pos);
      this.setStatus(PLAYING);
      return;
    }
    // A new track for the speaker: resolve, serve on the LAN, start it.
    const gen = ++this.gen;
    const { ip, name } = this.room;
    const id = this.videoId;
    console.warn(`[sonos] ${name}: play ${id}`);
    this.emit('waiting');
    setBuffering('load', true);
    this.lastCmd = performance.now();
    try {
      const d = await invoke<number>('sonos_play_video', { ip, video_id: id });
      if (gen !== this.gen) return; // a newer track or room took over
      this.dur = d;
      this.onSpeaker = id;
      this.setPos(0);
      this.lastCmd = performance.now();
      this.emit('fileLoaded');
      this.setStatus(PLAYING);
    } catch (e) {
      console.error(`[sonos] ${name}: play ${id} failed:`, String(e));
      if (gen === this.gen) this.setStatus(STOPPED);
    } finally {
      if (gen === this.gen) {
        setBuffering('load', false);
        this.emit('stopWaiting');
      }
    }
  }

  pause() {
    this.setPos(this.timeElapsed());
    this.setStatus(PAUSED);
    void this.ctl('pause');
  }
  stop() {
    this.gen++;
    if (this.onSpeaker) void this.ctl('stop');
    this.setPos(0);
    this.setStatus(STOPPED);
  }
  seekToTime(t: number) {
    const s = Math.max(0, this.dur ? Math.min(t, this.dur) : t);
    this.setPos(s);
    if (this.onSpeaker === this.videoId) void this.ctl('seek', Math.round(s));
    this.emit('timeupdate');
  }
  seekToPercentComplete(percent: number) { this.seekToTime(this.dur * (percent / 100)); }

  /** Webamp's slider, 0-100, straight to the speaker (debounced while dragging). */
  setVolume(v: number) {
    clearTimeout(this.volTimer);
    this.volTimer = window.setTimeout(() => void this.ctl('volume', Math.round(v)), 150);
  }

  private async poll() {
    const room = this.room;
    if (!room || this.status !== PLAYING || !this.onSpeaker) return;
    let st: { state: string; rel_s: number };
    try {
      st = await invoke('sonos_status', { ip: room.ip });
    } catch (e) {
      console.error('[sonos] status failed:', String(e));
      return;
    }
    if (room !== this.room || this.status !== PLAYING) return;
    const settling = performance.now() - this.lastCmd < SETTLE_MS;
    if (st.state === 'PLAYING' && !settling) {
      this.setPos(st.rel_s);
      this.emit('timeupdate');
    } else if (st.state === 'STOPPED' && !settling) {
      const nearEnd = this.dur > 0 && this.timeElapsed() >= this.dur - 5;
      console.warn(`[sonos] ${room.name}: stopped at ${Math.round(this.timeElapsed())}/${this.dur}s`);
      this.onSpeaker = '';
      this.setPos(0);
      this.setStatus(STOPPED);
      if (nearEnd) this.emit('ended'); // Webamp moves on to the next track
    }
  }

  /** Point at another room (or none). Stops the old one; the caller replays. */
  setRoom(room: Room | null) {
    if (this.room && this.onSpeaker) void this.ctl('stop');
    this.gen++;
    this.room = room;
    this.onSpeaker = '';
    this.setPos(0);
    this.setStatus(STOPPED);
  }

  dispose() { clearInterval(this.poller); clearTimeout(this.volTimer); }
}

let active: RoutedMedia | null = null;
let syncSlider: (v: number) => void = () => {};

/** main.ts passes `webamp.setVolume`, so the slider can follow the output. */
export function onSliderSync(fn: (v: number) => void) { syncSlider = fn; }

export function currentRoom(): Room | null { return active?.room() ?? null; }

/** Send playback to a Sonos room, or back to this computer with `null`. */
export function routeTo(room: Room | null) { return active?.route(room); }

let rooms: Room[] = [];
let lookedAt = 0;
let looking: Promise<Room[]> | null = null;

/** Known rooms; starts a discovery (~2 s) if the last is over 15 s old. */
export function sonosRooms(onUpdate?: (r: Room[]) => void): Room[] {
  if (!looking && performance.now() - lookedAt > 15_000 && '__TAURI_INTERNALS__' in window) {
    looking = invoke<Room[]>('sonos_rooms')
      .then((r) => {
        if (r.map((x) => x.name).join() !== rooms.map((x) => x.name).join()) {
          console.warn(`[sonos] rooms: ${r.map((x) => `${x.name} (${x.ip})`).join(', ') || 'none'}`);
        }
        rooms = r;
        return r;
      })
      .catch((e) => { console.error('[sonos] discovery failed:', String(e)); return rooms; })
      .finally(() => { lookedAt = performance.now(); looking = null; });
    if (onUpdate) void looking.then(onUpdate);
  }
  return rooms;
}

/** The discovery in progress, if any. */
export function sonosSearching(): Promise<Room[]> | null { return looking; }

type Media = MseMedia | SonosMedia;

/** Webamp's media class: forwards to the local engine or to the Sonos room. */
export class RoutedMedia {
  private local = new MseMedia();
  private sonos = new SonosMedia();
  private url = '';
  private localVolume = 75;

  constructor() { active = this; }

  room() { return this.sonos.room; }
  private get cur(): Media { return this.sonos.room ? this.sonos : this.local; }

  on(event: string, cb: Cb) {
    // Each engine's events count only while it is the one in use.
    this.local.on(event, (...a) => { if (this.cur === this.local) cb(...a); });
    this.sonos.on(event, (...a) => { if (this.cur === this.sonos) cb(...a); });
  }

  duration() { return this.cur.duration(); }
  timeElapsed() { return this.cur.timeElapsed(); }
  play() { return this.cur.play(); }
  pause() { this.cur.pause(); }
  stop() { this.cur.stop(); }
  seekToTime(t: number) { this.cur.seekToTime(t); }
  seekToPercentComplete(p: number) { this.cur.seekToPercentComplete(p); }
  setVolume(v: number) {
    if (!this.sonos.room) this.localVolume = v;
    this.cur.setVolume(v);
  }
  setBalance(v: number) { this.local.setBalance(v); }
  setPreamp(v: number) { this.local.setPreamp(v); }
  setEqBand(band: number, v: number) { this.local.setEqBand(band, v); }
  disableEq() { this.local.disableEq(); }
  enableEq() { this.local.enableEq(); }
  getAnalyser() { return this.local.getAnalyser(); }

  loadFromUrl(url: string, autoPlay: boolean) {
    this.url = url;
    return this.cur.loadFromUrl(url, autoPlay);
  }

  /** Move the current track to `room` (or back here), at the same position. */
  async route(room: Room | null) {
    if (room?.ip === this.sonos.room?.ip) return;
    const from = this.cur;
    const at = from.timeElapsed();
    const wasPlaying = from === this.local ? !videoEl.paused : this.sonos.isPlaying();
    if (from === this.local) this.local.stop();
    this.sonos.setRoom(room);
    // Sonos gets the audio stream only; the local picture stops with the local engine.
    setVideoNote(room ? `Playing on Sonos: ${room.name}\nVideo shows only when playing on this computer` : null);
    console.warn(`[sonos] output -> ${room ? room.name : 'this computer'} (at ${Math.round(at)}s, ${wasPlaying ? 'playing' : 'idle'})`);

    // The slider follows the output: the room's own volume, or the old local one.
    if (room) {
      try {
        syncSlider(await invoke<number>('sonos_volume', { ip: room.ip }));
      } catch (e) {
        console.error('[sonos] volume read failed:', String(e));
      }
    } else {
      syncSlider(this.localVolume);
    }

    if (!this.url) return;
    const to = this.cur;
    await to.loadFromUrl(this.url, false);
    if (wasPlaying) {
      await to.play();
      if (at > 1) to.seekToTime(at);
    }
  }

  dispose() {
    this.local.dispose();
    this.sonos.dispose();
  }
}
