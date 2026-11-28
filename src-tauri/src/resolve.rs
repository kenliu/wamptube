//! Resolves a YouTube video id to a direct audio stream URL using yt-dlp.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::process::Command;

const YTDLP_TIMEOUT: Duration = Duration::from_secs(20);
/// Listing a long playlist pages through it; give it longer than one resolve.
const LIST_TIMEOUT: Duration = Duration::from_secs(60);
const FORMAT: &str = "bestaudio[ext=m4a]/bestaudio";
/// Video-only H.264 (WKWebView plays avc1 reliably; VP9/AV1 it does not).
const FORMAT_VIDEO: &str = "bestvideo[vcodec^=avc1][height<=1080][ext=mp4]/bestvideo[vcodec^=avc1]";

/// Which of a video's streams to resolve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Audio,
    Video,
}
const DEFAULT_TTL_S: i64 = 6 * 60 * 60;

#[cfg(windows)]
const YTDLP_BIN: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const YTDLP_BIN: &str = "yt-dlp";

/// Where package managers put yt-dlp and deno when a GUI app's PATH may not
/// include them: Homebrew on macOS; Scoop shims and WinGet links on Windows.
fn fallback_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut dirs = vec![];
        if let Some(home) = std::env::var_os("USERPROFILE") {
            dirs.push(PathBuf::from(home).join("scoop").join("shims"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links"));
        }
        dirs
    }
    #[cfg(not(windows))]
    {
        ["/opt/homebrew/bin", "/usr/local/bin"]
            .iter()
            .map(PathBuf::from)
            .collect()
    }
}

/// System dirs added to the child's PATH only. yt-dlp itself is never taken
/// from them: a copy there is likely too old to play (see CLAUDE.md).
#[cfg(windows)]
const CHILD_ONLY_DIRS: &[&str] = &[];
#[cfg(not(windows))]
const CHILD_ONLY_DIRS: &[&str] = &["/usr/bin", "/bin"];

/// Everything we learned about one video's chosen audio format.
#[derive(Debug, Clone)]
pub struct ResolvedTrack {
    pub video_id: String,
    pub upstream_url: String,
    /// Headers yt-dlp says to send with requests for this format.
    pub headers: Vec<(String, String)>,
    pub title: String,
    pub channel: Option<String>,
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
    pub sample_rate_hz: Option<u32>,
    pub duration_s: u32,
    pub is_live: bool,
    pub is_hls: bool,
    pub expires_at: i64,
    /// Exact size of the audio stream, when yt-dlp reports it.
    pub size_bytes: Option<u64>,
    /// Unix time before which the stream URL answers 403 (newer yt-dlp).
    pub available_at: Option<i64>,
}

/// `^[A-Za-z0-9_-]{11}$`
pub fn is_valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(windows)]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

#[cfg(not(windows))]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// `WAMPTUBE_YTDLP` (a path) overrides the search, e.g. to try a newer build.
fn find_ytdlp() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("WAMPTUBE_YTDLP").map(PathBuf::from) {
        if is_executable(&p) {
            return Some(p);
        }
    }
    let path_dirs = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    path_dirs
        .into_iter()
        .chain(fallback_dirs())
        .map(|d| d.join(YTDLP_BIN))
        .find(|p| is_executable(p))
}

/// PATH for the child: the inherited PATH plus the package-manager dirs, so
/// yt-dlp can find a JS runtime (deno) even when launched from a GUI app.
fn child_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for d in fallback_dirs()
        .into_iter()
        .chain(CHILD_ONLY_DIRS.iter().map(PathBuf::from))
    {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

fn last_stderr_line(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines
        .iter()
        .rev()
        .find(|l| l.starts_with("ERROR"))
        .or_else(|| lines.last())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "(no output on stderr)".into())
}

/// yt-dlp warnings that mean it can no longer solve YouTube's JS challenges,
/// which in practice means it is out of date (NOTES.md, problem 2). Formats
/// go missing or stop playing, often with no error of yt-dlp's own.
const STALE_MARKERS: &[&str] = &["n challenge solving failed", "signature solving failed"];

/// The first stderr line that says yt-dlp looks out of date, if any.
pub fn stale_warning(stderr: &str) -> Option<&str> {
    stderr.lines().map(str::trim).find(|l| {
        let l = l.to_ascii_lowercase();
        STALE_MARKERS.iter().any(|m| l.contains(m))
    })
}

type StaleHook = Box<dyn Fn(&str) + Send + Sync>;
static STALE_HOOK: OnceLock<StaleHook> = OnceLock::new();
static VERSION: OnceLock<String> = OnceLock::new();

/// Called with the offending stderr line on every yt-dlp run that warns it
/// looks out of date. Set once, at startup (lib.rs sends it to the webview).
pub fn on_stale_warning(f: impl Fn(&str) + Send + Sync + 'static) {
    let _ = STALE_HOOK.set(Box::new(f));
}

/// The version `check_version` found, if it has run and succeeded.
pub fn version() -> Option<&'static str> {
    VERSION.get().map(String::as_str)
}

/// Run `yt-dlp --version` once (no network) and log it.
pub async fn check_version() {
    match run_ytdlp(&["--version"], Duration::from_secs(10), "checking its version").await {
        Ok(v) => {
            let v = v.trim().to_string();
            eprintln!("[resolve] yt-dlp version {v}");
            let _ = VERSION.set(v);
        }
        Err(e) => eprintln!("[resolve] yt-dlp version check failed: {e}"),
    }
}

pub fn now_s() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn parse_expire(url: &str) -> Option<i64> {
    let u = reqwest::Url::parse(url).ok()?;
    let v = u.query_pairs().find(|(k, _)| k == "expire")?.1;
    v.parse::<i64>().ok()
}

fn as_u32(v: Option<&Value>) -> Option<u32> {
    v.and_then(Value::as_f64)
        .filter(|f| f.is_finite() && *f >= 0.0)
        .map(|f| f.round() as u32)
}

fn as_string(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Parse yt-dlp's `-j` output into a track.
pub fn parse_ytdlp_json(video_id: &str, json: &str) -> Result<ResolvedTrack, String> {
    let root: Value = serde_json::from_str(json.trim())
        .map_err(|e| format!("Unparseable yt-dlp output: {e}"))?;

    // With a single-format selector the chosen format's fields are top-level.
    // If yt-dlp ever returns a merged selection, take its audio-only part.
    let fmt: &Value = match root.get("requested_formats").and_then(Value::as_array) {
        Some(list) if root.get("url").is_none() => list
            .iter()
            .find(|f| {
                f.get("vcodec").and_then(Value::as_str) == Some("none") && f.get("url").is_some()
            })
            .ok_or("Unparseable yt-dlp output: no audio-only format among requested_formats")?,
        _ => &root,
    };

    let upstream_url = as_string(fmt.get("url"))
        .ok_or("Unparseable yt-dlp output: chosen format has no url")?;
    let headers = fmt
        .get("http_headers")
        .or_else(|| root.get("http_headers"))
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let title = as_string(root.get("title")).unwrap_or_else(|| video_id.to_string());
    let channel = as_string(root.get("channel")).or_else(|| as_string(root.get("uploader")));
    let codec = as_string(fmt.get("acodec"))
        .filter(|c| c != "none")
        .or_else(|| as_string(fmt.get("vcodec")).filter(|c| c != "none"))
        .unwrap_or_else(|| "unknown".into());
    let expires_at = parse_expire(&upstream_url).unwrap_or_else(|| now_s() + DEFAULT_TTL_S);

    Ok(ResolvedTrack {
        video_id: video_id.to_string(),
        upstream_url,
        headers,
        title,
        channel,
        codec,
        bitrate_kbps: as_u32(fmt.get("abr")),
        sample_rate_hz: as_u32(fmt.get("asr")),
        duration_s: as_u32(root.get("duration")).unwrap_or(0),
        is_live: root.get("live_status").and_then(Value::as_str) == Some("is_live")
            || root.get("is_live").and_then(Value::as_bool) == Some(true),
        is_hls: matches!(fmt.get("protocol").and_then(Value::as_str), Some("m3u8" | "m3u8_native")),
        expires_at,
        size_bytes: fmt.get("filesize").and_then(Value::as_u64),
        available_at: fmt
            .get("available_at")
            .or_else(|| root.get("available_at"))
            .and_then(Value::as_i64),
    })
}

/// Process creation flag: run a console program without opening a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `taskkill /T /F`: end `pid` and every process it started. Best effort.
#[cfg(windows)]
async fn kill_tree(pid: u32) {
    let taskkill = std::env::var_os("SystemRoot")
        .map(|r| PathBuf::from(r).join("System32").join("taskkill.exe"))
        .unwrap_or_else(|| PathBuf::from("taskkill.exe"));
    let pid = pid.to_string();
    let run = Command::new(taskkill)
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match tokio::time::timeout(Duration::from_secs(5), run).await {
        Ok(Ok(s)) if s.success() => {}
        other => eprintln!("[yt-dlp] taskkill of pid {pid} did not succeed: {other:?}"),
    }
}

/// Run yt-dlp with `args` and a hard timeout; returns stdout. stderr is
/// echoed with a `[yt-dlp]` prefix. `what` names the job in error messages.
async fn run_ytdlp(args: &[&str], timeout: Duration, what: &str) -> Result<String, String> {
    let ytdlp = find_ytdlp().ok_or_else(|| {
        if cfg!(windows) {
            "yt-dlp not found (looked on PATH, Scoop shims, WinGet links). Install it with `winget install yt-dlp.yt-dlp DenoLand.Deno` or `scoop install yt-dlp deno`.".to_string()
        } else {
            "yt-dlp not found (looked on PATH, /opt/homebrew/bin, /usr/local/bin). Install it with `brew install yt-dlp`.".to_string()
        }
    })?;
    let mut cmd = Command::new(&ytdlp);
    // A GUI app spawning a console program gets a console window flashing up
    // on every resolve unless told not to.
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd
        .args(args)
        .env("PATH", child_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("yt-dlp not found or not runnable at {}: {e}", ytdlp.display()))?;

    #[cfg(windows)]
    let pid = child.id();
    // When this function returns, the future (and the Child it owns) is
    // dropped and kill_on_drop kills the process (SIGKILL / TerminateProcess).
    let mut wait = std::pin::pin!(child.wait_with_output());
    let out = match tokio::time::timeout(timeout, wait.as_mut()).await {
        Err(_) => {
            // On Windows that kills only yt-dlp.exe, which may be a Scoop shim or
            // a PyInstaller launcher with the real work in a child process.
            // Kill the tree while the parent is still alive to be found.
            #[cfg(windows)]
            {
                if let Some(pid) = pid {
                    kill_tree(pid).await;
                }
            }
            return Err(format!("yt-dlp timed out after {}s {what}", timeout.as_secs()));
        }
        Ok(Err(e)) => return Err(format!("yt-dlp failed to run: {e}")),
        Ok(Ok(o)) => o,
    };

    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stderr.lines().filter(|l| !l.trim().is_empty()) {
        eprintln!("[yt-dlp] {line}");
    }
    if let Some(line) = stale_warning(&stderr) {
        eprintln!("[resolve] yt-dlp {} looks out of date", version().unwrap_or("(version unknown)"));
        if let Some(hook) = STALE_HOOK.get() {
            hook(line);
        }
    }
    if !out.status.success() {
        return Err(format!(
            "Unavailable or extraction failed: {}",
            last_stderr_line(&stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Run yt-dlp for `video_id` (validated here) with a hard timeout.
pub async fn resolve(video_id: &str) -> Result<ResolvedTrack, String> {
    resolve_kind(video_id, Kind::Audio).await
}

pub async fn resolve_kind(video_id: &str, kind: Kind) -> Result<ResolvedTrack, String> {
    let format = if kind == Kind::Video { FORMAT_VIDEO } else { FORMAT };
    if !is_valid_video_id(video_id) {
        return Err(format!("Invalid video id: {video_id:?} (expected 11 chars of A-Z a-z 0-9 _ -)"));
    }
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let stdout = run_ytdlp(
        &["-j", "--no-playlist", "--no-update", "-f", format, &url],
        YTDLP_TIMEOUT,
        &format!("resolving {video_id}"),
    )
    .await?;
    parse_ytdlp_json(video_id, &stdout)
}

/// A playlist or a single video, as named in the config file or the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Playlist(String),
    Video(String),
}

impl Source {
    /// The URL handed to yt-dlp and stored in the config file.
    pub fn canonical_url(&self) -> String {
        match self {
            Source::Playlist(id) => format!("https://www.youtube.com/playlist?list={id}"),
            Source::Video(id) => format!("https://www.youtube.com/watch?v={id}"),
        }
    }
}

fn is_valid_playlist_id(id: &str) -> bool {
    (2..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Accepts a bare video id, a bare playlist id, or a YouTube / youtu.be /
/// YouTube Studio URL. Only YouTube hosts are accepted, so arbitrary URLs never
/// reach yt-dlp. A watch URL that also has `list=` counts as the playlist
/// (that is what "copy URL" gives while a playlist is playing), except for
/// auto-generated Mixes (`RD...`), which are endless and personal: those
/// count as the video.
pub fn parse_source(input: &str) -> Result<Source, String> {
    let s = input.trim();
    let bad = || format!("Not a YouTube video or playlist: {s:?}");
    if is_valid_video_id(s) {
        return Ok(Source::Video(s.to_string()));
    }
    if !s.contains(['/', '.', ':', '?']) {
        return if is_valid_playlist_id(s) { Ok(Source::Playlist(s.to_string())) } else { Err(bad()) };
    }
    let with_scheme = if s.contains("://") { s.to_string() } else { format!("https://{s}") };
    let u = reqwest::Url::parse(&with_scheme).map_err(|_| bad())?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(bad());
    }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let q = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    let segs: Vec<&str> = u.path_segments().map(|p| p.filter(|s| !s.is_empty()).collect()).unwrap_or_default();
    let video = |id: &str| if is_valid_video_id(id) { Ok(Source::Video(id.to_string())) } else { Err(bad()) };
    let playlist = |id: &str| if is_valid_playlist_id(id) { Ok(Source::Playlist(id.to_string())) } else { Err(bad()) };
    match host.as_str() {
        "youtu.be" => video(segs.first().copied().unwrap_or("")),
        "studio.youtube.com" => match segs.as_slice() {
            ["playlist", id, ..] => playlist(id),
            ["video", id, ..] => video(id),
            _ => Err(bad()),
        },
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            if let Some(v) = q("v") {
                if let Some(l) = q("list") {
                    if !l.starts_with("RD") && is_valid_playlist_id(&l) {
                        return Ok(Source::Playlist(l));
                    }
                }
                return video(&v);
            }
            match segs.as_slice() {
                ["playlist"] => playlist(&q("list").ok_or_else(bad)?),
                ["shorts" | "live" | "embed", id, ..] => video(id),
                _ => Err(bad()),
            }
        }
        _ => Err(bad()),
    }
}

/// One playlist row: enough to show it and to resolve it later.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub video_id: String,
    pub title: String,
    pub channel: Option<String>,
    pub duration_s: u32,
}

const UNAVAILABLE_TITLES: &[&str] = &["[Private video]", "[Deleted video]", "[Unavailable video]"];

fn entry_from(v: &Value) -> Option<Entry> {
    let video_id = as_string(v.get("id")).filter(|id| is_valid_video_id(id))?;
    let title = as_string(v.get("title")).unwrap_or_else(|| video_id.clone());
    if UNAVAILABLE_TITLES.contains(&title.as_str()) {
        eprintln!("[resolve] skipping {video_id}: {title}");
        return None;
    }
    Some(Entry {
        channel: as_string(v.get("channel")).or_else(|| as_string(v.get("uploader"))),
        duration_s: as_u32(v.get("duration")).unwrap_or(0),
        title,
        video_id,
    })
}

/// Parse `yt-dlp -J --flat-playlist`: a playlist (with `entries`) or one video.
pub fn parse_flat_json(json: &str) -> Result<Vec<Entry>, String> {
    let root: Value = serde_json::from_str(json.trim())
        .map_err(|e| format!("Unparseable yt-dlp output: {e}"))?;
    match root.get("entries").and_then(Value::as_array) {
        Some(list) => Ok(list.iter().filter_map(entry_from).collect()),
        None => entry_from(&root)
            .map(|e| vec![e])
            .ok_or_else(|| "Unparseable yt-dlp output: no video id".into()),
    }
}

/// List a source's videos without resolving any stream URLs. For a playlist
/// this is one cheap request; for a single video yt-dlp extracts it fully.
pub async fn list(source: &Source) -> Result<Vec<Entry>, String> {
    let url = source.canonical_url();
    let mut args = vec!["-J", "--flat-playlist", "--no-update"];
    if matches!(source, Source::Video(_)) {
        args.extend(["--no-playlist", "--ignore-no-formats-error"]);
    }
    args.push(&url);
    let stdout = run_ytdlp(&args, LIST_TIMEOUT, &format!("listing {url}")).await?;
    let entries = parse_flat_json(&stdout)?;
    eprintln!("[resolve] listed {url}: {} entries", entries.len());
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ids() {
        assert!(is_valid_video_id("u1MqeDGBo94"));
        assert!(is_valid_video_id("a-b_c-d_e-f"));
        assert!(!is_valid_video_id("u1MqeDGBo9"));
        assert!(!is_valid_video_id("u1MqeDGBo94x"));
        assert!(!is_valid_video_id("u1MqeDG;o94"));
        assert!(!is_valid_video_id("u1MqeDG o94"));
        assert!(!is_valid_video_id("u1MqeDGBo9é"));
    }

    #[test]
    fn detects_stale_ytdlp_warnings() {
        let n = "[youtube] Extracting URL: https://www.youtube.com/watch?v=Hf20ZzMRs-I
            [jsc:deno] Solving JS challenges using deno
            WARNING: [youtube] Hf20ZzMRs-I: n challenge solving failed: Some formats may be missing.             Ensure you have a supported JavaScript runtime and challenge solver script distribution installed.
";
        assert!(stale_warning(n).unwrap().starts_with("WARNING: [youtube] Hf20ZzMRs-I: n challenge"));
        let sig = "  WARNING: [youtube] x: Signature solving failed: Some formats may be missing.  ";
        assert_eq!(stale_warning(sig), Some(sig.trim()));
        assert_eq!(stale_warning("WARNING: [youtube] x: Some web client https formats have been skipped"), None);
        assert_eq!(stale_warning(""), None);
    }

    #[test]
    fn parses_minimal_json() {
        let j = r#"{"title":"T","uploader":"U","acodec":"mp4a.40.2","abr":129.478,"asr":44100,
            "duration":1197,"url":"https://x.googlevideo.com/videoplayback?expire=1794742059&a=b",
            "http_headers":{"User-Agent":"UA"}}"#;
        let t = parse_ytdlp_json("u1MqeDGBo94", j).unwrap();
        assert!(!t.is_live && !t.is_hls);
        assert_eq!(t.channel.as_deref(), Some("U"));
        assert_eq!(t.bitrate_kbps, Some(129));
        assert_eq!(t.sample_rate_hz, Some(44100));
        assert_eq!(t.expires_at, 1794742059);
        assert_eq!(t.headers, vec![("User-Agent".into(), "UA".into())]);
        assert!(parse_ytdlp_json("x", "WARNING nope").unwrap_err().starts_with("Unparseable"));
    }

    #[test]
    fn detects_audio_only_live_hls_with_unknown_codec() {
        let json = r#"{"live_status":"is_live","format_id":"234","protocol":"m3u8",
            "ext":"mp4","vcodec":"none","url":"https://manifest.googlevideo.com/live.m3u8"}"#;
        let track = parse_ytdlp_json("4xDzrJKXOOY", json).unwrap();
        assert!(track.is_live && track.is_hls);
        assert_eq!(track.duration_s, 0);
        assert_eq!(track.codec, "unknown");
    }

    #[test]
    fn parses_sources() {
        use Source::*;
        let p = |s: &str| parse_source(s);
        let pl = "PLhMuGX-q2si_M5d8KCBibBf6njb-414fs";
        assert_eq!(p("Hf20ZzMRs-I"), Ok(Video("Hf20ZzMRs-I".into())));
        assert_eq!(p(pl), Ok(Playlist(pl.into())));
        assert_eq!(p(&format!("https://www.youtube.com/playlist?list={pl}")), Ok(Playlist(pl.into())));
        assert_eq!(p(&format!("youtube.com/playlist?list={pl}")), Ok(Playlist(pl.into())));
        assert_eq!(p(&format!("https://studio.youtube.com/playlist/{pl}/videos")), Ok(Playlist(pl.into())));
        assert_eq!(p(&format!("https://www.youtube.com/watch?v=Hf20ZzMRs-I&list={pl}")), Ok(Playlist(pl.into())));
        assert_eq!(p("https://www.youtube.com/watch?v=Hf20ZzMRs-I&list=RDHf20ZzMRs-I"), Ok(Video("Hf20ZzMRs-I".into())));
        assert_eq!(p("https://youtu.be/Hf20ZzMRs-I?t=3"), Ok(Video("Hf20ZzMRs-I".into())));
        assert_eq!(p("https://m.youtube.com/shorts/Hf20ZzMRs-I"), Ok(Video("Hf20ZzMRs-I".into())));
        assert!(p("https://evil.example/watch?v=Hf20ZzMRs-I").is_err());
        assert!(p("file:///etc/passwd").is_err());
        assert!(p("https://www.youtube.com/playlist?list=a;b").is_err());
        assert!(p("").is_err());
        assert_eq!(
            Video("Hf20ZzMRs-I".into()).canonical_url(),
            "https://www.youtube.com/watch?v=Hf20ZzMRs-I"
        );
    }

    #[test]
    fn parses_flat_playlist_and_single_video() {
        let j = r#"{"_type":"playlist","entries":[
            {"id":"l5cdI3DdSyw","title":"Mix","channel":"AcidJazz","duration":9207.0},
            {"id":"xXBNlApwh0c","title":"[Private video]","duration":null},
            {"id":"FJdNFcDNR14","title":"Electric Feel","uploader":"Scary Pockets"}]}"#;
        let e = parse_flat_json(j).unwrap();
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].duration_s, 9207);
        assert_eq!(e[1].channel.as_deref(), Some("Scary Pockets"));
        assert_eq!(e[1].duration_s, 0);
        let v = parse_flat_json(r#"{"id":"Hf20ZzMRs-I","title":"T","channel":"C","duration":335}"#).unwrap();
        assert_eq!(v[0].video_id, "Hf20ZzMRs-I");
    }
}
