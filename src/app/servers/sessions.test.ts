import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '../api/http.ts';

/*
 * The store reads localStorage ONCE, at import, into a module-level snapshot.
 * Every test that cares what was on disk when the app launched therefore needs
 * its own module instance, not a shared one with a helper to reset it.
 */
async function fresh() {
  vi.resetModules();
  return import('./sessions.ts');
}

const KEY = 'attackfm-sessions';

function session(url: string, username = 'matt'): ServerSession {
  return { url, token: `tok-${username}`, streamToken: `stream-${username}`, username, isAdmin: false };
}

describe('normalise', () => {
  it('drops the trailing slash and the case, which are not identity', async () => {
    const { normalise } = await fresh();
    expect(normalise('https://Music.Example.com/')).toBe('https://music.example.com');
    expect(normalise('https://music.example.com///')).toBe('https://music.example.com');
    expect(normalise('  https://music.example.com  ')).toBe('https://music.example.com');
  });

  it('agrees with itself for the same box spelled four ways', async () => {
    const { normalise } = await fresh();
    const spellings = [
      'https://music.example.com',
      'https://music.example.com/',
      'HTTPS://MUSIC.EXAMPLE.COM',
      ' https://Music.Example.com// ',
    ];
    expect(new Set(spellings.map(normalise)).size).toBe(1);
  });
});

describe('the session set', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty', async () => {
    const s = await fresh();
    expect(s.allSessions()).toEqual([]);
    expect(s.primarySession()).toBeNull();
  });

  it('keeps every server, and the newest becomes primary', async () => {
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'));
    s.rememberSession(session('https://vps.example.com'));
    expect(s.allSessions().map((x) => x.url).sort()).toEqual([
      'https://home.example.com',
      'https://vps.example.com',
    ]);
    expect(s.primarySession()?.url).toBe('https://vps.example.com');
  });

  it('can add a server WITHOUT taking the app to it', async () => {
    // The whole point of the set: adding a library must not feel like leaving
    // the one you are on.
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'));
    s.rememberSession(session('https://vps.example.com'), false);
    expect(s.primarySession()?.url).toBe('https://home.example.com');
    expect(s.allSessions()).toHaveLength(2);
  });

  it('makes the FIRST server primary even when told not to', async () => {
    // `makePrimary || !snapshot.primary`: an app pointing at nothing is not a
    // state any screen can draw.
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'), false);
    expect(s.primarySession()?.url).toBe('https://home.example.com');
  });

  it('keys on the normalised url but stores the url as given', async () => {
    // The key is how two spellings of one box stay one card; the stored URL is
    // what the fetches are built on, so it keeps its case.
    const s = await fresh();
    s.rememberSession(session('https://Home.Example.com/'));
    s.rememberSession({ ...session('https://home.example.com'), token: 'newer' });
    expect(s.allSessions()).toHaveLength(1);
    expect(s.allSessions()[0]?.token).toBe('newer');
  });

  it('signs out of one server and leaves the others alone', async () => {
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'));
    s.rememberSession(session('https://vps.example.com'));
    s.forgetSession('https://VPS.example.com/');
    expect(s.allSessions().map((x) => x.url)).toEqual(['https://home.example.com']);
    expect(s.primarySession()?.url).toBe('https://home.example.com');
  });

  it('hands the primary seat on when the primary is the one signed out of', async () => {
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'));
    s.rememberSession(session('https://vps.example.com'));
    s.forgetSession('https://vps.example.com');
    expect(s.primarySession()?.url).toBe('https://home.example.com');
  });

  it('has no primary once the last server is gone', async () => {
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'));
    s.forgetSession('https://home.example.com');
    expect(s.primarySession()).toBeNull();
    expect(s.sessionsSnapshot().primary).toBe('');
  });

  it('setPrimary refuses a server it does not hold', async () => {
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'));
    s.setPrimary('https://stranger.example.com');
    expect(s.primarySession()?.url).toBe('https://home.example.com');
  });

  it('setPrimary takes a differently-spelled url', async () => {
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'));
    s.rememberSession(session('https://vps.example.com'));
    s.setPrimary('https://HOME.example.com/');
    expect(s.primarySession()?.url).toBe('https://home.example.com');
  });

  it('tells its listeners when anything moves, and stops when they go', async () => {
    const s = await fresh();
    let beats = 0;
    const off = s.subscribeSessions(() => {
      beats += 1;
    });
    s.rememberSession(session('https://home.example.com'));
    s.setPrimary('https://home.example.com');
    expect(beats).toBe(2);
    off();
    s.rememberSession(session('https://vps.example.com'));
    expect(beats).toBe(2);
  });
});

describe('reading what the last launch wrote', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('survives a relaunch', async () => {
    const first = await fresh();
    first.rememberSession(session('https://home.example.com'));
    const second = await fresh();
    expect(second.primarySession()?.url).toBe('https://home.example.com');
  });

  it('falls back to any session when the stored primary names one we do not hold', async () => {
    // An app pointing at nothing draws nothing; whatever IS here beats that.
    localStorage.setItem(
      KEY,
      JSON.stringify({ byUrl: { 'https://home.example.com': session('https://home.example.com') }, primary: 'https://gone.example.com' }),
    );
    const s = await fresh();
    expect(s.primarySession()?.url).toBe('https://home.example.com');
  });

  it('reads unparseable storage as empty rather than throwing at import', async () => {
    localStorage.setItem(KEY, '{not json');
    const s = await fresh();
    expect(s.allSessions()).toEqual([]);
    expect(s.primarySession()).toBeNull();
  });

  it('reads a half-written record as empty', async () => {
    localStorage.setItem(KEY, JSON.stringify({ primary: 'https://home.example.com' }));
    const s = await fresh();
    expect(s.allSessions()).toEqual([]);
    expect(s.sessionsSnapshot().primary).toBe('');
  });
});

describe('sessionForOrigin', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('gives the primary for a path that names no origin', async () => {
    // Every path written before multi-server existed - they came from
    // whichever server was current at the time.
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'));
    expect(s.sessionForOrigin(null)?.url).toBe('https://home.example.com');
    expect(s.sessionForOrigin(undefined)?.url).toBe('https://home.example.com');
    expect(s.sessionForOrigin('')?.url).toBe('https://home.example.com');
  });

  it('gives the named server when the path names one', async () => {
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'));
    s.rememberSession(session('https://vps.example.com'));
    expect(s.sessionForOrigin('https://home.example.com')?.url).toBe('https://home.example.com');
    expect(s.sessionForOrigin('https://HOME.example.com/')?.url).toBe('https://home.example.com');
  });

  it('falls back to the primary for a server this device is not signed in to', async () => {
    // Better a song from the box we can reach than no song at all.
    const s = await fresh();
    s.rememberSession(session('https://home.example.com'));
    expect(s.sessionForOrigin('https://stranger.example.com')?.url).toBe('https://home.example.com');
  });

  it('is null when there is no server at all', async () => {
    const s = await fresh();
    expect(s.sessionForOrigin('https://home.example.com')).toBeNull();
  });
});
