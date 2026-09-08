import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '../api/http.ts';

/*
 * Two ledgers and one network call are stubbed so the subject is the RESOLUTION
 * ORDER: owner, then the box's own name, then the known-servers card, then the
 * mirror card, then the bare host. `./sessions.ts` is left real - the labeller
 * reads it to decide whether a label is worth showing at all.
 */
const { knownServers, mirrorList, fetchServerInfo } = vi.hoisted(() => ({
  knownServers: vi.fn(() => [] as { url: string; name?: string }[]),
  mirrorList: vi.fn(() => [] as { url: string; name?: string }[]),
  fetchServerInfo: vi.fn(),
}));
vi.mock('./servers.ts', () => ({ knownServers }));
vi.mock('./mirrors.ts', () => ({ mirrorList }));
vi.mock('../api/auth.ts', () => ({ fetchServerInfo }));

const HOME = 'https://home.example.com';

function session(url = HOME): ServerSession {
  return { url, token: 't', streamToken: 's', username: 'matt', isAdmin: false };
}

async function fresh() {
  vi.resetModules();
  return import('./serverNames.ts');
}

beforeEach(() => {
  localStorage.clear();
  knownServers.mockReturnValue([]);
  mirrorList.mockReturnValue([]);
  fetchServerInfo.mockReset();
});

describe('serverLabelFor', () => {
  it('says nothing about no server', async () => {
    const n = await fresh();
    expect(n.serverLabelFor(null)).toBeNull();
    expect(n.serverLabelFor(undefined)).toBeNull();
    expect(n.serverLabelFor('')).toBeNull();
  });

  it('prefers the OWNER, which is the name a friend recognises', async () => {
    // "Matt's server" is what a friend recognises; "AttackFM (home)" is what
    // the box calls itself.
    const n = await fresh();
    n.rememberServerName(HOME, { name: 'AttackFM (home)', owner: 'Matt' });
    expect(n.serverLabelFor(HOME)).toBe("Matt's server");
  });

  it('spells the possessive the way the invite card does', async () => {
    const n = await fresh();
    n.rememberServerName(HOME, { owner: 'Chris' });
    expect(n.serverLabelFor(HOME)).toBe("Chris' server");
  });

  it('falls back to the box s own name when nobody owns it by name', async () => {
    const n = await fresh();
    n.rememberServerName(HOME, { name: 'AttackFM (home)' });
    expect(n.serverLabelFor(HOME)).toBe('AttackFM (home)');
  });

  it('then to the known-servers card', async () => {
    const n = await fresh();
    knownServers.mockReturnValue([{ url: `${HOME}/`, name: 'The Cupboard' }]);
    expect(n.serverLabelFor(HOME)).toBe('The Cupboard');
  });

  it('then to a mirror card', async () => {
    const n = await fresh();
    mirrorList.mockReturnValue([{ url: HOME, name: 'The Loft' }]);
    expect(n.serverLabelFor(HOME)).toBe('The Loft');
  });

  it('and finally to the bare host', async () => {
    const n = await fresh();
    expect(n.serverLabelFor('https://home.example.com/music')).toBe('home.example.com');
    expect(n.serverLabelFor('http://192.168.1.9:8787')).toBe('192.168.1.9:8787');
  });

  it('still says something for an address that will not parse', async () => {
    const n = await fresh();
    expect(n.serverLabelFor('https://not a url')).toBe('not a url');
  });

  it('does not let a trailing slash or a capital hide a learned name', async () => {
    const n = await fresh();
    n.rememberServerName('https://Home.Example.com/', { owner: 'Matt' });
    expect(n.serverLabelFor(HOME)).toBe("Matt's server");
    expect(n.serverLabelFor('https://HOME.example.com//')).toBe("Matt's server");
  });
});

describe('rememberServerName', () => {
  it('merges, so learning a name later does not lose the owner', async () => {
    const n = await fresh();
    n.rememberServerName(HOME, { owner: 'Matt' });
    n.rememberServerName(HOME, { name: 'AttackFM (home)' });
    expect(n.serverLabelFor(HOME)).toBe("Matt's server");
  });

  it('ignores a blank, so a box that answers with empty strings does not erase what we knew', async () => {
    const n = await fresh();
    n.rememberServerName(HOME, { owner: 'Matt' });
    n.rememberServerName(HOME, { owner: '   ', name: '' });
    expect(n.serverLabelFor(HOME)).toBe("Matt's server");
  });

  it('trims what it stores', async () => {
    const n = await fresh();
    n.rememberServerName(HOME, { name: '  The Cupboard  ' });
    expect(n.serverLabelFor(HOME)).toBe('The Cupboard');
  });

  it('says nothing to its listeners when nothing actually changed', async () => {
    // The probe calls this once a second for every server the app watches; a
    // beat per probe would re-render every row that reads a label.
    const n = await fresh();
    n.rememberServerName(HOME, { owner: 'Matt' });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    n.rememberServerName(HOME, { owner: 'Matt' });
    n.rememberServerName(HOME, { owner: '' });
    expect(write).not.toHaveBeenCalled();
    expect(n.serverLabelFor(HOME)).toBe("Matt's server");
  });

  it('survives a relaunch', async () => {
    const first = await fresh();
    first.rememberServerName(HOME, { owner: 'Matt' });
    const second = await fresh();
    expect(second.serverLabelFor(HOME)).toBe("Matt's server");
  });

  it('reads unparseable storage as nothing learned', async () => {
    localStorage.setItem('attackfm-server-names', 'not json');
    const n = await fresh();
    expect(n.serverLabelFor(HOME)).toBe('home.example.com');
  });
});

describe('learnServerName', () => {
  it('asks a box once per launch and remembers what it said', async () => {
    const n = await fresh();
    fetchServerInfo.mockResolvedValue({ name: 'AttackFM (home)', owner: 'Matt' });
    n.learnServerName(session());
    n.learnServerName(session(`${HOME}/`));
    await vi.waitFor(() => expect(n.serverLabelFor(HOME)).toBe("Matt's server"));
    expect(fetchServerInfo).toHaveBeenCalledTimes(1);
  });

  it('re-arms after a failure, so a box that was asleep is asked again', async () => {
    const n = await fresh();
    fetchServerInfo.mockRejectedValueOnce(new Error('asleep')).mockResolvedValueOnce({ name: 'AttackFM (home)' });
    n.learnServerName(session());
    // Asking again is a no-op until the failure has un-marked the url, so the
    // retry itself is what is being waited for.
    await vi.waitFor(() => {
      n.learnServerName(session());
      expect(fetchServerInfo).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => expect(n.serverLabelFor(HOME)).toBe('AttackFM (home)'));
  });
});
