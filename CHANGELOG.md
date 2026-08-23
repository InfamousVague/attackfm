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

## 0.3.348

- Audiobooks can be dropped in as-is. Make an `import` folder inside your server's Audiobooks folder and drop each downloaded book into it — one giant file, forty numbered parts, disc folders, text files and all. The Books page shows what is waiting; one tap and the server works out what each pile is (with its local AI reading the notes when one is set up), names it, orders the chapters, carries the cover, and shelves it properly. Nothing is deleted — consumed folders are kept in the library's trash

## 0.3.347

- When a book cannot be transcribed because the server has no speech model, the app now names the exact folder to put one in rather than leaving you to find it

## 0.3.346

- Scrolling the Books page hands its name and the Add-a-book button up to the app header, the way playlists already do

## 0.3.345

- Audiobooks that arrive as folders of MP3s now work properly: discs are one book rather than several, chapters play in the right order even with no track numbers, and a cover sitting in the folder is used
- The heart moved onto the book's cover, and the Books header is one line instead of four

## 0.3.344

- "Read along" now tells you what is actually wrong instead of saying "Not available" for everything — whether your server needs updating, needs the recogniser installed, or just needs its speech model

## 0.3.343

- An empty Books page now points at Free books, the LibriVox catalogue that already comes with the app — thousands of public-domain readings, free and legal to keep. It used to tell you to go and install something you already had

## 0.3.342

- Books you love get their own shelf: heart a book and it moves to Favourites at the top of the page, so the one you are actually reading is not buried among everything you own

## 0.3.341

- Books can be read along with. Ask your hub to transcribe one and its words appear where a song's lyrics do — lighting up line by line as the narrator reaches them, over the cover and in the lyrics panel

## 0.3.340

- Books now tell you where you are and where everything else is: tap the chapter line while a book plays to get the whole chapter list, jump to any of them, and see how much of the book is left

## 0.3.339

- The Audible and LibriVox downloaders install themselves again, the way they did before audiobooks were taken out — you no longer have to go and find them

## 0.3.338

- Books has an "Add a book" button: pick an audiobook off your phone or computer and it goes straight onto the shelf, chapters and all

## 0.3.337

- Audiobooks are back. Your books have their own shelf again, played with chapters and your place kept across devices — and they stay off every music surface, so a twelve-hour reading never turns up in a mix or a shuffle
- The Audible downloader returns with them: connect your account on the hub (Amazon does the sign-in, we never see a password) and pull down the books you own
- An audiobook you upload yourself now lands on the book shelf instead of loose among the songs, with its chapters read

## 0.3.336

- The DJ card lines up with the three beside it: its label sits where theirs do, and its infinity is a figure rather than the loudest thing on the row. The card had been stuck at the height of a card with no number in it

## 0.3.335

- Fixed tapping a playlist on the car screen doing nothing when the app was closed. The car draws its list from the app's own cache, so it can offer your playlists while the app isn't running — and every tap on that list was being thrown away. It is now held and played the moment the app is up
- The car's now-playing card can open the app again — the button had nothing behind it
- Closing the app no longer risks taking the car's controls down with it

## 0.3.334

- The app's news now reaches your phone's notification tray, not just the bell inside the app — downloads landing, stems finishing, and the rest arrive while you're doing something else, and are skipped while you're already looking at the app
- Settings → Notifications has the switch for it, and a "send a test one" button so you can see it work before you rely on it
- Needs the new app itself, not just an update: the tray is a native part of the app. An older install will say so when you press Test

## 0.3.333

- The DJ card's infinity now sits under its label where every other card's number does, instead of floating half-size in the middle with a gap above it

## 0.3.332

- Hold your Liked card to choose whether Liked songs are separated ahead of time — the one collection whose switch lived only in settings now answers from where the songs are
- Fixed the background-work switches flicking straight back off after you turned them on. The change was saved every time; the switch was showing you a copy of the answer that was up to twenty seconds old

## 0.3.331

- Hold a playlist to get its menu. Pressing and holding a playlist on Home now opens its actions — rename, cover, and whether to separate it ahead of time — and lifting your finger no longer drops you into the playlist instead
- The same "separate these ahead" switch now sits in a playlist's own ⋯ menu, so it is in both places you would look for it

## 0.3.330

- "Clear the rest" now counts before it asks — it names how many songs and how many gigabytes before you confirm, and says plainly whether your Liked songs are being spared or cleared along with them

## 0.3.329

- You can start a jam from Now Playing, and walk into a friend's from there too. Starting one was only ever possible from your profile — the page you leave in order to listen to something

## 0.3.328

- A jam now shows on Now Playing — who is in it, the code to invite someone, and the way out — instead of being visible only on your profile, which is the page you are not on while a jam is happening
- Jams wear a group of people as their mark, on the badge and on the cards, so a room that has no cover art of its own still looks like a room

## 0.3.327

- Your settings follow your account further: the card style, shake-to-skip, Now Playing's video clips, "keep my place across devices", developer mode, notification detail, your plugin sources and your place in the handbook now arrive on a new device with everything else. Crossfade and the rest of Playback already did
- Separating songs ahead of time is something you ask for now, list by list. Turn it on for a playlist from its ⋮ menu, or for Liked under Servers — instead of the server quietly pulling apart everything you ever filed anywhere. It is off by default (your server needs its update for this)
- And there is a way to clear what the old behaviour left behind: Servers → Background work → Clear the rest. Your music is untouched; anything cleared is separated again the next time you ask

## 0.3.326

- Local AI's activity list has pages. It showed the last forty things the model had done and stopped there; now it shows eight at a time and you can walk back through the rest

## 0.3.325

- The black screen after an update is fixed. The app was starting two copies of itself at once — the version that shipped with the app and the one it had downloaded — and they fought over the screen until one of them fell over. Only the right one starts now
- The four library doors line their names up again. On repeat has no number to show, so its name sat lower than the other three and made the DJ door beside it look wrong

## 0.3.324

- Updates are fixed properly this time, in the app itself rather than around it. The step that decided a previous update had failed could fire at the wrong moment and throw away a perfectly good one; it now happens once, at startup, and nothing else can trigger it. Needs the new app from the download page — until then nothing changes for you
- On iPhone and iPad, downloaded songs no longer go into your iCloud backup. A full offline library could quietly take fifteen gigabytes of your iCloud allowance to store music that is already on your server

## 0.3.323

- Updates stop black-screening. The check that ran before the app opened was the thing breaking it, and it turned out not to be needed: an update still installs quietly in the background and still starts up the next time you open the app, rather than interrupting a song. The only difference is that it is picked up during the next session instead of the one that found it

## 0.3.322

- The launch check no longer risks the app to run. It only asks the update server anything once it can prove the app has reported itself healthy — and if it cannot, it skips the check and opens, leaving the update to the periodic one later. Nothing is worth a black screen

## 0.3.321

- Updates stop refusing themselves. On a phone the download regularly takes longer than the launch check waits for, and that gap was making the app throw away the version it was updating from — which is what left you at a black screen having to close and reopen. It waits properly now

## 0.3.320

- Finishes the black-screen fix: the app no longer replaces a stylesheet that was still on its way in. It waits to see whether the one it was given arrives before deciding anything is wrong

## 0.3.319

- Updates open to the app again instead of a black screen. Installing one left the app repairing a stylesheet that was never broken — throwing away the working one and rewriting the page while it was still being drawn. Closing and reopening was the only way through, and it is not needed any more

## 0.3.318

- A Local AI page for whoever hosts the server. Point it at your model endpoint, name a model for each job, check the endpoint answers, see what each function has cost and what the curator has been doing — and hand any of it back to the server's own configuration when you would rather set it there
- Verbose notifications, off by default. Turn it on and the bell tells you when a song starts being taken apart and when it finishes, when a download is picked up, and when the AI starts and finishes a pass over your library
- A developer page, seventeen taps on the wordmark in About. Which frontend is actually running, what this device looks like to the layout, what is in storage — and Diagnostics now lives behind the same switch

## 0.3.317

- An update gives the song back. Restarting to install one used to drop whatever was playing; now the track, the queue and the exact second all come back, still playing if they were

## 0.3.316

- The sign-in screen leads with signing IN now, not signing up — and a short password no longer blocks the button when it is the one you already have
- Your servers travel with your AttackFM account properly. A new phone signs into the account and is handed the servers it belongs to: one tap each, or straight in when there is only one. Nothing about a server had been reaching the account at all if you signed into the server before making the account
- Album filler, the EQ rack and the Looper have been retired. The sound console already saves and recalls curves, and the ones that were instruments rather than ways to listen have gone with the Pads board

## 0.3.315

- Updates stick. An update would install, restart to a black screen, and then refuse itself ever after — the app was throwing away the very version it had just started running, every time it opened. It keeps it now

## 0.3.313

- Now Playing always shows where the song is coming out. The speaker button used to appear only once you owned a second device, so until then there was nothing telling you the sound was on this one

## 0.3.312

- The level meters in the Stems tab were all drawing the same thing — the whole song, six times over, instead of one part each. They show the actual parts now
- Dragging a stem's level asks the server for far fewer versions of the song on the way, so it settles sooner after you let go

## 0.3.311

- When a new version has downloaded, Settings shows a Restart banner right under the recent-settings chips — so you can update from there rather than waiting to come across it

## 0.3.310

- Queue rows sit a little tighter — the padding above and below each one is halved, so more of the queue fits on screen without the covers touching

## 0.3.309

- You can select more than one song now. Hold a song in any table, choose "Select songs…", tick as many as you like, and the bar that appears plays them next, queues them, likes them or files them all into a playlist in one go — including into a brand-new list

## 0.3.308

- The ATTACK wordmark is big now — leading the About page, and filling the screen the app shows while it checks for an update as it opens

## 0.3.307

- The Numbers first cards have their colour back. They were running about two thirds darker than every other card style, which read as switched off rather than as dark — the DJ card worst of all, since violet at that lightness is nearly black

## 0.3.306

- Back now works inside Settings: it returns to the section list from a pane, and only closes Settings once you are already there. Both the header arrow and the phone's own back button do the same thing
- The back and forward controls in the header are arrows now rather than chevrons

## 0.3.305

- Segmented toggles divide their space equally now, everywhere — each segment used to take its own label's width, which read as a lopsided control wherever two labels differed in length

## 0.3.304

- The storage bar in Downloads & space now shows the room left in grey, so you can see how full the cache is rather than only what is in it

## 0.3.303

- Clear cache now really clears: covers, Canvas clips and the lookup memo go with the songs, instead of megabytes of art surviving for music that was just thrown away
- The "send new music automatically" switch is back, beside the folder-sync row under Library — the setting was still honoured but its toggle had been lost in an old settings shuffle
- A broom through the codebase besides: dead code and stale styling removed, and a set of debris files retired. Nothing you can see changed shape

## 0.3.302

- Rich stock's labels are printed ink now rather than white text. They were white in 0.3.301, which left the card looking like a photo of paper instead of something printed on it

## 0.3.301

- A fourth look for your library cards: Rich stock prints the halftone on properly coloured card instead of pale paper, so the colour actually arrives and the dots stay crisp. Settings, Appearance, Card style
- The hidden workshop behind seven taps on the wordmark has been retired. It was there to choose between card looks, and the choosing is done

## 0.3.300

- The collection-page top bar’s fade-in on scroll is lighter now — each frame it redraws only the bar, not the whole screen behind it

## 0.3.299

- The "Wrong song?" listening room wears Now Playing's own glass now — on an unfolded screen its cards used to sit matte and flat beside the deck's frosted panels, like two apps sharing a hinge

## 0.3.298

- On a collection page the top bar is clear over the covers while you are at the top, then fades back to a solid black bar — with its soft shadow beneath it — as you scroll down into the songs

## 0.3.297

- Settings has been reorganized around what you actually come there to do. Four named shelves — Look & sound, Your stuff, The machinery, Reference — and a new Account & devices page gathering your sign-in, your household, device pairing and every device on the account, all of which had been scattered across three panes
- Every settings page now speaks one visual language: the same cards, rows and captions as the list that opens them, with each explanation attached to its own control
- The settings search finds individual settings now, not just pages — type "crossfade" and the row itself appears; choosing it opens the page and lights the row up. Your recent pages show on the desktop too
- What used to be General is Library now, and it is about your music: what you have, where it comes from, and the uploader. Streaming quality moved to Playback, where you would look for it; the lyric header, video clips, haptics and shake-to-shuffle moved to Appearance; the tour lives on the Handbook's cover

## 0.3.296

- On a collection page the covers are vivid behind the wordmark and the bell now — the top bar’s shading sits only along the very top edge, behind the phone’s own status bar, and lets go before the controls
- The cover backdrop is shorter too, with less empty space above the artwork, so the first song comes up sooner

## 0.3.295

- The guided tour is gone — no more walkthrough on a first launch, and no button for it on the Handbook. The Handbook itself is unchanged

## 0.3.294

- On a collection page the top bar is clear now — the covers run right up behind it and into the notch, dimmed just enough there that the wordmark and the bell stay readable, and vivid again the moment they clear the bar

## 0.3.293

- Chromecast (with the next app install): a Cast to section joins the device picker, and a tap sends the music to the TV - the phone keeps the queue and the scrubber, the TV gets the sound, and stopping the cast hands the song back mid-note

## 0.3.292

- Press and hold a song in Liked, All songs, On repeat or an artist's list - anywhere on the row, not only the title - and its menu opens; letting go no longer starts the song playing under the menu. On a desktop, a right-click anywhere on the row does the same, and a click held for a moment opens it too
- On the phone, the song table had lost the menu and the artist link on its title cell; both are back
- In a playlist, tapping the artist's name under a song opens that artist - on the phone as well, where the name folds under the title

## 0.3.291

- Songs kept on this device now bring their look with them: the cache sweep also stores their covers (both sizes) and the Canvas clips for the hottest songs, so an offline library stops drawing grey squares and still moves

## 0.3.290

- Your playlists appear in the car. Android Auto's browse list now carries every playlist beside Liked, All songs and Shuffle, and a tap plays it in its own order
- (With the next app install) Android gets a home-screen widget — the song, its art, and the transport, straight off the lock screen's own state — and iPhones get an AirPlay button beside Connect on Now Playing

## 0.3.289

- The bell's downloads-in-progress rows show the cover and the song coming down, with its artist, instead of a name and a count

## 0.3.288

- The downloads list shows each song's artist and length as it comes down, and its cover once it has landed — a playlist import reads like the record it is, not a list of titles. Your server needs its update to send the details; older servers still show titles

## 0.3.287

- Press and hold a playlist on the shelf for everything its page can do — rename it, file it in a folder, give it a cover — without opening it first

## 0.3.286

- Playlists can wear a picture of your choosing — pick one from the ⋮ menu and it takes the tile and the header
- Descriptions and folders now live with the playlist on your server once it is updated, so everyone in the household sees the same thing; anything you wrote before moves across by itself
- Long playlists get a Find box, for the one song in four hundred

## 0.3.285

- Playlists can go in folders. Open one, use its ⋮ menu to file it, and the shelf groups them underneath your loose playlists

## 0.3.284

- You can see how far the server has got through taking your songs apart, in Playback. It was only ever visible under Servers, and only to an admin — which is not where you would look for something about your own library

## 0.3.283

- Fixed: opening a playlist could hang the app. Yesterday's description field was the cause

## 0.3.282

- Playlists can say what they are for. Tap under the name to write a description — it follows your account, so it is there on every device

## 0.3.281

- A short guided tour now runs the first time you open the app, spotlighting the library, search, Discover, the booth and the player as it goes. You can stop it at any point, and take it again from Settings › General

## 0.3.280

- Music Date has an undo. Swiped the wrong way on a song? Take it back — it returns to the deck, and a keep or a pass is properly unwound rather than just hidden

## 0.3.279

- On a collection page the artwork, title and buttons now sit along the bottom of the drifting cover backdrop instead of floating in the middle of it

## 0.3.278

- The cover backdrop on a collection page is a little shorter, so you reach the first song sooner

## 0.3.277

- The cover backdrop on a collection page is a third taller, and the top bar is solid again rather than frosted

## 0.3.276

- On a collection page the top bar is frosted glass over the drifting covers, instead of a solid black strip across them

## 0.3.275

- On Android the bottom bar now sits clear above the system gesture bar instead of resting on it

## 0.3.274

- The bottom nav bar and the player bar above it wear the same rounded corner the More menu does now, so the three read as one set rather than three slightly different roundings stacked up

## 0.3.273

- The covers behind Liked, All songs, On repeat and your playlists are sharper now and drift on a diagonal, the way the sign-in wall does, instead of sliding flat and sideways under a heavy blur

## 0.3.272

- A collection's cover wall is twice as tall now: it fills the whole header, running behind the Play and Shuffle buttons and down to the first song
- The top bar is solid black again rather than glass, and picks up a shadow as you scroll under it

## 0.3.271

- The album covers behind a collection's title now really do run up behind the top bar, which turns to glass over them. They were stopping in a band underneath it

## 0.3.270

- The cover on Liked, All songs, On repeat and your playlists is bigger now and sits low in the header, level with the title and buttons, rather than small and floating high in the band

## 0.3.269

- Liked, All songs, On repeat and your playlists open on their cover wall running edge to edge and up behind the top bar now, rather than boxed into a card floating in the middle of the page

## 0.3.268

- Adding a song you already own to a playlist no longer sits there saying it is downloading. The app knows the difference between "added", "you already had it" and "that did not work"

## 0.3.267

- The Spotify preview card shows the exact song you tapped now — Spotify's own player with its sleeve, its artist and a 30-second preview — instead of a best guess pulled from your own library. Like and Add to playlist sit right beneath it

## 0.3.266

- Adding a song from Discover to a playlist worked only for songs you did not already have. One you owned went nowhere and said nothing; it is filed straight away now

## 0.3.265

- Open a Spotify link in AttackFM and it pops a preview card now — the song with its artwork, and a tap to Like it or add it to a playlist — instead of dropping you into the search box. (Set which links open here in your phone's app settings.)

## 0.3.264

- Playlists, mixes and your song pages now open on a slow-drifting wall of their own album covers, so a list looks like the music in it before you have read a word
- All songs finally opens on the record stack from its card, the way Liked and On repeat already opened on theirs
- The bottom bar's buttons have a softer corner, closer to the bar they sit in

## 0.3.263

- The bottom bar's tabs keep the plate's margin at each end again. The last update took it off along with the dead space it was meant to remove

## 0.3.262

- The bottom bar's five tabs now span the whole width of it, instead of sitting in from each end with dead space either side

## 0.3.261

- Opening a mix from Discover now scrolls, sits in from the edges, and stops above the player instead of having its last few songs sliced off behind it. It is the same page your own playlists and liked songs open in

## 0.3.260

- The now playing artwork no longer leans about when you tilt the phone. It was costing a redraw every frame on the busiest screen in the app, which is what made the animations there feel heavy. Shake to shuffle and flick to skip are untouched

## 0.3.259

- The playlist results under Discover's "Find a playlist" are seated like the rows in your own playlists now — they light up under the pointer and no longer sit flush against the edge

## 0.3.258

- Your four big library cards lead with their song count now, by default. The look picker in Settings › Appearance is pared to three: Numbers first, Blurred real art — your own sleeves softened into a field of the card's colours — and Chrome, metal tinted to each card

## 0.3.257

- You can choose the quality your phone downloads at — Lossless, 256k, 128k or 96k — in Downloads & space. At 128k the same space holds about seven times the music, and the hint tells you roughly how many hours that is
- It applies to songs you keep by hand as well as automatic downloads, and songs already on the phone are brought over a few dozen at a time. Songs already smaller than your choice are left as they are rather than being re-encoded into something worse

## 0.3.256

- The app looks for an update as it opens now, installs it, and starts on the new version — instead of interrupting you twenty seconds later with a banner. If anything is slow or offline it opens as normal

## 0.3.255

- A fresh set of six looks for the library cards, in Settings › Appearance. Real covers builds each door out of your own sleeves; Numbers first leads with the count; and there's Midnight, Risograph, Chrome and the classic Duotone alongside them

## 0.3.254

- Fixes the black screen on launch. 0.3.253 could not start at all — this restores it

## 0.3.253

- Your library's four big cards can wear one of six looks now. Settings › Appearance › Card style: the printed halftone they have always been, plus editorial, embossed, frosted glass, neon wire and die-cut sticker. Still tucked behind seven taps on the wordmark in About, if that is how you found it

## 0.3.252

- Adding a song from Discover can send it straight to your liked songs or a playlist. It downloads, files itself where you asked, and the app opens that list when it lands

## 0.3.251

- The Stems tab has levels now, not just on and off. Slide a part — vocals, drums, bass — anywhere between full and gone, so a vocal can sit faint under the rest instead of dropping out entirely

## 0.3.250

- On a wide screen with the player docked beside your library, drag the player down while nothing is playing and the library takes the whole width back. It returns the moment you play something

## 0.3.249

- Empty pages show a large icon instead of an illustration — and the app downloads about 2.8MB less on every update, because those pictures travelled inside it
- On an unfolded phone with nothing playing, Settings opens as a list beside its pane instead of one column you drill into

## 0.3.248

- The artwork on Now Playing leans a little as you tilt the phone, so it sits in the screen rather than on it
- New in Playback: shake to change shuffle, flick left or right to move between songs. Off until you turn it on, and it ignores walking, running and a pocket

## 0.3.247

- The notifications panel is the same frosted glass as the sound console now. It had been painting a second pane on top of the app's own, which is what made it the one dark slab among a set of matching panels
- The settings list scrolls. On a short window the bottom of it — About, Diagnostics, the handbook — could not be reached at all

## 0.3.246

- Storage tells the truth about what you kept. Songs you saved by hand are recorded when you save them, instead of being guessed at from what the app still remembered — which is why it could report gigabytes of songs you never chose
- Those songs go back under the cache's management too, so it can free space again instead of sitting at whatever size it had reached

## 0.3.245

- Settings opens as a full screen now rather than a panel floating over the page — except when the player is docked beside it, where it stays a panel so the player is not covered

## 0.3.244

- Smart shuffle is gone for now. The shuffle button is off and on again, and shuffle still avoids the same artist twice running and steers around what it just played

## 0.3.243

- Settings shows one thing at a time when the window is too narrow to hold the list beside the pane — no more search field and theme cards cut off at the edge with the player docked
- The list down the side of Settings now reads like the full-screen one: each section wears its own coloured icon and says what it is currently set to

## 0.3.242

- On a folding phone the player no longer takes half the screen for a song you did not choose. It waits until you have played something, and it steps aside for Music Date and the DJ instead of standing on top of them
- Menus, the pull-to-refresh mark and the DJ's messages stay in the app's half of an unfolded screen rather than sliding under the player
- Curator mixes and the lists plugins add open as a page now, drawn exactly like your own playlists, with Add in place of Play and Shuffle — it saves you a copy you can edit, and the original keeps updating on its own

## 0.3.241

- The library is the first stop on the bar at the bottom of the screen now, instead of sitting third behind the Booth and Discover

## 0.3.240

- Your playlists come with you now — every song in every playlist is kept on the phone, right behind the ones you liked, so a list plays through with no signal at all
- Downloads & space says so when your songs want more room than you have allowed, instead of quietly keeping fewer

## 0.3.239

- The notifications panel was a solid black slab where every other panel in the app is frosted glass. It matches now

## 0.3.238

- Your playlists come with you now — every song in every playlist is kept on the phone, right behind the ones you liked, so a list plays through with no signal at all
- Downloads & space says so when your songs want more room than you have allowed, instead of quietly keeping fewer

## 0.3.237

- The sound button now carries a count of everything you have changed — effects, parts left out, a set EQ — so a vocal you dropped two songs ago is not a silent surprise

## 0.3.236

- The pictures on the genre tiles were sitting small in the middle of them; they fill the tile properly now. A genre shown next to a search result had lost its picture entirely, as had the top genre on your stats

## 0.3.235

- Settings shows what your server is doing with the background separation: a bar of how many liked and playlisted songs are apart out of how many there are, and the name of the one being taken apart right now

## 0.3.234

- The new genre pictures were washing out to white; they carry their tile's colour now. Genres with two names in them — Alternative & Indie, Pop/Rock, Country & Folk — were also showing no picture at all when both halves had one

## 0.3.233

- The genre and mood tiles have their own artwork now — nineteen objects in frosted glass, lit from inside, printing through the dot screen instead of sitting behind it

## 0.3.232

- On repeat and the DJ did not get the new printed look yesterday even though their neighbours did. They have it now

## 0.3.231

- Liked, All songs, On repeat and the DJ are printed now: one deep colour with a fine screen of dots lifted out of it in white, and the object glowing through rather than sitting on top

## 0.3.230

- The genre tiles under Search are printed now rather than shaded: one deep colour with a fine dot screen lifted out of it in white. The pictures on them are the old ones for the moment and are the quiet part of it; new ones are being drawn to suit

## 0.3.229

- Six more looks in the workshop, and a way to see a look next to its alternatives instead of one at a time. Three of them are the printed one done properly — the old one was mixing its ink onto paper too pale to hold a colour

## 0.3.228

- Thirty looks in the workshop now. The newest ten stop being pictures of a thing on a colour: one is a record with its own label, one a cassette with a strip you would write on, one puts the artwork inside the letters of the name, and one is lit by a light that breathes

## 0.3.227

- The workshop hidden in About has twenty looks in it now instead of ten, and they sit much further apart: printed, brushed, drawn, cut from paper, read off a tube. Still nothing on your actual library has changed — this is the picking, not the choosing

## 0.3.226

- Nothing on screen has changed yet. There is a workshop hidden in About where the four cards at the top of your library — Liked, All songs, On repeat, DJ — are laid out in ten different looks against your own songs and counts. Whichever one wins will arrive here properly

## 0.3.225

- The connection light has left the header. It now sits in About, one row under the server it describes, saying the same thing in words — how far away your hub is, any mirrors standing by, and how many other devices are listening

## 0.3.224

- Scroll down in Liked songs or On repeat and the name that takes over the top bar now carries a small heart or loop, instead of a shrunken photograph that read as a cover failing to load

## 0.3.223

- The four cards at the top of your library wear their objects again, each on a gradient in its own colour, with the object tinted to match — the valve, the record stack, the loop and the DJ read as one set now rather than four separate photographs

## 0.3.222

- The four cards at the top of your library — Liked, All songs, On repeat and DJ — trade their photographed objects for a cleaner look: a soft pastel in each card's own colour, with a big plain icon to match. A heart, a list, the repeat arrows, a record

## 0.3.221

- The sign-in screen wears a wall of album art again — blurred and drifting behind the form, the same treatment attack.fm has. It had quietly stopped showing months ago
- Empty pages get new objects: a patch-cable heart where you have liked nothing, a step sequencer for an empty playlist, a tonearm at rest when a search finds nothing, a spindle of blank discs when nothing is downloaded

## 0.3.220

- The three cards under your week's listening — the streak, the songs, the artists — each take a colour of their own now, with the little icon in the same tone, the way the genres wear their colours on Search

## 0.3.219

- The four cards at the top of your library have their objects: a heart-shaped valve for Liked, a jukebox's record stack for All songs, chrome arrows for On repeat, and a mirrored helmet for the DJ
- Discover says its own name at the top, with a compass beside it, where the ATTACK wordmark used to sit — and the page below no longer repeats the heading, or explains itself before the first cover

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
