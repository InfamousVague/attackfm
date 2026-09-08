import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  jamCodeFromText,
  jamCodeFromUrl,
  playlistCodeFromText,
  spotifyEmbedUrl,
  spotifyLink,
  spotifyWebUrl,
} from './deepLink.ts';

/*
 * The plugin is never available in a test - the real `initDeepLinks` swallows
 * the import failure and does nothing, which would leave `deliver` unreachable.
 * Stubbing it with a launch that carried no links keeps the ONE door this
 * module opens for the platform bridge (`window.__AFM_SHARED_LINK__`) open,
 * which is how the delivery tests below feed it a URL.
 */
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: () => Promise.resolve(null),
  onOpenUrl: () => Promise.resolve(() => {}),
}));

/**
 * A module with no history: fresh subscriber sets, a fresh `pending` read out
 * of whatever localStorage holds right now, and the bridge wired.
 *
 * `initDeepLinks` guards itself with a module-level `started`, and the stores
 * are module-level too, so a suite that shares one instance is a suite whose
 * tests can only be run in one order.
 */
async function fresh() {
  vi.resetModules();
  const mod = await import('./deepLink.ts');
  await mod.initDeepLinks();
  const deliver = (window as unknown as { __AFM_SHARED_LINK__: (url: string) => void })
    .__AFM_SHARED_LINK__;
  return { mod, deliver };
}

/** Every door this module can put a link through, each recording what it got. */
function doors(mod: Awaited<ReturnType<typeof fresh>>['mod']) {
  const got = { invite: [] as string[], playlist: [] as string[], jam: [] as string[], profile: [] as string[], spotify: [] as string[] };
  mod.onInvite((c) => got.invite.push(c));
  mod.onPlaylistLink((c) => got.playlist.push(c));
  mod.onJamLink((c) => got.jam.push(c));
  mod.onProfileLink((h) => got.profile.push(h));
  mod.onSpotifyLink((u) => got.spotify.push(u));
  return got;
}

describe('spotifyLink', () => {
  it('takes a share URI as it stands', () => {
    expect(spotifyLink('spotify:track:4cOdK2wGLETKBW3PvgPWqT')).toBe('spotify:track:4cOdK2wGLETKBW3PvgPWqT');
    expect(spotifyLink('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toBe('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
  });

  it('takes a web link in either scheme', () => {
    expect(spotifyLink('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3')).toBe(
      'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3',
    );
    expect(spotifyLink('http://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4')).toBe(
      'http://open.spotify.com/artist/3TVXtAsR1Inumwj472S9r4',
    );
  });

  it('picks the link out of the sentence Spotify Share actually hands over', () => {
    const shared = 'Listen to Alright by Kendrick Lamar on Spotify: https://open.spotify.com/track/3iVcZ5G6tvkXZkZKlMpIUs?si=abc123';
    expect(spotifyLink(shared)).toBe('https://open.spotify.com/track/3iVcZ5G6tvkXZkZKlMpIUs?si=abc123');
  });

  it('drops the punctuation a sentence leaves stuck to the end', () => {
    expect(spotifyLink('have a listen (https://open.spotify.com/track/abc123).')).toBe(
      'https://open.spotify.com/track/abc123',
    );
  });

  it('says no to everything that is not one of the four kinds', () => {
    // A podcast, a user page, a look-alike host: each has to read as "not a
    // Spotify link we can do anything with", not as a link with a bad id.
    expect(spotifyLink('spotify:show:5CfCWKI5pZ28U0uOzXkDHe')).toBeNull();
    expect(spotifyLink('https://open.spotify.com/user/matt')).toBeNull();
    expect(spotifyLink('https://example.com/track/abc123')).toBeNull();
    expect(spotifyLink('')).toBeNull();
    expect(spotifyLink('just some words')).toBeNull();
  });
});

describe('spotifyWebUrl', () => {
  it('turns the app scheme into the https form the OS will hand to Spotify', () => {
    expect(spotifyWebUrl('spotify:track:4cOdK2wGLETKBW3PvgPWqT')).toBe(
      'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
    );
  });

  it('lowercases the kind but never the id', () => {
    // The kind is a fixed word in the path; the id is base62 and case IS data.
    expect(spotifyWebUrl('spotify:TRACK:AbCdEf')).toBe('https://open.spotify.com/track/AbCdEf');
  });

  it('leaves a web link alone', () => {
    expect(spotifyWebUrl('https://open.spotify.com/album/xyz?si=1')).toBe(
      'https://open.spotify.com/album/xyz?si=1',
    );
  });

  it('is null when there was no link to convert', () => {
    expect(spotifyWebUrl('https://open.spotify.com/user/matt')).toBeNull();
  });
});

describe('spotifyEmbedUrl', () => {
  it('names the embed player for the exact record the id names', () => {
    expect(spotifyEmbedUrl('spotify:album:1DFixLWuPkv3KT3TnV35m3')).toBe(
      'https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3',
    );
  });

  it('drops the tracking query, which the embed endpoint has no use for', () => {
    expect(spotifyEmbedUrl('https://open.spotify.com/track/abc123?si=deadbeef')).toBe(
      'https://open.spotify.com/embed/track/abc123',
    );
  });

  it('has no embed for a plain-http link', () => {
    // Documented asymmetry rather than an accident of the regex: `spotifyLink`
    // accepts http, and the embed matcher requires https. A phone's share
    // sheet only ever produces https, so the preview card simply does not
    // appear for the hand-typed http form.
    expect(spotifyWebUrl('http://open.spotify.com/track/abc123')).toBe('http://open.spotify.com/track/abc123');
    expect(spotifyEmbedUrl('http://open.spotify.com/track/abc123')).toBeNull();
  });

  it('is null for a non-link', () => {
    expect(spotifyEmbedUrl('https://attack.fm/p/AB2CDE')).toBeNull();
  });
});

describe('playlistCodeFromText', () => {
  it('reads a share link on any host', () => {
    expect(playlistCodeFromText('https://attack.fm/p/AB2CDE')).toEqual({ code: 'AB2CDE', bare: false });
    expect(playlistCodeFromText('https://registry.attack.fm/p/AB2CDE')).toEqual({ code: 'AB2CDE', bare: false });
    expect(playlistCodeFromText('attackfm://p/AB2CDE')).toEqual({ code: 'AB2CDE', bare: false });
  });

  it('reads a bare code off a card, uppercased and flagged as bare', () => {
    // `bare` is the caller's cue to confirm with the registry before promising
    // a playlist: six capitals can also be a word.
    expect(playlistCodeFromText('ab2cde')).toEqual({ code: 'AB2CDE', bare: true });
    expect(playlistCodeFromText('  AB2CDE  ')).toEqual({ code: 'AB2CDE', bare: true });
  });

  it('holds the registry alphabet: no 0, 1, I, L, O or U', () => {
    expect(playlistCodeFromText('ABCDEI')).toBeNull();
    expect(playlistCodeFromText('ABCDE0')).toBeNull();
    expect(playlistCodeFromText('ABCDEU')).toBeNull();
    expect(playlistCodeFromText('ABCDE2')).toEqual({ code: 'ABCDE2', bare: true });
  });

  it('holds the length: six, exactly', () => {
    expect(playlistCodeFromText('AB2CD')).toBeNull();
    expect(playlistCodeFromText('AB2CDEF')).toBeNull();
  });

  it('needs a SCHEME before it will read a link, unlike a groove code', () => {
    // A host-less "attack.fm/p/AB2CDE" is not accepted here: a playlist code
    // is confirmed against the registry, and the six-character form is the
    // one a person reads off a card.
    expect(playlistCodeFromText('attack.fm/p/AB2CDE')).toBeNull();
  });

  it('is null for nothing at all', () => {
    expect(playlistCodeFromText('')).toBeNull();
    expect(playlistCodeFromText('   ')).toBeNull();
    expect(playlistCodeFromText('https://attack.fm/')).toBeNull();
  });
});

describe('jamCodeFromText', () => {
  it('reads a groove link with or without a scheme', () => {
    expect(jamCodeFromText('https://attack.fm/j/abcd')).toEqual({ code: 'ABCD', bare: false });
    expect(jamCodeFromText('attackfm://j/abcd')).toEqual({ code: 'ABCD', bare: false });
    // The deliberate widening: "attack.fm/j/CODE" is how it reads off a card.
    expect(jamCodeFromText('attack.fm/j/xyz12')).toEqual({ code: 'XYZ12', bare: false });
  });

  it('takes a bare code of four to eight, from either alphabet', () => {
    // Wider than a playlist's on purpose: the registry's share code and the
    // hub's own room id both reach a person, and which one it is gets settled
    // by asking, not by the shape.
    expect(jamCodeFromText('ab3d')).toEqual({ code: 'AB3D', bare: true });
    expect(jamCodeFromText('a1b2c3d4')).toEqual({ code: 'A1B2C3D4', bare: true });
    expect(jamCodeFromText('abc')).toBeNull();
    expect(jamCodeFromText('a1b2c3d4e')).toBeNull();
  });

  it('is null for prose and for a link that is not a groove', () => {
    expect(jamCodeFromText('hello there')).toBeNull();
    expect(jamCodeFromText('https://attack.fm/p/AB2CDE')).toBeNull();
    expect(jamCodeFromText('')).toBeNull();
  });

  it('jamCodeFromUrl reads only the path, and keeps the case it found', () => {
    expect(jamCodeFromUrl('https://attack.fm/j/room7?from=qr')).toBe('room7');
    expect(jamCodeFromUrl('https://attack.fm/p/AB2CDE')).toBeNull();
  });
});

describe('delivering a link', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sends a playlist link to the playlist door and nowhere else', async () => {
    const { mod, deliver } = await fresh();
    const got = doors(mod);
    deliver('https://registry.attack.fm/p/AB2CDE');
    expect(got).toMatchObject({ playlist: ['AB2CDE'], invite: [], jam: [], profile: [], spotify: [] });
  });

  it('sends a groove link to the groove door', async () => {
    const { mod, deliver } = await fresh();
    const got = doors(mod);
    deliver('attackfm://j/ROOM7');
    expect(got.jam).toEqual(['ROOM7']);
    expect(got.invite).toEqual([]);
  });

  it('sends a profile link to the profile door, @ stripped and percent-decoded', async () => {
    const { mod, deliver } = await fresh();
    const got = doors(mod);
    deliver('https://attack.fm/u/@matt');
    deliver('https://attack.fm/u/mr%20matt');
    expect(got.profile).toEqual(['matt', 'mr matt']);
  });

  it('sends an invite to the invite door and writes it down for the next launch', async () => {
    const { mod, deliver } = await fresh();
    const got = doors(mod);
    deliver('https://registry.attack.fm/i/CODE12');
    expect(got.invite).toEqual(['CODE12']);
    expect(localStorage.getItem('afm.invite.pending')).toBe('CODE12');
  });

  it('reads the bare scheme form as an invite', async () => {
    const { mod, deliver } = await fresh();
    const got = doors(mod);
    deliver('attackfm://CODE12');
    expect(got.invite).toEqual(['CODE12']);
  });

  it('lets a Spotify link win over anything else in the same text', async () => {
    // Order is the logic here: the share sheet hands over a sentence, and a
    // sentence can carry two links.
    const { mod, deliver } = await fresh();
    const got = doors(mod);
    deliver('mine: https://open.spotify.com/track/abc123 and https://attack.fm/p/AB2CDE');
    expect(got.spotify).toEqual(['https://open.spotify.com/track/abc123']);
    expect(got.playlist).toEqual([]);
  });

  it('lets a playlist path win over the bare-scheme invite reading', async () => {
    // `attackfm://p/AB2CDE` would read as the invite code "p" if the invite
    // matcher ran first.
    const { mod, deliver } = await fresh();
    const got = doors(mod);
    deliver('attackfm://p/AB2CDE');
    expect(got.playlist).toEqual(['AB2CDE']);
    expect(got.invite).toEqual([]);
  });

  it('a URL that is none of them opens no door and leaves nothing behind', async () => {
    const { mod, deliver } = await fresh();
    const got = doors(mod);
    for (const url of [
      'https://example.com/nothing/here',
      'https://attack.fm/',
      'mailto:someone@example.com',
      'https://open.spotify.com/show/5CfCWKI5pZ28U0uOzXkDHe',
      '',
    ]) {
      deliver(url);
    }
    expect(got).toEqual({ invite: [], playlist: [], jam: [], profile: [], spotify: [] });
    expect(localStorage.getItem('afm.invite.pending')).toBeNull();
  });
});

describe('the replay contract', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('replays to a screen that mounts after the link arrived', async () => {
    // The whole reason this is a store and not a context: a cold launch FROM
    // the link has the URL in hand before any React tree exists.
    const { mod, deliver } = await fresh();
    deliver('https://attack.fm/p/AB2CDE');
    const late: string[] = [];
    mod.onPlaylistLink((c) => late.push(c));
    expect(late).toEqual(['AB2CDE']);
  });

  it('spends a link once it is cleared, so a later screen is not re-opened', async () => {
    const { mod, deliver } = await fresh();
    deliver('https://attack.fm/p/AB2CDE');
    mod.clearPlaylistLink();
    const late: string[] = [];
    mod.onPlaylistLink((c) => late.push(c));
    expect(late).toEqual([]);
  });

  it('keeps a pending invite across a relaunch, and spends it on clear', async () => {
    const first = await fresh();
    first.deliver('https://attack.fm/i/CODE12');

    // A cold launch: a brand new module, reading the same storage.
    const relaunched = await fresh();
    const seen: string[] = [];
    relaunched.mod.onInvite((c) => seen.push(c));
    expect(seen).toEqual(['CODE12']);

    relaunched.mod.clearInvite();
    expect(localStorage.getItem('afm.invite.pending')).toBeNull();

    const after = await fresh();
    const later: string[] = [];
    after.mod.onInvite((c) => later.push(c));
    expect(later).toEqual([]);
  });

  it('stops calling a handler that unsubscribed', async () => {
    const { mod, deliver } = await fresh();
    const seen: string[] = [];
    const off = mod.onJamLink((c) => seen.push(c));
    deliver('https://attack.fm/j/ROOM1');
    off();
    deliver('https://attack.fm/j/ROOM2');
    expect(seen).toEqual(['ROOM1']);
  });

  it('openPlaylistCode is the same door for a typed code', async () => {
    const { mod } = await fresh();
    const seen: string[] = [];
    mod.onPlaylistLink((c) => seen.push(c));
    mod.openPlaylistCode('  AB2CDE  ');
    expect(seen).toEqual(['AB2CDE']);

    // …and it holds, for a screen that has not mounted yet.
    const late: string[] = [];
    mod.onPlaylistLink((c) => late.push(c));
    expect(late).toEqual(['AB2CDE']);
  });

  it('openPlaylistCode ignores an empty ask', async () => {
    const { mod } = await fresh();
    const seen: string[] = [];
    mod.onPlaylistLink((c) => seen.push(c));
    mod.openPlaylistCode('   ');
    expect(seen).toEqual([]);
  });
});
