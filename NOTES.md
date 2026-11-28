# Prototype notes

Status of the prototype milestone's acceptance criteria. Last updated 2026-11-15.

## Run it

```bash
deno install
deno task tauri dev
```

Deno is the only JS runtime: it installs the npm packages from `package.json` (locked in `deno.lock`), runs Vite and the npm-local `@tauri-apps/cli` (no global `cargo install tauri-cli` needed), and is the runtime yt-dlp uses for YouTube's JS challenges. Node is not needed.
The webview's `console.warn` / `console.error` lines are forwarded into the `tauri dev`
terminal output (`console.log` is not), alongside `[proxy]` and `[resolve]` lines from the Rust core.

**yt-dlp must be current.** The Homebrew copy was upgraded from 2025.12.08 to 2026.10.26 on
2026-11-15 after the old one stopped producing playable URLs (see below). To try another build
without touching Homebrew:

```bash
WAMPTUBE_YTDLP=/path/to/yt-dlp deno task tauri dev
```

Opt-in checks, logged with a `[selftest]` / `[timeline]` prefix:

```bash
VITE_SELFTEST=1 deno task tauri dev          # plays each track quietly, deep-seeks, pauses, resumes
VITE_SELFTEST=timeline deno task tauri dev   # seeks track 1 to fixed times and logs the element's timeline
```

Tests (in `src-tauri/`):

```bash
cargo test                                             # offline: unit tests + proxy against a fake upstream
cargo test --test live_proxy -- --ignored --nocapture  # live: real yt-dlp + googlevideo through the proxy
```

## Acceptance criteria

All playback results below were obtained with yt-dlp 2026.10.26.

| Criterion | Status |
| --- | --- |
| `tauri dev` opens a borderless window with Webamp, default skin | Launches, Webamp renders, no console errors. |
| Test videos appear in the playlist with yt-dlp titles | Resolved with the right titles in ~2 s each; passed to Webamp as `initialTracks`. Playlist rows not eyeballed by me. |
| Play starts audio within a few seconds | Self-test: all three tracks reach `PLAYING` with `currentTime` advancing 1 s per second, `readyState=4`, no element errors. Fresh URLs have a ~6 s wait before the first play (see `available_at`). Audibility needs human ears. |
| Seek / pause / resume, including deep seeks | Self-test passes on all three: seek lands on target and keeps playing, pause holds position, resume continues. **But see the doubled-duration problem below.** |
| Which codec played | AAC-LC (`mp4a.40.2`, itag 140, m4a/DASH, ~129 kbps, 44.1 kHz) on all three. WKWebView accepted it; no format was rejected. Opus was never requested. |
| Did yt-dlp need an external JS runtime? | Yes with the current release: 2026.10.26 solves YouTube's JS challenges with Deno (`[jsc:deno] Solving JS challenges using deno`). Deno is installed and on the child's PATH. Plan to bundle it as a sidecar. (2025.12.08 did not ask for one, but no longer yields playable URLs.) |
| Does `__customMediaClass` exist? | Yes, in webamp 2.3.1: `node_modules/webamp/built/types/js/webampLazy.d.ts:11` (`PrivateOptions.__customMediaClass?: IMediaClass`), and it is read in the built bundles. Engine B's hook is available. |
| CPU and RAM during playback | **Pending** – read from Activity Monitor while a track plays and record here. |

## Problems found

### 1. WKWebView reports double the duration (open)

For every track the `<audio>` element reports exactly twice the real length: 2395 s for the
1197 s mix, 669 s for the 335 s track, 5392 s for the 2696 s mix. `buffered` and `seekable`
span the doubled range too.

- The file itself is right: `mvhd`, `mdhd` and `sidx` all say 334.5 s at timescale 44100 for
  `Hf20ZzMRs-I`. So this is WebKit's reading of YouTube's DASH-style fragmented m4a
  (yt-dlp calls the container `m4a_dash` and runs a "FixupM4a" remux when it downloads one).
- `currentTime` advances 1 s per wall-clock second, the element accepts seeks anywhere in the
  doubled range and keeps "playing", and the `ended` event fires at the doubled end (669 s).
- That means either the audio is playing at half speed, or it finishes at the real end and the
  element runs on in silence. **Not determined – needs a listen.** Either way the seek bar and
  time display are wrong on engine A as it stands.

Options: patch or remux the container in the proxy (remux needs ffmpeg, which the spec wanted
to avoid); request a different format (HLS audio, or Opus/WebM if this WebKit plays it);
or go to engine B (mpv), where the webview does not decode.

### 2. Stale yt-dlp gives URLs that only serve the first 1 MiB

With 2025.12.08, stream URLs (ANDROID client, no PO token) return 206 for bytes below
1,048,576 and 403 for everything else, including `bytes=0-`. The webview asks for the whole
file, so nothing plays. Other player clients on that version fail outright. 2026.10.26 fixes it.
This is the "yt-dlp breaks when YouTube changes" risk from the spec, already real: the
update-yt-dlp action matters more than its Polish-phase slot suggests.

### 3. New URLs are not valid immediately

yt-dlp 2026.10.26 reports `available_at` about 5–6 s after resolve; requests before then get 403.
The proxy now waits for it (plus 1 s) before the first upstream request. The boundary is not
exact: a request just after it can still 403, so within 10 s of `available_at` the proxy retries
once after 3 s before treating the URL as expired.

This is not always enough. On 2026-11-15, during three self-test runs in about five minutes,
two runs had a track whose fresh URL kept returning 403 after the retry. The re-resolved URL also
returned 403, the 30 s re-resolve limit stopped further attempts, and the element errored
(`play()` AbortError, `readyState=0`). The track that failed differed between runs, and the third
run passed cleanly. Possibly googlevideo pushing back on repeated resolves of the same ids;
unconfirmed.

### 4. googlevideo throttles large ranges

Bounded ranges up to 10 MB arrive at ~15 MB/s. Open-ended or whole-file ranges are throttled to
~32 KB/s (about 2x realtime). The proxy therefore answers the webview's range as one response
but fills it from sequential 2 MiB upstream requests. Verified live: 206 at offsets 0, 17.4 MB
and the file tail; a no-Range request served as a 200.

### 5. 403 re-resolve

Works (live test mangles the URL signature, proxy re-resolves and returns 206). Re-resolves are
limited to one per token per 30 s; before that limit, a stale yt-dlp caused a re-resolve on
every request.

### 6. YouTube unreachable for ~25 minutes during the build

From about 00:30 to 00:55 local, youtube.com and googlevideo.com timed out from this machine
while google.com worked. Cause unknown; it cleared on its own. The failure path behaved: each
resolve failed at 20 s with a visible "yt-dlp timed out" message, no hang or crash.

### 7. Playlists from the config file; resolving on first play

Tracks now come from `~/.config/wamptube/config.toml` (see CLAUDE.md). Startup runs one
`yt-dlp -J --flat-playlist` per source: the 56-video test playlist lists in about 2 s with titles,
channels and durations, and resolves nothing. Each track's URL is `/v/{video_id}` on the proxy,
which runs the full resolve on the first request for that video.

- Webamp measures any track without a `duration` by fetching it, so `duration` is always passed.
  Webamp still buffers track 1 at launch: one resolve at startup, verified in the dev log.
- WebKit sometimes cancels its first request for a new track and retries. When the resolve ran
  inside the request handler, the cancel killed yt-dlp and the retry started over (two resolves
  for `u1MqeDGBo94`). The resolve now runs in a detached task; one resolve per video, verified.
- Cost: a track's first play now waits for the resolve (~3 s) plus `available_at` (~6 s), about
  10 s of silence with no UI feedback. The self-test waits for playback to start instead of a
  fixed 12 s. Resolving the next track while the current one plays would hide this.
- Self-test (`VITE_SELFTEST=1`, three test ids via `/v/`): all checks pass on all three tracks.
- ADD > URL and dropping a link are built but not yet clicked through in the real window.

## Other findings

- **Second test video (`Hf20ZzMRs-I`)**: "Rock With You / MORE COWBELL!!!!!! 4pc BAND", channel SERGIO ACEDO, 5:35, no chapters. A single track, not a mix.
- `u1MqeDGBo94` is 1,197 s with 15 chapters; `dkrpqUyiZgA` is 2,696 s with 14 chapters (channel is "The Moment", performer ATTAME). Both have chapter markers for later splitting.
- **Extra Webamp windows** (for Library / Discover): no public option. `WindowId` is fixed to main / playlist / equalizer / milkdrop. An internal `ADD_GEN_WINDOW` action and `genWindows` reducer slice exist but are only reachable by dispatching to `webamp.store`; untried. Default plan stands: separate Tauri windows.
- Window positions use Webamp's public `windowLayout` option.
- The spec says "two hardcoded test videos" but its table lists three; all three are in the playlist.
- CSP is explicit. Milkdrop/butterchurn would need `'unsafe-eval'` in `script-src`; it is not enabled.
- Versions: tauri 2.12.5, axum 0.8.9, reqwest 0.13.5, webamp 2.3.1, vite 8.3.8, typescript 7.0.2.

## Spike: video through MSE (branch `spike/mse-video`, 2026-11-15)

`VITE_SPIKE=1 deno task tauri dev` opens `spike.html` (`src/spike.ts`): one `<video>` fed by two
MSE SourceBuffers, H.264 video-only (`/vv/{id}` on the proxy) plus the AAC audio (`/v/{id}`),
using each stream's `sidx` for segment offsets. Test video `Hf20ZzMRs-I`, in the real WKWebView:

- MSE accepts `avc1.640028` + `mp4a.40.2` fragmented MP4 from YouTube as is. 1920x1080, 0 dropped frames.
- **Duration is correct** (334.53 s vs the real 334.5 s). The doubled duration of problem 1 does
  not occur under MSE, so engine A through MSE would fix it without ffmpeg.
- Seeks near and far (60 s, 267 s, back to 5 s) land on target and keep playing; pause holds position.
- One element means one clock: no A/V drift handling needed.
- Audio is audible (confirmed by ear).

Wired into the player: `src/mse.ts` is the engine, `src/msemedia.ts` is an `IMedia` class passed as
Webamp's `__customMediaClass`, and `main.ts` puts the shared `<video>` in a 480x270 pane to the
right of the Webamp stack (window width grows by that). Play, pause, seek, volume and track
changes go through Webamp as before. While this engine is in use the EQ, preamp and balance
do nothing (audio plays straight from the element). Startup loads track 1 through it
without errors; clicking through playback is not yet checked. Known gaps: the video buffer is
never trimmed (memory grows over a long track), each track now costs a second yt-dlp resolve
(the video stream), and `VITE_SELFTEST` still targets Webamp's old `<audio>` element.

## Visualizers (FX pane and Webamp's small one)

- **A Web Audio tap on the MSE element reads silence in WKWebView.** `createMediaElementSource`
  on the `<video>` with the AudioContext running gave a waveform peak of 0/128 for 8 s of a
  playing track. Don't retry this route.
- **Decoding the segments a second time works.** `decodeAudioData` (on an `OfflineAudioContext`)
  accepts init segment + one media segment and returns about 9.94 s for a 9.98 s segment (a
  little is trimmed from the front, so `src/pcm.ts` counts back from the segment's end).
  `AudioDecoder` (WebCodecs) also exists and supports `mp4a.40.2`, unused so far.
- `src/pcm.ts` keeps the last few segments' bytes as `mse.ts` appends them and decodes the one
  under the playhead (and the next, 3 s ahead) while the FX pane is on. Readers ask for the
  waveform at `currentTime`. Checked in the app: real levels at 5, 8 and 12 s, across a segment
  boundary. Sync by eye and behaviour after a seek are not yet checked.
- Real MilkDrop (butterchurn) is out: it needs `'unsafe-eval'`. `src/fx.ts` is our own WebGL
  feedback effect instead.

## Engine decision

Not final. Engine A decodes and plays AAC in WKWebView without codec trouble, but the doubled
duration (problem 1) has to be resolved or worked around before A is viable; if the fix needs
ffmpeg or proves fragile, that is an argument for engine B. CPU/RAM numbers are still missing.

## Windows (WebView2, 2026-11-22)

Windows 10 x64, Edge WebView2 (Chromium), yt-dlp 2026.10.26 and deno 2.9.8 from Scoop.

- `cargo test`, `cargo clippy --all-targets -D warnings` and the live proxy test pass.
- `VITE_SELFTEST=1` passed all 12 checks (advance, deep seek, pause, resume on all three tracks).
  An earlier run failed one deep seek, on track 1, right after a `play() interrupted by pause()`
  AbortError. The rerun was clean, so that failure looks like a self-test timing race rather than
  a Windows problem.
- **Durations are correct** (1197 s, 335 s, 2696 s). WebView2 does not have problem 1's doubled
  duration, which supports reading that problem as WKWebView-specific.
- Changes needed: yt-dlp lookup (`yt-dlp.exe`, no Unix permission check, Scoop and WinGet dirs),
  `CREATE_NO_WINDOW` on the child, `USERPROFILE` when `HOME` is unset, and an `icon.ico`.
