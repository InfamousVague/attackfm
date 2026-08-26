/**
 * The demo library's records.
 *
 * Real albums, real track listings, real durations - taken from each record's
 * Wikipedia track-listing section, not written from memory. The site shows the
 * actual app running against this data (see make-demo-fixtures.mjs), so a
 * wrong track order or an invented song is a wrong track order or an invented
 * song ON THE MARKETING PAGE, which is why these were sourced rather than
 * recalled.
 *
 * `art` names a file in src/assets/wall - the covers the app already ships for
 * its hero wall. Titles use the form the records are actually tagged with
 * (DAMN. is upper-case with the stops, To Pimp a Butterfly's "u" and "i" are
 * lower-case), because that is what a real rip of these discs looks like in a
 * library, and looking real is the entire job of this fixture.
 *
 * Durations are "m:ss" and converted once, at the bottom.
 */
export const ALBUMS = [
  {
    artist: 'Radiohead', album: 'The Bends', year: 1995, genre: 'Alternative rock',
    art: 'cover-12.jpg', format: 'flac',
    tracks: [
      ['Planet Telex', '4:19'], ['The Bends', '4:06'], ['High and Dry', '4:17'],
      ['Fake Plastic Trees', '4:50'], ['Bones', '3:09'], ['(Nice Dream)', '3:53'],
      ['Just', '3:54'], ['My Iron Lung', '4:36'], ['Bullet Proof... I Wish I Was', '3:28'],
      ['Black Star', '4:07'], ['Sulk', '3:42'], ['Street Spirit (Fade Out)', '4:12'],
    ],
  },
  {
    artist: 'Radiohead', album: 'OK Computer', year: 1997, genre: 'Alternative rock',
    art: 'cover-11.jpg', format: 'flac',
    tracks: [
      ['Airbag', '4:44'], ['Paranoid Android', '6:23'], ['Subterranean Homesick Alien', '4:27'],
      ['Exit Music (For a Film)', '4:24'], ['Let Down', '4:59'], ['Karma Police', '4:21'],
      ['Fitter Happier', '1:57'], ['Electioneering', '3:50'], ['Climbing Up the Walls', '4:45'],
      ['No Surprises', '3:48'], ['Lucky', '4:19'], ['The Tourist', '5:24'],
    ],
  },
  {
    artist: 'Radiohead', album: 'In Rainbows', year: 2007, genre: 'Art rock',
    art: 'cover-13.jpg', format: 'flac',
    tracks: [
      ['15 Step', '3:58'], ['Bodysnatchers', '4:02'], ['Nude', '4:15'],
      ['Weird Fishes/Arpeggi', '5:18'], ['All I Need', '3:49'], ['Faust Arp', '2:10'],
      ['Reckoner', '4:50'], ['House of Cards', '5:28'], ['Jigsaw Falling into Place', '4:09'],
      ['Videotape', '4:40'],
    ],
  },
  {
    artist: 'Fleetwood Mac', album: 'Fleetwood Mac', year: 1975, genre: 'Soft rock',
    art: 'cover-28.jpg', format: 'flac',
    tracks: [
      ['Monday Morning', '2:48'], ['Warm Ways', '3:50'], ['Blue Letter', '2:31'],
      ['Rhiannon', '4:12'], ['Over My Head', '3:34'], ['Crystal', '5:12'],
      ['Say You Love Me', '4:11'], ['Landslide', '3:05'], ['World Turning', '4:25'],
      ['Sugar Daddy', '4:09'], ["I'm So Afraid", '4:15'],
    ],
  },
  {
    artist: 'Fleetwood Mac', album: 'Rumours', year: 1977, genre: 'Soft rock',
    art: 'cover-26.jpg', format: 'flac',
    tracks: [
      ['Second Hand News', '2:43'], ['Dreams', '4:14'], ['Never Going Back Again', '2:02'],
      ["Don't Stop", '3:11'], ['Go Your Own Way', '3:38'], ['Songbird', '3:20'],
      ['The Chain', '4:28'], ['You Make Loving Fun', '3:31'], ["I Don't Want to Know", '3:11'],
      ['Oh Daddy', '3:54'], ['Gold Dust Woman', '4:51'],
    ],
  },
  {
    artist: 'Miles Davis', album: 'Kind of Blue', year: 1959, genre: 'Modal jazz',
    art: 'cover-29.jpg', format: 'flac',
    tracks: [
      ['So What', '9:22'], ['Freddie Freeloader', '9:46'], ['Blue in Green', '5:27'],
      ['All Blues', '11:33'], ['Flamenco Sketches', '9:26'],
    ],
  },
  {
    artist: 'Miles Davis', album: 'Sketches of Spain', year: 1960, genre: 'Orchestral jazz',
    art: 'cover-31.jpg', format: 'flac',
    tracks: [
      ['Concierto de Aranjuez (Adagio)', '16:19'], ["Will o' the Wisp", '3:47'],
      ['The Pan Piper', '3:52'], ['Saeta', '5:06'], ['Solea', '12:15'],
    ],
  },
  {
    artist: 'Miles Davis', album: 'Bitches Brew', year: 1970, genre: 'Jazz fusion',
    art: 'cover-30.jpg', format: 'flac',
    tracks: [
      ["Pharaoh's Dance", '20:07'], ['Bitches Brew', '27:00'], ['Spanish Key', '17:30'],
      ['John McLaughlin', '4:23'], ['Miles Runs the Voodoo Down', '14:03'], ['Sanctuary', '10:54'],
    ],
  },
  {
    artist: 'Nirvana', album: 'In Utero', year: 1993, genre: 'Grunge',
    art: 'cover-40.jpg', format: 'flac',
    tracks: [
      ['Serve the Servants', '3:36'], ['Scentless Apprentice', '3:48'], ['Heart-Shaped Box', '4:41'],
      ['Rape Me', '2:50'], ['Frances Farmer Will Have Her Revenge on Seattle', '4:09'],
      ['Dumb', '2:32'], ['Very Ape', '1:56'], ['Milk It', '3:55'], ['Pennyroyal Tea', '3:37'],
      ['Radio Friendly Unit Shifter', '4:51'], ["Tourette's", '1:35'], ['All Apologies', '3:51'],
    ],
  },
  {
    artist: 'Amy Winehouse', album: 'Back to Black', year: 2006, genre: 'Soul',
    art: 'cover-42.jpg', format: 'flac',
    tracks: [
      ['Rehab', '3:34'], ["You Know I'm No Good", '4:17'], ['Me & Mr Jones', '2:33'],
      ['Just Friends', '3:13'], ['Back to Black', '4:01'], ['Love Is a Losing Game', '2:35'],
      ['Tears Dry on Their Own', '3:06'], ['Wake Up Alone', '3:42'], ['Some Unholy War', '2:22'],
      ['He Can Only Hold Her', '2:46'], ['Addicted', '2:45'],
    ],
  },
  {
    artist: 'Tame Impala', album: 'Lonerism', year: 2012, genre: 'Psychedelic rock',
    art: 'cover-15.jpg', format: 'flac',
    tracks: [
      ['Be Above It', '3:21'], ['Endors Toi', '3:06'], ['Apocalypse Dreams', '5:56'],
      ['Mind Mischief', '4:31'], ['Music to Walk Home By', '5:12'],
      ["Why Won't They Talk to Me?", '4:46'], ['Feels Like We Only Go Backwards', '3:12'],
      ['Keep on Lying', '5:54'], ['Elephant', '3:31'], ["She Just Won't Believe Me", '0:57'],
      ['Nothing That Has Happened So Far Has Been Anything We Could Control', '6:01'],
      ["Sun's Coming Up", '5:20'],
    ],
  },
  {
    artist: 'Tame Impala', album: 'The Slow Rush', year: 2020, genre: 'Psychedelic pop',
    art: 'cover-14.jpg', format: 'flac',
    tracks: [
      ['One More Year', '5:22'], ['Instant Destiny', '3:13'], ['Borderline', '3:57'],
      ['Posthumous Forgiveness', '6:05'], ['Breathe Deeper', '6:13'], ["Tomorrow's Dust", '5:25'],
      ['On Track', '5:00'], ['Lost in Yesterday', '4:09'], ['Is It True', '3:58'],
      ['It Might Be Time', '4:33'], ['Glimmer', '2:08'], ['One More Hour', '7:13'],
    ],
  },
  {
    artist: 'Arctic Monkeys', album: 'AM', year: 2013, genre: 'Indie rock',
    art: 'cover-23.jpg', format: 'flac',
    tracks: [
      ['Do I Wanna Know?', '4:31'], ['R U Mine?', '3:21'], ['One for the Road', '3:26'],
      ['Arabella', '3:27'], ['I Want It All', '3:04'], ['No. 1 Party Anthem', '4:03'],
      ['Mad Sounds', '3:35'], ['Fireside', '3:01'],
      ["Why'd You Only Call Me When You're High?", '2:41'], ['Snap Out of It', '3:12'],
      ['Knee Socks', '4:17'], ['I Wanna Be Yours', '3:04'],
    ],
  },
  {
    artist: 'Daft Punk', album: 'Random Access Memories', year: 2013, genre: 'Electronic',
    art: 'cover-05.jpg', format: 'flac',
    tracks: [
      ['Give Life Back to Music', '4:34'], ['The Game of Love', '5:22'],
      ['Giorgio by Moroder', '9:04'], ['Within', '3:48'], ['Instant Crush', '5:37'],
      ['Lose Yourself to Dance', '5:53'], ['Touch', '8:19'], ['Get Lucky', '6:09'],
      ['Beyond', '4:50'], ['Motherboard', '5:41'], ['Fragments of Time', '4:39'],
      ["Doin' It Right", '4:11'], ['Contact', '6:23'],
    ],
  },
  {
    artist: 'Kendrick Lamar', album: 'To Pimp a Butterfly', year: 2015, genre: 'Hip hop',
    art: 'cover-10.jpg', format: 'm4a',
    tracks: [
      ["Wesley's Theory", '4:47'], ['For Free? - Interlude', '2:10'], ['King Kunta', '3:54'],
      ['Institutionalized', '4:31'], ['These Walls', '5:00'], ['u', '4:28'], ['Alright', '3:39'],
      ['For Sale? - Interlude', '4:51'], ['Momma', '4:43'], ['Hood Politics', '4:52'],
      ['How Much a Dollar Cost', '4:21'], ['Complexion (A Zulu Love)', '4:23'],
      ['The Blacker the Berry', '5:28'], ["You Ain't Gotta Lie (Momma Said)", '4:01'],
      ['i', '5:36'], ['Mortal Man', '12:07'],
    ],
  },
  {
    artist: 'Kendrick Lamar', album: 'DAMN.', year: 2017, genre: 'Hip hop',
    art: 'cover-09.jpg', format: 'm4a',
    tracks: [
      ['BLOOD.', '1:58'], ['DNA.', '3:05'], ['YAH.', '2:40'], ['ELEMENT.', '3:28'],
      ['FEEL.', '3:34'], ['LOYALTY.', '3:47'], ['PRIDE.', '4:35'], ['HUMBLE.', '2:57'],
      ['LUST.', '5:07'], ['LOVE.', '3:33'], ['XXX.', '4:14'], ['FEAR.', '7:40'],
      ['GOD.', '4:08'], ['DUCKWORTH.', '4:08'],
    ],
  },
  {
    artist: 'The Weeknd', album: 'Beauty Behind the Madness', year: 2015, genre: 'Alternative R&B',
    art: 'cover-18.jpg', format: 'm4a',
    tracks: [
      ['Real Life', '3:43'], ['Losers', '4:41'], ['Tell Your Friends', '5:34'],
      ['Often', '4:09'], ['The Hills', '4:02'], ['Acquainted', '5:48'],
      ["Can't Feel My Face", '3:33'], ['Shameless', '4:13'], ['Earned It', '4:37'],
      ['In the Night', '3:55'], ['As You Are', '5:40'], ['Dark Times', '4:20'],
      ['Prisoner', '4:34'], ['Angel', '6:17'],
    ],
  },
  {
    artist: 'The Weeknd', album: 'My Dear Melancholy,', year: 2018, genre: 'Alternative R&B',
    art: 'cover-17.jpg', format: 'm4a',
    tracks: [
      ['Call Out My Name', '3:48'], ['Try Me', '3:41'], ['Wasted Times', '3:40'],
      ['I Was Never There', '4:01'], ['Hurt You', '3:50'], ['Privilege', '2:50'],
    ],
  },
  {
    artist: 'SZA', album: 'Ctrl', year: 2017, genre: 'Alternative R&B',
    art: 'cover-45.jpg', format: 'm4a',
    tracks: [
      ['Supermodel', '3:01'], ['Love Galore (feat. Travis Scott)', '4:35'],
      ['Doves in the Wind (feat. Kendrick Lamar)', '4:26'], ['Drew Barrymore', '3:51'],
      ['Prom', '3:16'], ['The Weekend', '4:32'], ['Go Gina', '2:41'],
      ['Garden (Say It like Dat)', '3:28'], ['Broken Clocks', '3:51'], ['Anything', '2:29'],
      ['Wavy - Interlude (feat. James Fauntleroy)', '1:15'], ['Normal Girl', '4:13'],
      ['Pretty Little Birds (feat. Isaiah Rashad)', '4:05'], ['20 Something', '3:18'],
    ],
  },
];

/** "m:ss" or "mm:ss" to whole seconds. */
export function seconds(clock) {
  const [m, s] = clock.split(':').map(Number);
  return m * 60 + s;
}
