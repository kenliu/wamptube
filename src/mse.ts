// Plays one YouTube video's H.264 video-only and AAC audio-only DASH streams
// through a single <video> element with Media Source Extensions, fed from the
// loopback proxy (`/v/{id}` audio, `/vv/{id}` video). One element means one
// clock, so audio and picture cannot drift. Proven in the real WKWebView by
// the spike (see NOTES.md).

import { pcmOffer, pcmSetTrack } from './pcm';

const AHEAD_S = 30;

interface Seg { start: number; end: number; t0: number; t1: number } // bytes [start,end), seconds
interface Track { name: string; url: string; mime: string; init: Uint8Array<ArrayBuffer>; segs: Seg[]; duration: number }

const u32 = (d: DataView, o: number) => d.getUint32(o);
const u64 = (d: DataView, o: number) => Number(d.getBigUint64(o));
const fourcc = (d: DataView, o: number) =>
  String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));

async function fetchRange(url: string, a: number, b: number): Promise<Uint8Array<ArrayBuffer>> {
  const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` } });
  if (!r.ok && r.status !== 206) throw new Error(`${url} ${a}-${b}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Read the init segment and the `sidx` segment index from the start of a fragmented MP4. */
async function loadTrack(name: string, url: string, kind: 'audio' | 'video'): Promise<Track> {
  const head = await fetchRange(url, 0, 128 * 1024 - 1);
  const d = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let o = 0, sidxAt = -1;
  while (o + 8 <= head.length) {
    let size = u32(d, o);
    const type = fourcc(d, o + 4);
    if (size === 1) size = u64(d, o + 8);
    if (type === 'sidx') { sidxAt = o; break; }
    if (size < 8) break;
    o += size;
  }
  if (sidxAt < 0) throw new Error(`${name}: no sidx in the first 128 KiB`);
  const init = head.slice(0, sidxAt);

  const ver = d.getUint8(sidxAt + 8);
  let p = sidxAt + 16; // box header(8) + version/flags(4) + reference_ID(4)
  const timescale = u32(d, p); p += 4;
  let ept: number, firstOffset: number;
  if (ver === 0) { ept = u32(d, p); firstOffset = u32(d, p + 4); p += 8; }
  else { ept = u64(d, p); firstOffset = u64(d, p + 8); p += 16; }
  p += 2; // reserved
  const count = d.getUint16(p); p += 2;
  let byte = sidxAt + u32(d, sidxAt) + firstOffset, t = ept;
  const segs: Seg[] = [];
  for (let i = 0; i < count; i++) {
    const size = u32(d, p) & 0x7fffffff, dur = u32(d, p + 4);
    p += 12;
    segs.push({ start: byte, end: byte + size, t0: t / timescale, t1: (t + dur) / timescale });
    byte += size; t += dur;
  }

  let codecs = 'mp4a.40.2';
  if (kind === 'video') {
    let at = -1;
    for (let i = 0; i + 8 < init.length; i++) {
      if (init[i] === 0x61 && init[i + 1] === 0x76 && init[i + 2] === 0x63 && init[i + 3] === 0x43) { at = i; break; } // 'avcC'
    }
    if (at < 0) throw new Error('video init has no avcC (not H.264?)');
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    codecs = `avc1.${hex(init[at + 5])}${hex(init[at + 6])}${hex(init[at + 7])}`;
  }
  return { name, url, mime: `${kind}/mp4; codecs="${codecs}"`, init, segs, duration: segs[segs.length - 1].t1 };
}

class Feeder {
  private sb: SourceBuffer;
  private done = new Set<number>();
  private busy = false;
  constructor(private tr: Track, ms: MediaSource, private el: HTMLMediaElement, private alive: () => boolean) {
    if (!MediaSource.isTypeSupported(tr.mime)) throw new Error(`MSE does not support ${tr.mime}`);
    this.sb = ms.addSourceBuffer(tr.mime);
  }
  private append(buf: Uint8Array<ArrayBuffer>): Promise<void> {
    return new Promise((res, rej) => {
      const ok = () => { this.sb.removeEventListener('error', bad); res(); };
      const bad = () => { this.sb.removeEventListener('updateend', ok); rej(new Error(`${this.tr.name} append error`)); };
      this.sb.addEventListener('updateend', ok, { once: true });
      this.sb.addEventListener('error', bad, { once: true });
      this.sb.appendBuffer(buf);
    });
  }
  start() { return this.append(this.tr.init); }
  /** Append every segment from the playhead to AHEAD_S beyond it that is not in yet. */
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.el.currentTime, segs = this.tr.segs;
      const first = Math.max(0, segs.findIndex((s) => s.t1 > now));
      for (let i = first; i < segs.length && segs[i].t0 < now + AHEAD_S; i++) {
        if (!this.alive()) return;
        if (this.done.has(i)) continue;
        const bytes = await fetchRange(this.tr.url, segs[i].start, segs[i].end - 1);
        if (!this.alive()) return;
        if (this.tr.name === 'audio') pcmOffer(i, bytes); // the visualizers decode the same bytes
        await this.append(bytes);
        this.done.add(i);
        if (Math.abs(this.el.currentTime - now) > 2) break; // user seeked: restart from the new position
      }
    } finally { this.busy = false; }
  }
}

/** One loaded video on one element. `load` again replaces it; `dispose` tears it down. */
export class MseSession {
  private gen = 0;
  private timer: number | undefined;
  private url: string | undefined;
  private live = false;
  private onSeeking: (() => void) | undefined;

  get isLive() { return this.live; }

  constructor(private el: HTMLVideoElement) {}

  /** `base` is the proxy origin, e.g. http://127.0.0.1:54321. Resolves once playable. */
  /** Returns false if a later `load` or `dispose` superseded this one. */
  async load(base: string, videoId: string, withVideo = true): Promise<boolean> {
    this.dispose();
    // Stop the previous video now: resolving the new one takes several seconds,
    // and the old picture and sound must not carry on under the new track.
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    pcmSetTrack(null);
    const gen = this.gen;
    const alive = () => gen === this.gen;
    const mode = await fetch(`${base}/playback/${videoId}`, { cache: 'no-store' });
    if (!alive()) return false;
    if (!mode.ok) throw new Error(`Playback lookup failed (HTTP ${mode.status})`);
    const livePath = await mode.text();
    if (!alive()) return false;
    if (livePath) {
      if (!this.el.canPlayType('application/vnd.apple.mpegurl')) {
        throw new Error('This webview cannot play live HLS');
      }
      this.live = true;
      this.el.src = `${base}${livePath}`;
      return true;
    }

    const [audio, video] = await Promise.all([
      loadTrack('audio', `${base}/v/${videoId}`, 'audio'),
      // With the video window off, skip the video stream entirely: audio only.
      withVideo ? loadTrack('video', `${base}/vv/${videoId}`, 'video') : Promise.resolve(null),
    ]);
    if (!alive()) return false;
    pcmSetTrack({
      init: audio.init,
      segs: audio.segs,
      fetch: (i) => fetchRange(audio.url, audio.segs[i].start, audio.segs[i].end - 1),
    });
    const ms = new MediaSource();
    this.url = URL.createObjectURL(ms);
    this.el.src = this.url;
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    if (!alive()) return false;
    const feeders = [audio, video].filter((t): t is Track => t !== null).map((t) => new Feeder(t, ms, this.el, alive));
    await Promise.all(feeders.map((f) => f.start()));
    if (!alive()) return false;
    ms.duration = Math.max(audio.duration, video?.duration ?? 0);
    const pumpAll = () => feeders.forEach((f) => f.pump().catch((e) => alive() && console.error('[mse] pump', String(e))));
    this.onSeeking = pumpAll;
    this.el.addEventListener('seeking', pumpAll);
    this.timer = window.setInterval(pumpAll, 500);
    pumpAll();
    return true;
  }

  dispose() {
    this.gen++;
    this.live = false;
    if (this.onSeeking) this.el.removeEventListener('seeking', this.onSeeking);
    this.onSeeking = undefined;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
  }
}
