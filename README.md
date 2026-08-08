# AttackFM

A desktop app skeleton built with [Glacier UI](https://github.com/InfamousVague/GlacierUI),
scaffolded by `create-glacier-app`.

## Develop

```sh
npm install
npm run dev        # web app on http://localhost:5240
```

Everything under `src/app` is yours to replace: the sidebar navigation, the
window title bar, the settings, the modal, and the toast system are all worked
examples composed from Glacier components. The kit is vendored under
`vendor/@glacier/*`, so the app installs and runs with no extra setup.

## Your music, on your phone

The library can come from two places: a folder on this machine, or a server you
run. Everyone runs their own — the library is your own files on your own
machine, not a service anyone else is on.

`server/` is that server: a single Rust binary that indexes a music folder and
streams the original files over HTTP byte ranges, so a phone plays the same FLAC
the desktop does, bit for bit. On the machine that will hold the music:

```sh
curl -fsSL https://raw.githubusercontent.com/InfamousVague/attackfm/main/server/install.sh | sudo sh
```

The installer asks where the music lives and whether you have a domain, sets up
systemd and (with a domain) Caddy with automatic HTTPS, and prints the address
to enter under **Settings → Server**. The app carries the same instructions
behind "I don't have a server yet" on that pane. See
[server/README.md](server/README.md) for the details.

```sh
npm run server         # or just run it locally: 127.0.0.1:8788
```

The design goal was that the player should not learn anything. It already plays
whatever URL it is handed through an `<audio>` element, and it already reads
levels off a CORS-clean remote source — so a remote track is just a track whose
`path` is an `afm://<id>` URI, and the only function that had to change is the
one that turns a path into something playable. Favourites, the queue, search,
the visualiser, the equaliser and the crossfade all work on a server library
without knowing one exists.

## Phone (iOS and Android)

```sh
npm run ios:dev          # or: npm run android:dev
npm run ios:build        # signed build for a real device
npm run ios:build:sim    # simulator build
```

Use the npm scripts rather than `tauri ios build` directly. They clear the
copied artifacts first, because Tauri finishes an iOS build by `rename()`-ing
the app into `gen/apple/build/<target>/`, and on macOS that fails with
`ENOTEMPTY` when the previous build's output is still there — so the first build
works and every one after it dies with "failed to rename app … Directory not
empty", several lines below a cheerful `** BUILD SUCCEEDED **`. Only the copied
bundles are cleared; the compiled objects live in DerivedData and are untouched.

The phone builds are the listening end of the system: there is no music folder
on a phone worth walking, so the library comes from the server. Three things
differ from the desktop build, all of them handled:

- **Window chrome.** `isDesktopApp` (in `src/app/platform.ts`) is what the
  chrome keys on now, not `isTauri()` — a phone build is inside Tauri but has no
  window to decorate. It gets a plain header carrying the same search and
  settings controls, and the browser gets it too.
- **Background audio.** iOS suspends audio at the lock screen unless the app
  both declares `UIBackgroundModes: [audio]` (`src-tauri/Info.ios.plist`) and
  claims the `playback` audio session (`src-tauri/src/ios_audio.rs`). Both are
  required; either alone does nothing.
- **What cannot run there.** The music importer drives a Python downloader as a
  child process, which mobile sandboxes forbid outright, so it is left out of
  the registry on phones rather than shipped as a card that cannot work.

One gotcha worth knowing: `tauri ios init` regenerates
`src-tauri/gen/apple/project.yml` and resets the iOS deployment target to 14.0,
which Xcode 26+ refuses to build. Re-apply the 15.0 in that file and run
`xcodegen generate` in `gen/apple` — neither `ios init` nor `ios build` re-runs
xcodegen for you.

## CarPlay

The car gets a native UI — CarPlay renders CPTemplate objects or nothing, so
there is no webview to bring along. The split:

- **`gen/apple/Sources/app/carplay.m`** is the whole car-facing app: a
  Liked / Artists / Songs tab bar, the shared Now Playing screen, and the
  system now-playing + remote-command registration that the lock screen and
  steering wheel also consume. Hand-written; survives `ios init`, but a
  delete-and-reinit loses it (it is listed in project.yml's header note).
- **`src-tauri/src/carplay.rs`** is the seam: two Tauri commands in
  (`carplay_set_library`, `carplay_now_playing`), two events out
  (`carplay:play`, `carplay:remote`). No-ops everywhere but iOS.
- **`src/app/carplay.ts`** is the webview half: the library push after each
  sync (`library.tsx`), the now-playing pushes and remote-command handling
  (`Player.tsx`), and queue reconstruction for car taps (`CarPlayBridge` in
  `App.tsx`). The audio never leaves the webview — the car is a remote
  control, and skips on the wheel run the exact handlers the player strip's
  buttons do.

**Entitlement staging.** CarPlay requires `com.apple.developer.carplay-audio`,
which Apple grants per-app on request (developer.apple.com/carplay). Simulator
builds carry it today via `app_iOS.simulator.entitlements` (the simulator does
not check provisioning); device builds deliberately leave it out so signing
keeps working, which leaves CarPlay dormant on a real phone. Once Apple grants
it for `com.mattssoftware.attackfm`, move the key into `app_iOS.entitlements`
and both builds light up — the code paths are identical either way.

Seeing it needs a CarPlay host: a car, Apple's "CarPlay Simulator" from the
Additional Tools for Xcode download (drives a USB-connected real iPhone, so it
waits on the entitlement), or Simulator.app's I/O → External Displays → CarPlay
on an Xcode that ships Simulator.app — the Xcode 27 beta's DeviceHub does not
offer a CarPlay display.

## Desktop (Tauri)

When you scaffolded with the Tauri backend, `src-tauri/` holds a Tauri v2 Rust
crate with a sample `greet` command wired to the About page:

```sh
npm run tauri:dev     # run the desktop window
npm run tauri:build   # produce an installer
```

Requires the [Rust toolchain](https://www.rust-lang.org/tools/install) and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Plugins

Features that are not the core player live under `src/plugins/` as compiled-in
plugins: a plugin is a plain object (see `src/plugins/types.ts`) listed in
`src/plugins/index.ts`, and that array's order is the render, nesting, and
merge order everywhere. A plugin can contribute:

- a **Provider** mounted inside the library context, for background work like
  queues and subscriptions;
- components for the chrome's fixed **slots** (`titlebar-end`,
  `player-trailing`);
- **settings tabs** appended to the settings modal;
- **playlist tiles** appended to the showcase strip;
- **palette commands** computed from the live ⌘K query, which may claim a
  query outright (a pasted link is an action, not a search).

Users switch plugins on and off in Settings → Plugins; a switched-off plugin
mounts nothing and detects nothing. A plugin that crashes while rendering is
pulled for the session and can be retried with the same switch.

The music importer (`src/plugins/spotify-import/`) is the worked example: the
download queue, the title-bar downloads popover, the Downloads settings tab,
and the paste-a-link import command are all its contributions. Its SpotiFLAC
download engine stays in `src-tauri/src/music.rs` - Rust is not hot-loadable,
so the backend is a service the plugin talks to, not part of the plugin.
