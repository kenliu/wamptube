/// <reference types="vite/client" />
import Webamp from 'webamp';
// Throwaway MSE spike (see src/spike.ts): VITE_SPIKE=1 deno task tauri dev
if (import.meta.env.VITE_SPIKE) location.replace('/spike.html');
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { fxAudio, videoEl } from './msemedia';
import { RoutedMedia, currentRoom, onSliderSync, routeTo, sonosRooms, sonosSearching, type Room } from './sonosmedia';
import { demoSource } from './fx';
import { installThrobber } from './throbber';
import { installNativeMenus } from './nativemenu';
import { installOutputMenu } from './output';
import {
  VIDEO_STACK_FLOOR,
  frameSize,
  getFrameWidth,
  isPaneOpen,
  installVideoMenuItem,
  mountVideoWindow,
  onVideoResize,
  placeVideoWindow,
  refreshGriplessSprite,
  setFrameWidth,
} from './videowindow';
import {
  handleAddUrlEvent,
  handleTrackDropEvent,
  listSource,
  toWebampTrack,
  type TrackInfo,
  type WebampTrack,
} from './addsource';

/**
 * Whole-UI scale factor (1 or 2). Webamp lays out at 1x (275x348) and #webamp
 * is scaled with a CSS transform (see style.css). The Tauri window size in
 * src-tauri/tauri.conf.json must be 275*UI_SCALE x 348*UI_SCALE.
 */
const UI_SCALE: number = 2;
document.documentElement.style.setProperty('--ui-scale', String(UI_SCALE));

type StartupTracks = {
  config_path: string;
  source_count: number;
  tracks: TrackInfo[];
  errors: string[];
};

/** Fixed tracks for VITE_SELFTEST runs, so the checks don't depend on the user's config. */
const TEST_VIDEO_IDS = ['u1MqeDGBo94', 'Hf20ZzMRs-I', 'dkrpqUyiZgA'];

const statusEl = document.getElementById('status')!;
/** Shown under every status message until clicked; see watchYtdlp. */
let stickyEl: HTMLElement | null = null;
function setStatus(lines: { text: string; err?: boolean }[]) {
  statusEl.replaceChildren(
    ...lines.map((l) => {
      const d = document.createElement('div');
      d.textContent = l.text;
      if (l.err) d.className = 'err';
      return d;
    }),
    ...(stickyEl ? [stickyEl] : []),
  );
}

type YtdlpOutdated = { line: string; version: string | null };

/**
 * yt-dlp warned that it could not solve YouTube's JS challenges (resolve.rs),
 * which means it is out of date: playback can break with no other error.
 * Say so once per launch, in the status line, until clicked. Playback goes on.
 */
async function watchYtdlp() {
  let shown = false;
  await listen<YtdlpOutdated>('ytdlp-outdated', ({ payload }) => {
    console.warn(`[yt-dlp] outdated? ${payload.version ?? '(version unknown)'}: ${payload.line}`);
    if (shown) return;
    shown = true;
    const v = payload.version ? ` ${payload.version}` : '';
    const d = document.createElement('div');
    d.className = 'err sticky';
    d.textContent = `yt-dlp${v} may be outdated: update it (brew upgrade yt-dlp / scoop update yt-dlp). Click to hide.`;
    d.title = payload.line;
    d.addEventListener('click', () => {
      d.remove();
      stickyEl = null;
    });
    stickyEl = d;
    statusEl.append(d);
  });
}

type Line = { text: string; err?: boolean };

/** Tracks from the config file, or the test ids under VITE_SELFTEST. */
async function loadTracks(): Promise<{ tracks: WebampTrack[]; lines: Line[] }> {
  const lines: Line[] = [];
  if (import.meta.env.VITE_SELFTEST) {
    const results = await Promise.allSettled(TEST_VIDEO_IDS.map(listSource));
    const tracks: WebampTrack[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') tracks.push(...r.value.tracks.map(toWebampTrack));
      else lines.push({ text: `${TEST_VIDEO_IDS[i]}: ${errMsg(r.reason)}`, err: true });
    });
    return { tracks, lines };
  }
  const s = await invoke<StartupTracks>('startup_tracks');
  console.warn(`[config] ${s.config_path}: ${s.source_count} sources, ${s.tracks.length} tracks`);
  for (const e of s.errors) {
    console.error('[config]', e);
    lines.push({ text: e, err: true });
  }
  if (s.source_count === 0) {
    lines.push({ text: `No sources yet. Use the playlist's ADD > URL, or edit ${s.config_path}` });
  }
  return { tracks: s.tracks.map(toWebampTrack), lines };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function installDragHandler() {
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const bar = target.closest('#main-window #title-bar, .video-top');
      if (!bar) return;
      // leave the menu / minimize / shade / close buttons alone
      if (target.closest('#option, #minimize, #shade, #close, #video-close')) return;
      e.preventDefault();
      e.stopPropagation();
      getCurrentWindow()
        .startDragging()
        .catch((err) => console.error('startDragging failed', err));
    },
    true,
  );
}

/** Top-to-bottom stacking order of the Webamp windows inside the Tauri window. */
const STACK = ['main', 'equalizer', 'playlist'] as const;

/**
 * Pixel size of a Webamp window at 1x, from its store entry. Mirrors Webamp's
 * own getWPixelSize (webamp 2.3.1): 275x116 plus 25x29 per resize segment,
 * 14 tall when shaded, doubled for main/EQ in double-size mode.
 */
function windowPixelSize(w: any, doubled: boolean) {
  const [segW, segH] = w.size as [number, number];
  const k = doubled && w.canDouble ? 2 : 1;
  return { width: (275 + segW * 25) * k, height: (w.shade ? 14 : 116 + segH * 29) * k };
}

/**
 * Where the open windows go when stacked top to bottom with no gaps, and the
 * 1x box they fill.
 */
function stackLayout(state: any) {
  const gen = state.windows.genWindows;
  const doubled = !!state.display.doubled;
  const moves: Record<string, { x: number; y: number }> = {};
  let height = 0;
  let width = 275;
  for (const id of STACK) {
    const w = gen[id];
    if (!w?.open) continue;
    const size = windowPixelSize(w, doubled);
    if (w.position.x !== 0 || w.position.y !== height) moves[id] = { x: 0, y: height };
    height += size.height;
    width = Math.max(width, size.width);
  }
  return { width, height, moves };
}

/** Set by installAutoLayout; lets the video window ask for a fresh layout. */
let relayoutNow: () => void = () => {};

let fittedKey = '';
let lastStack = { width: 275, height: 348 };
/**
 * Size #app (1x) to a stack of the given size, put the video window to its right
 * when open, and size the Tauri window (scaled) to hold both. #app has to match
 * the stack: on every window resize Webamp re-checks that its windows fit inside
 * the mount node and shoves them back in if not.
 */
function fitWindow(width: number, height: number): Promise<void> {
  lastStack = { width, height };
  const video = isPaneOpen();
  const key = `${width}x${height}${video ? `v${getFrameWidth()}` : ''}`;
  if (key === fittedKey) return Promise.resolve();
  fittedKey = key;
  console.warn(`[layout] ${key} (x${UI_SCALE})`);
  const app = document.getElementById('app')!;
  app.style.width = `${width}px`;
  app.style.height = `${height}px`;
  placeVideoWindow(width, height);
  const frame = frameSize(height);
  return getCurrentWindow()
    .setSize(
      new LogicalSize(
        (width + (video ? frame.w : 0)) * UI_SCALE,
        Math.max(height, video ? frame.h : 0) * UI_SCALE,
      ),
    )
    .catch((e) => console.error('setSize failed', e));
}

const WAMPTUBE_SKIN = '/skins/wamptube.wsz';
/** Set in main() once Webamp exists; used to answer the "Base skin" menu item. */
let setBaseSkin: (() => void) | null = null;

/**
 * Redux middleware for Webamp's `__customMiddlewares` option: hold the
 * playlist's width at the main window's when its resize handle is dragged,
 * since main and EQ can't be widened. Only its height changes. Also redirects the
 * "Base skin" menu item to our skin.
 */
const resizeMiddleware = () => (next: (a: any) => any) => (action: any) => {
  if (action?.type === 'WINDOW_SIZE_CHANGED' && action.windowId === 'playlist') {
    action = { ...action, size: [0, action.size[1]] };
  }
  // "Base skin" in the skin menu would restore Webamp's stock art; load ours instead.
  if (action?.type === 'LOAD_DEFAULT_SKIN' && setBaseSkin) {
    setBaseSkin();
    return;
  }
  return next(action);
};

/**
 * Keep the open Webamp windows stacked with no gaps and size the Tauri window
 * to fit them, so closing or shading the EQ or playlist (or resizing the
 * playlist) doesn't leave an empty black slot. Works from Webamp's store
 * (`webamp.store`, public in the 2.3.1 typings), not the DOM, because React
 * renders a store change later than the store notifies us.
 */
function installAutoLayout(webamp: Webamp) {
  const store = (webamp as any).store as {
    getState(): any;
    dispatch(a: unknown): void;
    subscribe(cb: () => void): () => void;
  };
  let scheduled = false;

  /** Playlist segments (29 px each) needed so the stack reaches the video's minimum height. */
  const minPlaylistSeg = (state: any) => {
    const pl = state.windows.genWindows.playlist;
    const { height } = stackLayout(state);
    const others = height - windowPixelSize(pl, false).height;
    return Math.max(0, Math.ceil((VIDEO_STACK_FLOOR - others - 116) / 29));
  };
  const playlistFlexible = (state: any) => {
    const pl = state.windows.genWindows.playlist;
    return !!pl?.open && !pl.shade;
  };

  const relayout = () => {
    scheduled = false;
    refreshGriplessSprite();
    const state = store.getState();
    // With the video window open, the playlist grows so the stack is tall enough
    // for the picture (rather than leaving an empty box under a short stack).
    if (isPaneOpen() && playlistFlexible(state)) {
      const pl = state.windows.genWindows.playlist;
      const need = minPlaylistSeg(state);
      if (pl.size[1] < need) {
        store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'playlist', size: [0, need] });
        return; // the store change schedules another pass
      }
    }
    const { width, height, moves } = stackLayout(store.getState());
    if (height === 0) return;
    void fitWindow(width, height);
    if (Object.keys(moves).length) {
      store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions: moves });
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(relayout);
  };
  store.subscribe(schedule);
  relayoutNow = schedule;

  // The video window's bottom-right grip: horizontal drag sets the video frame's width,
  // vertical drag changes the playlist's height (so the whole stack and frame).
  let startSeg = 0;
  let startW = 0;
  onVideoResize((dx, dy, phase) => {
    const state = store.getState();
    if (phase === 'start') {
      startSeg = state.windows.genWindows.playlist?.size[1] ?? 0;
      startW = getFrameWidth();
    }
    if (phase !== 'move') return;
    if (playlistFlexible(state)) {
      const seg = Math.min(14, Math.max(minPlaylistSeg(state), startSeg + Math.round(dy / UI_SCALE / 29)));
      if (seg !== state.windows.genWindows.playlist.size[1]) {
        store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'playlist', size: [0, seg] });
      }
    }
    setFrameWidth(startW + dx / UI_SCALE);
    if (getFrameWidth() !== startW) schedule();
  });
  relayout();
}

/**
 * Webamp's resize handles turn raw clientX/Y deltas into 25x29 px steps, but
 * #webamp is drawn UI_SCALE times larger, so the window would grow faster than
 * the pointer moves. While a resize handle is held, swap each mousemove for one
 * whose offset from the press point is divided by UI_SCALE.
 */
function installResizeScaling() {
  if (UI_SCALE === 1) return;
  const ours = new WeakSet<Event>();
  let start: { x: number; y: number } | null = null;
  window.addEventListener(
    'mousedown',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (e.button === 0 && t?.closest('#playlist-resize-target, #gen-resize-target')) {
        start = { x: e.clientX, y: e.clientY };
      }
    },
    true,
  );
  window.addEventListener('mouseup', () => (start = null), true);
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!start || ours.has(e)) return;
      e.stopImmediatePropagation();
      const scaled = new MouseEvent('mousemove', {
        bubbles: true,
        clientX: start.x + (e.clientX - start.x) / UI_SCALE,
        clientY: start.y + (e.clientY - start.y) / UI_SCALE,
        buttons: e.buttons,
      });
      ours.add(scaled);
      window.dispatchEvent(scaled);
    },
    true,
  );
}

function logAudioErrors() {
  const handler = (e: Event) => {
    const t = e.target;
    if (t instanceof HTMLMediaElement) {
      console.error('[audio error]', t.currentSrc || t.src, t.error?.code, t.error?.message, e);
    }
  };
  // media error events don't bubble; capture on window catches them
  window.addEventListener('error', handler, true);
  window.addEventListener('unhandledrejection', (e) =>
    console.error('[unhandled rejection]', e.reason),
  );
}

async function main() {
  logAudioErrors();
  // before anything runs yt-dlp, so the first warning is not missed
  await watchYtdlp().catch((e) => console.error('[yt-dlp] cannot watch for outdated warnings', e));
  setStatus([{ text: 'loading playlist…' }]);

  const { tracks, lines } = await loadTracks().catch((e) => ({
    tracks: [] as WebampTrack[],
    lines: [{ text: errMsg(e), err: true }] as Line[],
  }));
  setStatus(lines);

  // Messages from ADD > URL and link drops; they replace the startup lines.
  let clearTimer: number | undefined;
  const notify = (text: string, err?: boolean) => {
    setStatus([{ text, err }]);
    clearTimeout(clearTimer);
    if (!err && !text.endsWith('…')) clearTimer = window.setTimeout(() => setStatus([]), 5000);
  };

  const webamp = new Webamp({
    initialTracks: tracks,
    // Webamp's default art with WAMPTUBE lettering; built by tools/make-skin.ts
    initialSkin: { url: WAMPTUBE_SKIN },
    windowLayout: {
      main: { position: { left: 0, top: 0 } },
      equalizer: { position: { left: 0, top: 116 } },
      playlist: { position: { left: 0, top: 232 }, size: { extraHeight: 0, extraWidth: 0 } },
    },
    enableHotkeys: true,
    handleAddUrlEvent: handleAddUrlEvent(notify),
    handleTrackDropEvent: handleTrackDropEvent(notify),
    // private option in webamp 2.3.1; see resizeMiddleware
    __customMiddlewares: [resizeMiddleware],
    // private option in webamp 2.3.1: video + audio through one MSE <video> element,
    // or a Sonos room picked in the Output device menu (sonosmedia.ts)
    __customMediaClass: RoutedMedia,
  } as any);

  setBaseSkin = () => webamp.setSkinFromUrl(WAMPTUBE_SKIN);
  onSliderSync((v) => webamp.setVolume(v));
  installOutputMenu(videoEl, { rooms: () => sonosRooms(), searching: sonosSearching, current: currentRoom, routeTo });

  const inTauri = '__TAURI_INTERNALS__' in window;
  if (inTauri) {
    installNativeMenus();
    webamp.onClose(() => {
      getCurrentWindow().close().catch((e) => console.error('close failed', e));
    });
    webamp.onMinimize(() => {
      getCurrentWindow().minimize().catch((e) => console.error('minimize failed', e));
    });
    installDragHandler();
  }

  // attach audio error listeners to Webamp's <audio> element(s) as they appear
  const hook = (el: HTMLMediaElement) => {
    if ((el as any).__wt) return;
    (el as any).__wt = true;
    el.addEventListener('error', () =>
      console.error('[audio element error]', el.currentSrc, el.error?.code, el.error?.message),
    );
    el.addEventListener('stalled', () => console.warn('[audio stalled]', el.currentSrc));
  };
  document.querySelectorAll('audio').forEach(hook);
  new MutationObserver(() => document.querySelectorAll('audio').forEach(hook)).observe(
    document.documentElement,
    { childList: true, subtree: true },
  );
  // Webamp's audio element is created detached; also hook via Audio constructor path
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    hook(this);
    lastAudio = this;
    const p = origPlay.call(this);
    p?.catch?.((e: unknown) => console.error('[audio play() rejected]', this.currentSrc, e));
    return p;
  };

  await webamp.renderWhenReady(document.getElementById('app')!);
  mountVideoWindow(
    document.getElementById('webamp')!,
    videoEl,
    () => relayoutNow(),
    // `?fxdemo`: made-up audio, for looking at FX in a plain browser where nothing plays
    () => (new URLSearchParams(location.search).has('fxdemo') ? demoSource : fxAudio),
  );
  installVideoMenuItem();
  installThrobber();
  if (inTauri) installAutoLayout(webamp);
  else placeVideoWindow(275, 348); // plain browser: no auto layout, so size the pane for the default stack
  installResizeScaling();

  if (import.meta.env.VITE_SELFTEST === 'timeline') void timelineProbe(webamp);
  else if (import.meta.env.VITE_SELFTEST === 'sonos') void sonosSelfTest(webamp);
  else if (import.meta.env.VITE_SELFTEST) void selfTest(webamp, tracks.length);
}

let lastAudio: HTMLMediaElement | null = null;

/** Diagnostic (VITE_SELFTEST=timeline): seek track 1 to known times and log what the element reports. */
async function timelineProbe(webamp: Webamp) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rep = (label: string) => {
    const a = lastAudio;
    const b = a ? Array.from({ length: a.buffered.length }, (_, i) => `${a.buffered.start(i).toFixed(0)}-${a.buffered.end(i).toFixed(0)}`).join(',') : '';
    const sk = a && a.seekable.length ? `${a.seekable.start(0).toFixed(0)}-${a.seekable.end(a.seekable.length - 1).toFixed(0)}` : '';
    console.warn(`[timeline] ${label}: t=${a?.currentTime.toFixed(1)} dur=${a?.duration.toFixed(1)} buffered=[${b}] seekable=[${sk}] ended=${a?.ended} paused=${a?.paused} ready=${a?.readyState}`);
  };
  webamp.setVolume(4);
  webamp.setCurrentTrack(1);
  webamp.play();
  await sleep(12000);
  rep('playing');
  for (const t of [663]) {
    console.warn(`[timeline] --- setting currentTime=${t}`);
    if (lastAudio) lastAudio.currentTime = t;
    lastAudio?.addEventListener('ended', () => console.warn(`[timeline] ENDED event at t=${lastAudio?.currentTime.toFixed(1)}`), { once: true });
    await sleep(3000);
    rep(`after ${t} +3s`);
    await sleep(6000);
    rep(`after ${t} +9s`);
  }
  webamp.stop();
  console.warn('[timeline] done');
}

/**
 * Opt-in playback check (run with VITE_SELFTEST=1): plays each track quietly,
 * seeks deep into it, pauses and resumes, and logs the audio element's state
 * so playback can be verified from the dev log without clicking.
 */
async function selfTest(webamp: Webamp, count: number) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const report = (label: string) => {
    const a = lastAudio;
    console.warn(
      `[selftest] ${label}: status=${webamp.getMediaStatus()} t=${a?.currentTime.toFixed(1)} ` +
        `dur=${a?.duration.toFixed(0)} readyState=${a?.readyState} paused=${a?.paused} err=${a?.error?.code ?? 'none'}`,
    );
    return a?.currentTime ?? 0;
  };
  webamp.setVolume(4);
  for (let i = 0; i < count; i++) {
    webamp.setCurrentTrack(i);
    webamp.play();
    // First play resolves the video (~3 s) and waits for the fresh URL to become
    // available (~6 s); wait for the element to have data, then a little more.
    for (let w = 0; w < 30 && !((lastAudio?.readyState ?? 0) >= 3 && (lastAudio?.currentTime ?? 0) > 0); w++) {
      await sleep(1000);
    }
    await sleep(2000);
    const t1 = report(`track ${i} after play`);
    await sleep(3000);
    const t2 = report(`track ${i} +3s`);
    console.warn(`[selftest] track ${i} advancing=${t2 > t1 + 2}`);
    const target = Math.floor((lastAudio?.duration || 0) * 0.85);
    webamp.seekToTime(target);
    await sleep(6000);
    const t3 = report(`track ${i} after seek to ${target}s`);
    console.warn(`[selftest] track ${i} deep-seek-ok=${t3 >= target && t3 < target + 12}`);
    webamp.pause();
    await sleep(2000);
    const t4 = report(`track ${i} paused`);
    await sleep(2000);
    console.warn(`[selftest] track ${i} pause-holds=${Math.abs(report(`track ${i} still paused`) - t4) < 0.2}`);
    webamp.play();
    await sleep(3000);
    console.warn(`[selftest] track ${i} resume-ok=${report(`track ${i} resumed`) > t4 + 2}`);
  }
  webamp.stop();
  console.warn('[selftest] done');
}

/**
 * Sonos check (VITE_SELFTEST=sonos, room from VITE_SONOS_ROOM or the first
 * found): starts track 1 here, moves it to the room, then drives volume, seek,
 * pause, next track and end-of-track through Webamp, and brings it back.
 * Plays out loud in that room at its current volume.
 */
async function sonosSelfTest(webamp: Webamp) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const log = (m: string) => console.warn(`[selftest] ${m}`);
  const status = () => invoke<{ state: string; rel_s: number }>('sonos_status', { ip: room!.ip }).catch((e) => ({ state: String(e), rel_s: -1 }));

  webamp.setVolume(4);
  webamp.setCurrentTrack(0);
  webamp.play();
  for (let w = 0; w < 30 && !((lastAudio?.currentTime ?? 0) > 3); w++) await sleep(1000);
  const tLocal = lastAudio?.currentTime ?? 0;
  log(`local playing t=${tLocal.toFixed(1)} local-ok=${tLocal > 3}`);

  let room: Room | undefined;
  const want = import.meta.env.VITE_SONOS_ROOM as string | undefined;
  for (let w = 0; w < 20 && !room; w++) {
    const rooms = sonosRooms();
    room = want ? rooms.find((r) => r.name.toLowerCase() === want.toLowerCase()) : rooms[0];
    if (!room) await sleep(1000);
  }
  if (!room) { log(`no Sonos room ${want ?? ''} found; done`); return; }

  const at = webamp.getMediaStatus() === 'PLAYING' ? lastAudio?.currentTime ?? 0 : 0;
  await routeTo(room);
  await sleep(6000);
  let st = await status();
  log(`routed to ${room.name} at ${at.toFixed(0)}s: ${st.state} rel=${st.rel_s} webamp=${webamp.getMediaStatus()} localPaused=${videoEl.paused}`);
  log(`route-ok=${st.state === 'PLAYING' && st.rel_s >= at - 2 && st.rel_s < at + 15 && videoEl.paused}`);

  const v0 = await invoke<number>('sonos_volume', { ip: room.ip });
  webamp.setVolume(Math.max(v0 - 3, 0));
  await sleep(1500);
  const v1 = await invoke<number>('sonos_volume', { ip: room.ip });
  log(`volume ${v0} -> slider ${Math.max(v0 - 3, 0)} -> speaker ${v1} volume-ok=${v1 === Math.max(v0 - 3, 0)}`);
  webamp.setVolume(v0);
  await sleep(1000);

  const trackDur = () => {
    const st = (webamp as any).store.getState();
    return Math.round(st.tracks[st.playlist.currentTrack]?.duration ?? 0);
  };
  const dur = trackDur();
  const target = Math.floor(dur / 2);
  webamp.seekToTime(target);
  await sleep(6000);
  st = await status();
  log(`seek to ${target}s (dur ${dur}): rel=${st.rel_s} seek-ok=${st.state === 'PLAYING' && st.rel_s >= target && st.rel_s < target + 12}`);

  webamp.pause();
  await sleep(2500);
  st = await status();
  log(`pause: ${st.state} pause-ok=${st.state === 'PAUSED_PLAYBACK'}`);
  webamp.play();
  await sleep(4000);
  st = await status();
  log(`resume: ${st.state} rel=${st.rel_s} resume-ok=${st.state === 'PLAYING' && st.rel_s >= target}`);

  webamp.nextTrack();
  await sleep(10000);
  st = await status();
  log(`next track: ${st.state} rel=${st.rel_s} next-ok=${st.state === 'PLAYING' && st.rel_s < 12}`);

  const dur2 = trackDur();
  webamp.seekToTime(Math.max(dur2 - 4, 0));
  await sleep(16000);
  st = await status();
  log(`end of track (dur ${dur2}): ${st.state} rel=${st.rel_s} track=${(webamp as any).store.getState().playlist.currentTrack} advance-ok=${st.state === 'PLAYING' && st.rel_s < 14}`);

  const atBack = webamp.getMediaStatus() === 'PLAYING' ? st.rel_s : 0;
  await routeTo(null);
  await sleep(8000);
  st = await status();
  const tBack = lastAudio?.currentTime ?? 0;
  log(`back here: speaker ${st.state}, local t=${tBack.toFixed(1)} paused=${videoEl.paused} back-ok=${st.state === 'STOPPED' && !videoEl.paused && tBack >= atBack}`);

  webamp.stop();
  log('done');
}

main().catch((e) => {
  console.error('fatal', e);
  setStatus([{ text: `fatal: ${errMsg(e)}`, err: true }]);
});
