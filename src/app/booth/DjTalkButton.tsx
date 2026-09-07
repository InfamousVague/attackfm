import { IconButton, Spinner, useToast } from '@glacier/react';
import { Mic, Square } from '@glacier/icons';
import { useServerSession } from '../servers/serverSession.tsx';
import { useTalkToDj } from './useTalkToDj.ts';
import { useT } from '../i18n/LocaleShell.tsx';

/**
 * The mic beside the DJ conversation's composer: tap to talk, tap again to
 * send, and what the hub heard goes into the conversation as your turn -
 * exactly as if you had typed it. Renders nothing where the device cannot
 * record or nobody is signed in.
 */
export function DjTalkButton({ onHeard }: { onHeard: (text: string) => void }) {
  const t = useT();
  const { session } = useServerSession();
  const { toast } = useToast();
  const { canTalk, recording, hearing, talk } = useTalkToDj(
    session,
    ({ heard, fetching }) => {
      if (heard.trim()) onHeard(heard.trim());
      if (fetching.length > 0) {
        toast({ message: t('booth.heardFetching', { heard, count: fetching.length }) });
      }
    },
    (message) => toast({ message }),
  );
  if (!canTalk) return null;
  return (
    <IconButton
      size="lg"
      variant={recording ? 'solid' : 'ghost'}
      className="djTalk"
      data-on={recording || undefined}
      disabled={hearing}
      onClick={() => void talk()}
      aria-label={
        hearing
          ? t('booth.listeningBack')
          : recording
            ? t('booth.stopAndSend')
            : t('booth.talkWithVoice')
      }
    >
      {hearing ? <Spinner size="sm" aria-label={t('booth.listeningBack')} /> : recording ? <Square size={18} fill="currentColor" /> : <Mic size={18} />}
    </IconButton>
  );
}
