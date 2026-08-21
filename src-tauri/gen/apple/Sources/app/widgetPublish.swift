// The app's half of the home-screen widget: publishing what is playing.
//
// A WidgetKit widget is a SEPARATE PROCESS that cannot ask the app anything.
// The only channel is the App Group container, so the app leaves the truth
// there and rings the bell. The payload is the exact JSON the CarPlay seam
// already carries ({title, artist, album, artUrl, duration, position,
// playing}) - Rust calls this beside afm_carplay_set_now_playing with the
// same string, so the widget can never disagree with the car or the lock
// screen about what is on.
//
// Stored raw and parsed by the widget, not unpacked here: the writer's job
// is to be cheap and unfailing on the audio path. If the App Group
// entitlement is missing (a build from before it, or a provisioning profile
// that has not learned it yet) suiteName comes back nil and this whole file
// is a no-op - the widget shows its idle face, nothing else notices.
//
// HAND-WRITTEN, like carplay.m: `tauri ios init` regenerates the project,
// not these sources, but a delete-and-reinit loses this file.

import Foundation
import WidgetKit

/// One name, shared with widget/AttackFMWidget.swift and both entitlement
/// files. Change it in all four places or not at all.
private let suite = "group.com.mattssoftware.attackfm"

@_cdecl("afm_widget_publish")
public func afmWidgetPublish(_ json: UnsafePointer<CChar>?) {
  guard let json else { return }
  let payload = String(cString: json)
  guard let store = UserDefaults(suiteName: suite) else { return }
  store.set(payload, forKey: "nowPlaying")
  store.set(Date().timeIntervalSince1970, forKey: "nowPlayingAt")
  if #available(iOS 14.0, *) {
    WidgetCenter.shared.reloadTimelines(ofKind: "AttackFMNowPlaying")
  }
}
