import { Button, ConversationView, Input, MessageBar, Text, TypingIndicator } from '@glacier/react';
import { ListPlus, ListMusic, Play, Plus, X } from '@glacier/icons';
import { useState } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import { usePlaylists } from '../playlists/playlists.tsx';
import { useQueueControls } from '../player/queueControls.tsx';
import { artSized } from '../server.ts';
import { useDjChat, useDjPlay, DJ_AUTHOR, type DjEmbed, type DjMessage } from './djChat.tsx';
import { TrackMenu } from '../library/TrackMenu.tsx';
import type { Track } from '../core/tauri.ts';
import djMascot from '../../assets/dj-mascot.png';

/**
 * The DJ, as a conversation.
 *
 * The words are the connective tissue and the CARDS are the product: every
 * answer that names music comes with something you can act on, and every card
 * is built from ids resolved against the synced library rather than from
 * anything the model asserted. The transcript itself lives in djChat.tsx, at
 * the app's root, so leaving this page does not end the conversation.
 */

function rowsOf(track: Track) {
  return artSized(track.artwork, 160);
}

/** One song in a card: art, name, and the same menu it wears everywhere. */
function EmbedRow({
  track,
  onPlay,
  trailing,
}: {
  track: Track;
  onPlay: () => void;
  trailing?: React.ReactNode;
}) {
  const src = rowsOf(track);
  return (
    <TrackMenu track={track} className="djRowMenu">
      <div className="djRow">
        <button type="button" className="djRow__main" onClick={onPlay}>
          {src ? (
            <img className="djRow__art" src={src} alt="" loading="lazy" />
          ) : (
            <span className="djRow__art djRow__art--blank" aria-hidden />
          )}
          <span className="djRow__text">
            <span className="djRow__title">{track.title}</span>
            <span className="djRow__artist">{track.artist}</span>
          </span>
        </button>
        {trailing}
      </div>
    </TrackMenu>
  );
}

/** The card under a message. Everything it can do is an app seam that already
 *  existed - play, queue, create a playlist - so nothing here depends on the
 *  model having behaved. */
function EmbedCard({ embed }: { embed: DjEmbed }) {
  const chat = useDjChat();
  const play = useDjPlay();
  const queue = useQueueControls();
  const { playlists } = usePlaylists();
  const [name, setName] = useState<string | null>(null);
  if (!chat) return null;

  if (embed.kind === 'notice') {
    return (
      <Text tone={embed.tone === 'warn' ? 'danger' : 'muted'} size="sm">
        {embed.text}
      </Text>
    );
  }

  if (embed.kind === 'chips') {
    return (
      <div className="djChips">
        {embed.options.map((o) => (
          <button
            key={o.label}
            type="button"
            className="djChip"
            onClick={() => chat.send(o.send)}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }

  if (embed.kind === 'receipt') {
    const found = chat.resolve(embed.trackIds);
    return (
      <div className="djCard djCard--receipt">
        <div className="djCard__head">
          <span className="djCard__title">{embed.name}</span>
          <span className="djCard__count">
            {found.length} {found.length === 1 ? 'song' : 'songs'}
          </span>
        </div>
        <div className="djCard__actions">
          <Button
            variant="solid"
            size="sm"
            disabled={found.length === 0}
            onClick={() => found[0] && play?.(found[0], found)}
          >
            <Play size={14} fill="currentColor" /> Play
          </Button>
        </div>
      </div>
    );
  }

  const found = chat.resolve(embed.trackIds);
  const total = found.reduce((n, t) => n + (t.duration ?? 0), 0);
  const mins = Math.round(total / 60);

  if (embed.kind === 'set') {
    return (
      <div className="djCard">
        <div className="djCard__head">
          <span className="djCard__count">
            {found.length} {found.length === 1 ? 'song' : 'songs'}
            {mins > 0 ? ` · ${mins} min` : ''}
          </span>
        </div>
        <div className="djCard__rows">
          {found.map((t) => (
            <EmbedRow
              key={t.path}
              track={t}
              onPlay={() => play?.(t, found)}
              trailing={
                <button
                  type="button"
                  className="djRow__add"
                  aria-label={`Queue ${t.title}`}
                  onClick={() => queue.addToQueue(t)}
                >
                  <Plus size={15} />
                </button>
              }
            />
          ))}
        </div>
        <div className="djCard__actions">
          <Button
            variant="solid"
            size="sm"
            disabled={found.length === 0}
            onClick={() => found[0] && play?.(found[0], found)}
          >
            <Play size={14} fill="currentColor" /> Play these
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={found.length === 0}
            onClick={() => chat.toDraft(embed.trackIds)}
          >
            <ListPlus size={14} /> Into a playlist
          </Button>
        </div>
      </div>
    );
  }

  // The draft: live until it is saved, then frozen in place as a record of
  // what was saved rather than a control that would now lie.
  const saved = embed.saved === true;
  const existing = saved ? playlists.find((p) => p.name === embed.name) : undefined;
  return (
    <div className="djCard djCard--draft" data-saved={saved || undefined}>
      <div className="djCard__head">
        {saved ? (
          <span className="djCard__title">{embed.name}</span>
        ) : (
          <Input
            aria-label="Playlist name"
            value={name ?? embed.name}
            onChange={(e) => {
              setName(e.currentTarget.value);
              chat.renameDraft(embed.draftId, e.currentTarget.value);
            }}
          />
        )}
        <span className="djCard__count">
          {found.length} {found.length === 1 ? 'song' : 'songs'}
          {mins > 0 ? ` · ${mins} min` : ''}
        </span>
      </div>
      <div className="djCard__rows">
        {found.map((t) => (
          <EmbedRow
            key={t.path}
            track={t}
            onPlay={() => play?.(t, found)}
            trailing={
              saved ? undefined : (
                <button
                  type="button"
                  className="djRow__add"
                  aria-label={`Remove ${t.title}`}
                  onClick={() => {
                    const id = embed.trackIds.find((n) => rowsOfId(t) === n);
                    if (id != null) chat.removeFromDraft(embed.draftId, id);
                  }}
                >
                  <X size={15} />
                </button>
              )
            }
          />
        ))}
      </div>
      <div className="djCard__actions">
        <Button
          variant="solid"
          size="sm"
          disabled={saved || found.length === 0}
          onClick={() => chat.saveDraft(embed.draftId)}
        >
          <ListMusic size={14} /> {saved ? 'Saved' : 'Save to my playlists'}
        </Button>
        {existing && (
          <Text tone="muted" size="xs">
            In your playlists
          </Text>
        )}
      </div>
    </div>
  );
}

/** The library id behind a track, for matching a row back to the draft. */
function rowsOfId(track: Track): number | null {
  const m = /^afm:\/\/(\d+)$/.exec(track.path);
  return m ? Number(m[1]) : null;
}

export function DjPage() {
  const chat = useDjChat();
  const { session } = useServerSession();
  const [draft, setDraft] = useState('');
  if (!chat) return null;

  // Nobody has spoken yet. The seeded greeting and its chips render as a
  // clean invitation - the mascot, one line, the suggestions - instead of a
  // transcript cosplaying a messenger around two system messages. The
  // transcript takes over with the first real exchange and keeps the whole
  // history, opening included.
  const virgin = !chat.messages.some((m) => m.authorId !== DJ_AUTHOR);
  if (virgin) {
    const greeting = chat.messages.find((m) => m.text)?.text;
    const chips = chat.messages.flatMap((m) =>
      m.embed?.kind === 'chips' ? m.embed.options : [],
    );
    return (
      <div className="djPage">
        <div className="djFresh">
          <img className="djFresh__mascot" src={djMascot} alt="" />
          {greeting && <p className="djFresh__line">{greeting}</p>}
          <div className="djChips djFresh__chips">
            {chips.map((o) => (
              <button
                key={o.label}
                type="button"
                className="djChip"
                onClick={() => chat.send(o.send)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <MessageBar
          className="djComposer"
          value={draft}
          onValueChange={setDraft}
          busy={chat.busy}
          placeholder="Tell the DJ what you're after"
          minRows={1}
          maxRows={4}
          onSend={({ text }) => {
            if (!text.trim()) return;
            chat.send(text);
            setDraft('');
          }}
        />
      </div>
    );
  }

  return (
    <div className="djPage">
      <ConversationView<DjMessage>
        className="djTranscript"
        messages={chat.messages}
        viewerId={session?.username ?? 'me'}
        label="DJ"
        stick
        avatarFor={(id) =>
          id === DJ_AUTHOR ? <img className="djAvatar" src={djMascot} alt="" /> : undefined
        }
        authorNameFor={(id) => (id === DJ_AUTHOR ? 'DJ' : (session?.username ?? 'You'))}
        renderBody={(ctx) => (
          <>
            {ctx.message.text && <span className="djSaid">{ctx.message.text}</span>}
            {ctx.message.embed && <EmbedCard embed={ctx.message.embed} />}
          </>
        )}
      />
      {chat.busy && (
        <TypingIndicator
          className="djTyping"
          names={['DJ']}
          dots
          templates={{ one: '{first} is going through the crates' }}
        />
      )}
      <MessageBar
        className="djComposer"
        value={draft}
        onValueChange={setDraft}
        busy={chat.busy}
        placeholder="Tell the DJ what you're after"
        minRows={1}
        maxRows={4}
        onSend={({ text }) => {
          if (!text.trim()) return;
          chat.send(text);
          setDraft('');
        }}
      />
    </div>
  );
}
