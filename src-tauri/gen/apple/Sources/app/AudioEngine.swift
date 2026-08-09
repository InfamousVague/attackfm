// AttackFM's native audio engine (iOS).
//
// The web layer plays through an <audio> element in WKWebView, which survives a
// screen lock but is a black box: WKWebView exposes none of its samples, so the
// visualiser levels, the beat pulse, and the equaliser have nothing to read
// from on a phone. This file is the native player that DOES expose them - an
// AVPlayer whose output is tapped for PCM, run through an FFT for the levels the
// bar and the disc move to, and past a biquad bank for the EQ - while keeping
// the background-audio entitlement the <audio> path relies on.
//
// It is wired to Rust the same dumb, C-ABI way carplay.m is: `@_cdecl` exports
// the Rust -> native calls as plain C symbols the app target links, and the
// native -> Rust direction calls the `afm_audio_*` C functions Rust marks
// `#[no_mangle]`. No objc2 message-sends, no Tauri plugin crate - just a Swift
// object compiled into the app beside main.mm.
//
// PHASE 0: this is the build-surface proof. Only `afm_audio_ping` exists, so a
// device build confirms Swift compiles into the app target and Rust links the
// symbol before the AVPlayer + tap + FFT + EQ land on top of it.

import Foundation

/// Returns a fixed sentinel so the Rust `native_audio_ping` command - and the
/// JS behind it - can confirm the Swift half is present and linked. Replaced by
/// real transport calls once the surface is proven.
@_cdecl("afm_audio_ping")
public func afm_audio_ping() -> Int32 {
  return 42
}
