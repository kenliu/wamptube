//! Letting the front end pick the audio output device.
//!
//! The webview plays through `HTMLMediaElement.setSinkId`, which needs real
//! device ids from `enumerateDevices`. Chromium (WebView2) hides those ids and
//! labels until the page holds microphone permission, so on Windows the app
//! grants that permission to its own origins up front. Nothing ever calls
//! getUserMedia: the grant only unlocks the device list. WKWebView has no
//! setSinkId, so on macOS the picker stays hidden and this is a no-op.

#[cfg(windows)]
pub fn allow_device_list(app: &tauri::App) {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::SetPermissionStateCompletedHandler;
    use windows_core::{Interface, HSTRING};

    let Some(win) = app.get_webview_window("main") else { return };
    let res = win.with_webview(|pw| {
        let grant = || -> windows_core::Result<()> {
            unsafe {
                let profile = pw
                    .controller()
                    .CoreWebView2()?
                    .cast::<ICoreWebView2_13>()?
                    .Profile()?
                    .cast::<ICoreWebView2Profile4>()?;
                // the bundled app's origin, and the Vite dev server's
                for origin in ["http://tauri.localhost", "http://localhost:1420"] {
                    let done = SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(())));
                    profile.SetPermissionState(
                        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                        &HSTRING::from(origin),
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                        &done,
                    )?;
                }
            }
            Ok(())
        };
        if let Err(e) = grant() {
            eprintln!("[audio] cannot unlock the output device list: {e}");
        }
    });
    if let Err(e) = res {
        eprintln!("[audio] no webview to configure: {e}");
    }
}

#[cfg(not(windows))]
pub fn allow_device_list(_app: &tauri::App) {}
