import { Heading, Text } from '@glacier/react';
import { useCallback, useState } from 'react';
import { useRegistry } from './registrySession.tsx';
import { useServerSession } from './serverSession.tsx';
import { enterServer } from './server.ts';
import { AccountSetup, FriendsSection } from './RegistryFriends.tsx';
import { useSharing, setSharing } from './listeningShare.tsx';

/**
 * The people, on their own page.
 *
 * Friends used to be the bottom third of Profile, under the servers, which
 * made a page about YOU end with a grid about everyone else - and gave the
 * grid nowhere to grow. Here it gets the whole screen, which is what the
 * artist photographs on the cards need to be worth drawing.
 *
 * Visiting a friend's server is handled in place rather than by sending the
 * viewer back to Profile: it is two calls (enter, adopt) and the answer -
 * "you're listening from theirs now", or the invite-only truth - belongs next
 * to the card that asked.
 */

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  return raw.trim() || 'That did not work.';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

export function FriendsPage() {
  const { session: registry, account, apply } = useRegistry();
  const { applySession } = useServerSession();
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const sharing = useSharing();

  const visit = useCallback(
    async (url: string) => {
      if (!registry) return;
      setNote(null);
      try {
        const next = await enterServer(url.replace(/\/+$/, ''), registry.token);
        applySession(next);
        setNote({ tone: 'ok', text: `Listening from ${hostOf(url)} now.` });
      } catch (err) {
        setNote({ tone: 'bad', text: messageOf(err) });
      }
    },
    [registry, applySession],
  );

  if (!registry || !account) {
    return (
      <div className="homePage friendsPage">
        <header className="friendsPage__head">
          <Heading level={2} noMargin>
            Friends
          </Heading>
          <Text size="sm" tone="muted">
            Friends live on your AttackFM account, not on any one server — so they follow you
            between them.
          </Text>
        </header>
        <AccountSetup onDone={apply} />
      </div>
    );
  }

  return (
    <div className="homePage friendsPage">
      <header className="friendsPage__head">
        <Heading level={2} noMargin>
          Friends
        </Heading>
        <Text size="sm" tone="muted">
          What everyone has been playing this week.
        </Text>
      </header>

      {note && (
        <Text size="sm" tone={note.tone === 'ok' ? 'success' : 'danger'}>
          {note.text}
        </Text>
      )}

      <FriendsSection
        token={registry.token}
        me={account.handle}
        onVisit={(friend) => {
          if (friend.serverUrl) void visit(friend.serverUrl);
        }}
      />

      {/* The reciprocity note, said where the consequence is visible: these
          cards are only full because everyone shares, and yours is one of
          them. Turning it off here is one tap, next to what it affects. */}
      <footer className="friendsPage__foot">
        <Text size="xs" tone="subtle">
          {sharing
            ? 'Your friends see your minutes, top artist and streak for the week. No track list, no history.'
            : 'You are not sharing your week, so your card is blank on their side.'}
        </Text>
        <button type="button" className="friendsPage__shareToggle" onClick={() => setSharing(!sharing)}>
          {sharing ? 'Stop sharing my week' : 'Share my week'}
        </button>
      </footer>
    </div>
  );
}
