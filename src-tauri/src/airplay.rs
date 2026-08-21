//! The seam to the AirPlay route picker (gen/apple/Sources/app/airplay.swift).
//!
//! Two commands where one would seem enough, and the second is the point:
//! `airplay_supported` exists so the frontend can ask BEFORE drawing a button.
//! The OTA bundle travels ahead of the native shell - a phone can run today's
//! JS on last month's binary - and on a shell from before this module the
//! probe call simply rejects, which reads as "no". That is what lets the
//! button hide itself on an old shell instead of sitting there dead, and it is
//! why adding these commands does NOT bump NATIVE_GENERATION: nothing in the
//! bundle requires them to exist, so no device has to be refused an update
//! over an optional button.

/// Whether this build can present the picker at all.
#[tauri::command]
pub fn airplay_supported() -> bool {
    cfg!(target_os = "ios")
}

#[cfg(target_os = "ios")]
extern "C" {
    fn afm_airplay_show();
}

/// Open the system route sheet. A no-op everywhere but iOS, so the frontend
/// may call it unguarded the way it calls the CarPlay seam.
#[tauri::command]
pub fn airplay_show() {
    #[cfg(target_os = "ios")]
    unsafe {
        afm_airplay_show()
    };
}
