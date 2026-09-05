import { useEffect, useRef, useState } from 'react';
import { djHear, type ServerSession } from '../server.ts';

/**
 * Talking to the DJ, as one hook two surfaces share.
 *
 * The recorder lived inside the Booth's hero launcher - and the Booth is a
 * developer-mode page, so the DJ conversation everyone actually reaches from
 * Now Playing never had a way to talk. The owner's words: "there is no longer
 * a spot for me to talk to the DJ with my voice." The recorder is lifted
 * here unchanged (tap to talk, tap again to send, a hard twenty-second stop
 * matching the server's own cap, the stream released the moment recording
 * ends so the orange dot never outlives the feature) and what the hub HEARD
 * is handed to the caller: the launcher starts a set with it, the
 * conversation sends it as a turn.
 */
export interface Heard {
  heard: string;
  /** Songs the hub is fetching in the background because you asked for them. */
  fetching: { title: string; artist: string }[];
}

export function useTalkToDj(
  session: ServerSession | null,
  onHeard: (h: Heard) => void | Promise<void>,
  onError: (message: string) => void,
): { canTalk: boolean; recording: boolean; hearing: boolean; talk: () => Promise<void> } {
  const [recording, setRecording] = useState(false);
  const [hearing, setHearing] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const stopTimer = useRef(0);
  const heardRef = useRef(onHeard);
  heardRef.current = onHeard;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  // Unmount mid-recording: let go of the mic rather than leaving it hot.
  useEffect(
    () => () => {
      window.clearTimeout(stopTimer.current);
      const rec = recRef.current;
      if (rec && rec.state !== 'inactive') rec.stop();
      rec?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const canTalk =
    typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && !!session;

  const talk = async () => {
    if (!session) return;
    if (recording) {
      // Second tap: stop; onstop below sends what was said.
      window.clearTimeout(stopTimer.current);
      recRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // iOS records mp4/aac, everything else webm/opus; the server's ffmpeg
      // reads either, so the first supported container wins.
      const mime = ['audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        recRef.current = null;
        const clip = new Blob(chunks, { type: rec.mimeType || 'application/octet-stream' });
        if (clip.size === 0) return;
        setHearing(true);
        void (async () => {
          try {
            const { heard, fetching } = await djHear(session, clip);
            await heardRef.current({ heard, fetching });
          } catch (err) {
            errorRef.current(err instanceof Error ? err.message : 'The DJ could not hear that.');
          } finally {
            setHearing(false);
          }
        })();
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
      stopTimer.current = window.setTimeout(() => {
        if (recRef.current?.state === 'recording') recRef.current.stop();
      }, 20_000);
    } catch {
      errorRef.current('The DJ needs the microphone for that - allow it and try again.');
    }
  };

  return { canTalk, recording, hearing, talk };
}
