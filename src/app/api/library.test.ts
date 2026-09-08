import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from './http.ts';
import type { RemoteTrack } from './library.ts';
import {
  artSized,
  artUrl,
  fetchTrack,
  fromHub,
  isRemotePath,
  originFromPath,
  remotePath,
  streamUrl,
  syncLibrary,
  toTrack,
  trackIdFromPath,
  tracksOfHub,
} from './library.ts';

const { request, ServerError, loadCachedIndex, saveCachedIndex } = vi.hoisted(() => {
  class FakeServerError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    request: vi.fn(),
    ServerError: FakeServerError,
    loadCachedIndex: vi.fn(),
    saveCachedIndex: vi.fn(),
  };
});

vi.mock('./http.ts', () => ({ request, ServerError }));
vi.mock('./libraryCache.ts', () => ({ loadCachedIndex, saveCachedIndex }));

const session: ServerSession = {
  url: 'https://home.example.com',
  token: 'tok',
  streamToken: 'stream tok/+',
  username: 'matt',
  isAdmin: false,
};
const other: ServerSession = { ...session, url: 'https://vps.example.com' };

function row(over: Partial<RemoteTrack> = {}): RemoteTrack {
  return {
    id: 42,
    title: 'Alright',
    artist: 'Kendrick Lamar',
    albumArtist: 'Kendrick Lamar',
    album: 'To Pimp a Butterfly',
    trackNo: 7,
    discNo: 1,
    year: 2015,
    genre: 'Hip-Hop',
    lyrics: '',
    duration: 219,
    codec: 'flac',
    lossless: true,
    sampleRate: 44100,
    bitDepth: 16,
    channels: 2,
    bitrate: 900,
    sizeBytes: 1234,
    addedAt: 1_700_000_000,
    artId: null,
    rev: 3,
    ...over,
  };
}

beforeEach(() => {
  request.mockReset();
  loadCachedIndex.mockReset();
  saveCachedIndex.mockReset();
  loadCachedIndex.mockReturnValue({ rev: 0, tracks: [] });
});

describe('the remote path', () => {
  it('writes the untagged form for the server the app is on', () => {
    // Byte-identical to every path already written into a playlist, a
    // favourite or a saved queue. Tagging those would orphan them.
    expect(remotePath(42)).toBe('afm://42');
    expect(remotePath(42, null)).toBe('afm://42');
  });

  it('encodes an origin so it cannot contain a character the path means', () => {
    const path = remotePath(42, 'https://home.example.com');
    const encoded = path.slice('afm://42@'.length);
    expect(path.startsWith('afm://42@')).toBe(true);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('reads the id back out of either form', () => {
    expect(trackIdFromPath('afm://42')).toBe(42);
    expect(trackIdFromPath(remotePath(42, 'https://vps.example.com'))).toBe(42);
  });

  it('has no id for a path that is not a remote one', () => {
    expect(trackIdFromPath('/Users/matt/Music/track.flac')).toBeNull();
    expect(isRemotePath('/Users/matt/Music/track.flac')).toBe(false);
    expect(isRemotePath('afm://42')).toBe(true);
  });

  it('round-trips an origin through the path', () => {
    for (const url of ['https://home.example.com', 'http://192.168.1.9:8787', 'https://a.b.c/music']) {
      expect(originFromPath(remotePath(7, url))).toBe(url);
    }
  });

  it('reads an untagged path as "whichever server is current"', () => {
    // Null is the answer for every path written before multi-server existed.
    expect(originFromPath('afm://42')).toBeNull();
    expect(originFromPath('/Users/matt/Music/track.flac')).toBeNull();
  });

  it('reads an origin it cannot decode as the current server rather than as unplayable', () => {
    expect(originFromPath('afm://42@!!!not-base64!!!')).toBeNull();
  });
});

describe('fromHub / tracksOfHub', () => {
  it('counts an untagged path as this hub s', () => {
    expect(fromHub('afm://42', 'https://home.example.com')).toBe(true);
  });

  it('counts a tagged path only for the hub it names', () => {
    // With two hubs merged into one library, #42 exists on both; a map built
    // from every row hands the stats page the wrong hub's song.
    const tagged = remotePath(42, 'https://vps.example.com');
    expect(fromHub(tagged, 'https://vps.example.com')).toBe(true);
    expect(fromHub(tagged, 'https://home.example.com')).toBe(false);
  });

  it('keeps only this hub s rows', () => {
    const rows = [
      { path: 'afm://1' },
      { path: remotePath(2, 'https://vps.example.com') },
      { path: remotePath(3, 'https://home.example.com') },
    ];
    expect(tracksOfHub(rows, session).map((t) => t.path)).toEqual([rows[0]?.path, rows[2]?.path]);
  });

  it('a local library has only one place to be from - and gets a COPY', () => {
    const rows = [{ path: '/music/a.flac' }];
    const out = tracksOfHub(rows, null);
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });
});

describe('toTrack', () => {
  it('leaves the primary library s paths untagged', () => {
    expect(toTrack(session, row()).path).toBe('afm://42');
  });

  it('stamps the origin only when asked', () => {
    const track = toTrack(other, row(), true);
    expect(originFromPath(track.path)).toBe('https://vps.example.com');
    expect(track.origin).toBe('https://vps.example.com');
  });

  it('carries the origin field even on an untagged path', () => {
    // The path stays byte-stable; the field says which session built the row.
    expect(toTrack(other, row()).origin).toBe('https://vps.example.com');
  });

  it('has no artwork when the row has no art id', () => {
    expect(toTrack(session, row({ artId: null })).artwork).toBeNull();
  });

  it('builds an art URL that carries the stream token and names its song', () => {
    const track = toTrack(session, row({ artId: 'ab/cd' }));
    expect(track.artwork).toBe(artUrl(session, 'ab/cd', 42));
    expect(track.artwork).toContain('/api/art/ab%2Fcd');
    // The inert `track` param is what lets a FAILING cover ask a mirror.
    expect(track.artwork).toContain('&track=42');
    expect(track.artwork).toContain(`t=${encodeURIComponent(session.streamToken)}`);
  });

  it('reads a row from before audiobooks as music', () => {
    expect(toTrack(session, row()).kind).toBe('music');
    expect(toTrack(session, row({ kind: 'book' })).kind).toBe('book');
  });

  it('drops an EMPTY chapter list rather than passing an empty array on', () => {
    expect(toTrack(session, row({ chapters: [] })).chapters).toBeUndefined();
    expect(toTrack(session, row()).chapters).toBeUndefined();
    expect(toTrack(session, row({ chapters: [{ title: 'One', startMs: 0 }] })).chapters).toHaveLength(1);
  });

  it('turns an empty albumArtist into null, not an empty string', () => {
    expect(toTrack(session, row({ albumArtist: '' })).albumArtist).toBeNull();
    expect(toTrack(session, row({ albumArtist: 'Kendrick Lamar' })).albumArtist).toBe('Kendrick Lamar');
  });

  it('keeps a curator id of 0 rather than folding it into "nobody"', () => {
    // `?? null`, not `|| null`: user 0 is a user.
    expect(toTrack(session, row({ curatorUserId: 0 })).curatorUserId).toBe(0);
    expect(toTrack(session, row()).curatorUserId).toBeNull();
    expect(toTrack(session, row()).curatorPromoted).toBe(false);
    expect(toTrack(session, row({ curatorPromoted: true })).curatorPromoted).toBe(true);
  });
});

describe('artSized', () => {
  it('asks the server for a thumbnail', () => {
    expect(artSized('https://h.example.com/api/art/x', 160)).toBe('https://h.example.com/api/art/x?size=160');
  });

  it('joins onto a query that is already there', () => {
    expect(artSized('https://h.example.com/api/art/x?t=abc', 640)).toBe('https://h.example.com/api/art/x?t=abc&size=640');
  });

  it('leaves a blob URL entirely alone', () => {
    // A query string BREAKS a blob: URL - the blob store keys on the whole
    // serialized string.
    const blob = 'blob:http://localhost/6f0a-11e0';
    expect(artSized(blob, 160)).toBe(blob);
  });

  it('has nothing to size when there is no cover', () => {
    expect(artSized(null, 160)).toBeNull();
  });
});

describe('streamUrl', () => {
  it('escapes the stream token it puts in the query string', () => {
    expect(streamUrl(session, 42)).toBe(
      `https://home.example.com/api/stream/42?t=${encodeURIComponent('stream tok/+')}`,
    );
  });
});

describe('syncLibrary', () => {
  it('drains every page and folds them into one library', async () => {
    request
      .mockResolvedValueOnce({ rev: 1, more: true, tracks: [row({ id: 1 }), row({ id: 2 })], removed: [] })
      .mockResolvedValueOnce({ rev: 2, more: false, tracks: [row({ id: 3 })], removed: [] });
    const out = await syncLibrary(session);
    expect(out.tracks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(out.changed).toBe(true);
    expect(saveCachedIndex).toHaveBeenCalledWith('https://home.example.com', {
      rev: 2,
      tracks: out.tracks,
    });
  });

  it('asks each page from where the last one left off', async () => {
    request
      .mockResolvedValueOnce({ rev: 5, more: true, tracks: [], removed: [] })
      .mockResolvedValueOnce({ rev: 9, more: false, tracks: [], removed: [] });
    loadCachedIndex.mockReturnValue({ rev: 3, tracks: [] });
    await syncLibrary(session);
    expect((request.mock.calls[0] as [string, string])[1]).toBe('/api/library?since=3');
    expect((request.mock.calls[1] as [string, string])[1]).toBe('/api/library?since=5');
  });

  it('applies a removal against the cache', async () => {
    loadCachedIndex.mockReturnValue({ rev: 1, tracks: [row({ id: 1 }), row({ id: 2 })] });
    request.mockResolvedValueOnce({ rev: 2, more: false, tracks: [], removed: [1] });
    const out = await syncLibrary(session);
    expect(out.tracks.map((t) => t.id)).toEqual([2]);
    expect(out.changed).toBe(true);
  });

  it('replaces a row the server sent again rather than filing it twice', async () => {
    loadCachedIndex.mockReturnValue({ rev: 1, tracks: [row({ id: 1, title: 'old' })] });
    request.mockResolvedValueOnce({ rev: 2, more: false, tracks: [row({ id: 1, title: 'new' })], removed: [] });
    const out = await syncLibrary(session);
    expect(out.tracks).toHaveLength(1);
    expect(out.tracks[0]?.title).toBe('new');
  });

  it('writes nothing on a settled pass - the heartbeat s usual answer', async () => {
    loadCachedIndex.mockReturnValue({ rev: 7, tracks: [row({ id: 1 })] });
    request.mockResolvedValueOnce({ rev: 7, more: false, tracks: [], removed: [] });
    const out = await syncLibrary(session);
    expect(out.changed).toBe(false);
    expect(saveCachedIndex).not.toHaveBeenCalled();
  });

  it('still writes when only the rev moved', async () => {
    // Nothing changed for the caller, but the next sync must ask from here.
    loadCachedIndex.mockReturnValue({ rev: 7, tracks: [row({ id: 1 })] });
    request.mockResolvedValueOnce({ rev: 8, more: false, tracks: [], removed: [] });
    const out = await syncLibrary(session);
    expect(out.changed).toBe(false);
    expect(saveCachedIndex).toHaveBeenCalledWith('https://home.example.com', { rev: 8, tracks: out.tracks });
  });

  it('stops rather than spinning forever on a server that always says "more"', async () => {
    request.mockResolvedValue({ rev: 1, more: true, tracks: [], removed: [] });
    await syncLibrary(session);
    expect(request).toHaveBeenCalledTimes(200);
  });

  it('reports pages as they land', async () => {
    request
      .mockResolvedValueOnce({ rev: 1, more: true, tracks: [row({ id: 1 })], removed: [] })
      .mockResolvedValueOnce({ rev: 2, more: false, tracks: [row({ id: 2 })], removed: [] });
    const seen: number[] = [];
    await syncLibrary(session, { onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([1, 2]);
  });
});

describe('fetchTrack', () => {
  it('builds the same path the listing would have produced', async () => {
    request.mockResolvedValue(row({ id: 42 }));
    const track = await fetchTrack(session, 42);
    expect(track?.path).toBe('afm://42');
  });

  it('reads a 404 as "nothing to play here", which is also what an older hub says', async () => {
    request.mockRejectedValue(new ServerError(404, 'no such track'));
    await expect(fetchTrack(session, 42)).resolves.toBeNull();
  });

  it('lets anything else through', async () => {
    // A 500 is not "no such song", and swallowing it would hide an outage.
    request.mockRejectedValue(new ServerError(500, 'boom'));
    await expect(fetchTrack(session, 42)).rejects.toThrow('boom');
  });
});
