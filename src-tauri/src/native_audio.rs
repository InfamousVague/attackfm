//! The seam between the webview and the native audio engine (gen/apple/Sources/
//! app/AudioEngine.swift).
//!
//! Same shape as the CarPlay seam next door: plain C-ABI functions in both
//! directions, no objc2 message-sends. Rust -> native calls the `afm_audio_*`
//! symbols Swift exports with `@_cdecl`; native -> Rust (the level/position/
//! ended stream) will call the `#[no_mangle]` functions here and ride out to
//! the webview as Tauri events. Off iOS every entry point is a cheap no-op, so
//! the frontend can call unconditionally and desktop logs nothing.
//!
//! PHASE 0: only `native_audio_ping` exists - it links the Swift sentinel so a
//! device build proves the Swift build surface and the C bridge before the real
//! transport, tap, FFT, and EQ land on top.

#[cfg(target_os = "ios")]
mod native {
    // Implemented in AudioEngine.swift, exported as a C symbol via @_cdecl and
    // resolved when Xcode links the app target.
    extern "C" {
        fn afm_audio_ping() -> i32;
    }

    pub fn ping() -> i32 {
        unsafe { afm_audio_ping() }
    }
}

/// Confirms the native engine is present and linked. Returns the Swift
/// sentinel (42) on a device, and -1 anywhere the engine does not exist, so the
/// frontend can probe once and pick its playback path from the answer.
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
