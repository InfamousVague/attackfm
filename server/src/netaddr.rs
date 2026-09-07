//! Where a request came from, on the network - and whether two callers share
//! one.
//!
//! A groove started on the same Wi-Fi as you is the groove you want offered.
//! The hub cannot see Wi-Fi; what it can see is each caller's address, in one
//! of two ways depending on how it is deployed:
//!
//! - Behind Caddy (matt.attack.fm) every connection arrives from loopback and
//!   the real address rides `X-Forwarded-For` (first entry) or `X-Real-IP`.
//!   Two phones on one home network leave it through one NAT, so they arrive
//!   with the SAME public address.
//! - A home hub (`AFM_BIND=0.0.0.0`, nothing in front) sees each peer's LAN
//!   address directly, via axum's `ConnectInfo`. Two phones on that LAN have
//!   different private addresses in one /24.
//!
//! So "same network" is: equal addresses, or both private and in one IPv4
//! /24. Addresses are read here, compared here, and NEVER serialised - a
//! client learns that a room is nearby, not where anybody is.
//!
//! The forwarded header is taken at its word. Caddy replaces any
//! `X-Forwarded-For` an untrusted client sent rather than appending to it, so
//! behind the proxy the first entry is the proxy's own observation; a hub
//! with nothing in front is a circle of people who already share a server,
//! and the worst a spoofed header can do there is make a room appear nearby.
use axum::extract::ConnectInfo;
use axum::http::HeaderMap;
use axum::Extension;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// The peer address axum recorded for the connection, when the router was
/// served with `into_make_service_with_connect_info` (main.rs does). Optional,
/// so a handler mounted on a router that was not does not fail for it.
pub type Peer = Option<Extension<ConnectInfo<SocketAddr>>>;

/// The caller's address as this hub best knows it: the proxy's word first,
/// the socket's peer otherwise, nothing when neither says.
pub fn client_addr(headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<IpAddr> {
    // A proxy that spoke at all has the last word: a forwarded header that
    // is present but unparseable names NOBODY, rather than falling through
    // to the socket - behind a proxy the socket is the proxy's own loopback,
    // and "nearby to everyone the proxy carries" is the wrong answer for
    // garbage. Only a bare connection (a home hub) is read off the socket.
    let spoke = headers.contains_key("x-forwarded-for") || headers.contains_key("x-real-ip");
    let named = forwarded(headers, "x-forwarded-for").or_else(|| forwarded(headers, "x-real-ip"));
    if spoke {
        return named;
    }
    named.or_else(|| peer.map(|p| canonical(p.ip())))
}

/// `client_addr` straight from a handler's extractors.
pub fn from_request(headers: &HeaderMap, peer: &Peer) -> Option<IpAddr> {
    client_addr(headers, peer.as_ref().map(|Extension(ConnectInfo(addr))| *addr))
}

/// The first address in a comma-separated forwarding header, parsed. A proxy
/// may write the port too (`203.0.113.9:51234`, `[2001:db8::1]:443`); that is
/// stripped. Anything unparseable counts as absent rather than as a network
/// of its own.
fn forwarded(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    let raw = headers.get(name)?.to_str().ok()?;
    let first = raw.split(',').next().unwrap_or("").trim();
    if first.is_empty() {
        return None;
    }
    parse_host(first).map(canonical)
}

/// An address with or without a port, bracketed or not.
fn parse_host(s: &str) -> Option<IpAddr> {
    if let Ok(ip) = s.parse::<IpAddr>() {
        return Some(ip);
    }
    if let Ok(sock) = s.parse::<SocketAddr>() {
        return Some(sock.ip());
    }
    // `[v6]` without a port.
    s.strip_prefix('[').and_then(|r| r.strip_suffix(']')).and_then(|inner| inner.parse().ok())
}

/// An IPv4 address that arrived as IPv4-mapped IPv6 (`::ffff:10.0.0.5`, what
/// a dual-stack listener reports) is the IPv4 address.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => ip,
        },
        v4 => v4,
    }
}

/// RFC 1918, plus IPv4 link-local (169.254/16, the v4 twin of fe80::) - the
/// addresses a device carries on a LAN and nowhere else.
fn private_v4(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

/// Two callers are on one network when they have the same address (one NAT
/// seen from outside, or one device), or when both carry private IPv4
/// addresses in the same /24 (one LAN seen from inside). IPv6 matches on
/// equality only: every link-local address on earth shares fe80::/64, so a
/// prefix says nothing about the link.
pub fn same_network(a: IpAddr, b: IpAddr) -> bool {
    let (a, b) = (canonical(a), canonical(b));
    if a == b {
        return true;
    }
    match (a, b) {
        (IpAddr::V4(a), IpAddr::V4(b)) => {
            private_v4(a) && private_v4(b) && a.octets()[..3] == b.octets()[..3]
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn a_garbage_forwarded_header_names_nobody_rather_than_the_proxy() {
        let peer = "127.0.0.1:5555".parse().ok();
        let h = headers(&[("x-forwarded-for", "not-an-address")]);
        assert_eq!(client_addr(&h, peer), None);
        let h = headers(&[("x-forwarded-for", "garbage"), ("x-real-ip", "198.51.100.7")]);
        assert_eq!(client_addr(&h, peer), "198.51.100.7".parse().ok());
        let h = headers(&[]);
        assert_eq!(client_addr(&h, peer), "127.0.0.1".parse().ok());
    }

    #[test]
    fn equal_public_v4_is_one_network() {
        assert!(same_network(ip("203.0.113.9"), ip("203.0.113.9")));
        // Two public addresses are two networks, /24 or not: only a private
        // range says "one LAN".
        assert!(!same_network(ip("203.0.113.9"), ip("203.0.113.10")));
    }

    #[test]
    fn private_v4_matches_on_the_slash_24() {
        assert!(same_network(ip("10.0.0.5"), ip("10.0.0.9")));
        assert!(same_network(ip("192.168.1.20"), ip("192.168.1.254")));
        assert!(same_network(ip("172.16.4.1"), ip("172.16.4.200")));
        assert!(same_network(ip("169.254.7.1"), ip("169.254.7.9")));
    }

    #[test]
    fn private_v4_off_the_slash_24_is_another_network() {
        assert!(!same_network(ip("10.0.0.5"), ip("10.0.1.9")));
        assert!(!same_network(ip("192.168.1.20"), ip("192.168.2.20")));
        // A private and a public address never share a LAN.
        assert!(!same_network(ip("10.0.0.5"), ip("203.0.113.5")));
    }

    #[test]
    fn v6_matches_on_equality_only() {
        assert!(same_network(ip("2001:db8::1"), ip("2001:db8::1")));
        assert!(same_network(ip("fe80::1"), ip("fe80::1")));
        assert!(!same_network(ip("fe80::1"), ip("fe80::2")), "fe80::/64 is every link, not one");
        assert!(!same_network(ip("2001:db8::1"), ip("2001:db8::2")));
        // IPv4 mapped into v6 is the v4 address.
        assert!(same_network(ip("::ffff:10.0.0.5"), ip("10.0.0.9")));
    }

    #[test]
    fn the_first_forwarded_for_entry_wins() {
        let h = headers(&[("x-forwarded-for", "203.0.113.9, 10.0.0.2, 127.0.0.1"), ("x-real-ip", "198.51.100.7")]);
        let peer: SocketAddr = "127.0.0.1:41234".parse().unwrap();
        assert_eq!(client_addr(&h, Some(peer)), Some(ip("203.0.113.9")));
        // Real-IP fills in when Forwarded-For is absent; the peer only when
        // both are.
        let h = headers(&[("x-real-ip", "198.51.100.7")]);
        assert_eq!(client_addr(&h, Some(peer)), Some(ip("198.51.100.7")));
        assert_eq!(client_addr(&HeaderMap::new(), Some(peer)), Some(ip("127.0.0.1")));
        // A port on the forwarded value is stripped; garbage is nothing.
        let h = headers(&[("x-forwarded-for", "203.0.113.9:51234")]);
        assert_eq!(client_addr(&h, None), Some(ip("203.0.113.9")));
        let h = headers(&[("x-forwarded-for", "[2001:db8::1]:443")]);
        assert_eq!(client_addr(&h, None), Some(ip("2001:db8::1")));
        let h = headers(&[("x-forwarded-for", "not-an-address")]);
        assert_eq!(client_addr(&h, None), None);
        // A dual-stack peer reports mapped v4; it is read as v4.
        let mapped: SocketAddr = "[::ffff:10.0.0.5]:9".parse().unwrap();
        assert_eq!(client_addr(&HeaderMap::new(), Some(mapped)), Some(ip("10.0.0.5")));
    }

    #[test]
    fn nothing_known_is_none() {
        assert_eq!(client_addr(&HeaderMap::new(), None), None);
        let h = headers(&[("x-forwarded-for", "  ")]);
        assert_eq!(client_addr(&h, None), None);
    }
}
