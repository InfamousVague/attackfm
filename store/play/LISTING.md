# Google Play listing — AttackFM

Everything the console asks for, drafted from the app as it actually is.
Anything marked **CONFIRM** is a judgement only Matt can make.

---

## Store listing

**App name** (30 max)
```
AttackFM
```

**Short description** (80 max — this is the line people actually read)
```
Your own music, streamed lossless from your own server. No ads, no rentals.
```
*(75 characters)*

**Full description** (4000 max)
```
AttackFM plays your music library from a server you own.

Point the app at your own AttackFM server — a spare Mac, a home box, a VPS —
and your whole collection is on your phone, streamed at full quality. No
subscription, no catalogue that changes under you, no songs quietly
disappearing because a licence lapsed.

WHAT IT DOES

• Lossless streaming from your own machine. FLAC and ALAC stay lossless; the
  server transcodes on the fly when the connection cannot carry it.
• Offline downloads. Keep what you want on the device; the cache manages its
  own space and never evicts anything you have pinned.
• One account, every device. Start a song on the phone, pick it up on the
  desktop — playback, queue and position follow you, and any device can drive
  any other.
• Real gapless playback, crossfade, and an equaliser.
• Synced lyrics, tap a line to seek to it.
• Playlists that live on your server, not on this phone.
• Listen together. Start a jam and friends hear what you hear, in step.
• A library that organises itself: albums, artists, genres, and mixes built
  from what you actually play.
• Android Auto support for the car.

WHAT IT IS NOT

There is no store, no catalogue and nothing to buy. AttackFM plays music you
already have. You need your own AttackFM server — it is free and open, and the
app will walk you through connecting to one.

YOUR DATA STAYS YOURS

Your library, your play history and your playlists live on your server. There
is no advertising, no tracking, and nothing is sold to anyone.
```

**CONFIRM** — the "open" claim in "free and open": only accurate if the server
is genuinely published under an open licence. Cut the word if not.

**Category:** Music & Audio
**Tags:** music player, streaming, offline
**Contact email:** CONFIRM (Play publishes this on the listing)
**Website:** https://attack.fm
**Privacy policy:** https://attack.fm/privacy/  ← already live, verified

---

## Graphics (in this folder, ready to upload)

| Asset | Requirement | File |
|---|---|---|
| App icon | 512×512 PNG, 32-bit | `icon-512.png` |
| Feature graphic | 1024×500 PNG | `feature-graphic-1024x500.png` |
| Phone screenshots | 2–8, min 320px | `screenshots/01-library.png` … `04-profile.png` (1080×2400) |

Tablet screenshots are optional. Skip unless you want the tablet badge.

---

## App access (required — the app needs a login)

Play review cannot see past the sign-in screen without credentials, exactly as
Apple could not. Give them the review server:

- **All functionality is available with the credentials below**
- Server: `https://matt.attack.fm:8443`
- Sign-in: choose **"Log in with a code"** and enter `APPLEREVIEW2026`
- The code is a standing one — it never expires and can be reused.

Instructions to paste into the console:
```
Open the app, tap "Log in with a code", enter the server address
https://matt.attack.fm:8443 and the code APPLEREVIEW2026. This signs in to a
demo account with a small royalty-free library so every screen can be reached.
```

---

## Data safety form

Derived from the manifest and what the client actually sends.

**Does your app collect or share any required user data?** Yes.

| Data type | Collected | Shared | Purpose | Required? |
|---|---|---|---|---|
| Name / username (account handle) | Yes | No | Account management | Required |
| Other user-generated content (playlists, favourites) | Yes | No | App functionality | Required |
| App interactions (play history) | Yes | No | App functionality, personalisation | Optional |

**Security practices:**
- Data is encrypted in transit — every server connection is HTTPS. **Yes**
- Users can request data deletion — **CONFIRM.** Play wants a deletion route.
  Because the data sits on the user's own server, "delete your account on your
  server" is the honest answer, and there is a Settings path for it. Confirm
  the in-app path exists before ticking this.
- Data is NOT shared with third parties. **Yes**
- No advertising or analytics SDKs. **Yes**

**The nuance worth writing into the form:** AttackFM sends this data to a
server the user chooses and controls, not to us. Play has no checkbox for that,
so say it in the description field.

---

## Permissions to justify

From `AndroidManifest.xml`:

| Permission | Why |
|---|---|
| `INTERNET` | Streaming from the user's server |
| `WAKE_LOCK` | Keeps playback alive with the screen off |
| `POST_NOTIFICATIONS` | The playback notification and its transport controls |
| `FOREGROUND_SERVICE` | Background playback |
| `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | The declared FGS type for playback |
| `FOREGROUND_SERVICE_DATA_SYNC` | Library sync and offline downloads |

`MEDIA_PLAYBACK` is the standard type for a music player and needs no special
declaration form. **DATA_SYNC** is the one Play scrutinises — justify it as
"downloading the user's own music for offline playback and syncing the library
index", which is what it does.

---

## Content rating questionnaire

Category: **Music & Audio**. Expected answers — all "No": violence, sexual
content, profanity, drugs, gambling, user-to-user communication is limited to
listening-together with people you already added as friends.

**CONFIRM** — jams and friends are arguably "users can interact". Answer yes to
"Does the app allow users to interact or exchange content?" if you want to be
conservative; it raises the rating slightly but avoids a later correction.
