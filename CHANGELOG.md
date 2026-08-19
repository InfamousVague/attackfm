# Changelog

What each published version changed, in the words a listener would use.

`npm run ship` reads the section matching the version it is publishing and
sends those lines to every device, where they appear in the update banner
before the restart and again as "what changed" after it. Keep the lines short:
they are read on a phone, in a strip, one thumb away from a song.

This history was reset on 2026-08-18 and starts again from the next release.
The whole file ships inside the app (`settings/WhatsNew.tsx` imports it with
`?raw` and stands every section up as a timeline in About), so a line written
here is not a note to ourselves - it is product copy on every device, kept for
good. Write it as something a listener should read, and leave out anything
about how music gets onto the disk in the first place: the app plays a library,
and where that library came from is not the app's story to tell.

## 0.3.180

- Your settings follow your account now. Sign in on a new phone, or open the player in a browser, and the app arrives looking the way you left it: the theme and accent, the plugins you run, your equaliser and pedalboard, and the servers you belong to
- Opening the player at attack.fm no longer asks which server you want; it arrives pointed at the library it was opened from, and you can still change it
- The artwork behind genres and moods loads again

## 0.3.179

- An invite can now make your account for you. Opening an invite with no AttackFM account used to show a Join button that did nothing at all; it now offers to create the account (or sign in) right there and carries straight on into the server
- The shared artwork behind genres, moods and the curator is served from attack.fm itself. It was pointed at a hub that no longer had it, so those images were missing for everyone, and it also meant listening on a friend's server quietly fetched pictures from someone else's house
- Songs can be played slower or faster: Slowed, Slowed + reverb, Sped up, Nightcore, Half speed, and one that speeds up without raising the pitch. The seek bar and the time remaining follow the new length instead of the original one
- A filter your server is too old to play says so, instead of applying and changing nothing

## 0.3.178

- Volume levelling. Your server measures how loud each song actually is, and playback evens the library out — a 1979 vinyl rip and a 2019 remaster now arrive at the same level, so you stop riding the volume knob across your own collection
- Choose per-album levelling (records keep their quiet tracks quiet) or per-song (best for shuffling), in Settings → Playback. A song is never boosted to the point where it would distort
- The measuring runs quietly in the background; songs it hasn't reached yet simply play as they always did

## 0.3.177

- Now Playing on a second device keeps up with the song again. If that device's clock was off by even a few seconds, the position bar sat frozen where the track started; it now reads time from your server's clock instead of its own
- The skip and transport buttons work the moment you pick the phone up. They used to do nothing until the connection happened to come back on its own — now waking the screen reconnects immediately, and a tap made in that gap is delivered rather than dropped

## 0.3.176

- Picking up your phone while the desktop is playing no longer stops the music. A device whose connection dropped now stays a remote showing what's actually playing, instead of quietly becoming its own paused player and stealing playback when you pressed play

## 0.3.175

- A pedal your server is too old to play now says so, rather than looking exactly like one that works. Effects are rendered by your server, and it ignores any it does not recognise, so those pedals went into the chain, changed nothing, and sounded like a weak effect instead of a missing one. The shelf marks them, and a pedal already on your board tells you it is passing through silently
