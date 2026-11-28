//! Serve live HLS through loopback. The player gets opaque resource IDs, while
//! upstream URLs and yt-dlp's request headers stay in the Rust core.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use reqwest::Url;
use tokio::sync::Mutex;

use super::{cors, simple, wait_available, ProxyState, StreamEntry, RERESOLVE_MIN_GAP_S};
use crate::resolve::{self, now_s, Kind};

const MAX_PLAYLIST_BYTES: usize = 1024 * 1024;
const MAX_RESOURCES: usize = 2048;
const PLAYLIST_TYPE: &str = "application/vnd.apple.mpegurl";

#[derive(Clone, PartialEq)]
struct Resource {
    url: Url,
    playlist: bool,
}

pub(super) struct Proxy {
    client: reqwest::Client,
    resources: Mutex<VecDeque<(String, String, Resource)>>,
}

fn allowed_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| {
            host == "youtube.com"
                || host.ends_with(".youtube.com")
                || host == "googlevideo.com"
                || host.ends_with(".googlevideo.com")
        })
}

impl Proxy {
    pub(super) fn new() -> reqwest::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() < 5 && allowed_url(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.error("disallowed HLS redirect")
                }
            }))
            .build()?;
        Ok(Self {
            client,
            resources: Mutex::new(VecDeque::new()),
        })
    }
}

pub(super) async fn playback_mode(
    State(st): State<Arc<ProxyState>>,
    Path(video_id): Path<String>,
) -> Response {
    if !resolve::is_valid_video_id(&video_id) {
        return simple(StatusCode::NOT_FOUND, "invalid video id");
    }
    let token = match st.token_for_video(&video_id, Kind::Audio).await {
        Ok(token) => token,
        Err(error) => {
            eprintln!("[proxy] playback resolve failed for {video_id}: {error}");
            return simple(StatusCode::BAD_GATEWAY, "could not resolve video");
        }
    };
    match st.entry(&token).await {
        Some(entry) if entry.is_live && entry.is_hls => {
            simple(StatusCode::OK, format!("/hls/{token}/live.m3u8"))
        }
        Some(entry) if entry.is_live || entry.is_hls => simple(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported streaming format",
        ),
        Some(_) => simple(StatusCode::OK, ""),
        None => simple(StatusCode::NOT_FOUND, "unknown stream token"),
    }
}

pub(super) async fn playlist(
    State(st): State<Arc<ProxyState>>,
    Path(token): Path<String>,
    method: Method,
) -> Response {
    let Some(entry) = st.entry(&token).await.filter(|e| e.is_live && e.is_hls) else {
        return simple(StatusCode::NOT_FOUND, "unknown HLS stream");
    };
    let response = root_playlist(&st, &token, &entry, &method).await;
    if !matches!(response.status(), StatusCode::FORBIDDEN | StatusCode::GONE) {
        return response;
    }

    // Signed manifest URLs expire during long sessions. Keep the loopback URL
    // stable so the native player can continue refreshing the same playlist.
    let resolve_guard = st.resolve_lock.lock().await;
    let Some(current) = st.entry(&token).await else {
        return response;
    };
    let refreshed = if current.upstream_url != entry.upstream_url {
        current
    } else {
        let now = now_s();
        if current
            .last_reresolve
            .is_some_and(|at| now - at < RERESOLVE_MIN_GAP_S)
        {
            return response;
        }
        if let Some(saved) = st.tokens.write().await.get_mut(&token) {
            saved.last_reresolve = Some(now);
        }
        let track = match resolve::resolve(&entry.video_id).await {
            Ok(track) if track.is_live && track.is_hls => track,
            Ok(_) => return simple(StatusCode::GONE, "stream is no longer live"),
            Err(error) => {
                eprintln!("[proxy] HLS refresh failed for {}: {error}", entry.video_id);
                return response;
            }
        };
        let mut tokens = st.tokens.write().await;
        let Some(saved) = tokens.get_mut(&token) else {
            return response;
        };
        saved.upstream_url = track.upstream_url;
        saved.headers = track.headers;
        saved.available_at = track.available_at;
        saved.clone()
    };
    drop(resolve_guard);
    root_playlist(&st, &token, &refreshed, &method).await
}

async fn root_playlist(
    st: &ProxyState,
    token: &str,
    entry: &StreamEntry,
    method: &Method,
) -> Response {
    let Ok(url) = Url::parse(&entry.upstream_url) else {
        return simple(StatusCode::BAD_GATEWAY, "invalid HLS playlist URL");
    };
    serve(
        st,
        token,
        entry,
        Resource {
            url,
            playlist: true,
        },
        method,
        &HeaderMap::new(),
    )
    .await
}

pub(super) async fn resource(
    State(st): State<Arc<ProxyState>>,
    Path((token, id)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let item = st
        .hls
        .resources
        .lock()
        .await
        .iter()
        .find(|(owner, key, _)| owner == &token && key == &id)
        .map(|(_, _, item)| item.clone());
    let (Some(item), Some(entry)) = (item, st.entry(&token).await) else {
        return simple(StatusCode::NOT_FOUND, "unknown HLS resource");
    };
    serve(&st, &token, &entry, item, &method, &headers).await
}

async fn serve(
    st: &ProxyState,
    token: &str,
    entry: &StreamEntry,
    item: Resource,
    method: &Method,
    headers: &HeaderMap,
) -> Response {
    if !allowed_url(&item.url) {
        return simple(StatusCode::BAD_GATEWAY, "disallowed HLS URL");
    }
    wait_available(entry).await;
    let mut request = st.hls.client.request(
        if item.playlist {
            Method::GET
        } else {
            method.clone()
        },
        item.url,
    );
    for (name, value) in &entry.headers {
        request = request.header(name.as_str(), value.as_str());
    }
    if !item.playlist {
        if let Some(range) = headers.get(header::RANGE) {
            request = request.header(header::RANGE, range.clone());
        }
    }
    let Ok(mut upstream) = request.send().await else {
        return simple(StatusCode::BAD_GATEWAY, "HLS upstream request failed");
    };
    if !upstream.status().is_success() {
        return simple(upstream.status(), "HLS upstream returned an error");
    }

    let mut response = if item.playlist {
        let mut bytes = Vec::new();
        loop {
            match upstream.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_PLAYLIST_BYTES => {
                    bytes.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                _ => return simple(StatusCode::BAD_GATEWAY, "could not read HLS playlist"),
            }
        }
        let Ok(body) = std::str::from_utf8(&bytes) else {
            return simple(StatusCode::BAD_GATEWAY, "invalid HLS playlist encoding");
        };
        let mut resources = st.hls.resources.lock().await;
        let rewritten = rewrite(body, upstream.url(), |item| {
            let key = if let Some(index) = resources
                .iter()
                .position(|(owner, _, saved)| owner == token && *saved == item)
            {
                let saved = resources.remove(index).expect("known resource index");
                let key = saved.1.clone();
                resources.push_back(saved);
                key
            } else {
                let key = uuid::Uuid::new_v4().simple().to_string();
                resources.push_back((token.into(), key.clone(), item));
                if resources.len() > MAX_RESOURCES {
                    resources.pop_front();
                }
                key
            };
            format!("/hls/{token}/resource/{key}")
        });
        let Ok(body) = rewritten else {
            return simple(StatusCode::BAD_GATEWAY, "invalid HLS playlist");
        };
        let mut response = Response::new(if *method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(body)
        });
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(PLAYLIST_TYPE),
        );
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    } else {
        let status = upstream.status();
        let upstream_headers = upstream.headers().clone();
        let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
        *response.status_mut() = status;
        for name in [
            header::CONTENT_TYPE,
            header::CONTENT_LENGTH,
            header::CONTENT_RANGE,
            header::ACCEPT_RANGES,
        ] {
            if let Some(value) = upstream_headers.get(&name) {
                response.headers_mut().insert(name, value.clone());
            }
        }
        response
    };
    cors(response.headers_mut());
    response
}

fn rewrite(
    body: &str,
    base: &Url,
    mut local_url: impl FnMut(Resource) -> String,
) -> Result<String, ()> {
    if body.lines().next() != Some("#EXTM3U") {
        return Err(());
    }
    let mut resolve = |value: &str, playlist| {
        let url = base.join(value).map_err(|_| ())?;
        if !allowed_url(&url) {
            return Err(());
        }
        let playlist = playlist || url.path().ends_with(".m3u8");
        Ok(local_url(Resource { url, playlist }))
    };

    let mut output = String::new();
    let mut next_playlist = false;
    for line in body.lines().map(str::trim) {
        if line.starts_with('#') {
            if line.starts_with("#EXT-X-STREAM-INF:") {
                next_playlist = true;
            }
            let playlist = [
                "#EXT-X-MEDIA:",
                "#EXT-X-I-FRAME-STREAM-INF:",
                "#EXT-X-RENDITION-REPORT:",
            ]
            .iter()
            .any(|tag| line.starts_with(tag));
            let mut rest = line;
            while let Some((prefix, value)) = rest.split_once("URI=\"") {
                let (uri, suffix) = value.split_once('"').ok_or(())?;
                output.push_str(prefix);
                output.push_str("URI=\"");
                output.push_str(&resolve(uri, playlist)?);
                output.push('"');
                rest = suffix;
            }
            output.push_str(rest);
        } else if !line.is_empty() {
            output.push_str(&resolve(line, next_playlist)?);
            next_playlist = false;
        }
        output.push('\n');
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_manifest_and_segment_references() {
        let base = Url::parse("https://manifest.googlevideo.com/live/index.m3u8").unwrap();
        let mut resources = Vec::new();
        let body = rewrite(
            "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"/audio\"\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nvariant\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\nsegment?sig=123\n",
            &base,
            |item| {
                resources.push(item);
                format!("/local/{}", resources.len())
            },
        ).unwrap();
        assert_eq!(body, "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"/local/1\"\n#EXT-X-STREAM-INF:BANDWIDTH=128000\n/local/2\n#EXT-X-MAP:URI=\"/local/3\"\n#EXTINF:2,\n/local/4\n");
        assert_eq!(
            resources
                .iter()
                .map(|item| item.playlist)
                .collect::<Vec<_>>(),
            [true, true, false, false]
        );
        assert_eq!(
            resources[3].url.as_str(),
            "https://manifest.googlevideo.com/live/segment?sig=123"
        );
        assert!(rewrite(
            "#EXTM3U\nhttps://googlevideo.com.example.org/segment\n",
            &base,
            |_| unreachable!()
        )
        .is_err());
    }
}
