# wamptube

A lightweight macOS desktop audio player for music on regular YouTube videos, with a classic
Winamp 2 interface (Webamp) inside a Tauri 2 shell. Personal-use tool, not distributed.

This repo is at the **prototype milestone**: Webamp in Tauri plays YouTube playlists and videos
listed in a config file through a loopback proxy. There is no library, database, tagging, Discover
window or enrichment yet.
`NOTES.md` is the record of what the prototype found, including open problems; read it before
changing playback code, and update it when a finding changes.

## Commands

```bash
deno install                      # npm packages from package.json into node_modules
deno task tauri dev               # run the app (Vite on :1420 + cargo run)
deno task build                   # type-check (tsc --noEmit) + front-end production build

cd src-tauri
cargo test                        # offline: unit tests + proxy against a fake upstream
cargo test --test live_proxy -- --ignored --nocapture   # live: real yt-dlp + googlevideo
cargo test --test live_sonos -- --ignored --nocapture   # live: plays a track on a Sonos (WAMPTUBE_SONOS_ROOM)
cargo clippy --all-targets
```

Deno is the only JS runtime; there is no Node. Deno reads `package.json` (scripts run via
`deno task`) and locks with `deno.lock`. The Tauri CLI is the npm-local `@tauri-apps/cli`, run
by `deno task tauri`; there is no global `cargo tauri`. `tauri.conf.json`'s `beforeDevCommand` /
`beforeBuildCommand` call `deno task` too. Add packages with `deno add npm:<name>` (or
`-D` for dev), not npm.

Release build: `deno task tauri build` makes `src-tauri/target/release/bundle/{macos,dmg}`. CI
(`.github/workflows/build.yml`) does this on every push to main (Apple Silicon, unsigned) and
replaces the rolling `latest` GitHub prerelease with the dmg and a zipped .app.

Config: `$XDG_CONFIG_HOME/wamptube/config.toml`, else `~/.config/wamptube/config.toml` (not
`~/Library/Application Support`, on purpose). It holds `sources = [ ... ]`: playlist or video URLs,
loaded in order at startup. A missing file is created as a commented template. ADD > URL in the
playlist window, or dropping a YouTube link on it, appends to `sources` (comments are kept).
Playlists must be Public or Unlisted: yt-dlp runs signed out.

Environment switches:

- `WAMPTUBE_YTDLP=/path/to/yt-dlp` – use a specific yt-dlp build instead of the one on PATH.
- `VITE_SELFTEST=1` – ignore the config and load the three test videos (`TEST_VIDEO_IDS` in
  `main.ts`), then play each quietly, deep-seek, pause and resume, logging `[selftest]` lines.
  This is the end-to-end check.
- `VITE_SELFTEST=timeline` – same test videos; seek track 1 to fixed times and log the audio element's timeline.
- `VITE_SELFTEST=sonos` (with `VITE_SONOS_ROOM=<room>`, else the first found) – same test videos;
  start track 1 here, move it to the room, then check volume, seek, pause, next track, end-of-track
  advance and moving back, logging `[selftest] ...-ok=` lines. Plays out loud at the room's volume.

In `tauri dev`, the webview's `console.warn` and `console.error` are forwarded to the terminal;
`console.log` is not. Rust logs `[proxy]`, `[resolve]` and `[yt-dlp]` lines to stderr. This is the
way to observe the app without looking at the window.

## Prerequisites

Rust (rustup), and Homebrew `yt-dlp` and `deno`. yt-dlp must be recent: a build a few
months old can resolve URLs that then refuse to play. Deno does double duty: it is the front-end
toolchain, and yt-dlp finds it on PATH at runtime to solve YouTube's JS challenges (in Deno's
sandbox, which is why we don't point yt-dlp at another runtime). ffmpeg is not used.

Windows also works (WebView2, a Chromium engine, instead of WKWebView). yt-dlp and deno come from
winget or Scoop; `resolve.rs` also looks in the Scoop shims and WinGet links dirs, spawns yt-dlp
with `CREATE_NO_WINDOW` so no console flashes, and the config's `~` is `USERPROFILE` when
`HOME` is unset. CI builds and tests on both macOS and Windows.

## Architecture

Two halves. The webview draws the UI and never contacts YouTube; the Rust core owns everything else.

- `src/main.ts` – loads tracks via `startup_tracks` (or the test ids under `VITE_SELFTEST`), builds
  Webamp, positions the three Webamp windows with `windowLayout`, wires window dragging /
  close / minimize to Tauri, and holds the self-test code.
- `src/throbber.ts` – buffering indicator: the Winamp bolt logo pulses (fixed size, hard steps, muted)
  while a track loads or the video element stalls. `msemedia.ts` calls `setBuffering`. The frames are
  cut at runtime from the active skin's main background at the logo's spot (`X,Y,W,H`), so a custom skin
  whose artwork differs there gets a pulse on that artwork, or nothing if the area is flat. Not yet
  skin-aware beyond that.
- `src/videowindow.ts` – the big pane to the right of the stack and its VI / FX buttons. The pane
  shows the video picture or the FX visualizer, never both (`setPane('off' | 'video' | 'fx')`).
- `src/fx.ts` – the FX visualizer: a MilkDrop-style WebGL feedback effect (our own; butterchurn
  needs `'unsafe-eval'`). Presets are the `PRESETS` table. A band under the picture holds its control strip (effect 1-5, wave shape, color,
  mirror, spectrum bars, auto; `FX_CONTROLS` in `videowindow.ts`), which the title
  bar's minimize button hides. Button art comes from `tools/make-skin.ts`.
  `http://localhost:1420/?fxdemo` shows it in a plain browser on made-up audio.
- `src/pcm.ts` – audio numbers for FX and for Webamp's small visualizer. It decodes the AAC
  segments a second time, only while FX is on, because WKWebView cannot tap the element's
  sound (see NOTES.md). `getAnalyser()` in `msemedia.ts` returns a stand-in backed by it.
- `src/addsource.ts` – Webamp's `handleAddUrlEvent` (ADD > URL, with a small input box) and
  `handleTrackDropEvent` (dropped links). Both call `list_source`, then `save_source`. Dropping
  works because `dragDropEnabled` is off in `tauri.conf.json`; Tauri would otherwise swallow the drop.
- `public/skins/wamptube.wsz` – Webamp's default skin art with WAMPTUBE lettering (main title
  bar; the playlist bar says PLAYLIST). Loaded as `initialSkin`, so a custom skin replaces it and
  renders only what it contains. Generated and committed: after upgrading webamp, rebuild it with
  `deno run -A tools/make-skin.ts` (reads the sprites out of the webamp bundle).
- `src/output.ts` – the "Output device" submenu, added to Webamp's main (Winamp logo) menu by
  DOM injection when it opens (Webamp has no menu API). Local devices: `setSinkId` on the one media
  element, choice kept by device name in localStorage (WebView2 only; WKWebView has no `setSinkId`,
  so macOS shows a single "This computer"). Below a separator, "Sonos: <room>" entries on every
  platform, or a grey "Searching for Sonos…" / "No Sonos rooms found" line, so the submenu is
  always there; a room choice is not kept across launches. Gets its Sonos hooks as a parameter so it
  imports no DOM code (the Deno web tests import it).
- `src/nativemenu.ts` – every Webamp menu (main, right-click, EQ presets, playlist buttons) shows
  as a real OS popup menu, so it can extend past the window. Webamp still renders its HTML menu,
  hidden by the `native-menus` class; a MutationObserver copies it into a Tauri `Menu` at the
  cursor and, on a pick, clicks the matching HTML item (dismissing sends Webamp's click-away). So
  anything injected into the HTML menu, like `output.ts`'s submenu, appears natively for free.
  The native menu is a snapshot: it does not redraw while open.
- `src-tauri/src/audio_out.rs` – Windows: grants the app's own origins microphone permission through
  WebView2's profile API at startup, because Chromium hides output-device names and ids without it.
  Nothing calls getUserMedia; the grant only unlocks `enumerateDevices`.
- `src/style.css` – layout and the UI scale. `UI_SCALE` in `main.ts` drives a `--ui-scale` CSS
  variable applied as `transform: scale()` on `#webamp`.
- `src-tauri/src/resolve.rs` – runs yt-dlp as a child process (no shell, validated ids, timeouts)
  and parses its JSON. `parse_source` turns pasted input into a playlist or video id and accepts
  YouTube hosts only, so arbitrary URLs never reach yt-dlp. `list` is `-J --flat-playlist`: one
  request per playlist, no stream URLs.
- `src-tauri/src/config.rs` – finds, reads and appends to `config.toml` (toml_edit, keeps comments).
- `src-tauri/src/proxy.rs` – axum server on `127.0.0.1:<random port>`. Serves
  `GET|HEAD /stream/{token}` and `/v/{video_id}` with CORS and Range support so Webamp's Web Audio
  graph can use it. `/v/` resolves the video with yt-dlp on its first request (in a detached task,
  one at a time, failures cached 30 s), which is how a 56-track playlist loads without 56 resolves.
- `src/sonosmedia.ts` – Webamp's media class is `RoutedMedia`: it forwards to `MseMedia` or, while a
  Sonos room is picked, to `SonosMedia`, which sends commands and polls the speaker once a second
  (position, and STOPPED near the end = `ended`). Nothing reaches the speaker until play, so loading
  track 1 at launch never interrupts a room. Switching output carries the track and position over,
  and the volume slider follows the output (the room's own volume, or the old local one). The
  speaker gets audio only, so while a room plays the video pane shows a note (`setVideoNote`).
- `src-tauri/src/sonos.rs` – Sonos discovery (SSDP on every interface), one room per zone group
  (addressed by its coordinator), and transport/volume SOAP calls on port 1400. Commands accept
  only addresses the last discovery returned. The speaker fetches from `proxy::start_on(lan_ip)`,
  which serves only `/stream/{token}` and answers small ranges from cached 1 MiB blocks (Sonos
  reads in 6 KB ranges). See NOTES.md.
- `src-tauri/src/lib.rs` – Tauri setup, starts the proxy, registers the commands.

### Contract between the halves

All commands reject with a string. `TrackInfo` is
`{ video_id, title, channel, duration_s, stream_url }`, where `stream_url` is a lazy `/v/` URL.

```
invoke('startup_tracks')            -> { config_path, source_count, tracks: TrackInfo[], errors: string[] }
invoke('list_source', { source })   -> { source /* canonical URL */, tracks: TrackInfo[] }
invoke('save_source', { source })   -> boolean  /* false if already in the config */
invoke('sonos_rooms')               -> { name, ip }[]          /* ~2 s discovery; [] if none */
invoke('sonos_play_video', { ip, video_id }) -> number         /* duration_s; speaker reports 0 */
invoke('sonos_control', { ip, action, value })                 /* play|pause|stop|seek s|volume 0-100 */
invoke('sonos_status', { ip })      -> { state, rel_s }
invoke('sonos_volume', { ip })      -> number
```

Keys are snake_case on purpose. Change both sides together.

## Things that are easy to get wrong

- **Window size and scale are coupled by hand.** The Tauri window (`src-tauri/tauri.conf.json`,
  550x696) must equal 275x348 times `UI_SCALE`. `#app` deliberately stays at 1x size because
  Webamp centres its windows in the mount node's unscaled box. That size is only the starting
  size: `installAutoLayout` in `main.ts` restacks the open Webamp windows (main, EQ, playlist)
  with no gaps and resizes the Tauri window to fit whenever one is closed, shaded or resized.
- **Scale with `transform`, not CSS `zoom`.** Webamp's sliders compare `getBoundingClientRect()`
  with the mouse position; `zoom` breaks that in WebKit.
- **The proxy must chunk upstream requests.** googlevideo throttles open-ended or whole-file
  ranges to about 32 KB/s but serves bounded ranges at full speed, so the proxy fills each
  response from sequential 2 MiB upstream requests. Don't simplify it to a pass-through.
- **Fresh stream URLs 403 for a few seconds.** yt-dlp reports `available_at`; the proxy waits for
  it and retries once near the boundary. A 403 outside that window means expired: re-resolve
  once, at most once per token per 30 s.
- **The webview is WKWebView, not Chromium.** A browser check at `localhost:1420` shows layout
  only (resolves fail without Tauri, by design). Verify behaviour in the real app.
- **CSP is explicit** in `tauri.conf.json`. Audio comes from `http://127.0.0.1:*`; skin images are
  `data:` URLs. Milkdrop would need `'unsafe-eval'`, which is not enabled.
- **Every Webamp track needs a `duration`.** Without one Webamp fetches the URL to measure it,
  which through `/v/` would resolve every track in the playlist at startup. Webamp still buffers
  track 1 at launch, so that one is resolved straight away.
- **Known open problem:** WKWebView reports double the real duration for YouTube's DASH m4a.
  See NOTES.md before touching seek or time display.

## Constraints from the spec

- Audio only; never decode or render video. No downloading or exporting audio for offline use.
- No Electron or bundled Chromium. Rust core plus the system webview.
- Do not use the YouTube Data API; extraction goes through yt-dlp only, and nothing writes back
  to YouTube.
- Optional enrichment (Gemini, MusicBrainz) must fail soft; the player works without it.
- Ship Webamp's default skin only. No bundled third-party skins or downloaded art.
- Keep request rates modest: resolve just before playback, don't bulk re-resolve. Startup costs one
  flat listing per configured source.

## Roadmap

Prototype (here) → Library core (SQLite, tags, playlists) → Import → Enrichment → Discover →
Polish (engine B via mpv if needed, media keys, sidecar bundling, update-yt-dlp action) →
Recommendations. Engine A is Webamp's own audio through the proxy; engine B would be libmpv
behind Webamp's private `__customMediaClass` option, which exists in webamp 2.3.1.
