# Changelog

What each published version changed, in the words a listener would use.

`npm run ship` reads the section matching the version it is publishing and
sends those lines to every device, where they appear in the update banner
before the restart and again as "what changed" after it. Keep the lines short:
they are read on a phone, in a strip, one thumb away from a song.

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
