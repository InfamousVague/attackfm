import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REGISTRY_URL,
  RegistryError,
  SHARE_URL,
  announce,
  fetchFriends,
  fetchJamShare,
  fetchMemberships,
  fetchPlaylistShare,
  fetchRegistryProfile,
  fetchShares,
  forgetMembership,
  inviteLink,
  jamShareLink,
  login,
  mintRecoveryCodes,
  playlistShareLink,
  previewInvite,
  profileLink,
  recordMembership,
  removeFriend,
  uploadProfileImage,
} from './registry.ts';

/** The last fetch, decoded: where it went, how, and what it carried. */
interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

let sent: Sent[] = [];

/** A registry that answers with `body` (a string is sent verbatim, so a test
 *  can hand back an EMPTY 200 - which several of these routes really do). */
function answering(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, req: RequestInit) => {
      const headers = new Headers(req.headers);
      sent.push({
        url,
        method: req.method ?? 'GET',
        headers,
        body: typeof req.body === 'string' ? (JSON.parse(req.body) as unknown) : req.body,
      });
      return Promise.resolve({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        statusText: init.statusText ?? 'OK',
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(JSON.parse(text) as unknown),
      });
    }),
  );
}

function last(): Sent {
  const it = sent.at(-1);
  if (!it) throw new Error('nothing was sent');
  return it;
}

beforeEach(() => {
  sent = [];
});

describe('call', () => {
  it('sends the token as a bearer, and only when there is one', async () => {
    answering({});
    await fetchFriends('reg-token');
    expect(last().headers.get('authorization')).toBe('Bearer reg-token');

    await previewInvite('CODE12');
    expect(last().headers.get('authorization')).toBeNull();
  });

  it('declares JSON only when it is actually sending some', async () => {
    answering({});
    await login('matt', 'hunter2');
    expect(last().headers.get('content-type')).toBe('application/json');

    await removeFriend('reg-token', 9);
    expect(last().body).toBeUndefined();
    expect(last().headers.get('content-type')).toBeNull();
  });

  it('reads an EMPTY 200 as an empty answer rather than throwing on the parse', async () => {
    // Several of these routes answer 200 with no body at all.
    answering('');
    await expect(announce('reg-token', { songs: 12 })).resolves.toBeUndefined();
  });

  it('carries the registry s own words on a refusal', async () => {
    answering('that handle is taken', { ok: false, status: 409, statusText: 'Conflict' });
    await expect(login('matt', 'nope')).rejects.toMatchObject({
      status: 409,
      message: 'that handle is taken',
      name: 'RegistryError',
    });
  });

  it('falls back to the status line when the refusal had no words', async () => {
    answering('', { ok: false, status: 502, statusText: 'Bad Gateway' });
    await expect(login('matt', 'nope')).rejects.toThrow('502 Bad Gateway');
    await expect(login('matt', 'nope')).rejects.toBeInstanceOf(RegistryError);
  });

  it('talks to the API host, not the share host', async () => {
    answering({});
    await fetchFriends('reg-token');
    expect(last().url).toBe(`${REGISTRY_URL}/v1/friends`);
  });
});

describe('what an older registry leaves out', () => {
  it('reads a friends feed with no lists as three empty lists', async () => {
    answering({});
    await expect(fetchFriends('reg-token')).resolves.toEqual({ friends: [], incoming: [], outgoing: [] });
  });

  it('keeps the lists it does send', async () => {
    answering({ friends: [{ id: 1, handle: 'kayla' }], outgoing: [{ id: 4, accountId: 2, handle: 'sam' }] });
    const feed = await fetchFriends('reg-token');
    expect(feed.friends).toHaveLength(1);
    expect(feed.incoming).toEqual([]);
    expect(feed.outgoing).toHaveLength(1);
  });

  it('reads a share inbox with no `inbox` as no shares', async () => {
    answering({});
    await expect(fetchShares('reg-token')).resolves.toEqual([]);
  });

  it('reads a memberships reply with none as none', async () => {
    answering({});
    await expect(fetchMemberships('reg-token')).resolves.toEqual([]);
  });

  it('reads a recovery mint with no codes as none, rather than as undefined', async () => {
    answering({});
    await expect(mintRecoveryCodes('reg-token')).resolves.toEqual([]);
  });
});

describe('the links a person is asked to pass around', () => {
  it('wear the bare name, never the API subdomain', async () => {
    // Two constants, one job each. `registry.` is an implementation detail
    // leaking into the one string the app asks people to send each other.
    expect(SHARE_URL).not.toBe(REGISTRY_URL);
    for (const link of [inviteLink('CODE12'), playlistShareLink('AB2CDE'), jamShareLink('ROOM7'), profileLink('matt')]) {
      expect(link.startsWith(`${SHARE_URL}/`)).toBe(true);
      expect(link).not.toContain('registry.');
    }
  });

  it('use the path each door reads', () => {
    expect(inviteLink('CODE12')).toBe(`${SHARE_URL}/i/CODE12`);
    expect(playlistShareLink('AB2CDE')).toBe(`${SHARE_URL}/p/AB2CDE`);
    expect(jamShareLink('ROOM7')).toBe(`${SHARE_URL}/j/ROOM7`);
    expect(profileLink('matt')).toBe(`${SHARE_URL}/u/matt`);
  });

  it('escape a handle that is not URL-safe', () => {
    expect(profileLink('mr matt')).toBe(`${SHARE_URL}/u/mr%20matt`);
    expect(profileLink('a/b')).toBe(`${SHARE_URL}/u/a%2Fb`);
  });
});

describe('the codes that go into a path', () => {
  it('are escaped, so a stray slash cannot reach a different route', async () => {
    answering({});
    await fetchPlaylistShare('a/b');
    expect(last().url).toBe(`${REGISTRY_URL}/v1/playlists/share/a%2Fb`);

    await fetchJamShare('a b');
    expect(last().url).toBe(`${REGISTRY_URL}/v1/jams/share/a%20b`);

    await previewInvite('a?b');
    expect(last().url).toBe(`${REGISTRY_URL}/v1/invites/a%3Fb`);

    await fetchRegistryProfile('reg-token', 'mr matt');
    expect(last().url).toBe(`${REGISTRY_URL}/v1/profile/mr%20matt`);
  });
});

describe('memberships', () => {
  it('fills in the parts a caller left off', async () => {
    answering({});
    await recordMembership('reg-token', { serverUrl: 'https://home.example.com' });
    expect(last().body).toEqual({ serverUrl: 'https://home.example.com', serverName: '', role: 'member' });
  });

  it('forgets through the SAME route, with a flag', async () => {
    answering({});
    await forgetMembership('reg-token', 'https://home.example.com');
    expect(last().url).toBe(`${REGISTRY_URL}/v1/memberships`);
    expect(last().body).toEqual({ serverUrl: 'https://home.example.com', forget: true });
  });
});

describe('uploadProfileImage', () => {
  it('sends the picture as the whole body, with no multipart wrapper', async () => {
    answering({ url: 'https://cdn.example.com/a.jpg', updatedAt: 7 });
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    await expect(uploadProfileImage('reg-token', 'avatar', blob)).resolves.toEqual({
      url: 'https://cdn.example.com/a.jpg',
      updatedAt: 7,
    });
    expect(last().method).toBe('PUT');
    expect(last().url).toBe(`${REGISTRY_URL}/v1/profile/image/avatar`);
    expect(last().body).toBe(blob);
  });

  it('says why a picture was refused, in the registry s words', async () => {
    answering('that is not an image', { ok: false, status: 415 });
    const blob = new Blob(['x']);
    await expect(uploadProfileImage('reg-token', 'banner', blob)).rejects.toThrow('that is not an image');
  });
});
