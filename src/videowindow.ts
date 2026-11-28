// The big pane's window chrome: it shows either the video picture or the FX
// visualizer (src/fx.ts), never both. It is drawn inside Webamp's own #webamp root
// (so it scales with everything else) from the skin's "gen window" classes, the
// frame Winamp skins define for extra windows (GEN.BMP): corners, bottom edge,
// close button and title lettering all come from the active skin.

/** 1x pixel sizes: gen borders are 11 and 8 wide, the title bar 20 tall, the bottom edge 14. */
const CHROME_W = 11 + 8, CHROME_H = 20 + 14;
const MIN_FRAME_H = 116;
/** Frame widths the grip can set (1x px). The default gives a full 16:9 picture at the minimum stack height. */
const MIN_FRAME_W = 220, MAX_FRAME_W = 900, DEFAULT_FRAME_W = CHROME_W + 448;
/** Shortest Webamp stack (1x px) that gives the video a full 448x252 picture; the playlist grows to reach it. */
export const VIDEO_STACK_FLOOR = CHROME_H + 252;

let frameWidth = DEFAULT_FRAME_W;
export const getFrameWidth = () => frameWidth;
export function setFrameWidth(w: number) {
  frameWidth = Math.round(Math.min(MAX_FRAME_W, Math.max(MIN_FRAME_W, w)));
}

/**
 * Frame size for a Webamp stack `stackHeight` tall: as tall as the stack (so the
 * Tauri window has no empty slab under it), at the width the user dragged to;
 * the picture is letterboxed inside whatever shape results.
 */
export function frameSize(stackHeight: number) {
  return { w: frameWidth, h: Math.max(stackHeight, MIN_FRAME_H) };
}

import { FX_PRESET_COUNT, Fx, demoSource, type FxSource } from './fx';

const div = (cls: string, ...kids: HTMLElement[]) => {
  const d = document.createElement('div');
  d.className = cls;
  d.append(...kids);
  return d;
};

let frame: HTMLElement | undefined;
let host: HTMLElement | undefined;
let resizeCb: (dxPx: number, dyPx: number, phase: 'start' | 'move' | 'end') => void = () => {};

/** The bottom-right grip: `dxPx`/`dyPx` are the screen-pixel drag so far. */
export function onVideoResize(cb: typeof resizeCb) {
  resizeCb = cb;
}
/** What the pane shows. Video and FX share the one frame, so they can't both be on. */
type Pane = 'off' | 'video' | 'fx';
let pane: Pane = 'video';
let onChange: () => void = () => {};
let fx: Fx | undefined;
let fxSource: () => FxSource = () => demoSource;

/** The frame is on screen (with either content): what the layout cares about. */
export const isPaneOpen = () => pane !== 'off';
/** The picture is showing: what decides whether a track's video stream is fetched. */
export const isVideoOpen = () => pane === 'video';

export function setPane(p: Pane) {
  pane = p;
  if (frame) {
    frame.style.display = p === 'off' ? 'none' : 'flex';
    frame.dataset.pane = p; // style.css shows the matching title and content
  }
  host?.classList.toggle('video-active', p !== 'off');
  viButton?.classList.toggle('on', p === 'video');
  fxButton?.classList.toggle('on', p === 'fx');
  if (p === 'fx') {
    try {
      if (!fx) {
        fx = new Fx(fxCanvas(), fxSource());
        fx.onState = syncStrip;
      }
      fx.start();
      syncStrip();
    } catch (e) {
      console.error('[fx] start failed', String((e as Error)?.message ?? e));
    }
  } else {
    fx?.stop();
  }
  onChange();
}
export const toggleVideo = () => setPane(pane === 'video' ? 'off' : 'video');
export const toggleFx = () => setPane(pane === 'fx' ? 'off' : 'fx');

/** VI and FX buttons in the main window, where the mono/stereo lights were; each is lit while its pane is on. */
let viButton: HTMLElement | undefined;
let fxButton: HTMLElement | undefined;
// Made on first use, not at import, so the module loads without a DOM (web-tests).
let fxCanvasEl: HTMLCanvasElement | undefined;
function fxCanvas(): HTMLCanvasElement {
  if (!fxCanvasEl) {
    fxCanvasEl = document.createElement('canvas');
    fxCanvasEl.id = 'fx-pane';
    fxCanvasEl.title = 'Click for the next effect';
  }
  return fxCanvasEl;
}

function installPaneButtons() {
  const main = document.getElementById('main-window');
  if (!main || viButton) return;
  const make = (cls: string, title: string, toggle: () => void, on: boolean) => {
    const b = div(cls);
    b.title = title;
    b.addEventListener('mousedown', (e) => e.stopPropagation()); // not a window drag
    b.addEventListener('click', toggle);
    b.classList.toggle('on', on);
    main.appendChild(b);
    return b;
  };
  viButton = make('vi-button', 'Toggle Video (Alt+V)', toggleVideo, pane === 'video');
  fxButton = make('fx-button', 'Toggle FX visualizer (Alt+F)', toggleFx, pane === 'fx');
}

/**
 * The FX control strip: a band under the picture, just above the frame's bottom bar
 * (the bar itself has border lines through it, so buttons can't sit on it). Order matches the columns of
 * /skins/fx-strip.png (FX_STRIP in tools/make-skin.ts). `lit` says when a button's
 * light is on; the step-through buttons (WV, CO) have none.
 */
const FX_CONTROLS: { title: string; press: (f: Fx) => void; lit?: (f: Fx) => boolean }[] = [
  ...Array.from({ length: FX_PRESET_COUNT }, (_, i) => ({
    title: `Effect ${i + 1}`,
    press: (f: Fx) => f.setPreset(i),
    lit: (f: Fx) => f.state.preset === i,
  })),
  { title: 'Waveform shape (next)', press: (f) => f.nextWave() },
  { title: 'Color (next)', press: (f) => f.nextColor() },
  { title: 'Mirror', press: (f) => f.toggle('mirror'), lit: (f) => f.state.mirror },
  { title: 'Spectrum bars', press: (f) => f.toggle('bars'), lit: (f) => f.state.bars },
  { title: 'Auto: change effect by itself', press: (f) => f.toggle('auto'), lit: (f) => f.state.auto },
];
let stripButtons: HTMLElement[] = [];

function buildStrip() {
  stripButtons = FX_CONTROLS.map((c, i) => {
    const b = div('fx-ctl');
    b.title = c.title;
    b.style.setProperty('--i', String(i));
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', () => { if (fx) { c.press(fx); syncStrip(); } });
    return b;
  });
  return div('fx-strip', ...stripButtons);
}

/** Light the strip's buttons to match the visualizer. */
function syncStrip() {
  if (!fx) return;
  FX_CONTROLS.forEach((c, i) => stripButtons[i]?.classList.toggle('on', !!c.lit?.(fx!)));
}

const STRIP_KEY = 'wamptube.fxStripHidden';
/** The title bar's minimize button hides the strip; remembered between runs. */
function setStripHidden(hidden: boolean) {
  frame?.classList.toggle('strip-hidden', hidden);
  try { localStorage.setItem(STRIP_KEY, hidden ? '1' : ''); } catch { /* no storage: just not remembered */ }
}

const titleLetters = (word: string) => {
  const t = div(`gen-top-title title-${word.toLowerCase()}`);
  for (const ch of word) t.append(div(`gen-text-letter gen-text-${ch.toLowerCase()}`));
  return t;
};

/**
 * Build the window around `video` and add it to `host` (Webamp's #webamp).
 * `audio` gives the FX visualizer its audio numbers; it is called the first time FX is switched on.
 */
export function mountVideoWindow(hostEl: HTMLElement, video: HTMLVideoElement, changed: () => void, audio: () => FxSource) {
  host = hostEl;
  onChange = changed;
  fxSource = audio;
  const grip = div('video-resize');
  grip.title = 'Resize';
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY;
    resizeCb(0, 0, 'start');
    const move = (m: MouseEvent) => resizeCb(m.clientX - x0, m.clientY - y0, 'move');
    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      resizeCb(0, 0, 'end');
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  });
  const close = div('');
  close.id = 'video-close';
  close.title = 'Close';
  close.addEventListener('click', () => setPane('off'));
  const shade = div('gen-shade');
  shade.title = 'Hide / show the FX controls';
  shade.addEventListener('mousedown', (e) => e.stopPropagation()); // not a window drag
  shade.addEventListener('click', () => setStripHidden(!frame?.classList.contains('strip-hidden')));
  frame = div(
    'gen-window selected video-window',
    div(
      'gen-top video-top',
      div('gen-top-left'),
      div('gen-top-left-fill'),
      div('gen-top-left-end'),
      titleLetters('VIDEO'),
      titleLetters('FX'),
      div('gen-top-right-end'),
      div('gen-top-right-fill'),
      div('gen-top-right', shade, div('gen-close', close)),
    ),
    div(
      'gen-middle',
      div('gen-middle-left', div('gen-middle-left-bottom')),
      div('gen-middle-center', video, fxCanvas(), buildStrip()),
      div('gen-middle-right', div('gen-middle-right-bottom')),
    ),
    div('gen-bottom', div('gen-bottom-left'), div('gen-bottom-right', grip)),
  );
  frame.style.left = '275px'; // beside the default stack until the first layout
  host.appendChild(frame);
  frame.dataset.pane = pane;
  let hidden = false;
  try { hidden = !!localStorage.getItem(STRIP_KEY); } catch { /* no storage */ }
  setStripHidden(hidden);
  host.classList.toggle('video-active', pane !== 'off');
  refreshGriplessSprite();
  installPaneButtons();
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyV') { e.preventDefault(); toggleVideo(); }
    if (e.altKey && e.code === 'KeyF') { e.preventDefault(); toggleFx(); }
  });
}

/** Put the window `left` 1x pixels from the origin, sized for a stack `stackHeight` tall. */
export function placeVideoWindow(left: number, stackHeight: number) {
  if (!frame) return;
  const { w, h } = frameSize(stackHeight);
  frame.style.left = `${left}px`;
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
}

let gripless: { src: string; url: string } | undefined;

/**
 * While the video window is open its grip is the resize handle, so the playlist's
 * own grip art has to go. The grip is part of the playlist's bottom-right sprite
 * (150x38), so this redraws that sprite with the grip's pixels (x 131..143,
 * y 19..31 in the default skin's layout) blended from the plain rows above and
 * below, column by column, which keeps the sprite's own diagonal shading. The result is handed to
 * the stylesheet as --playlist-bottom-right (see style.css). Cheap to call often.
 */
export function refreshGriplessSprite() {
  const el = host?.querySelector('.playlist-bottom-right') as HTMLElement | null;
  if (!el || !host) return;
  const src = /url\("?([^")]+)"?\)/.exec(getComputedStyle(el).backgroundImage)?.[1];
  if (!src || src === gripless?.src || src === gripless?.url) return;
  const img = new Image();
  img.onload = () => {
    if (img.width !== 150 || img.height !== 38) return; // not the default-skin layout: leave it alone
    const c = document.createElement('canvas');
    c.width = 150;
    c.height = 38;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    // Plain rows bracket the grip (18 above, 32 below); blend between them per column.
    for (let x = 131; x <= 143; x++) {
      const top = g.getImageData(x, 18, 1, 1).data;
      const bottom = g.getImageData(x, 32, 1, 1).data;
      for (let y = 19; y <= 31; y++) {
        const t = (y - 18) / 14;
        g.fillStyle = `rgb(${[0, 1, 2].map((k) => Math.round(top[k] + (bottom[k] - top[k]) * t)).join(',')})`;
        g.fillRect(x, y, 1, 1);
      }
    }
    const url = c.toDataURL('image/png');
    gripless = { src, url };
    host!.style.setProperty('--playlist-bottom-right', `url(${url})`);
    host!.classList.add('grip-patched'); // only now may the stylesheet swap the sprite in
  };
  img.src = src;
}

/**
 * Add "Video" and "FX Visualizer" check items under "Playlist Editor" in Webamp's right-click menu.
 * Webamp has no API for extra items, so this watches for its menu portal
 * (#webamp-context-menu, rebuilt on every open) and inserts a matching <li>.
 */
export function installVideoMenuItem() {
  const addTo = (menu: Element) => {
    const items = [...menu.querySelectorAll('li')];
    const anchor = items.find((li) => li.textContent?.trim() === 'Playlist Editor');
    if (!anchor || menu.querySelector('li.video-toggle')) return;
    const item = (label: string, on: boolean, toggle: () => void) => {
      const li = anchor.cloneNode(false) as HTMLLIElement;
      li.className = `video-toggle${on ? ' checked' : ''}`;
      li.textContent = label;
      li.addEventListener('click', () => toggle()); // Webamp's own click-away handler closes the menu
      return li;
    };
    anchor.after(item('Video', pane === 'video', toggleVideo), item('FX Visualizer', pane === 'fx', toggleFx));
  };
  new MutationObserver(() => {
    const m = document.getElementById('webamp-context-menu');
    if (m) addTo(m);
  }).observe(document.body, { childList: true, subtree: true });
}
