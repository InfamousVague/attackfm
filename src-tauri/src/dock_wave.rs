//! The dock icon.
//!
//! The webview draws the station mark once at boot and ships it here as raw
//! PNG bytes; this side hands it to the Dock. A dev binary has no bundle
//! icon behind it, so without this macOS shows the generic executable tile.
//! The icon is never handed back to macOS (`setApplicationIconImage(nil)`)
//! for the same reason.
//!
//! This used to receive a ~15fps stream of spectrum-driven frames while
//! music played; the meter never sat close enough to the beat to feel
//! synced, so the icon is still again.
//!
//! Everything here is a no-op off macOS: the command exists everywhere so
//! the frontend never needs to know, but only AppKit has a dock tile.

use tauri::AppHandle;

/// Replaces the dock icon. Main thread only - AppKit's rule - so the swap
/// is queued rather than performed in place.
#[cfg(target_os = "macos")]
fn set_dock_icon(app: &AppHandle, png: Vec<u8>) {
    let _ = app.run_on_main_thread({
        move || {
            use objc2::{AnyThread, MainThreadMarker};
            use objc2_app_kit::{NSApplication, NSImage};
            use objc2_foundation::NSData;
            let Some(mtm) = MainThreadMarker::new() else { return };
            let ns_app = NSApplication::sharedApplication(mtm);
            let data = NSData::with_bytes(&png);
            if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
                unsafe { ns_app.setApplicationIconImage(Some(&image)) };
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn set_dock_icon(_app: &AppHandle, _png: Vec<u8>) {}

/// Receives the brand frame and wears it. Sent at boot; a reload sends it
/// again, which just repaints the same mark.
#[tauri::command]
pub fn dock_wave_still(app: AppHandle, still: Vec<u8>) -> Result<(), String> {
    if still.is_empty() {
        return Err("dock icon needs a frame".into());
    }
    set_dock_icon(&app, still);
    Ok(())
}
