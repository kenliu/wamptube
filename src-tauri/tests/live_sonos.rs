//! Live Sonos spike: find a speaker, serve one YouTube track to it through the
//! proxy bound on the LAN, play, seek, pause, and change volume. Plays audio
//! out loud and replaces whatever the speaker was playing. Run with:
//!   cargo test --test live_sonos -- --ignored --nocapture
//! Env: WAMPTUBE_SONOS_ROOM picks a room by name (default: the first found);
//! WAMPTUBE_SONOS_IP skips SSDP discovery.

use std::net::IpAddr;
use std::time::Duration;

use wamptube_lib::sonos::{self, Sonos};
use wamptube_lib::{proxy, resolve};

const VIDEO: &str = "u1MqeDGBo94";
/// The test never plays louder than this; the original volume is restored.
const MAX_TEST_VOLUME: u8 = 20;

async fn sleep(s: f32) {
    tokio::time::sleep(Duration::from_secs_f32(s)).await;
}

/// Poll until the speaker is PLAYING and its position has moved past `from + 2`.
async fn wait_playing(so: &Sonos, ip: IpAddr, from: u32, secs: u32) -> bool {
    for i in 0..secs {
        sleep(1.0).await;
        let state = so.transport_state(ip).await.unwrap_or_else(|e| e);
        let pos = so.position(ip).await.unwrap_or_default();
        println!("  t+{:>2}s {state:<16} pos {}/{}", i + 1, sonos::hms(pos.rel_s), sonos::hms(pos.track_s));
        if state == "PLAYING" && pos.rel_s >= from + 2 {
            return true;
        }
    }
    false
}

#[tokio::test]
#[ignore = "plays audio on a real Sonos; run explicitly"]
async fn play_one_track_on_sonos() {
    let so = Sonos::new();

    // 1. Find speakers.
    let ips: Vec<IpAddr> = match std::env::var("WAMPTUBE_SONOS_IP") {
        Ok(ip) => vec![ip.parse().expect("WAMPTUBE_SONOS_IP")],
        Err(_) => sonos::discover_ips(Duration::from_secs(3)).await.expect("ssdp"),
    };
    let mut speakers = Vec::new();
    for ip in ips {
        match sonos::describe(so.client(), ip).await {
            Ok(s) => speakers.push(s),
            Err(e) => println!("{ip}: no device description ({e})"),
        }
    }
    println!("found {} speaker(s):", speakers.len());
    for s in &speakers {
        println!("  {:<16} {:<20} {:<22} {}", s.ip, s.room, s.model, s.uuid);
    }
    assert!(!speakers.is_empty(), "no Sonos answered SSDP; try WAMPTUBE_SONOS_IP");
    let room = std::env::var("WAMPTUBE_SONOS_ROOM").ok();
    let target = match &room {
        Some(r) => speakers.iter().find(|s| s.room.eq_ignore_ascii_case(r)).expect("no speaker in that room"),
        None => &speakers[0],
    };

    // 2. Commands go to the group coordinator.
    let groups = so.groups(target.ip).await.expect("zone groups");
    let group = groups
        .iter()
        .find(|g| g.members.iter().any(|m| m.0 == target.uuid))
        .expect("target not in any group");
    let coord = group.members.iter().find(|m| m.0 == group.coordinator).map(|m| m.1).unwrap_or(target.ip);
    let rooms: Vec<&str> = group.members.iter().map(|m| m.2.as_str()).collect();
    println!("target {} -> group coordinator {coord}, rooms {rooms:?}", target.room);

    // 3. Proxy on the interface that reaches the speaker.
    let lan = sonos::local_ip_toward(coord).expect("local ip");
    let px = proxy::start_on(lan).await.expect("proxy on LAN");
    let t = resolve::resolve(VIDEO).await.expect("resolve");
    let url = px.register(&t).await;
    println!("track: {} | {} {:?}kbps {}s | {url}", t.title, t.codec, t.bitrate_kbps, t.duration_s);

    // 4. Cap the volume for the test.
    let v0 = so.volume(coord).await.expect("get volume");
    let v_test = v0.min(MAX_TEST_VOLUME);
    if v_test != v0 {
        so.set_volume(coord, v_test).await.expect("set volume");
    }
    println!("volume was {v0}, testing at {v_test}");

    // 5. Try the plain URL first, then with an .m4a extension.
    let mut played = None;
    for variant in [url.clone(), format!("{url}.m4a")] {
        println!("SetAVTransportURI {variant}");
        let meta = sonos::didl(&variant, "audio/mp4", &t.title, t.channel.as_deref(), t.duration_s);
        if let Err(e) = so.set_uri(coord, &variant, &meta).await {
            println!("  rejected: {e}");
            continue;
        }
        if let Err(e) = so.play(coord).await {
            println!("  play failed: {e}");
            continue;
        }
        if wait_playing(&so, coord, 0, 20).await {
            played = Some(variant);
            break;
        }
        println!("  did not start playing");
        let _ = so.stop(coord).await;
    }

    let mut ok = played.is_some();
    if let Some(variant) = &played {
        println!("PLAYING via {variant}");
        let pos = so.position(coord).await.unwrap_or_default();
        println!("speaker reports duration {}s (yt-dlp says {}s)", pos.track_s, t.duration_s);

        // 6. Seek deep into the track.
        let target_s = (t.duration_s * 2 / 3).max(10);
        match so.seek(coord, target_s).await {
            Ok(()) => {
                let landed = wait_playing(&so, coord, target_s, 15).await;
                println!("seek to {} -> {}", sonos::hms(target_s), if landed { "ok" } else { "FAILED" });
                ok &= landed;
            }
            Err(e) => {
                println!("seek rejected: {e}");
                ok = false;
            }
        }

        // 7. Volume down and back.
        let lower = v_test.saturating_sub(5);
        so.set_volume(coord, lower).await.expect("set volume");
        let read = so.volume(coord).await.expect("get volume");
        println!("volume set {lower}, reads {read}");
        ok &= read == lower;
        sleep(2.0).await;
        so.set_volume(coord, v_test).await.expect("set volume");

        // 8. Pause and resume.
        so.pause(coord).await.expect("pause");
        sleep(2.0).await;
        let state = so.transport_state(coord).await.unwrap_or_default();
        println!("after pause: {state}");
        ok &= state == "PAUSED_PLAYBACK";
        let at = so.position(coord).await.unwrap_or_default().rel_s;
        so.play(coord).await.expect("resume");
        let resumed = wait_playing(&so, coord, at, 10).await;
        println!("resume -> {}", if resumed { "ok" } else { "FAILED" });
        ok &= resumed;
    }

    let _ = so.stop(coord).await;
    let _ = so.set_volume(coord, v0).await;
    println!("stopped; volume restored to {v0}");
    println!("upstream requests to googlevideo: {}", px.upstream_requests.load(std::sync::atomic::Ordering::Relaxed));
    assert!(played.is_some(), "Sonos would not play the stream (see [proxy] lines for what it fetched)");
    assert!(ok, "played, but a control step failed (see above)");
}
