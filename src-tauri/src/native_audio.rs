//! The seam between the webview and the native audio engine (gen/apple/Sources/
//! app/AudioEngine.swift).
//!
//! Same shape as the CarPlay seam next door: plain C-ABI functions, no objc2
//! message-sends. Rust -> native calls the `afm_audio_*` symbols Swift exports
//! with `@_cdecl`; the frontend drives transport through the commands below and
//! polls state back. Off iOS every entry point is a cheap no-op, so the frontend
//! can call unconditionally and desktop logs nothing.
//!
//! INCREMENT A: transport (load/play/pause/seek/volume/teardown) and a state
//! poll (position/duration/playing/ended). The PCM tap that streams FFT levels
//! to the webview as events lands on top, once native playback itself is proven.

#[cfg(target_os = "ios")]
mod native {
    use std::ffi::{c_char, CString};

    // Implemented in AudioEngine.swift, exported as C symbols via @_cdecl and
    // resolved when Xcode links the app target.
    extern "C" {
        fn afm_audio_ping() -> i32;
        fn afm_audio_load(url: *const c_char);
        fn afm_audio_play();
        fn afm_audio_pause();
        fn afm_audio_seek(seconds: f64);
        fn afm_audio_set_volume(volume: f64);
        fn afm_audio_teardown();
        fn afm_audio_poll(
            position: *mut f64,
            duration: *mut f64,
            playing: *mut i32,
            ended: *mut i32,
        );
    }

    pub fn ping() -> i32 {
        unsafe { afm_audio_ping() }
    }

    pub fn load(url: &str) {
        if let Ok(c) = CString::new(url) {
            unsafe { afm_audio_load(c.as_ptr()) }
        }
    }

    pub fn play() {
        unsafe { afm_audio_play() }
    }

    pub fn pause() {
        unsafe { afm_audio_pause() }
    }

    pub fn seek(seconds: f64) {
        unsafe { afm_audio_seek(seconds) }
    }

    pub fn set_volume(volume: f64) {
        unsafe { afm_audio_set_volume(volume) }
    }

    pub fn teardown() {
        unsafe { afm_audio_teardown() }
    }

    pub fn poll() -> (f64, f64, bool, bool) {
        let mut position = 0.0f64;
        let mut duration = 0.0f64;
        let mut playing = 0i32;
        let mut ended = 0i32;
        unsafe { afm_audio_poll(&mut position, &mut duration, &mut playing, &mut ended) };
        (position, duration, playing != 0, ended != 0)
    }
}

/// Confirms the native engine is present and linked. Returns the Swift sentinel
/// (42) on a device, -1 anywhere the engine does not exist, so the frontend can
/// probe once and pick its playback path from the answer.
#[tauri::command]
pub fn native_audio_ping() -> i32 {
    #[cfg(target_os = "ios")]
    {
        native::ping()
    }
    #[cfg(not(target_os = "ios"))]
    {
        -1
    }
}

/// Hands the engine a stream URL (the same signed URL the <audio> element would
/// load). Replaces whatever was playing; call play() after.
#[tauri::command]
pub fn native_audio_load(url: String) {
    #[cfg(target_os = "ios")]
    native::load(&url);
    #[cfg(not(target_os = "ios"))]
    let _ = url;
}

#[tauri::command]
pub fn native_audio_play() {
    #[cfg(target_os = "ios")]
    native::play();
}

#[tauri::command]
pub fn native_audio_pause() {
    #[cfg(target_os = "ios")]
    native::pause();
}

#[tauri::command]
pub fn native_audio_seek(seconds: f64) {
    #[cfg(target_os = "ios")]
    native::seek(seconds);
    #[cfg(not(target_os = "ios"))]
    let _ = seconds;
}

#[tauri::command]
pub fn native_audio_set_volume(volume: f64) {
    #[cfg(target_os = "ios")]
    native::set_volume(volume);
    #[cfg(not(target_os = "ios"))]
    let _ = volume;
}

#[tauri::command]
pub fn native_audio_teardown() {
    #[cfg(target_os = "ios")]
    native::teardown();
}

/// The live transport state, polled by the frontend a few times a second to
/// mirror native playback: `{position, duration, playing, ended}` in seconds.
/// Off iOS it reports `available: false` so the frontend keeps its <audio> path.
#[tauri::command]
pub fn native_audio_poll() -> serde_json::Value {
    #[cfg(target_os = "ios")]
    {
        let (position, duration, playing, ended) = native::poll();
        serde_json::json!({
            "available": true,
            "position": position,
            "duration": duration,
            "playing": playing,
            "ended": ended,
        })
    }
    #[cfg(not(target_os = "ios"))]
    {
        serde_json::json!({ "available": false })
    }
}
