//! The seam to the nearby-listeners layer (gen/apple/Sources/app/nearby.swift).
//!
//! Discovery only, and only while the listener asks for it. Nothing here
//! carries audio, a queue, or an identity beyond the handle they already
//! publish to friends: a peer's advertisement is a handle and, when they are
//! hosting, the jam's own code - which is already the invitation, so finding
//! somebody nearby IS the invitation arriving, and joining runs the ordinary
//! code path with nothing new to trust.
//!
//! Off iOS every command is a no-op answering an empty list, so the frontend
//! calls them unconditionally the way it does CarPlay's.

#[cfg(target_os = "ios")]
mod native {
    use std::ffi::{c_char, CStr, CString};

    extern "C" {
        fn afm_nearby_start(handle: *const c_char, code: *const c_char);
        fn afm_nearby_stop();
        fn afm_nearby_peers() -> *mut c_char;
        fn afm_nearby_free(ptr: *mut c_char);
    }

    pub fn start(handle: &str, code: Option<&str>) {
        let h = CString::new(handle).unwrap_or_default();
        let c = CString::new(code.unwrap_or("")).unwrap_or_default();
        unsafe { afm_nearby_start(h.as_ptr(), c.as_ptr()) };
    }

    pub fn stop() {
        unsafe { afm_nearby_stop() };
    }

    pub fn peers() -> String {
        unsafe {
            let raw = afm_nearby_peers();
            if raw.is_null() {
                return "[]".to_string();
            }
            let out = CStr::from_ptr(raw).to_string_lossy().into_owned();
            afm_nearby_free(raw);
            out
        }
    }
}

#[cfg(not(target_os = "ios"))]
mod native {
    pub fn start(_handle: &str, _code: Option<&str>) {}
    pub fn stop() {}
    pub fn peers() -> String {
        "[]".to_string()
    }
}

/// Begin advertising and browsing. `code` is the jam being hosted, if any.
#[tauri::command]
pub async fn nearby_start(handle: String, code: Option<String>) -> Result<(), String> {
    native::start(&handle, code.as_deref());
    Ok(())
}

/// Stop both halves and forget what was seen.
#[tauri::command]
pub async fn nearby_stop() -> Result<(), String> {
    native::stop();
    Ok(())
}

/// Who is around right now, as the JSON the Swift side keeps: a list of
/// `{ handle, code? }`. Polled rather than pushed so a webview returning from
/// the background cannot sit on a stale list it missed the edge of.
#[tauri::command]
pub async fn nearby_peers() -> Result<String, String> {
    Ok(native::peers())
}
