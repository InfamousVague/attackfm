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
