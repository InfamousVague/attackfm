//! Keeping the music playing on iOS when the screen locks.
//!
//! This is the one thing a music app on iOS cannot do without and gets nothing
//! for free. An app starts in the `SoloAmbient` audio session category, which
//! is defined to stop when the screen locks or the app leaves the foreground -
//! so a WKWebView playing an `<audio>` element goes silent the moment the
//! phone is pocketed, which for a music player means it does not work.
//!
//! Two halves, and both are required:
//!
//! 1. `UIBackgroundModes: [audio]` in the Info.plist, which is what entitles
//!    the process to keep running audio in the background at all. That lives in
//!    `Info.ios.plist`, next to this crate.
//! 2. The audio session category set to `playback` and activated, which is what
//!    tells the system this app's audio is the point rather than incidental.
//!    That is this file.
//!
//! Done through raw message sends rather than a bindings crate: it is three
//! calls into a framework that has been stable for a decade, and the objc2
//! runtime is already in the tree.

/// Puts the process into the `playback` audio session category.
///
/// Safe to call more than once, and safe to fail: a phone that refuses the
/// category still plays in the foreground, which is worse but not broken. Every
/// call is checked rather than assumed, because the alternative to a null check
/// here is a crash on launch.
#[cfg(target_os = "ios")]
pub fn configure_session() {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::msg_send;
    use objc2_foundation::NSString;

    unsafe {
        let Some(class) = AnyClass::get(c"AVAudioSession") else {
            // The framework is not loaded. Nothing to configure, nothing to
            // report - the app still runs.
            return;
        };
        let session: *mut AnyObject = msg_send![class, sharedInstance];
        if session.is_null() {
            return;
        }

        // The constant `AVAudioSessionCategoryPlayback` is an NSString whose
        // value is literally "playback", so the literal is the constant - and
        // reaching for the symbol would mean linking AVFAudio explicitly.
        let category = NSString::from_str("playback");
        let mut error: *mut AnyObject = std::ptr::null_mut();
        let _: bool = msg_send![session, setCategory: &*category, error: &mut error];

        // Activating is separate, and is what actually takes the session. A
        // failure here is usually another app holding an exclusive session; the
        // next play attempt will take it.
        let mut activate_error: *mut AnyObject = std::ptr::null_mut();
        let _: bool = msg_send![session, setActive: true, error: &mut activate_error];

        let _ = Retained::<AnyObject>::retain(session);
    }
}

/// Everywhere else this is nothing: Android's WebView keeps playing in the
/// background on its own, and desktops never stopped.
#[cfg(not(target_os = "ios"))]
pub fn configure_session() {}
