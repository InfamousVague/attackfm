import { Button, Drawer, Input, Modal, Text } from '@glacier/react';
import { ClipboardPaste, KeyRound } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import { jamCodeFromText } from '../servers/deepLink.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useNarrowViewport } from '../ux/useNarrowViewport.ts';
import { useJamOptional } from './jam.tsx';
import { clearGrooveCode, enterGroove, hubHost, onGrooveCode, type GrooveEntry } from './grooveEntry.ts';

/**
 * "Have a code?" - the groove's typed door.
 *
 * A link is supposed to open the app and walk you in, and on most phones it
 * does. On the ones where it cannot - two installs claiming one scheme, a
 * build the app-link file does not name, a chooser that picked the wrong one
 * - the person is left holding a code with nowhere to put it. The playlist
 * share had exactly this gap once ("there is nowhere to enter the share
 * code"); this is the same door in the groove's own vocabulary.
 *
 * One field that takes whatever they have: the code read off a friend's
 * deck, the code off the link's page, or the whole link pasted. What follows
 * a tap on Join is the same road a tapped link takes (grooveEntry): the
 * registry says where the room is, the hub says whether you may enter, and
 * a join that works is announced by the provider - the toast, the player up,
 * the deck open - so this sheet's only job on success is to get out of the
 * way. Every other outcome is a sentence here rather than a dead button.
 *
 * Hoisted to app level and opened through grooveEntry's little store: the
 * row that opens it sits in the deck's popover, and a sheet rendered in
 * there would be unmounted by the tap that opens it. A bottom sheet on a
 * phone, a small dialog anywhere wider - keyed on WIDTH, not pointer, so an
 * unfolded foldable gets the dialog.
 */
export function JoinGrooveSheet() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Exclude<GrooveEntry, { kind: 'joined' }> | null>(null);
  const narrow = useNarrowViewport();
  const { session } = useServerSession();
  const jam = useJamOptional();
  const field = useRef<HTMLInputElement | null>(null);

  // The kit's dialog takes focus for itself as it opens; the field takes it
  // back once the sheet has settled, so the keyboard is up when the eye
  // lands on it - the field is the whole sheet.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => field.current?.focus(), 180);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(
    () =>
      onGrooveCode((seed) => {
        setText(seed);
        setAnswer(null);
        setBusy(false);
        setOpen(true);
      }),
    [],
  );

  const close = () => {
    setOpen(false);
    clearGrooveCode();
  };

  const ref = jamCodeFromText(text);
  // Reading the clipboard is a permission on some phones and simply absent
  // on others; the button only appears where asking is possible. A refusal
  // leaves the field, which is right there.
  const canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';

  const go = async () => {
    if (!ref || !jam || !session || busy) return;
    setBusy(true);
    setAnswer(null);
    try {
      const out = await enterGroove(jam, session.url, ref);
      if (out.kind === 'joined') close();
      else setAnswer(out);
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const held = (await navigator.clipboard.readText()).trim();
      if (held) {
        setText(held);
        setAnswer(null);
      }
    } catch {
      // Refused, or empty. Nothing to say: the field is the fallback.
    }
  };

  // The one line under the field. Busy first, then the hub's or the
  // registry's answer, then a nudge for text that is not a code.
  let status: { tone: 'muted' | 'danger'; words: string } | null = null;
  if (busy) status = { tone: 'muted', words: 'Looking for that groove…' };
  else if (answer) {
    switch (answer.kind) {
      case 'elsewhere': {
        const where = answer.share.hubName ? `${answer.share.hubName} (${hubHost(answer.share.hubUrl)})` : hubHost(answer.share.hubUrl);
        status = {
          tone: 'muted',
          words: `That groove is on ${where}. A groove is a room on one server, and you would need to be signed in there to walk in${answer.share.by ? ` - ask @${answer.share.by} for an invite` : ''}.`,
        };
        break;
      }
      case 'missing':
        status = {
          tone: 'danger',
          words: answer.bare
            ? 'No groove answers to that code. It may have ended, or a letter is off - check it with whoever gave it to you.'
            : 'That link is not one we know about. Ask whoever sent it for another.',
        };
        break;
      case 'ended':
        status = {
          tone: 'danger',
          words: `That groove has ended.${answer.share.by ? ` Ask @${answer.share.by} to start another.` : ''}`,
        };
        break;
      case 'failed':
        status = { tone: 'danger', words: 'Could not look that up just now. Try again in a moment.' };
        break;
    }
  } else if (text.trim() && !ref) {
    status = { tone: 'muted', words: 'A code is a few letters and numbers; a link has /j/ in it.' };
  }

  const body = (
    <div className="joinGroove">
      <Text tone="muted" size="sm">
        Read it off a friend&rsquo;s groove deck, or paste the link they sent you.
      </Text>
      <form
        className="joinGroove__form"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <label className="joinGroove__field">
          <span className="joinGroove__label">Code or link</span>
          <Input
            ref={field}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setAnswer(null);
            }}
            placeholder="GR00VE or attack.fm/j/GR00VE"
            leadingIcon={<KeyRound size={16} aria-hidden />}
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            autoFocus
            disabled={busy}
            aria-invalid={answer?.kind === 'missing' || answer?.kind === 'ended' || undefined}
          />
        </label>
        {canPaste && (
          <button type="button" className="jamAction joinGroove__paste" onClick={() => void paste()} disabled={busy}>
            <ClipboardPaste size={16} aria-hidden />
            Paste
          </button>
        )}
      </form>
      <div className="joinGroove__status" role="status" aria-live="polite">
        {status && (
          <Text tone={status.tone} size="xs">
            {status.words}
          </Text>
        )}
      </div>
      <div className="joinGroove__actions">
        <Button variant="ghost" onClick={close}>
          Not now
        </Button>
        <Button variant="solid" disabled={!ref || busy || !jam || !session} onClick={() => void go()}>
          {busy ? 'Looking…' : 'Join'}
        </Button>
      </div>
    </div>
  );

  if (narrow) {
    return (
      <Drawer open={open} onClose={close} side="bottom" size="md" title="Join a groove" className="joinGrooveSheet">
        {body}
      </Drawer>
    );
  }
  return (
    <Modal open={open} onClose={close} title="Join a groove" size="sm">
      {body}
    </Modal>
  );
}
