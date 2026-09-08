import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerError, deviceLabel, normalizeServerUrl, request } from './http.ts';
import { noteServerAnswered, serverSeemsDown } from './reachability.ts';

/* The diag log is a sink; reachability is deliberately left REAL, because the
   contract between these two modules - what counts as "the server is gone" -
   is one of the things worth pinning. */
vi.mock('../diag/diagLog.ts', () => ({
  recordDiag: vi.fn(),
  describeFailure: (e: unknown) => String(e),
  redactUrl: (u: string) => u,
}));

interface Answer {
  ok?: boolean;
  status?: number;
  statusText?: string;
  /** The body, as text. `undefined` means "not JSON at all". */
  json?: unknown;
  text?: string;
}

let calls: { url: string; init: RequestInit }[] = [];

function answering(answer: Answer = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: answer.ok ?? true,
        status: answer.status ?? 200,
        statusText: answer.statusText ?? 'OK',
        text: () => Promise.resolve(answer.text ?? JSON.stringify(answer.json ?? {})),
        json: () =>
          answer.text !== undefined
            ? Promise.reject(new SyntaxError('Unexpected token <'))
            : Promise.resolve(answer.json ?? {}),
      });
    }),
  );
}

/** A door nobody answers - the phone hopped networks mid-flight. */
function silent() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.reject(new TypeError('Load failed'));
    }),
  );
}

function headersOf(i = 0): Headers {
  return new Headers(calls[i]?.init.headers);
}

function userAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => ua });
}

beforeEach(() => {
  calls = [];
  // The flag is module state shared by every test in this file.
  noteServerAnswered();
});

afterEach(() => {
  noteServerAnswered();
});

describe('normalizeServerUrl', () => {
  it('assumes TLS for a bare host, because anything a phone reaches should have it', () => {
    expect(normalizeServerUrl('music.example.com')).toBe('https://music.example.com');
    expect(normalizeServerUrl('192.168.1.9:8787')).toBe('https://192.168.1.9:8787');
  });

  it('leaves a scheme somebody typed alone', () => {
    expect(normalizeServerUrl('http://192.168.1.9:8787')).toBe('http://192.168.1.9:8787');
    expect(normalizeServerUrl('HTTPS://music.example.com')).toBe('HTTPS://music.example.com');
  });

  it('takes the trailing slashes and the whitespace off', () => {
    expect(normalizeServerUrl('  https://music.example.com///  ')).toBe('https://music.example.com');
  });

  it('has nothing to normalise about nothing', () => {
    expect(normalizeServerUrl('')).toBe('');
    expect(normalizeServerUrl('   ')).toBe('');
  });
});

describe('deviceLabel', () => {
  it('reads each platform off the user agent', () => {
    const cases: [string, string][] = [
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36', 'Android'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'iPhone'],
      ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'iPad'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'macOS'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Windows'],
      ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'Linux'],
      ['something nobody has ever shipped', 'web'],
    ];
    for (const [ua, expected] of cases) {
      userAgent(ua);
      expect(deviceLabel()).toBe(expected);
    }
  });

  it('is written in the ONE order that gets Android and iPadOS right', () => {
    // Android's UA also says "Linux"; an iPad on iPadOS 13+ claims to be a
    // Macintosh and gives itself away only with "Mobile". Reorder these tests
    // and both devices start reporting as something else.
    userAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)');
    expect(deviceLabel()).toBe('Android');
    userAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148');
    expect(deviceLabel()).toBe('iPad');
  });
});

describe('request', () => {
  it('carries the session token as a bearer, and says what this device is', () => {
    // The device name is what lets a hub list "iPhone" and "macOS" as two
    // sessions and let you end one of them.
    userAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    answering({ json: { ok: true } });
    return request('https://home.example.com', '/api/library', { token: 'tok' }).then(() => {
      expect(calls[0]?.url).toBe('https://home.example.com/api/library');
      expect(headersOf().get('authorization')).toBe('Bearer tok');
      expect(headersOf().get('x-afm-device')).toBe('iPhone');
    });
  });

  it('sends no authorization at all when there is no token', async () => {
    answering();
    await request('https://home.example.com', '/api/server');
    expect(headersOf().get('authorization')).toBeNull();
  });

  it('declares JSON only when there is a body', async () => {
    answering();
    await request('https://home.example.com', '/api/x', { method: 'POST', body: '{"a":1}' });
    expect(headersOf().get('content-type')).toBe('application/json');
    await request('https://home.example.com', '/api/x', { method: 'POST' });
    expect(headersOf(1).get('content-type')).toBeNull();
  });

  it('does not overwrite a content type the caller chose', async () => {
    answering();
    await request('https://home.example.com', '/api/x', {
      method: 'POST',
      body: 'raw',
      headers: { 'content-type': 'image/jpeg' },
    });
    expect(headersOf().get('content-type')).toBe('image/jpeg');
  });

  it('hands back the parsed body', async () => {
    answering({ json: { tracks: [1, 2, 3] } });
    await expect(request('https://home.example.com', '/api/x')).resolves.toEqual({ tracks: [1, 2, 3] });
  });
});

describe('what a refusal says', () => {
  it('puts the server s own plain-text words in the error, which is what belongs in a toast', async () => {
    answering({ ok: false, status: 403, text: 'that friend is not on this server' });
    await expect(request('https://home.example.com', '/api/jams/invite')).rejects.toMatchObject({
      status: 403,
      message: 'that friend is not on this server',
    });
  });

  it('is a ServerError, so a caller can tell a 403 from a 404 without parsing words', async () => {
    // Every retry-once-then-give-up path in the app keys on the status.
    answering({ ok: false, status: 404, text: 'nope' });
    const err = await request('https://home.example.com', '/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as ServerError).status).toBe(404);
  });

  it('falls back to the status line when the body was empty', async () => {
    answering({ ok: false, status: 502, statusText: 'Bad Gateway', text: '' });
    await expect(request('https://home.example.com', '/api/x')).rejects.toThrow('502 Bad Gateway');
  });

  it('throws on a 200 whose body is not JSON - a captive portal, not a server bug', async () => {
    answering({ text: '<html>sign in to the wifi</html>' });
    await expect(request('https://home.example.com', '/api/x')).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('what teaches the reachability flag', () => {
  it('counts a transport failure as nobody answering the door', async () => {
    silent();
    await expect(request('https://home.example.com', '/api/x')).rejects.toThrow('Load failed');
    expect(serverSeemsDown()).toBe(false);
    await expect(request('https://home.example.com', '/api/x')).rejects.toThrow('Load failed');
    expect(serverSeemsDown()).toBe(true);
  });

  it('counts a 500 as the server TALKING', async () => {
    // Treating an error page as an outage would send the app to the vault
    // over a bad request.
    silent();
    await request('https://home.example.com', '/api/x').catch(() => null);
    await request('https://home.example.com', '/api/x').catch(() => null);
    expect(serverSeemsDown()).toBe(true);

    answering({ ok: false, status: 500, text: 'boom' });
    await request('https://home.example.com', '/api/x').catch(() => null);
    expect(serverSeemsDown()).toBe(false);
  });

  it('counts a non-JSON 200 as the server talking too', async () => {
    silent();
    await request('https://home.example.com', '/api/x').catch(() => null);
    await request('https://home.example.com', '/api/x').catch(() => null);
    answering({ text: '<html/>' });
    await request('https://home.example.com', '/api/x').catch(() => null);
    expect(serverSeemsDown()).toBe(false);
  });
});

describe('the deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch that never settles unless it is aborted - the black hole an
   *  established connection becomes when a phone changes network. */
  function blackHole() {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            // A real fetch rejects at once for a signal that is ALREADY
            // aborted, which is the case when the caller's own signal was
            // dead before the request was made.
            if (init.signal?.aborted) return reject(init.signal.reason as Error);
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
          }),
      ),
    );
  }

  it('gives up rather than leaving every await upstream a zombie', async () => {
    blackHole();
    const pending = request('https://home.example.com', '/api/x');
    const settled = expect(pending).rejects.toThrow('request timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
  });

  it('lets a long-running endpoint opt into more without weakening the default', async () => {
    blackHole();
    const pending = request('https://home.example.com', '/api/ai', { timeoutMs: 120_000 });
    const settled = expect(pending).rejects.toThrow('request timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(90_000);
    await settled;
  });

  it('answers an outer signal that is already aborted, without waiting on the network', async () => {
    blackHole();
    const outer = AbortSignal.abort(new Error('the screen went away'));
    await expect(request('https://home.example.com', '/api/x', { signal: outer })).rejects.toThrow(
      'the screen went away',
    );
  });

  it('answers an outer signal aborted mid-flight', async () => {
    blackHole();
    const outer = new AbortController();
    const pending = request('https://home.example.com', '/api/x', { signal: outer.signal });
    const settled = expect(pending).rejects.toThrow('the screen went away');
    outer.abort(new Error('the screen went away'));
    await settled;
  });
});
