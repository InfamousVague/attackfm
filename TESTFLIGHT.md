# AttackFM — App Store / TestFlight submission guide

Everything on the *code* side is done (see “What I set up” at the bottom). The
steps below are the ones only you can do, because they need your Apple ID logged
into Apple’s systems — I can’t and won’t enter your credentials.

- **Bundle ID:** `com.mattssoftware.attackfm`
- **Team ID:** `F6ZAL7ANAD`
- **Version / build:** `0.1.0` (bump in `src-tauri/tauri.conf.json` for future uploads)
- **Archive to upload:** `src-tauri/gen/apple/build/app_iOS.xcarchive`

---

## 0. Prerequisites (one-time)

- You need the **Apple Developer Program** membership ($99/yr) on the account
  that owns team `F6ZAL7ANAD`. (Signing already points at it, so this almost
  certainly exists.)
- Sign in to **https://appstoreconnect.apple.com** with that Apple ID.

## 1. Register the App ID (usually already done)

Automatic signing typically registers `com.mattssoftware.attackfm` for you. If
step 2 doesn’t offer the bundle ID in the dropdown:

1. https://developer.apple.com/account → **Certificates, Identifiers & Profiles**
   → **Identifiers** → **+**.
2. **App IDs → App**, Description “AttackFM”, Bundle ID **Explicit** =
   `com.mattssoftware.attackfm`.
3. Capabilities: leave defaults. (Background Modes needs no capability toggle
   here; CarPlay Audio is gated separately and is fine to skip for now.)

## 2. Create the app record in App Store Connect

1. App Store Connect → **Apps** → **+** → **New App**.
2. Platform **iOS**; Name **AttackFM**; Primary language; Bundle ID
   `com.mattssoftware.attackfm`; SKU = any unique string (e.g. `attackfm-ios`);
   User Access **Full**.
3. Create. (You do **not** need to fill in the full App Store listing to run
   TestFlight — that’s only for public App Store release.)

## 3. Upload the build (easiest path — Xcode Organizer)

The fresh archive is already built at
`src-tauri/gen/apple/build/app_iOS.xcarchive`.

1. Open **Xcode → Window → Organizer** (Archives tab).
2. If the archive isn’t listed, double-click the `.xcarchive` file in Finder to
   open it in Organizer.
3. Select it → **Distribute App** → **App Store Connect** → **Upload** →
   **Automatically manage signing** → **Upload**.
4. Xcode signs it with an App Store distribution profile (minting one under your
   account if needed) and uploads. Done.

**Alternative (Transporter / CLI):** export an `.ipa` with the file I added:
```bash
xcodebuild -exportArchive \
  -archivePath src-tauri/gen/apple/build/app_iOS.xcarchive \
  -exportPath  src-tauri/gen/apple/build/appstore \
  -exportOptionsPlist src-tauri/ExportOptions-AppStore.plist
```
then drag the `.ipa` into the **Transporter** app (free, Mac App Store) and sign
in with your Apple ID to deliver it.

## 4. Wait for processing

The build shows up under **App Store Connect → your app → TestFlight** after
~5–30 min of processing. Export compliance is already answered (I set
`ITSAppUsesNonExemptEncryption = false`), so there’s no “missing compliance”
prompt.

## 5. Add friends to TestFlight

Two kinds of testers — pick based on how many friends and whether you want to
wait for review:

### A. Internal testers — instant, **no review** (best for a handful of friends)
- Up to **100** people, but each must be a **user on your App Store Connect team**.
- App Store Connect → **Users and Access** → **+** → invite each friend’s Apple
  ID with the **Developer** (or **Marketing / Customer Support**) role — low
  privilege, enough for TestFlight.
- Then **TestFlight → Internal Testing → (a group, or “App Store Connect Users”)**
  → add them → check the new build.
- They get the invite in the **TestFlight** app immediately.

### B. External testers — for friends you don’t want on your team
- Up to **10,000**, invited by **email** or a **public link** — no team access
  needed.
- Requires a one-time, per-version **Beta App Review** (usually < 24h).
- TestFlight → **External Testing** → create a group → add the build → fill
  **Test Information** (feedback email, “what to test”, a demo account if the app
  needs a login) → **Submit for Review**.
- After approval: add testers by email, or enable **Public Link** and share it.

> Fastest for a few friends: **A (internal)**. No review, builds go out the
> moment you upload.

---

## ⚠️ One honest heads-up before you invite people

The **Music import** feature downloads tracks from Spotify/Deezer/etc. via
SpotiFLAC. Apple’s reviewers routinely **reject** apps that let users download
copyrighted music from streaming services — this applies to **External** TestFlight
(Beta App Review) and to any future App Store release.

- **Internal** testing (path A) is **not** reviewed, so you can share with a few
  friends today regardless.
- For **External** testing or App Store, expect this to be flagged. Options if it
  is: gate/remove the downloader for the reviewed build, position it as a
  personal media player for a user’s own server/library, or keep distribution to
  internal testers only.

I’d rather you know now than get a rejection out of the blue.

---

## What I set up on the code side (already done)

- `Info.ios.plist`: added **`ITSAppUsesNonExemptEncryption = false`** (kills the
  per-build export-compliance prompt) and **`LSApplicationCategoryType =
  public.app-category.music`**.
- Confirmed the app is submission-shaped: background-audio mode + AVAudioSession,
  scene lifecycle (iOS 27-safe), portrait lock, local-network usage string, a
  full **AppIcon set including the 1024px marketing icon**, launch storyboard,
  automatic signing on team `F6ZAL7ANAD`.
- Added **`src-tauri/ExportOptions-AppStore.plist`** for the CLI/Transporter path.
- Built a fresh **App Store archive** carrying all of the above.

### Uploading future builds
Bump the version in `src-tauri/tauri.conf.json` (and/or the build number), run
`npm run ios:build`, then repeat step 3. App Store Connect requires each upload’s
build number to be **higher** than the last for the same version.
