// Add your own #[tauri::command] functions here and register them in the
// invoke_handler below.

mod music;

/// Holds the window square while it is resized.
///
/// macOS has this natively: an aspect ratio on the window is honoured by the
/// window server itself, so the drag is constrained as it happens rather than
/// corrected after the fact - the edge follows the pointer along one axis and
/// the other side keeps up, with no frame ever painted at the wrong shape.
/// Tauri's window API has no word for it, so it is set straight on the NSWindow.
#[cfg(target_os = "macos")]
fn square_aspect(window: &tauri::WebviewWindow) {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::NSSize;

    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    // Tauri hands back the NSWindow it owns; it outlives this borrow, and setup
    // runs on the main thread, which is where AppKit requires the call.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    // The frame, not the content view: the square the user sees is the window,
    // and the title bar sits over the content rather than above it.
    ns_window.setAspectRatio(NSSize::new(1.0, 1.0));
}

/// Holds the window square while it is resized.
///
/// Off macOS there is no aspect ratio to hand the window manager, so the shape
/// is restored after each resize instead: the longer side wins, which reads as
/// the window following whichever edge is being dragged. The guard is what ends
/// it - the size this sets comes back as another resize event, and a square one
/// asks for nothing further.
#[cfg(not(target_os = "macos"))]
fn square_aspect(window: &tauri::WebviewWindow) {
    let win = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Resized(size) = event {
            if size.width != size.height {
                let side = size.width.max(size.height);
                let _ = win.set_size(tauri::PhysicalSize::new(side, side));
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_decorum::init())
        .setup(|app| {
            use tauri::Manager;
            let main = app.get_webview_window("main").expect("main window");
            // Spin up the music-import download queue (SpotiFLAC-backed).
            music::init(&app.handle());
            // Center the native macOS traffic lights in the taller custom title
            // bar. decorum's `y` is the extra title-bar height reserved BELOW the
            // buttons (container height = button_height + y), and the buttons
            // center in that container; ~30 centers a ~14px button set in the
            // 52px (3.25rem) bar. macOS re-lays-out the buttons on resize, so
            // re-apply the inset on every resize.
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_decorum::WebviewWindowExt;
                const INSET: (f32, f32) = (16.0, 30.0);
                let _ = main.set_traffic_lights_inset(INSET.0, INSET.1);
                let win = main.clone();
                main.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Resized(_)) {
                        let _ = win.set_traffic_lights_inset(INSET.0, INSET.1);
                    }
                });
            }
            square_aspect(&main);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            music::music_import_enqueue,
            music::music_imports_list,
            music::music_import_remove,
            music::music_import_cancel,
            music::music_imports_clear,
            music::music_import_retry,
            music::music_spotiflac_status,
            music::music_spotiflac_install,
            music::music_import_get_settings,
            music::music_import_set_settings,
            music::music_import_set_paused,
            music::music_import_paused,
            music::music_album_art,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
