//! The seam between the webview and the CarPlay surface (gen/apple/Sources/
//! app/carplay.m).
//!
//! Traffic in both directions is deliberately dumb - JSON strings in, Tauri
//! events out - because the two sides update at different rhythms and neither
//! should block the other:
//!
//! - the webview pushes the library after each sync and the now-playing state
//!   on each discontinuity (`carplay_set_library` / `carplay_now_playing`);
//! - the car pushes back taps and transport commands, which surface in the
//!   webview as `carplay:play` and `carplay:remote` events.
//!
//! Off iOS every command is a no-op rather than an unknown command, so the
//! frontend calls them unconditionally and nothing logs errors on desktop.

#[cfg(target_os = "ios")]
mod native {
    use std::ffi::{c_char, CStr, CString};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter};

    // The native side of the seam, compiled into the app target from
    // carplay.m and resolved when Xcode links the final binary.
    extern "C" {
        fn afm_carplay_set_library(json: *const c_char);
        fn afm_carplay_set_now_playing(json: *const c_char);
        fn afm_set_idle_timer_disabled(disabled: i32);
    }

    // The handle events ride out on. A OnceLock because the CarPlay scene can
    // connect before or after Tauri finishes setup; a tap that arrives before
    // the handle exists is dropped, and the car's next tap works.
    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn init(handle: &AppHandle) {
        let _ = APP.set(handle.clone());
    }

    pub fn push_library(payload: &str) {
        if let Ok(json) = CString::new(payload) {
            unsafe { afm_carplay_set_library(json.as_ptr()) };
        }
    }

    pub fn push_now_playing(payload: &str) {
        if let Ok(json) = CString::new(payload) {
            unsafe { afm_carplay_set_now_playing(json.as_ptr()) };
        }
    }

    pub fn set_idle_disabled(disabled: bool) {
        unsafe { afm_set_idle_timer_disabled(if disabled { 1 } else { 0 }) };
    }

    /// A song tapped on the car screen: forwarded to the webview, which owns
    /// the queue and the audio.
    #[no_mangle]
    pub extern "C" fn afm_carplay_play_track(track_id: i64, context: *const c_char) {
        let Some(app) = APP.get() else { return };
        let context = if context.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(context) }.to_string_lossy().into_owned()
        };
        let _ = app.emit(
            "carplay:play",
            serde_json::json!({ "trackId": track_id, "context": context }),
        );
    }

    /// A transport command from the car or the lock screen.
    #[no_mangle]
    pub extern "C" fn afm_carplay_remote(command: *const c_char) {
        let Some(app) = APP.get() else { return };
        if command.is_null() {
            return;
        }
        let command = unsafe { CStr::from_ptr(command) }.to_string_lossy().into_owned();
        let _ = app.emit("carplay:remote", serde_json::json!({ "command": command }));
    }
}

/// Stores the handle the car's events ride out on. A no-op off iOS.
pub fn init(handle: &tauri::AppHandle) {
    #[cfg(target_os = "ios")]
    native::init(handle);
    let _ = handle;
}

/// The webview's library, pushed after each sync. `payload` is the JSON the
/// native store parses: `{ tracks: [{id, title, artist, album, trackNo,
/// artUrl, duration}], liked: [id, ...] }`.
#[tauri::command]
pub fn carplay_set_library(payload: String) {
    #[cfg(target_os = "ios")]
    native::push_library(&payload);
    let _ = payload;
}

/// What is playing right now, pushed on track change, play/pause, and seek:
/// `{ title, artist, album, artUrl, duration, position, playing }`.
#[tauri::command]
pub fn carplay_now_playing(payload: String) {
    #[cfg(target_os = "ios")]
    native::push_now_playing(&payload);
    let _ = payload;
}

/// Parks the phone's auto-lock while the full-screen player is up (the
/// webview dims itself instead - the Spotify behavior). No-op off iOS.
#[tauri::command]
pub fn set_idle_timer_disabled(disabled: bool) {
    #[cfg(target_os = "ios")]
    native::set_idle_disabled(disabled);
    let _ = disabled;
}
