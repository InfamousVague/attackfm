# AttackFM — App Store submission package

Everything to paste into App Store Connect for the **first review**. Bundle
`com.mattssoftware.attackfm`, version `0.1.3`, category **Music**.

> **Version note:** the build is now **0.1.3** (bumped from 0.1.0 so App Store
> Connect accepts it as a new build — a build number can't be reused). In App
> Store Connect set the version string to **0.1.3** and select this build.

> **The one thing that gets AttackFM rejected if it's missing:** AttackFM has no
> built-in server — it points at *your* server. A reviewer who opens the app
> just sees a sign-in screen with nothing to type. So the **App Review
> Information** below (demo account + the review server address) is mandatory,
> not optional. It is already filled in for the review server I set up.

---

## App Review Information  ← most important

| Field | Value |
|---|---|
| **Sign-in required** | Yes |
| **Demo account — Username** | `apple-review` |
| **Demo account — Password** | `ReviewAttack2026!` |
| **Contact — First / Last** | *(your name)* |
| **Contact — Phone** | *(your number)* |
| **Contact — Email** | infamousvaguerat@gmail.com |

**Notes to the reviewer** (paste into the Notes box verbatim):

```
AttackFM is a self-hosted music player: each user runs their own AttackFM
server and streams their own music library from it. The app ships with NO
default server, so on first launch it shows a sign-in screen.

To review the app, please sign in to the demo server we host for App Review:

  1. On the first screen, enter the Server address:  matt.attack.fm:8443
  2. It will confirm "Found AttackFM Review · 28 tracks".
  3. Tap Continue / Sign in and enter:
        Username:  apple-review
        Password:  ReviewAttack2026!
  4. You are now in the library. Tap any album or song to play it.

The demo library is stocked entirely with royalty-free / public-domain music
that we are licensed to distribute (Kevin MacLeod — CC-BY 4.0; ccMixter —
CC-BY 3.0; the Open Goldberg Variations by Kimiko Ishizaka — CC0/public
domain). No third-party or copyrighted catalog is served.

There is no account signup inside the app: accounts live on the user's own
server. The demo account above is a normal user account on our review server.
```

---

## App information (static, set once)

| Field | Value |
|---|---|
| **Name** | AttackFM |
| **Subtitle** (30 char max) | Your music, your own server |
| **Bundle ID** | com.mattssoftware.attackfm |
| **Primary category** | Music |
| **Secondary category** | Utilities |
| **Content rights** | Does **not** contain, show, or access third-party content *(you host your own files)* |
| **Age rating** | 4+ — answer **None / No** to every content question |

### Privacy — "App Privacy" questionnaire
AttackFM collects nothing on Apple's side; all data lives on the user's own
server. Recommended answers:

- **Data collection:** *Data is not collected* — if strictly true for the app
  binary (the app talks only to the user's server; Apple's question is about
  data **you** the developer collect and receive — you don't).
- If you'd rather over-disclose: declare *User Content* + *Identifiers*
  (username), **not linked** to identity, **not used for tracking**.
- **Privacy Policy URL:** https://attack.fm/privacy (live).

---

## Version information (per-version, 0.1.3)

**Promotional text** (170 char max — editable without review):
```
Stream your whole music collection from a server you run yourself. Lossless or
on-the-fly transcode, every device in sync, no subscription, no cloud middleman.
```

**Description:**
```
AttackFM is a music player for people who own their music.

Run the lightweight AttackFM server on any machine — a spare laptop, a home
server, a cheap VPS — point it at your music folder, and stream your entire
library to every device you own. No subscription. No catalog you rent and lose.
No company between you and your files.

YOUR LIBRARY, YOUR RULES
• Stream lossless straight from the original file, or transcode on the fly when
  you're on cellular — a per-device choice.
• FLAC, ALAC, AAC, MP3, and more, with your own tags and cover art.
• Everything is your own music on your own server.

EVERY DEVICE IN SYNC
• Start a song on your laptop, pick it up on your phone right where it was.
• Change the track on any device and it changes everywhere — the device
  playing the audio follows along.
• Link a new device in seconds with a QR code — no retyping passwords.

BUILT FOR LISTENING
• A clean library of everything you have: recently added, artists, albums,
  liked songs, playlists.
• Full-screen now-playing with artwork, lyrics, and a real scrubber.
• Search your whole library instantly.

Bring your own server. Keep your own music. Listen anywhere.
```

**Keywords** (100 char max, comma-separated):
```
music,player,self-hosted,streaming,lossless,flac,server,library,offline,sync,home server,audio
```

**What's New in This Version:**
```
First release of AttackFM. Stream your own music library from your own server,
in sync across every device.
```

**Copyright:** `2026 Matt's Software`

**Support URL:** `https://matt.attack.fm/` *(needs a reachable page — see below)*

**Marketing URL** (optional): `https://attack.fm/`

---

## Build / encryption

| Field | Value |
|---|---|
| **Uses non-exempt encryption** | **No** — already declared in Info.plist (`ITSAppUsesNonExemptEncryption = false`). HTTPS only, which is exempt. App Store Connect will not ask again. |
| **Build to attach** | The new **0.1.3** GA-SDK build (iOS 26.5 SDK, DTSDKName `iphoneos26.5`), built with the login-gate + QR changes. Upload the `.ipa` via Transporter, then select it under version 0.1.3. |

---

## Screenshots required

This listing's iPhone slot accepts **6.5" / 6.7"** sizes (App Store Connect
rejected 6.9"). Exact pixel dimensions, PNG/JPEG, **no device frame required**:

| Display | Portrait pixels | Note |
|---|---|---|
| 6.7" | **1284 × 2778** | ← the 5 screenshots I delivered are this size |
| 6.5" | 1242 × 2688 | Also accepted |
| iPad 13" | 2048 × 2732 | Only if you ship iPad |

**Delivered (upload to the 6.7" slot):** `01-sign-in`, `02-home`,
`03-library`, `04-now-playing` (a track actually playing), `05-artist` — all
1284 × 2778, captured from the simulator against the review server.

---

## What I can and can't do here

- ✅ I built the review server, the demo account, the royalty-free library, and
  the sign-in flow, and I wrote all the copy above.
- ✅ I can generate the screenshot image files at exact App Store resolutions
  from the iOS Simulator.
- ❌ I **cannot sign in to your Apple / App Store Connect account** or click
  Upload / Submit for you — that's your account and requires your Apple ID.
- ⚙️ **If you want me to actually upload the screenshots + push this metadata
  automatically**, create an **App Store Connect API key** (Users and Access →
  Integrations → App Store Connect API → generate a key with App Manager role;
  download the `.p8`, note the Key ID and Issuer ID). With those I can push
  everything via `fastlane deliver` / the ASC API — no browser login needed.
```
