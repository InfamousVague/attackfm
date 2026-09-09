import { Button, Drawer, Input, Modal, SegmentedControl, Skeleton, Text } from '@glacier/react';
import { Check, Search, X } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { fetchMembers } from '../api/friends.ts';
import { fetchFriends as fetchRegistryFriends, type RegistryFriend } from '../servers/registry.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { useNarrowViewport } from '../ux/useNarrowViewport.ts';
import { useJamOptional } from '../player/jam.tsx';
import { sameHub } from '../player/grooveEntry.ts';
import {
  onFriendPicker,
  type FriendPick,
  type FriendPickerAsk,
  type FriendPickerMode,
} from '../nav/friendPickerDoor.ts';
import { FriendAvatar } from './FriendAvatar.tsx';
import { isOnline } from './friendPresence.ts';
import { useT } from '../i18n/LocaleShell.tsx';

/** What `t` is, for the two plain helpers below that are handed one. */
type T = ReturnType<typeof useT>;

/**
 * The friend picker - one multi-select for every "who?" in the app.
 *
 * A row a person: their face, their handle, one line of standing (online,
 * on this server, elsewhere, in a groove), and a check. Tap to choose, tap
 * again to un-choose; the chosen ride as chips above the list so a long
 * list never hides who is already picked; a field filters as you type; and
 * the one button counts ("Add 3 to the playlist"), dead at zero.
 *
 * Two sources, merged and de-duplicated by name: the registry's friends -
 * the people you know, with where they are and whether they are online -
 * and, for a playlist, the hub's own roster, so a member of this server
 * who is not a registry friend (or is one under another name) can still be
 * seated: being on the box is the hub's rule for a seat. A friend on
 * another server is shown, dimmed, with the reason - a playlist lives on
 * one server and a groove is a room on one - rather than hidden, so nobody
 * wonders where Ana went.
 *
 * Hoisted to app level and asked through nav/friendPickerDoor: the seats
 * that open it are popovers and drawers, and a sheet inside those dies
 * with them. A bottom sheet on a phone, a dialog anywhere wider - keyed on
 * width, like the groove's code sheet.
 */

interface Person {
  key: string;
  handle: string;
  userId?: number;
  avatar?: string | null;
  where: 'here' | 'elsewhere';
  /** A registry friend (as opposed to a hub member the roster named). */
  friend: boolean;
  online: boolean;
  playing: boolean;
  /** "hosting a groove", "in Kayla's groove" - null when not in one. */
  groove: string | null;
}

/** Why a dimmed row cannot be chosen, in the mode's own words. */
function awayReason(mode: FriendPickerMode, t: T): string {
  return mode === 'groove' ? t('profile.pickerAwayGroove') : t('profile.pickerAwayPlaylist');
}

function standingOf(p: Person, mode: FriendPickerMode, t: T): string {
  if (p.where === 'elsewhere') return awayReason(mode, t);
  if (p.groove) return p.groove;
  const bits: string[] = [];
  if (p.playing) bits.push(t('profile.pickerListeningNow'));
  else if (p.online) bits.push(t('profile.pickerOnline'));
  bits.push(p.friend ? t('profile.pickerOnThisServer') : t('profile.pickerMemberHere'));
  // The separator is punctuation, not a word - it joins the same way in
  // every language, and the pieces either side are each their own key.
  return bits.join(' · ');
}

/** The order that matters: reachable first, live first within that, then
 *  the friends, then the rest of the roster, then whoever is elsewhere. */
function rank(p: Person): number {
  if (p.where === 'elsewhere') return 30;
  if (p.playing || p.online) return 0;
  return p.friend ? 10 : 20;
}

function PickerBody({ ask, onDone }: { ask: FriendPickerAsk; onDone: (pick: FriendPick | null) => void }) {
  const { request } = ask;
  const { mode } = request;
  const t = useT();
  const { session } = useServerSession();
  const registry = useRegistryOptional();
  const jam = useJamOptional();
  const token = registry?.session?.token ?? null;
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');

  // Fetched fresh on every open: a friend made a minute ago belongs here now.
  useEffect(() => {
    let live = true;
    const friends: Promise<RegistryFriend[] | null> = token
      ? fetchRegistryFriends(token)
          .then((f) => f.friends)
          .catch(() => null)
      : Promise.resolve([]);
    const roster = mode === 'playlist' && session ? fetchMembers(session).catch(() => null) : Promise.resolve(null);
    void Promise.all([friends, roster]).then(([known, members]) => {
      if (!live) return;
      if (known === null) setError(t('profile.pickerRegistryUnreachable'));
      const byKey = new Map<string, Person>();
      for (const f of known ?? []) {
        const key = f.handle.toLowerCase();
        byKey.set(key, {
          key,
          handle: f.handle,
          avatar: f.avatarUrl,
          where: session && f.serverUrl && sameHub(session.url, f.serverUrl) ? 'here' : 'elsewhere',
          friend: true,
          online: isOnline(f),
          playing: !!f.nowPlaying?.playing,
          groove: null,
        });
      }
      for (const m of members ?? []) {
        const key = m.username.toLowerCase();
        const had = byKey.get(key);
        if (had) {
          // A friend the registry places elsewhere who IS a member here
          // (their announce is stale, or they sit on two hubs): the roster
          // is the box's own word, and it wins.
          had.userId = m.userId;
          had.where = 'here';
          continue;
        }
        byKey.set(key, {
          key,
          handle: m.username,
          userId: m.userId,
          where: 'here',
          friend: false,
          online: false,
          playing: false,
          groove: null,
        });
      }
      setPeople([...byKey.values()]);
    });
    return () => {
      live = false;
    };
  }, [token, session, mode, t]);

  // Who is out of the question: the names the seat already has, and you.
  const hidden = useMemo(() => {
    const set = new Set((request.exclude ?? []).map((h) => h.toLowerCase()));
    if (session) set.add(session.username.toLowerCase());
    if (registry?.session) set.add(registry.session.account.handle.toLowerCase());
    return set;
  }, [request.exclude, session, registry?.session]);

  // A friend already in a groove of their own says so on their line - when
  // the question is about grooves. A playlist seat does not care.
  const grooves = useMemo(() => {
    const m = new Map<string, string>();
    if (mode !== 'groove') return m;
    for (const room of jam?.friendJams ?? []) {
      m.set(room.hostName.toLowerCase(), t('profile.pickerHostingGroove'));
      for (const name of room.members) {
        if (name.toLowerCase() !== room.hostName.toLowerCase())
          m.set(name.toLowerCase(), t('profile.pickerInGroove', { host: room.hostName }));
      }
    }
    return m;
  }, [jam?.friendJams, mode, t]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people ?? [])
      .filter((p) => !hidden.has(p.key))
      .map((p) => (grooves.has(p.key) ? { ...p, groove: grooves.get(p.key)! } : p))
      .filter((p) => !q || p.handle.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.handle.localeCompare(b.handle));
  }, [people, hidden, grooves, query]);

  const byKey = useMemo(() => new Map((people ?? []).map((p) => [p.key, p] as const)), [people]);
  const picked = chosen.map((k) => byKey.get(k)).filter((p): p is Person => !!p);
  const count = picked.length;
  const reachable = rows.some((p) => p.where === 'here');
  const everyone = (people ?? []).filter((p) => !hidden.has(p.key));

  const toggle = (p: Person) => {
    if (p.where !== 'here') return;
    setChosen((cur) => (cur.includes(p.key) ? cur.filter((k) => k !== p.key) : [...cur, p.key]));
  };

  const confirm = () => {
    if (count === 0) return;
    onDone({
      people: picked.map((p) => ({ handle: p.handle, userId: p.userId })),
      role: request.roles ? role : 'editor',
    });
  };

  // The one empty sentence, chosen for what is actually the case.
  let empty: string | null = null;
  if (people !== null && rows.length === 0) {
    if (query.trim()) empty = t('profile.pickerNoMatch');
    else if (everyone.length > 0) empty = t('profile.pickerEveryoneIn');
    else if (!token && !session) empty = t('profile.pickerNeedServer');
    else if (!token) empty = t('profile.pickerNeedAccount');
    else empty = t('profile.pickerNoFriends');
  }

  return (
    <div className="friendPicker" data-mode={mode}>
      {people !== null && everyone.length > 2 && (
        <Input
          className="friendPicker__search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder={t('profile.pickerFind')}
          aria-label={t('profile.pickerFind')}
          leadingIcon={<Search size={16} aria-hidden />}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      )}

      {picked.length > 0 && (
        <div className="friendPicker__chips" role="list" aria-label={t('profile.pickerChosen')}>
          {picked.map((p) => (
            <button
              key={p.key}
              type="button"
              role="listitem"
              className="fpChip"
              aria-label={t('profile.pickerRemovePerson', { handle: p.handle })}
              onClick={() => toggle(p)}
            >
              <FriendAvatar handle={p.handle} size="sm" src={p.avatar} />
              <span className="fpChip__name">{p.handle}</span>
              <X size={14} aria-hidden />
            </button>
          ))}
        </div>
      )}

      {error && (
        <Text tone="muted" size="xs" className="friendPicker__note" role="status">
          {error}
        </Text>
      )}

      {people === null ? (
        <ul className="friendPicker__list" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="fpRow fpRow--pending">
              <Skeleton variant="circle" width="2.5rem" height="2.5rem" />
              <span className="fpRow__text">
                <Skeleton variant="text" width="6rem" />
                <Skeleton variant="text" width="9rem" />
              </span>
            </li>
          ))}
        </ul>
      ) : empty ? (
        <Text tone="muted" size="sm" className="friendPicker__empty">
          {empty}
        </Text>
      ) : (
        <ul className="friendPicker__list" aria-label={t('profile.pickerPeople')}>
          {rows.map((p) => {
            const on = chosen.includes(p.key);
            const away = p.where !== 'here';
            return (
              <li key={p.key}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-disabled={away || undefined}
                  className="fpRow"
                  data-on={on || undefined}
                  data-away={away || undefined}
                  data-live={p.playing || p.online || undefined}
                  onClick={() => toggle(p)}
                >
                  <FriendAvatar handle={p.handle} size="md" src={p.avatar} />
                  <span className="fpRow__text">
                    <span className="fpRow__name">{p.handle}</span>
                    <span className="fpRow__standing">
                      {(p.playing || p.online) && p.where === 'here' && <span className="fpRow__dot" aria-hidden />}
                      {standingOf(p, mode, t)}
                    </span>
                  </span>
                  <span className="fpRow__check" aria-hidden>
                    {on && <Check size={16} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {people !== null && rows.length > 0 && !reachable && (
        <Text tone="muted" size="xs" className="friendPicker__note">
          {mode === 'groove' ? t('profile.pickerNoneHereGroove') : t('profile.pickerNoneHerePlaylist')}
        </Text>
      )}

      <div className="friendPicker__foot">
        {request.roles && (
          <div className="friendPicker__roles">
            <SegmentedControl
              size="sm"
              fullWidth
              aria-label={t('profile.pickerSeatLabel')}
              value={role}
              onValueChange={(v) => setRole(v === 'viewer' ? 'viewer' : 'editor')}
              options={[
                { value: 'editor', label: t('profile.pickerAsEditors') },
                { value: 'viewer', label: t('profile.pickerAsViewers') },
              ]}
            />
            <Text tone="muted" size="xs" className="friendPicker__roleWords">
              {role === 'editor' ? t('profile.pickerEditorWords') : t('profile.pickerViewerWords')}
            </Text>
          </div>
        )}
        <div className="friendPicker__actions">
          <Button variant="ghost" onClick={() => onDone(null)}>
            {t('profile.pickerNotNow')}
          </Button>
          <Button variant="solid" disabled={count === 0} onClick={confirm} data-count={count}>
            {request.action(count)}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Mounted once at app level (App.tsx). */
export function FriendPicker() {
  const t = useT();
  const [ask, setAsk] = useState<FriendPickerAsk | null>(null);
  const narrow = useNarrowViewport();
  useEffect(() => onFriendPicker((next) => setAsk(next)), []);

  const done = (pick: FriendPick | null) => {
    ask?.settle(pick);
    setAsk(null);
  };
  const open = ask !== null;
  const title = ask?.request.title ?? t('profile.pickerTitle');
  const body = ask ? <PickerBody key={ask.id} ask={ask} onDone={done} /> : null;

  if (narrow) {
    return (
      <Drawer
        open={open}
        onClose={() => done(null)}
        side="bottom"
        size="lg"
        title={title}
        description={ask?.request.hint}
        className="friendPickerSheet"
      >
        {body}
      </Drawer>
    );
  }
  return (
    <Modal open={open} onClose={() => done(null)} title={title} description={ask?.request.hint} size="md">
      {body}
    </Modal>
  );
}
