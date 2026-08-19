//! What kind of network this device is on, for "only download on Wi-Fi".
//!
//! WHY THIS IS NATIVE AT ALL. The web platform already answers this, and on
//! Android it answers it well: `navigator.connection.type` is a Chromium
//! feature and the Android build is Chromium. iOS is the problem. WKWebView
//! ships no Network Information API whatsoever, so the one device where mobile
//! data is an actual bill is the one device the web answer cannot reach. A
//! Wi-Fi-only switch that silently does nothing on iPhone would be worse than
//! no switch, because it would read as a promise.
//!
//! So this asks the OS through the interface list. It is a heuristic and not a
//! route-table lookup: the question being asked is "would bytes cost money",
//! which is about the BILL rather than the radio, and the interface names
//! answer that well enough on every platform that has a cellular modem. Where
//! it cannot tell, it says so - see `network_kind`.

/// What this device is connected through, as far as the interface list shows.
///
/// Three answers, and `unknown` is a real one rather than a failure. A build
/// that cannot look (Windows), a device mid-handover, and a machine with no
/// network at all all land there. Every caller treats it as "do not block",
/// because a download that silently stops is a worse bug than one that costs a
/// few megabytes: the first looks like the feature is broken and gives no clue
/// why, the second is visible on a bill the user can act on.
#[tauri::command]
pub fn network_kind() -> &'static str {
    probe()
}

#[cfg(unix)]
fn probe() -> &'static str {
    use std::ffi::CStr;

    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs writes an owned linked list into `list` on success and
    // leaves it alone otherwise; the freeifaddrs below releases it exactly once.
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return "unknown";
    }

    let mut wifi = false;
    let mut cellular = false;
    let mut node = list;
    while !node.is_null() {
        // SAFETY: node is non-null here and came from getifaddrs, which
        // guarantees a well-formed entry with an ifa_next terminating in null.
        let ifa = unsafe { &*node };
        node = ifa.ifa_next;

        if ifa.ifa_addr.is_null() || ifa.ifa_name.is_null() {
            continue;
        }
        let flags = ifa.ifa_flags as i32;
        // UP is "configured", RUNNING is "actually has a carrier". Both, or a
        // laptop with Wi-Fi enabled and no network joined reports Wi-Fi.
        if flags & libc::IFF_UP == 0 || flags & libc::IFF_RUNNING == 0 {
            continue;
        }
        if flags & libc::IFF_LOOPBACK != 0 {
            continue;
        }
        // SAFETY: ifa_addr is non-null (checked) and points at a sockaddr whose
        // family tag says which concrete layout follows.
        if !unsafe { routable(ifa.ifa_addr) } {
            continue;
        }

        // SAFETY: ifa_name is non-null (checked) and NUL-terminated.
        let name = unsafe { CStr::from_ptr(ifa.ifa_name) }.to_string_lossy();
        if is_cellular(&name) {
            cellular = true;
        } else if is_unmetered(&name) {
            wifi = true;
        }
    }

    // SAFETY: `list` came from a successful getifaddrs and is freed once, after
    // the walk above has finished reading every node.
    unsafe { libc::freeifaddrs(list) };

    // Wi-Fi wins when both are up, and on iOS both being up is the NORMAL
    // state rather than the exception: the cellular interface keeps its
    // address while you are on Wi-Fi. Reading "cellular" from its mere
    // presence would report cellular to a phone sitting on a home network,
    // which is the failure mode that makes this kind of check useless.
    if wifi {
        "wifi"
    } else if cellular {
        "cellular"
    } else {
        "unknown"
    }
}

/// Windows has no getifaddrs, and a Windows desktop is not where a mobile data
/// bill comes from. Unknown, which reads as "do not block".
#[cfg(not(unix))]
fn probe() -> &'static str {
    "unknown"
}

/// Whether an address could carry traffic off this machine.
///
/// The link-local checks are what let an idle Wi-Fi interface read as absent.
/// A phone with Wi-Fi switched on but nothing joined still has `en0` up and
/// running carrying an `fe80::` address, and counting that would report Wi-Fi
/// for a device doing every byte of its work over cellular - the exact case
/// this whole module exists to catch.
///
/// # Safety
/// `addr` must be non-null and point at a `sockaddr` whose `sa_family` field
/// correctly describes the layout that follows it.
#[cfg(unix)]
unsafe fn routable(addr: *const libc::sockaddr) -> bool {
    match unsafe { (*addr).sa_family } as i32 {
        libc::AF_INET => {
            let v4 = unsafe { &*(addr as *const libc::sockaddr_in) };
            // 169.254.0.0/16 - what a machine assigns itself when no DHCP
            // server ever answered.
            u32::from_be(v4.sin_addr.s_addr) >> 16 != 0xA9FE
        }
        libc::AF_INET6 => {
            let v6 = unsafe { &*(addr as *const libc::sockaddr_in6) };
            let b = v6.sin6_addr.s6_addr;
            // fe80::/10
            !(b[0] == 0xFE && b[1] & 0xC0 == 0x80)
        }
        // A link-layer entry (AF_LINK/AF_PACKET) says nothing about whether the
        // interface can reach anything, so it is not evidence either way.
        _ => false,
    }
}

/// Interface names that mean "these bytes are metered".
#[cfg(unix)]
fn is_cellular(name: &str) -> bool {
    // iOS names every cellular context pdp_ipN. Android and desktop Linux use
    // whatever the modem driver calls itself, which is vendor-specific: rmnet
    // is Qualcomm, ccmni MediaTek, and wwan/qmi the generic USB modem stack.
    name.starts_with("pdp_ip")
        || name.starts_with("rmnet")
        || name.starts_with("ccmni")
        || name.starts_with("wwan")
        || name.starts_with("qmi")
}

/// Interface names we treat as costing nothing per byte.
#[cfg(unix)]
fn is_unmetered(name: &str) -> bool {
    // `en*` covers both Wi-Fi and Ethernet on Apple platforms, which is right
    // rather than sloppy - the question is the bill, not the radio.
    //
    // Deliberately NOT a catch-all, and this is the half that has to stay
    // narrow: awdl0 (AirDrop), utun* (VPN), ap1 (personal hotspot, where the
    // bytes leaving the device are somebody's cellular) and bridge* all reach
    // this function while a phone is tethering, and every one of them must
    // fail it. A VPN is the subtle case: traffic routes over utun*, but the
    // interface underneath is still en0 or pdp_ip0, so ignoring the tunnel is
    // what keeps the answer correct.
    name.starts_with("en")
        || name.starts_with("wlan")
        || name.starts_with("eth")
        || name.starts_with("wl")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn tunnels_and_hotspots_are_not_wifi() {
        // The names that are up and running on a TETHERING iPhone. If any of
        // these counted, the phone sharing its cellular connection would
        // report Wi-Fi and download over exactly the link being paid for.
        for name in ["utun0", "utun3", "awdl0", "ap1", "bridge100", "llw0"] {
            assert!(!is_unmetered(name), "{name} must not count as unmetered");
            assert!(!is_cellular(name), "{name} is not a modem either");
        }
    }

    #[test]
    fn the_modem_names_are_recognised() {
        for name in ["pdp_ip0", "pdp_ip1", "rmnet_data0", "ccmni0", "wwan0"] {
            assert!(is_cellular(name), "{name} is a modem");
            assert!(!is_unmetered(name), "{name} must never read as unmetered");
        }
    }

    #[test]
    fn ordinary_interfaces_still_read_as_unmetered() {
        for name in ["en0", "en1", "eth0", "wlan0"] {
            assert!(is_unmetered(name), "{name} should count as unmetered");
        }
    }

    #[test]
    fn probing_this_machine_answers_one_of_three() {
        // Not asserting WHICH - it depends on the machine running the tests -
        // only that the walk completes, frees its list and returns a value the
        // frontend's union actually contains.
        assert!(matches!(probe(), "wifi" | "cellular" | "unknown"));
    }
}

