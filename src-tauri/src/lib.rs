pub mod audio_out;
pub mod config;
pub mod proxy;
pub mod resolve;
pub mod sonos;

use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, Manager};

/// Returned to the front end. Keys are snake_case and fixed by contract.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedAudio {
    pub proxy_url: String,
    pub title: String,
    pub channel: Option<String>,
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub duration_s: u32,
    pub expires_at: i64,
}

/// Resolve a video and register it with the proxy (usable without Tauri).
pub async fn resolve_and_register(
    proxy: &proxy::ProxyState,
    video_id: &str,
) -> Result<ResolvedAudio, String> {
    let t = resolve::resolve(video_id).await?;
    let proxy_url = proxy.register(&t).await;
    eprintln!(
        "[resolve] {video_id} -> {} | {} {:?}kbps {:?}Hz {}s | {proxy_url}",
        t.title, t.codec, t.bitrate_kbps, t.sample_rate_hz, t.duration_s
    );
    Ok(ResolvedAudio {
        proxy_url,
        title: t.title,
        channel: t.channel,
        codec: t.codec,
        bitrate_kbps: t.bitrate_kbps,
        sample_rate_hz: t.sample_rate_hz,
        duration_s: t.duration_s,
        expires_at: t.expires_at,
    })
}

/// One playlist row for the front end. `stream_url` is a lazy proxy URL:
/// nothing is resolved until the webview requests it. Keys are snake_case.
#[derive(Debug, Clone, Serialize)]
pub struct TrackInfo {
    pub video_id: String,
    pub title: String,
    pub channel: Option<String>,
    pub duration_s: u32,
    pub stream_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StartupTracks {
    pub config_path: String,
    pub source_count: usize,
    pub tracks: Vec<TrackInfo>,
    /// One message per source that could not be listed (or a config error).
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListedSource {
    /// Canonical URL, as stored in the config file.
    pub source: String,
    pub tracks: Vec<TrackInfo>,
}

/// Payload of the `ytdlp-outdated` event: yt-dlp warned that it could not
/// solve YouTube's JS challenges. Keys are snake_case.
#[derive(Debug, Clone, Serialize)]
pub struct YtdlpOutdated {
    /// The stderr line that tripped the check.
    pub line: String,
    /// `yt-dlp --version`, when the startup check has finished.
    pub version: Option<String>,
}

fn track_infos(proxy: &proxy::ProxyState, entries: Vec<resolve::Entry>) -> Vec<TrackInfo> {
    entries
        .into_iter()
        .map(|e| TrackInfo {
            stream_url: proxy.video_url(&e.video_id),
            video_id: e.video_id,
            title: e.title,
            channel: e.channel,
            duration_s: e.duration_s,
        })
        .collect()
}

/// Parse and list one source (playlist or video) without resolving streams.
pub async fn list_and_wrap(proxy: &proxy::ProxyState, source: &str) -> Result<ListedSource, String> {
    let src = resolve::parse_source(source)?;
    let entries = resolve::list(&src).await?;
    Ok(ListedSource { source: src.canonical_url(), tracks: track_infos(proxy, entries) })
}

fn config_path() -> Result<std::path::PathBuf, String> {
    config::path().ok_or_else(|| "cannot locate config dir: neither HOME nor USERPROFILE is set".to_string())
}

/// Everything in the config file, in order. Sources are listed one at a time.
#[tauri::command]
async fn startup_tracks(proxy: tauri::State<'_, Arc<proxy::ProxyState>>) -> Result<StartupTracks, String> {
    let p = config_path()?;
    let mut out = StartupTracks {
        config_path: p.display().to_string(),
        source_count: 0,
        tracks: vec![],
        errors: vec![],
    };
    let sources = match config::load(&p) {
        Ok(s) => s,
        Err(e) => {
            out.errors.push(format!("config: {e}"));
            return Ok(out);
        }
    };
    out.source_count = sources.len();
    for s in sources {
        match list_and_wrap(&proxy, &s).await {
            Ok(l) => out.tracks.extend(l.tracks),
            Err(e) => {
                eprintln!("[config] {s}: {e}");
                out.errors.push(format!("{s}: {e}"));
            }
        }
    }
    Ok(out)
}

/// List a pasted or dropped playlist/video URL (or id).
#[tauri::command]
async fn list_source(
    source: String,
    proxy: tauri::State<'_, Arc<proxy::ProxyState>>,
) -> Result<ListedSource, String> {
    list_and_wrap(&proxy, &source).await
}

/// Spike: loopback origin of the proxy, e.g. `http://127.0.0.1:54321`.
#[tauri::command]
fn proxy_base(proxy: tauri::State<'_, Arc<proxy::ProxyState>>) -> String {
    format!("http://127.0.0.1:{}", proxy.port)
}

/// Append a source to the config file. Returns false if it was already there.
/// Sonos rooms on the network (takes ~2 s). Empty when none answer.
#[tauri::command(rename_all = "snake_case")]
async fn sonos_rooms(sonos: tauri::State<'_, Arc<sonos::Player>>) -> Result<Vec<sonos::Room>, String> {
    sonos.rooms().await
}

/// Start `video_id` on the room at `ip`; returns its duration in seconds.
#[tauri::command(rename_all = "snake_case")]
async fn sonos_play_video(sonos: tauri::State<'_, Arc<sonos::Player>>, ip: String, video_id: String) -> Result<u32, String> {
    let ip = sonos.check(&ip).await?;
    sonos.play_video(ip, &video_id).await
}

/// `action`: play, pause, stop, seek (`value` seconds) or volume (`value` 0-100).
#[tauri::command(rename_all = "snake_case")]
async fn sonos_control(
    sonos: tauri::State<'_, Arc<sonos::Player>>,
    ip: String,
    action: String,
    value: Option<u32>,
) -> Result<(), String> {
    let ip = sonos.check(&ip).await?;
    let so = &sonos.so;
    match (action.as_str(), value) {
        ("play", _) => so.play(ip).await,
        ("pause", _) => so.pause(ip).await,
        ("stop", _) => so.stop(ip).await,
        ("seek", Some(s)) => so.seek(ip, s).await,
        ("volume", Some(v)) => so.set_volume(ip, v.min(100) as u8).await,
        _ => Err(format!("bad sonos action {action} {value:?}")),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn sonos_status(sonos: tauri::State<'_, Arc<sonos::Player>>, ip: String) -> Result<sonos::Status, String> {
    let ip = sonos.check(&ip).await?;
    sonos.status(ip).await
}

#[tauri::command(rename_all = "snake_case")]
async fn sonos_volume(sonos: tauri::State<'_, Arc<sonos::Player>>, ip: String) -> Result<u8, String> {
    let ip = sonos.check(&ip).await?;
    sonos.so.volume(ip).await
}

#[tauri::command]
async fn save_source(source: String) -> Result<bool, String> {
    let canonical = resolve::parse_source(&source)?.canonical_url();
    config::add_source(&config_path()?, &canonical)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let proxy = tauri::async_runtime::block_on(proxy::start())?;
            app.manage(proxy);
            app.manage(Arc::new(sonos::Player::default()));
            audio_out::allow_device_list(app);
            let handle = app.handle().clone();
            resolve::on_stale_warning(move |line| {
                let payload = YtdlpOutdated { line: line.to_string(), version: resolve::version().map(String::from) };
                if let Err(e) = handle.emit("ytdlp-outdated", payload) {
                    eprintln!("[resolve] could not send ytdlp-outdated: {e}");
                }
            });
            tauri::async_runtime::spawn(resolve::check_version());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_tracks,
            list_source,
            save_source,
            proxy_base,
            sonos_rooms,
            sonos_play_video,
            sonos_control,
            sonos_status,
            sonos_volume
        ])
        .run(tauri::generate_context!())
        .expect("error while running wamptube");
}
