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

## 0.3.219

- The four cards at the top of your library have their objects: a heart-shaped valve for Liked, a jukebox's record stack for All songs, chrome arrows for On repeat, and a mirrored helmet for the DJ
- Discover says its own name at the top, with a compass beside it, where the ATTACK wordmark used to sit — and the page below no longer repeats the heading

## 0.3.218

- On a phone, the now-playing bar and the tab bar below it now share a corner. The player's was tighter than the nav's, which read as two cards that had not been drawn together

## 0.3.217

- Liked, All songs, On repeat and DJ wear real hi-fi photography now — a lacquer highlight, a machined edge, a lit VU meter, a glowing valve. One picture made for each tile, instead of a texture drawn at random from a shared set

## 0.3.216

- Recent and New Playlist go back to their plain marks. They were given torn-paper faces last version and read better as the quiet outlines they were — they are buttons, and the artwork beside them belongs to the things you open
- Recent opens as a full page now, like Liked and All songs, instead of a sheet over the library. Same frame, same Play and Shuffle, and nothing to reorder — it is a window on what arrived lately, not a list you arrange

## 0.3.215

- Recent and New Playlist have proper faces now — a torn clock and a torn paper cross, in the same hand as the Liked and All songs artwork — instead of the thin outline marks they were wearing beside them

## 0.3.214

- A mix wears the actual albums inside it. Four songs off one record used to draw that one sleeve four times over, because the covers were being compared by a web address that carries the song's id — so the same picture never matched itself. Every mosaic in the app was doing it: playlists, search, the artist page, the Booth's mixes
- And a mix made of one, two or three records now shows those, instead of falling back to a texture while holding the very covers it was made of
- Liked, All songs, On repeat and DJ have their backing again. They had been left on the page's own black, which meant they stopped reading as tiles at all and the four objects appeared to float in the margin
- The DJ tile's name sits left, with its neighbours', instead of centred

## 0.3.213

- A mix wears its music again. The home shelves show the album art of the songs inside — the four-cover mosaic, the same face a playlist wears — instead of a stand-in. The brutalist textures stay as the fallback for a mix too small to fill the square

## 0.3.212

- The notifications panel reads properly over the new home artwork. It was letting the shelves behind it show through, so "Liked" and "All songs" sat in among the notifications like rows of the list

## 0.3.211

- The home shelves trade their coloured gradient cards for bold brutalist textures — torn paper, halftone and grain in the app's pink and white, a different one per mix so a shelf still reads as varied. The Liked / All songs / On repeat chips lose their gradient too, and the DJ gets a new hand-inked face. Same ATTACK mark and type throughout

## 0.3.210

- A bell at the top of every page, holding what happened while you were somewhere else: music that finished downloading, and downloads that did not. It waits until you read it, and it is still there tomorrow
- A download finishing no longer throws a pill over whatever you were doing. Starting one says so briefly at the top of the screen instead — that is the half worth interrupting you for, because it is the half you just asked for
- The floating "3 downloading" pill has gone. What it was telling you now sits inside the bell, above the list, while work is in flight
- Notices appear at the top of the screen now rather than over the transport and the navigation, which is where they had been landing

## 0.3.209

- A bolder look on the way in. The sign-in screen drops the frosted wall of blurred covers for artwork that sits flush on the black, and the DJ gets a new face to match. Same ATTACK mark, same type — just a harder-edged backdrop behind them

## 0.3.208

- Fixes the Filters and Stems lists losing their styling. The app could end up running one version's code against an older version's stylesheet, and the screens built most recently were the ones with no rules behind them — bare bulleted lists, buttons at their default grey. It now notices the mismatch and puts the right stylesheet back, from the device if it is there and from the update server if it is not
- "Only download on Wi-Fi" now covers the video clips too. Sitting on Now Playing over mobile data was pulling down a clip for every song that came on, and the deck on Date was fetching them for cards you had not reached yet. On mobile data the blurred cover stands in, exactly as it does for a song with no clip

## 0.3.207

- "Only download on Wi-Fi" now also covers the Stems tab. Opening it measures each part of the song so the rows can move to their own music, and that measuring is a real download — on mobile data, with the switch on, it now waits

## 0.3.206

- Automatic downloads wait for Wi-Fi now, and that is on by default. The app had been filling the phone's cache over mobile data without asking. Playing a song, keeping one on this device and "Check now" are never held back — those are you asking, and they still work anywhere
- Settings has a Privacy section: online lookups, listening history, what you are playing and what friends see, gathered in one place and ordered by how far each one travels
- The app had been sending the song, the artist and how far in to your account every twenty seconds, while the screen said nothing was written anywhere. It is off until something actually offers to pick a song up where you left it
- The More menu's entries rise into place again instead of arriving all at once

## 0.3.205

- Each part in the Stems tab now moves to its own music: the drums pulse on the beat while a held string line sits calm beside them, instead of every row twitching to the same mix
- A part switched out holds still, and each row's line shows that part's own shape across the song

## 0.3.204

- Karaoke has gone. Turn Vocals off in the sound console's Stems tab and open the lyrics popover instead — the words follow the song exactly now, because it is the same player rather than a second one running its own copy
- The Stems tab could sit on "looking for this song's parts" and never finish. It finds them
- The HiFi chain has no on/off switch any more. A chain is on when a box in it is on, and "All out" puts them all down at once — no more rack full of lit pedals with the whole room greyed out from a switch at the top
- The Pads board has gone. Taking a part out of the song you are listening to lives in the sound console, where the seek bar and the transport are the song's own
- On a computer, the navigation moved from a rail up the left edge to a bar along the bottom, tucked to the left. The page runs full width behind it

## 0.3.203

- Scratching a song you have slowed down or sped up lands where you let go. The platter was reading the song at its original speed, so letting go dropped you somewhere else in the track — half a minute out at 1.25x, further the deeper in you were

## 0.3.202

- Taking a part out, or moving an effect, picks up where you are — it used to rebuild the song from the beginning first, and the wait grew the deeper into a track you were
- The seek bar works on a song with effects or parts taken out: drag it anywhere, forward or back, and it goes there
- A song kept on this device no longer forgets the parts you took out of it

## 0.3.201

- On a desktop, Now Playing is simply there: the record, the artwork and the transport keep the right half of the window while the library carries on in the left, the way it already worked on an unfolded foldable. Before this the desktop had no Now Playing at all, only the strip along the bottom
- The desktop's navigation lies along the bottom now instead of running up the side, where your hand already is on every other screen

## 0.3.200

- The Pads board is built into the app now, not a plugin you install
- Closing the board hands the song back where it had got to, instead of leaving it paused

## 0.3.199

- Karaoke is built in, and now actually starts the separation instead of waiting forever for one nobody asked for
- "Take it apart" in the Stems tab works — it had been asking the wrong address and reporting "not found"

## 0.3.198

- Stems moved into the sound console, beside the EQ: take the vocal or the drums out of what you are listening to without leaving the song
- The player keeps playing and keeps its place — no separate screen, no second set of controls
- Parts go back the moment you put them back, and they reset when the song changes
- Taking a song apart says how far along it is, and how many songs are ahead of it in the queue
- Long separations are no longer cut off partway through and reported as failures

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
