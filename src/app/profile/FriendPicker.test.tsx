import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { openFriendPicker, type FriendPick } from '../nav/friendPickerDoor.ts';
import { FriendPicker } from './FriendPicker.tsx';

/*
 * THE FRIEND-MIRROR WINDOW, from the picker's side.
 *
 * Friendships live on the registry and reach a hub on a ten-minute mirror, so
 * for up to ten minutes a person can be a MEMBER of this box and not yet a
 * friend of it. The old picker was fed by the registry alone, so that person
 * simply was not offered - and being on the box is the hub's rule for a
 * playlist seat, so they were being kept out of a list they were entitled to.
 *
 * What this file pins is the merge and the gate: who appears, who can be
 * picked, and - the part that "blamed the wrong thing" - that a member here,
 * a friend here and a friend elsewhere each get their OWN sentence. The words
 * are asserted as translation KEYS, so the test says "these three are
 * different" without owning a word of English copy.
 */

const { fetchMembers, fetchRegistryFriends } = vi.hoisted(() => ({
  fetchMembers: vi.fn(),
  fetchRegistryFriends: vi.fn(),
}));

vi.mock('../api/friends.ts', () => ({ fetchMembers }));
vi.mock('../servers/registry.ts', () => ({
  fetchFriends: fetchRegistryFriends,
  // `player/grooveEntry.ts` (real, for `sameHub`) reaches for these two.
  fetchJamShare: vi.fn(),
  RegistryError: class extends Error {},
}));
vi.mock('../ux/useNarrowViewport.ts', () => ({ useNarrowViewport: () => false }));
/* One `t`, not a fresh arrow per render: react-i18next's is stable per
   language, and the picker's fetch effect lists it as a dependency - an
   unstable stand-in would re-ask both hosts on every render and quietly
   invalidate every assertion about what was fetched. */
const translate = (key: string) => key;
vi.mock('../i18n/LocaleShell.tsx', () => ({ useT: () => translate }));
vi.mock('./RegistryFriends.tsx', () => ({ FriendAvatar: () => null }));
vi.mock('./friendPresence.ts', () => ({ isOnline: (f: { online?: boolean }) => f.online === true }));

const session = { url: 'https://home.example.com', username: 'matt' };
let registrySession: { account: { handle: string }; token: string } | null = null;
let currentSession: typeof session | null = session;

vi.mock('../servers/serverSession.tsx', () => ({ useServerSession: () => ({ session: currentSession }) }));
vi.mock('../servers/registrySession.tsx', () => ({
  useRegistryOptional: () => (registrySession ? { session: registrySession } : null),
}));
vi.mock('../player/jam.tsx', () => ({ useJamOptional: () => null }));

/* Stand-ins for the kit: this file is about who is in the list and whether the
   row can be tapped, and a Modal that portals or animates only gets in the
   way of asking that. */
vi.mock('@glacier/icons', () => ({ Check: () => null, Search: () => null, X: () => null }));
vi.mock('@glacier/react', () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  Drawer: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  Button: ({ children, disabled, onClick, ...rest }: { children: ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  ),
  Input: (props: Record<string, unknown>) => <input {...props} />,
  Text: ({ children, className }: { children: ReactNode; className?: string }) => <p className={className}>{children}</p>,
  Skeleton: () => <span />,
  SegmentedControl: ({
    options,
    onValueChange,
  }: {
    options: { value: string; label: string }[];
    onValueChange: (v: string) => void;
  }) => (
    <span>
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onValueChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  ),
}));

interface Row {
  handle: string;
  standing: string;
  away: boolean;
  el: HTMLElement;
}

/** Raise the picker and wait for the two sources to have merged. */
async function open(
  request: Partial<Parameters<typeof openFriendPicker>[0]> = {},
): Promise<{ rows: () => Row[]; picked: Promise<FriendPick | null>; container: HTMLElement }> {
  /* Ask BEFORE mounting, which is the door's whole point - and which also
     settles any ask a previous test left standing, so the sheet that mounts
     here is answering this test's question and not the last one's. */
  const picked = openFriendPicker({
    title: 'Add people',
    mode: 'playlist',
    action: (n) => `add ${n}`,
    ...request,
  });
  const { container } = render(<FriendPicker />);
  const rows = () =>
    [...container.querySelectorAll('.fpRow')].map((el) => ({
      handle: el.querySelector('.fpRow__name')?.textContent ?? '',
      standing: el.querySelector('.fpRow__standing')?.textContent ?? '',
      away: el.hasAttribute('data-away'),
      el: el as HTMLElement,
    }));
  // The skeletons stand until BOTH sources have answered; an empty answer
  // draws the one empty sentence instead of a list, so waiting on the list
  // itself would hang on exactly the cases worth asserting.
  await waitFor(() => {
    expect(container.querySelector('.fpRow--pending')).toBeNull();
  });
  return { rows, picked, container };
}

beforeEach(() => {
  currentSession = session;
  registrySession = { account: { handle: 'matt' }, token: 'reg-token' };
  fetchMembers.mockReset();
  fetchRegistryFriends.mockReset();
  fetchMembers.mockResolvedValue([]);
  fetchRegistryFriends.mockResolvedValue({ friends: [] });
});

describe('a hub member who is not (yet) a registry friend', () => {
  it('is offered for a playlist seat, because being on the box IS the rule', async () => {
    fetchMembers.mockResolvedValue([{ userId: 5, username: 'sam' }]);
    const { rows } = await open();
    expect(rows().map((r) => r.handle)).toEqual(['sam']);
    expect(rows()[0]?.away).toBe(false);
  });

  it('can actually be picked, and comes back with the hub s own id for them', async () => {
    fetchMembers.mockResolvedValue([{ userId: 5, username: 'sam' }]);
    const { rows, picked, container } = await open();
    act(() => rows()[0]?.el.click());
    const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent === 'add 1');
    expect(confirm).toBeDefined();
    act(() => confirm?.click());
    await expect(picked).resolves.toEqual({ people: [{ handle: 'sam', userId: 5 }], role: 'editor' });
  });

  it('gets its own sentence - not the one a stranger elsewhere gets', async () => {
    // The bug this replaces: one line of words for three different situations,
    // which told the owner's partner she was "not on this server" while she
    // was standing in the members list.
    fetchMembers.mockResolvedValue([{ userId: 5, username: 'sam' }]);
    fetchRegistryFriends.mockResolvedValue({
      friends: [
        { handle: 'kayla', serverUrl: 'https://home.example.com' },
        { handle: 'ana', serverUrl: 'https://elsewhere.example.com' },
      ],
    });
    const { rows } = await open();
    const standing = Object.fromEntries(rows().map((r) => [r.handle, r.standing]));
    expect(standing.sam).toBe('profile.pickerMemberHere');
    expect(standing.kayla).toBe('profile.pickerOnThisServer');
    expect(standing.ana).toBe('profile.pickerAwayPlaylist');
    expect(new Set(Object.values(standing)).size).toBe(3);
  });
});

describe('who can be tapped', () => {
  it('will not take a friend who is on another server', async () => {
    // A playlist lives on one server; the link makes a COPY on hers.
    fetchRegistryFriends.mockResolvedValue({
      friends: [{ handle: 'ana', serverUrl: 'https://elsewhere.example.com' }],
    });
    const { rows, container } = await open();
    expect(rows()[0]?.away).toBe(true);
    expect(rows()[0]?.el.getAttribute('aria-disabled')).toBe('true');
    act(() => rows()[0]?.el.click());
    expect(rows()[0]?.el.getAttribute('aria-checked')).toBe('false');
    expect([...container.querySelectorAll('button')].find((b) => b.textContent === 'add 1')).toBeUndefined();
  });

  it('lets the roster overrule a stale announce', async () => {
    // A friend the registry places elsewhere who IS on this box - her announce
    // is old, or she sits on two hubs. The box's own word wins, and she gains
    // the hub id the registry never had.
    fetchRegistryFriends.mockResolvedValue({
      friends: [{ handle: 'ana', serverUrl: 'https://elsewhere.example.com' }],
    });
    fetchMembers.mockResolvedValue([{ userId: 9, username: 'ana' }]);
    const { rows, picked, container } = await open();
    expect(rows()[0]?.away).toBe(false);
    act(() => rows()[0]?.el.click());
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'add 1')?.click());
    await expect(picked).resolves.toEqual({ people: [{ handle: 'ana', userId: 9 }], role: 'editor' });
  });

  it('shows one row for a person both sources name, whatever the case', async () => {
    fetchRegistryFriends.mockResolvedValue({ friends: [{ handle: 'Kayla', serverUrl: 'https://home.example.com' }] });
    fetchMembers.mockResolvedValue([{ userId: 3, username: 'kayla' }]);
    const { rows } = await open();
    expect(rows()).toHaveLength(1);
    // The registry's spelling of the name survives; the hub's id is adopted.
    expect(rows()[0]?.handle).toBe('Kayla');
    expect(rows()[0]?.standing).toBe('profile.pickerOnThisServer');
  });

  it('hides yourself and anyone already seated', async () => {
    fetchMembers.mockResolvedValue([
      { userId: 1, username: 'matt' },
      { userId: 2, username: 'kayla' },
      { userId: 3, username: 'sam' },
    ]);
    const { rows } = await open({ exclude: ['KAYLA'] });
    expect(rows().map((r) => r.handle)).toEqual(['sam']);
  });
});

describe('the two modes ask two different questions', () => {
  it('a playlist asks the hub for its roster', async () => {
    fetchMembers.mockResolvedValue([{ userId: 5, username: 'sam' }]);
    await open({ mode: 'playlist' });
    expect(fetchMembers).toHaveBeenCalled();
  });

  it('a groove never does - a room invite can only reach a registry friend', async () => {
    fetchMembers.mockResolvedValue([{ userId: 5, username: 'sam' }]);
    const { rows } = await open({ mode: 'groove' });
    expect(fetchMembers).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });
});

describe('when the registry cannot be reached', () => {
  it('still seats the people the hub knows about, and says what is missing', async () => {
    // The hub is the box the playlist lives on; attack.fm being down is not a
    // reason to refuse a seat to somebody standing on it.
    fetchRegistryFriends.mockRejectedValue(new Error('offline'));
    fetchMembers.mockResolvedValue([{ userId: 5, username: 'sam' }]);
    const { rows, container } = await open();
    expect(rows().map((r) => r.handle)).toEqual(['sam']);
    expect(container.querySelector('.friendPicker__note')?.textContent).toBe('profile.pickerRegistryUnreachable');
  });
});
