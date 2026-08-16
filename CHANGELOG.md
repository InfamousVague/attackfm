# Changelog

What each published version changed, in the words a listener would use.

`npm run ship` reads the section matching the version it is publishing and
sends those lines to every device, where they appear in the update banner
before the restart and again as "what changed" after it. Keep the lines short:
they are read on a phone, in a strip, one thumb away from a song.

## 0.3.89

- The Booth: the DJ, your mixes, and what the curator is up to — one room, with its own preferences, in the nav where Search used to be
- Search is a pull now: drag down on any page (or ⌘K) and it drops in; close it and you're right where you were
- Profile is about you: This week and Dates live there as rooms, not buried in the ⋯ menu
- A little light in the header says whether your server is close, far, or unreachable — tap it for the story and the controls
- Settings has a search field, remembers the panes you use, and is two panes lighter

## 0.3.88

- Android: play, pause and skip work from outside the app now — lock screen, a paired computer's media panel, a car — even resuming while the app sleeps in the background
- Android: pausing no longer makes the controls vanish everywhere; they stay until you swipe them away
- Android Auto: AttackFM shows up with Liked, All songs and Shuffle all, and the dashboard buttons drive the deck (new app install needed for this one)

## 0.3.87

- An album page now shows the whole record: the songs you have, and the ones you don't, dimmed with a + to pull them
- Missing-song numbers are the sleeve's own now, not a count of what survived

## 0.3.86

- Tapping an album now opens it: the whole record, in running order, with its discs and its guests
- Artist pages were missing songs and whole albums — anything with a guest credit did not count. Fixed, so the counts are right too
- Search no longer splits one record into two when a guest sings on it

## 0.3.85

- Two new notifications: songs the collector found waiting for a date, and a weekly recap of what you played
- "While you were away" now names who most of the new music was by
- A Notifications pane in settings, with a switch for each kind

## 0.3.84

- Paused, the player bar can be swiped down out of the way; it comes back on its own with the next song

## 0.3.83

- Dragging up or down on a row of albums scrolls the page again, instead of doing nothing

## 0.3.82

- The app now notices a new version within a couple of minutes while you are using it, instead of only when you come back to it

## 0.3.81

- Shelves finally do both: swipe one sideways from anywhere on it, or pull down from the same spot to scroll the page

## 0.3.80

- Shelves swipe sideways reliably again — scroll the page from the gaps between them

## 0.3.79

- An artist page now shows the songs missing from albums you own part of — dimmed, with a plus to add each one, or Add all to finish the record

## 0.3.78

- A download that fails from a network hiccup is retried twice on its own before it ever shows red
- Download lanes start staggered, so a fresh check no longer drops its first connections

## 0.3.77

- "Wrong song" now says plainly when your server is too old for it, instead of failing with a number

## 0.3.76

- Failed downloads can be retried in one tap, and the error note can be dismissed

## 0.3.75

- Downloads run six at a time while nothing is playing, and step back to two under a song so the music never stutters for the cache

## 0.3.74

- Downloads keep going when you switch apps: the check now holds the phone awake the way playback does, with its own "Downloading your music" notification

## 0.3.73

- Download failures now say their real reason — the layer that was eating the server's answer is gone
- A download that stops answering is given up on and the sweep moves to the next song, instead of wedging the whole pass

## 0.3.72

- The Overview shows the last check's whole plan as a wall of covers — green landed, red refused, pulsing while it downloads — so what should be on the phone is visible, song by song
- A check interrupted by locking the phone resumes on return instead of waiting six hours
- Freshly downloaded songs no longer show as "no longer in the library" in Files

## 0.3.71

- When downloads fail, the Overview now says which server refused and what it said, instead of only counting the failures

## 0.3.70

- Downloads & space is redesigned: an Overview with one picture of the space and the last check's receipt, and a Files browser of everything on the device — by artist and album, or biggest first — with delete on every row
- Deleting an automatic download now sticks: the cache stops bringing that song back
- The AI page is gone from the More menu — the Curator pane in Settings carries the same information

## 0.3.69

- Offline and Storage are one pane now — Downloads & space — since they were two halves of the same question

## 0.3.68

- Scrolling now carries the cover up too: a playlist's album, an artist's portrait, or the collection's own mark, beside its name in the top bar

## 0.3.67

- Play and Shuffle now fade into the top bar in step with the name, instead of snapping in
- Artist pages do it too: scroll past the artist and their name, Play and Shuffle move up

## 0.3.66

- The changelog no longer parks itself on the home screen after an update — it is said once and then gone

## 0.3.65

- The library's week now leads with how long you listened, three numbers under it, and a View all stats button

## 0.3.64

- Settings → Offline now says what the last check actually did, so "nothing kept" can tell you why

## 0.3.63

- Settings → Servers is split into This server / Network / Access, so it is one chunk at a time instead of one long page
- The server's name and address fit on a line each again instead of breaking mid-word

## 0.3.62

- Servers are one place now: Settings → Servers holds the box you are on, how near each one is, and the servers saved to your account
- Fixed: the old Servers page could not scroll, so a long list had no way down

## 0.3.61

- Now Playing wears the app's own colour again — the heart and the other lit controls had turned blue

## 0.3.60

- Fixed: opening or leaving a playlist could take the whole app down

## 0.3.59

- Playlists scroll like the song collections do: the cover travels with the songs, and the playlist's name and its Play and Shuffle move up into the top bar

## 0.3.58

- Songs scrolling up a collection dissolve into the top bar again instead of cutting off at a hard edge

## 0.3.57

- Scrolling a song list now fades its name into the top bar in place of the logo, and the little strip that used to repeat it underneath is gone

## 0.3.56

- Play and Shuffle move up into the top bar when you scroll a song list, instead of crowding the strip below it

## 0.3.55

- The "what changed" note after an update is a one-line banner again — tap +N to read the rest

## 0.3.54

- Light mode: the Liked, All songs and On repeat tiles no longer wear their dark-mode colours
- Light mode: the bar's unselected icons use ink picked for a light bar instead of the dark one's grey

## 0.3.53

- Friends has its own place in the ⋮ menu, so you can go straight there instead of through Profile
- The frosted top bar is gone again — the header is back to plain

## 0.3.52

- The top bar is frosted glass now, the same material as the bar along the bottom

## 0.3.51

- Loading placeholders all shimmer the same way now: covers still arriving no longer sweep out of step with the cards holding their place
- With reduced motion on, a still-loading cover gently pulses instead of sitting frozen

## 0.3.50

- Coming back to the app now checks for an update straight away, instead of only once an hour

## 0.3.49

- Music keeps playing on Android when you switch to maps or another app
- A spoken direction from navigation no longer stops the music for good — it ducks and comes back
- The bottom bar is a touch smaller, giving the page back a little room
- Android only: needs the new app from your installer, not just this update

## 0.3.48

- New updates arrive as a proper panel now, with the whole changelog instead of one line behind a chevron
- Every change carries an icon for what it is: a fix, something new, your phone, the way things look
- The panel shows the version you're leaving and the one you're getting, and asks once — say Later and the small strip keeps the offer

## 0.3.47

- Playlist tiles and album covers now flex a little with the screen: rows pack edge to edge instead of leaving white gaps
- Phones fit one more cover per row; unfolded and wide screens get slightly larger art instead of empty space

## 0.3.46

- Installing a newer app now wins over an older downloaded update that used to quietly keep running instead

## 0.3.45

- Updates now come straight from attack.fm — the same place you sign in — whichever server your music lives on
- Checking works even before you've joined a server
- About says exactly where updates come from

## 0.3.44

- A live test of the new update pipe — if you're reading this on your phone, it worked
- Nothing else changed; enjoy the fireworks

## 0.3.43

- Android: the back swipe goes back inside the app — closes the sheet, steps to the last page — instead of quitting; at the very start it just tucks the app away, music still playing
- Updates actually arrive now: the download itself was failing silently on every device, since the first one
- Settings → About has a Check for updates button, and says what happened either way
- About shows the version you're really running, and it moves when an update lands
- The app also looks for updates when you come back to it, not just on a slow clock

## 0.3.42

- Liked, All songs and On repeat: the header scrolls away into a small sticky bar with the title, Play and Shuffle
- Fixed: the update banner no longer squeezes the app into a sliver when it appears
- Light mode looks right everywhere: Now Playing keeps its dark, art-first look while the rest of the app goes light
- The fade at the top of scrolling lists matches the theme instead of always being black
- The little loading ring on song add buttons is visible on light now
- Unfolded: the nav bar's glow no longer cuts off at the edge of the Now Playing card
- Android: the white strip under the app is gone

## 0.3.40

- Stream from whichever of your servers answers fastest and has the song
- New Servers page: how near each server is, how much of your library it holds, how full its disk is
- Free up space on any server you host — pick songs, see which are your only copy
- The phone now keeps your liked and most-played songs on it automatically, up to 15 GB, rotating as taste moves
- Dates: clips loop, the next twenty wait on the phone, and "Wrong song?" swaps in the right recording
- Profile is about you now — your week as stat tiles, a listening-shape radar, when you listen, and what you played
- Friends moved to their own page, with cards showing each friend's most-played artist
- Removing a friend works again
- Scrolling down no longer dies when your thumb is over a shelf
- Stats page rebuilt, and friends carry a stats card
- Everything that loads now shows a placeholder instead of a blank or a wrong "nothing here"
- Android: the app runs, with its own nav card, icon, and Now Playing beside the library on a wide screen
- The app can now update itself from your hub — no cable, no store

## 0.3.39

- The first version published over the air
