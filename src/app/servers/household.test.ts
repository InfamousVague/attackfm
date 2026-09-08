import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '../api/http.ts';
import { forgetProfile, otherProfiles, profiles, rememberProfile } from './household.ts';

const KEY = 'attackfm-household';

function session(url: string, username: string): ServerSession {
  return { url, token: `${url}#${username}`, streamToken: 's', username, isAdmin: false };
}

beforeEach(() => {
  localStorage.clear();
});

describe('the household', () => {
  it('is empty on a device nobody has signed in on', () => {
    expect(profiles()).toEqual([]);
  });

  it('puts the most recently used first', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
    rememberProfile(session('https://home.example.com', 'matt'));
    rememberProfile(session('https://home.example.com', 'kayla'));
    expect(profiles().map((p) => p.session.username)).toEqual(['kayla', 'matt']);
  });

  it('re-signing in as the same person on the same box replaces the card, not stacks it', () => {
    rememberProfile(session('https://home.example.com', 'matt'));
    rememberProfile({ ...session('https://home.example.com', 'matt'), token: 'fresher' });
    expect(profiles()).toHaveLength(1);
    expect(profiles()[0]?.session.token).toBe('fresher');
  });

  it('keeps two people on one box apart', () => {
    rememberProfile(session('https://home.example.com', 'matt'));
    rememberProfile(session('https://home.example.com', 'kayla'));
    expect(profiles()).toHaveLength(2);
  });

  it('keeps one person on two boxes apart', () => {
    // Identity is (server, username): the same name on a friend's hub is a
    // different account entirely.
    rememberProfile(session('https://home.example.com', 'matt'));
    rememberProfile(session('https://vps.example.com', 'matt'));
    expect(profiles()).toHaveLength(2);
  });

  it('forgets one and leaves the rest', () => {
    rememberProfile(session('https://home.example.com', 'matt'));
    rememberProfile(session('https://home.example.com', 'kayla'));
    forgetProfile(session('https://home.example.com', 'matt'));
    expect(profiles().map((p) => p.session.username)).toEqual(['kayla']);
  });

  it('survives a relaunch', () => {
    rememberProfile(session('https://home.example.com', 'matt'));
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toHaveLength(1);
    expect(profiles()[0]?.session.username).toBe('matt');
  });
});

describe('otherProfiles', () => {
  beforeEach(() => {
    rememberProfile(session('https://home.example.com', 'matt'));
    rememberProfile(session('https://home.example.com', 'kayla'));
  });

  it('is who this device could switch to right now', () => {
    const others = otherProfiles(session('https://home.example.com', 'matt'));
    expect(others.map((p) => p.session.username)).toEqual(['kayla']);
  });

  it('is everybody when nobody is signed in', () => {
    expect(otherProfiles(null)).toHaveLength(2);
  });

  it('excludes only the same name on the same box', () => {
    expect(otherProfiles(session('https://vps.example.com', 'matt'))).toHaveLength(2);
  });
});

describe('what was written down last time', () => {
  it('reads unparseable storage as nobody', () => {
    localStorage.setItem(KEY, 'not json');
    expect(profiles()).toEqual([]);
  });

  it('reads a non-list as nobody', () => {
    localStorage.setItem(KEY, JSON.stringify({ matt: {} }));
    expect(profiles()).toEqual([]);
  });

  it('drops a card that could not be signed in with', () => {
    // A row with no token or no url is not a session; keeping it would put a
    // dead face on the switcher.
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { usedAt: 1, session: { url: 'https://home.example.com', token: 'ok', username: 'matt' } },
        { usedAt: 2, session: { url: 'https://home.example.com', username: 'kayla' } },
        { usedAt: 3, session: { token: 'ok', username: 'sam' } },
        { session: { url: 'https://home.example.com', token: 'ok', username: 'ana' } },
        null,
      ]),
    );
    expect(profiles().map((p) => p.session.username)).toEqual(['matt']);
  });
});
