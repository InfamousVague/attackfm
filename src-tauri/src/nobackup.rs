//! Keep re-downloadable bulk out of the device backup.
//!
//! On iOS, `app_data_dir()` resolves to `Library/Application Support/<bundle>`,
//! and iOS backs that up to iCloud by default. Two directories under it are
//! things this app can always fetch again - the offline audio cache, which is
//! allowed to grow to fifteen gigabytes, and the downloaded frontend bundles.
//! Left alone they go into the user's backup, which is both rude (it can swamp
//! a whole iCloud allowance with music that is already on a server) and a named
//! rejection reason in Apple's iOS Data Storage Guidelines: re-creatable data
//! must not be backed up.
//!
//! WHY NOT `Library/Caches`, which is the other thing Apple suggests. Because
//! iOS purges Caches under storage pressure without warning, and pinned songs
//! are the one thing in here that must never be evicted by anyone but the
//! listener. "We manage this, do not back it up" is exactly what Application
//! Support plus the exclusion flag means, and it is the honest description.
//!
//! Nothing to do anywhere else. Android's app data is not backed up by default
//! at the sizes involved (and `allowBackup` governs it wholesale), and desktop
//! backups are the user's own business.

/// Mark a directory as excluded from backup. Idempotent, and best-effort:
/// failing to set it costs a larger backup, never the app.
#[cfg(target_os = "ios")]
pub fn exclude(path: &std::path::Path) {
    use objc2_foundation::{NSNumber, NSString, NSURL, NSURLIsExcludedFromBackupKey};

    let Some(text) = path.to_str() else { return };
    unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        let yes = NSNumber::numberWithBool(true);
        // The error is deliberately dropped. There is no recovery worth
        // writing: the directory still works, the backup is just bigger.
        let _ = url.setResourceValue_forKey_error(Some(&yes), NSURLIsExcludedFromBackupKey);
    }
}

#[cfg(not(target_os = "ios"))]
pub fn exclude(_path: &std::path::Path) {}
