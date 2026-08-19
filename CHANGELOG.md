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

## 0.3.197

- Stems: a button on the now playing screen takes the song apart where it stands — drop the vocal, drop the drums, put them back
- Tap a part to drop it, hold it to drop it just while you hold; close and the song carries on exactly where the stems got to
- The Pads board plays whole songs now instead of one loop, and fits on one screen with nothing to scroll
- Songs split into six parts, so guitar and keys are their own controls instead of being buried in "everything else"
- Taking a song apart shows how far along it is, and the parts light up as they land

## 0.3.196

- Karaoke shows up on desktop — plugins that act on the playing song had no home there at all

## 0.3.195

- One settings cog on desktop, not two — the rail's has gone, the title bar's stays

## 0.3.194

- About lines up again when your server has a long name, and reports the server's real version

## 0.3.193

- The lyrics view and the queue sheet are glass too — the cover shows through them instead of being covered up

## 0.3.192

- The console's search row loses its backing too — nothing in the popover sits on a second pane now

## 0.3.191

- More room inside the sound console, and the same margin on every side

## 0.3.190

- Fixes the sound console losing its styling — the app now notices when its stylesheet did not load at startup and puts it back

## 0.3.189

- The Filters tab no longer shows its dot when no filter is on
- The sound console's room switcher is a plain header now — no dark bar behind it, and no gap at its edge

## 0.3.188

- The sound console is glass again — the artwork reads through the panels instead of sitting behind black cards
- Its pinned headers run the full width of the popover, and the counts on the tabs are proper badges

## 0.3.187

- The sound console is the whole editor now: build a HiFi chain right in the popover — add boxes from a searchable shelf, reorder them, bypass one to hear what it was doing
- Filters take the console's third tab: slowed, sped up, nightcore, lofi, vinyl, cathedral and thirty more, one tap each
- Pedals stays a plugin with its own page — fifty-five stompboxes is a board you go somewhere to build
- The HiFi Lab and Filters plugins retire into the player; they uninstall themselves on next launch
- A/B and saved chains moved below the tabs, where it is plain they act on the whole signal path

## 0.3.186

- The DJ's station cards get their background back — they were see-through

## 0.3.185

- One door for sound. The equaliser and pedals popovers are now a single console with EQ, HiFi and Pedals tabs — and the HiFi tab finally has real controls, every knob of every box in your chain rather than just an on switch. It opens where you left it
- HiFi Lab comes installed now, so the HiFi tab is somewhere to go rather than an advert for a page you don't have
- Panels that should have had a background were rendering see-through on the Pads and Looper pages

## 0.3.184

- The DJ suggests stations now. Unlike a mix, a station never ends — it keeps going in the lane you picked. They're on the Booth page, named from what you actually listen to, and tapping one just asks the DJ for it

## 0.3.183

- Karaoke is a microphone on the Now Playing screen now, rather than a page you go and find. Press it while a song is playing and the singer comes out of that song, with the words full screen and nothing else on it
- The lyrics button wears a book, since the microphone now means singing

## 0.3.182

- Pick up where you left off. Stop on one device and the next one you open knows what you were in the middle of, and how far in you were

## 0.3.181

- You can be on several servers at once. Join a friend's library and it stays with you: their songs turn up in your searches and shelves alongside your own, and play without switching anywhere first
- The rest of your settings follow your account too now, including how playback behaves, your effects, loudness, haptics and the choice about sharing what you listen to

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
