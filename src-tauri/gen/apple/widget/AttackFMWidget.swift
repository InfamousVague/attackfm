// The home-screen widget: now playing, on the springboard.
//
// The Android widget's rules apply here translated into WidgetKit's grammar.
// NO STATE OF ITS OWN: everything drawn is read from the App Group store the
// app publishes into (Sources/app/widgetPublish.swift), at the moment the
// timeline is asked for - and the app reloads this timeline on every
// discontinuity, so the "timeline" is always exactly one entry, policy
// .never, that says what is true right now. When the store is empty or
// stale-with-nothing-playing, the idle face: the wordmark and an invitation,
// and the tap opens the app, because that is the only promise a dead app can
// keep. (WidgetKit gives every widget tap-opens-the-app for free; deep
// transport control would need App Intents into a process that may not be
// running - a later feature, deliberately not faked here.)
//
// The art is fetched by the WIDGET, not stored by the app: the publish path
// must stay cheap on the audio thread's timing, and the artUrl it hands over
// carries its own token - the widget's one URLSession call either lands
// within its timeline budget or the plate draws with the gradient instead.
//
// HAND-WRITTEN: `tauri ios init` regenerates the project, not this target's
// sources. project.yml's widget_iOS target is what compiles this.

import SwiftUI
import WidgetKit

private let suite = "group.com.mattssoftware.attackfm"

struct NowPlayingState {
  var title: String
  var artist: String
  var playing: Bool
  var artUrl: String?
}

/// What the app last published, or nil for the idle face.
private func readState() -> NowPlayingState? {
  guard
    let store = UserDefaults(suiteName: suite),
    let raw = store.string(forKey: "nowPlaying"),
    let data = raw.data(using: .utf8),
    let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let title = parsed["title"] as? String,
    !title.isEmpty
  else { return nil }
  return NowPlayingState(
    title: title,
    artist: parsed["artist"] as? String ?? "",
    playing: parsed["playing"] as? Bool ?? false,
    artUrl: parsed["artUrl"] as? String,
  )
}

struct Entry: TimelineEntry {
  let date: Date
  let state: NowPlayingState?
  let art: UIImage?
}

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> Entry {
    Entry(date: Date(), state: NowPlayingState(title: "AttackFM", artist: "Nothing playing", playing: false, artUrl: nil), art: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
    completion(Entry(date: Date(), state: readState(), art: nil))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    let state = readState()
    let done: (UIImage?) -> Void = { art in
      completion(Timeline(entries: [Entry(date: Date(), state: state, art: art)], policy: .never))
    }
    guard let raw = state?.artUrl, let url = URL(string: raw), raw.hasPrefix("http") else {
      done(nil)
      return
    }
    let task = URLSession.shared.dataTask(with: url) { data, _, _ in
      done(data.flatMap(UIImage.init(data:)))
    }
    task.resume()
    // The timeline budget is short; a slow fetch forfeits the art, never the
    // words. The completion above is idempotent-guarded by URLSession only
    // firing once; this deadline path cancels so it cannot fire late.
    DispatchQueue.global().asyncAfter(deadline: .now() + 4) {
      if task.state == .running { task.cancel() }
    }
  }
}

struct NowPlayingView: View {
  let entry: Entry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    content
      .containerBackground(for: .widget) {
        LinearGradient(
          colors: [Color(red: 0.07, green: 0.07, blue: 0.10), Color(red: 0.12, green: 0.10, blue: 0.16)],
          startPoint: .topLeading,
          endPoint: .bottomTrailing,
        )
      }
  }

  @ViewBuilder private var content: some View {
    if let state = entry.state {
      HStack(spacing: 12) {
        artBlock
        VStack(alignment: .leading, spacing: 3) {
          Text(state.title)
            .font(.system(.subheadline, design: .rounded).weight(.semibold))
            .foregroundStyle(.white)
            .lineLimit(family == .systemSmall ? 2 : 1)
          Text(state.artist)
            .font(.system(.caption, design: .rounded))
            .foregroundStyle(.white.opacity(0.65))
            .lineLimit(1)
          if family != .systemSmall {
            Label(state.playing ? "Playing" : "Paused", systemImage: state.playing ? "waveform" : "pause.fill")
              .font(.system(.caption2, design: .rounded))
              .foregroundStyle(.white.opacity(0.45))
              .padding(.top, 2)
          }
        }
        Spacer(minLength: 0)
      }
    } else {
      VStack(alignment: .leading, spacing: 4) {
        Text("AttackFM")
          .font(.system(.subheadline, design: .rounded).weight(.bold))
          .foregroundStyle(.white)
        Text("Nothing playing — tap to open")
          .font(.system(.caption, design: .rounded))
          .foregroundStyle(.white.opacity(0.6))
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder private var artBlock: some View {
    if let art = entry.art {
      Image(uiImage: art)
        .resizable()
        .scaledToFill()
        .frame(width: 52, height: 52)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    } else {
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(.white.opacity(0.08))
        .frame(width: 52, height: 52)
        .overlay(
          Image(systemName: "music.note")
            .foregroundStyle(.white.opacity(0.4)),
        )
    }
  }
}

struct AttackFMNowPlaying: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "AttackFMNowPlaying", provider: Provider()) { entry in
      NowPlayingView(entry: entry)
    }
    .configurationDisplayName("Now Playing")
    .description("The song that's on, straight from the deck.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

@main
struct AttackFMWidgets: WidgetBundle {
  var body: some Widget {
    AttackFMNowPlaying()
  }
}
