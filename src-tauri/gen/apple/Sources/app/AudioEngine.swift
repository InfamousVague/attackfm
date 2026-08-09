// AttackFM's native audio engine (iOS).
//
// The web layer plays through an <audio> element in WKWebView, which survives a
// screen lock but is a black box: WKWebView exposes none of its samples, so the
// visualiser levels, the beat pulse, and the equaliser have nothing to read on
// a phone. This is the native player that DOES expose them - an AVPlayer whose
// output can be tapped for PCM - while keeping the background-audio entitlement
// the <audio> path relies on (the session is already set to `playback` in
// ios_audio.rs, and AVPlayer honours it).
//
// Wired to Rust the same dumb, C-ABI way carplay.m is: `@_cdecl` exports the
// Rust -> native calls as plain C symbols the app target links. Rust drives
// transport and reads state back through `afm_audio_poll`; no objc2, no Tauri
// plugin crate - just a Swift object compiled into the app beside main.mm.
//
// INCREMENT A: transport + a state poll. Playback, seeking, volume, and the
// position/duration/ended a UI needs to mirror it. The PCM tap that feeds the
// FFT (levels, beat) and the biquad EQ land on top of this once playback itself
// is proven on the simulator.

import AVFoundation
import Foundation

/// The one native player. A singleton because the transport calls arrive as
/// bare C functions with no handle to carry - there is exactly one player on
/// the device, so a shared instance is the honest model.
final class AFMAudioEngine {
  static let shared = AFMAudioEngine()

  private let player = AVPlayer()
  private var item: AVPlayerItem?
  private var endObserver: NSObjectProtocol?
  /// Set when the current item plays to its end, cleared on the next load or a
  /// seek, so the poll can tell the queue "advance" exactly once per track.
  private var ended = false

  private init() {
    // Route around the ringer switch and keep going in the background: the
    // category is already claimed in ios_audio.rs, but a bare AVPlayer is
    // content to obey silent mode until the session is active, so make sure.
    player.automaticallyWaitsToMinimizeStalling = true
  }

  // MARK: Transport (Rust -> native)

  func load(_ urlString: String) {
    guard let url = URL(string: urlString) else { return }
    if let endObserver {
      NotificationCenter.default.removeObserver(endObserver)
      self.endObserver = nil
    }
    ended = false
    let newItem = AVPlayerItem(url: url)
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: newItem,
      queue: .main
    ) { [weak self] _ in
      self?.ended = true
    }
    player.replaceCurrentItem(with: newItem)
    item = newItem
  }

  func play() {
    ended = false
    player.play()
  }

  func pause() {
    player.pause()
  }

  func seek(_ seconds: Double) {
    ended = false
    player.seek(
      to: CMTime(seconds: max(0, seconds), preferredTimescale: 600),
      toleranceBefore: .zero,
      toleranceAfter: .zero
    )
  }

  func setVolume(_ volume: Double) {
    player.volume = Float(max(0, min(1, volume)))
  }

  func teardown() {
    player.pause()
    if let endObserver {
      NotificationCenter.default.removeObserver(endObserver)
      self.endObserver = nil
    }
    player.replaceCurrentItem(with: nil)
    item = nil
    ended = false
  }

  // MARK: State (native -> Rust, pulled)

  var position: Double {
    let t = player.currentTime().seconds
    return t.isFinite ? t : 0
  }

  var duration: Double {
    guard let d = item?.duration.seconds, d.isFinite else { return 0 }
    return d
  }

  var isPlaying: Bool {
    player.timeControlStatus == .playing
  }

  var isEnded: Bool { ended }
}

// MARK: - C ABI (Rust -> native)

@_cdecl("afm_audio_load")
public func afm_audio_load(_ url: UnsafePointer<CChar>) {
  let s = String(cString: url)
  DispatchQueue.main.async { AFMAudioEngine.shared.load(s) }
}

@_cdecl("afm_audio_play")
public func afm_audio_play() {
  DispatchQueue.main.async { AFMAudioEngine.shared.play() }
}

@_cdecl("afm_audio_pause")
public func afm_audio_pause() {
  DispatchQueue.main.async { AFMAudioEngine.shared.pause() }
}

@_cdecl("afm_audio_seek")
public func afm_audio_seek(_ seconds: Double) {
  DispatchQueue.main.async { AFMAudioEngine.shared.seek(seconds) }
}

@_cdecl("afm_audio_set_volume")
public func afm_audio_set_volume(_ volume: Double) {
  DispatchQueue.main.async { AFMAudioEngine.shared.setVolume(volume) }
}

@_cdecl("afm_audio_teardown")
public func afm_audio_teardown() {
  DispatchQueue.main.async { AFMAudioEngine.shared.teardown() }
}

/// Fills the caller's out-params with the live transport state. Read every
/// frame or two by the poll command; AVPlayer's properties are safe to read off
/// the main thread, so this needs no hop.
@_cdecl("afm_audio_poll")
public func afm_audio_poll(
  _ position: UnsafeMutablePointer<Double>,
  _ duration: UnsafeMutablePointer<Double>,
  _ playing: UnsafeMutablePointer<Int32>,
  _ ended: UnsafeMutablePointer<Int32>
) {
  let e = AFMAudioEngine.shared
  position.pointee = e.position
  duration.pointee = e.duration
  playing.pointee = e.isPlaying ? 1 : 0
  ended.pointee = e.isEnded ? 1 : 0
}

/// Kept so the Phase 0 probe (native_audio_ping) still links.
@_cdecl("afm_audio_ping")
public func afm_audio_ping() -> Int32 {
  return 42
}
