// Add your own #[tauri::command] functions here and register them in the
// invoke_handler below.
//
// Three of the four modules here are desktop-only, and gated as such rather
// than left to fail at runtime on a phone:
//
// - `dock_wave` paints a Dock tile. Phones have no Dock.
// - `music` drives the SpotiFLAC downloader as a child process. iOS and Android
//   both forbid an app spawning executables outright, so the code could not
//   work there even if it compiled.
// - `spotify` completes an OAuth flow by opening a browser and catching a
//   loopback redirect, which is a desktop shape.
//
// What is left - the window itself, the filesystem plugin, the dialog plugin -
// is what a phone build actually needs, and the streaming server covers the
// rest: on mobile the library comes over HTTP rather than off a disk.

#[cfg(desktop)]
mod dock_wave;
#[cfg(desktop)]
mod music;
#[cfg(desktop)]
mod spotify;

// The one piece of native code a phone build DOES need: without it iOS stops
// the audio the moment the screen locks.
mod ios_audio;

// The CarPlay seam. Compiled everywhere so the frontend can call its commands
// unconditionally; every call is a no-op except on iOS, where it bridges to
// the native template UI in gen/apple/Sources/app/carplay.m.
mod carplay;

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
#[cfg(all(desktop, not(target_os = "macos")))]
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

/// Makes the app's window the key window once the scene has attached it.
///
/// Under the scene lifecycle (UIApplicationSupportsMultipleScenes, which iOS
/// 26+ forces on this app), tao attaches its window to the scene but nothing
/// ever calls `makeKeyAndVisible` - and a window that is not KEY cannot host a
/// first responder. The visible symptom is exactly Apple's QA1813: taps land
/// (buttons work, focus rings draw) but the keyboard never rises, because the
/// text field's becomeFirstResponder is silently refused. Asserted twice on a
/// delay because the scene connect that creates the window races setup, and
/// re-asserting on an already-key window is a no-op.
#[cfg(target_os = "ios")]
fn ensure_key_window(handle: &tauri::AppHandle) {
    let handle = handle.clone();
    std::thread::spawn(move || {
        for delay_ms in [600u64, 2200] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let _ = handle.run_on_main_thread(|| unsafe {
                use objc2::msg_send;
                use objc2::runtime::{AnyClass, AnyObject};
                let Some(app_class) = AnyClass::get(c"UIApplication") else {
                    return;
                };
                let shared: *mut AnyObject = msg_send![app_class, sharedApplication];
                if shared.is_null() {
                    return;
                }
                let key: *mut AnyObject = msg_send![shared, keyWindow];
                if !key.is_null() {
                    return;
                }
                let windows: *mut AnyObject = msg_send![shared, windows];
                if windows.is_null() {
                    return;
                }
                let first: *mut AnyObject = msg_send![windows, firstObject];
                if first.is_null() {
                    return;
                }
                let () = msg_send![first, makeKeyAndVisible];
            });
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // decorum positions the native macOS traffic lights. There are none to
    // position on a phone, and the plugin is not built for those targets.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_decorum::init());

    builder
        .setup(|app| {
            // Before anything else on iOS: the audio session has to be claimed
            // at launch, not at the first play, or the first play is what
            // discovers it was never claimed.
            ios_audio::configure_session();
            // The window the scene attaches must also become KEY, or text
            // fields can never raise the keyboard - see ensure_key_window.
            #[cfg(target_os = "ios")]
            ensure_key_window(&app.handle());
            // The CarPlay scene may connect at any moment (including before
            // the webview loads, when the phone is already docked in the
            // car), so the event handle is stored as early as possible.
            carplay::init(&app.handle());

            #[cfg(desktop)]
            {
                use tauri::Manager;
                // On a phone this is where setup ends: there is no window to
                // shape and no download queue to run.
                let Some(main) = app.get_webview_window("main") else {
                    return Ok(());
                };
                desktop_setup(app, &main);
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Everything that only means something in front of a real window.
#[cfg(desktop)]
fn desktop_setup(app: &tauri::App, main: &tauri::WebviewWindow) {
    {
        // Spin up the music-import download queue (SpotiFLAC-backed).
        music::init(&app.handle());
        spotify::init(&app.handle());
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
            square_aspect(main);
    }
}

/// The commands the frontend may call.
///
/// Two lists rather than one, because the desktop-only modules do not exist in
/// a phone build - naming them there would not compile. A mobile frontend
/// therefore reaches nothing it should not, and the plugin that would have
/// called them is switched off in the registry anyway.
#[cfg(desktop)]
fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
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
        dock_wave::dock_wave_still,
        spotify::spotify_status,
        spotify::spotify_connect,
        spotify::spotify_disconnect,
        spotify::spotify_library,
        spotify::spotify_mark_synced,
        // No-ops here; real on iOS. Registered on both so the frontend can
        // push without asking which build it is in.
        carplay::carplay_set_library,
        carplay::carplay_now_playing,
    ]
}

#[cfg(mobile)]
fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![carplay::carplay_set_library, carplay::carplay_now_playing]
}
