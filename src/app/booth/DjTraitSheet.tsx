import { Button, Drawer, Spinner, Text, Textarea, useToast } from '@glacier/react';
import { Play, Sparkles } from '@glacier/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useDjPlay } from './djChat.tsx';
import { rememberDjReasons } from './djReasons.ts';
import {
  analyzeDjTrack,
  analyzeDjCollection,
  generateDjCollectionQueue,
  generateDjTraitQueue,
  saveDjNote,
  trackIdFromPath,
  type DjTrait,
  type DjTraitAnalysis,
} from '../server.ts';
import type { Track } from '../core/tauri.ts';
import { useT } from '../i18n/LocaleShell.tsx';

export function DjTraitSheet({ track, open, onClose, quick = false }: {
  track: Track;
  open: boolean;
  onClose: () => void;
  /** Analyze, choose the strongest directions, and play without asking. */
  quick?: boolean;
}) {
  const t = useT();
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const play = useDjPlay();
  const { toast } = useToast();
  const trackId = trackIdFromPath(track.path);
  const [analysis, setAnalysis] = useState<DjTraitAnalysis | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [djNote, setDjNote] = useState('');
  const [noteSaved, setNoteSaved] = useState(true);
  const quickStarted = useRef(false);

  useEffect(() => {
    if (!open || !session || trackId === null) return;
    const ctrl = new AbortController();
    setAnalysis(null);
    setSelected(new Set());
    setError(null);
    setBusy(true);
    quickStarted.current = false;
    void analyzeDjTrack(session, trackId, ctrl.signal)
      .then((value) => {
        setAnalysis(value);
        setDjNote(value.djNote ?? '');
        setNoteSaved(true);
        // Begin with the strongest three as a useful suggestion, while making
        // every concept an ordinary touch target the listener can change.
        setSelected(new Set([...value.traits]
          .sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)
          .slice(0, 3).map((t) => t.id)));
      })
      .catch((reason: unknown) => {
        if (!ctrl.signal.aborted) setError(reason instanceof Error ? reason.message : t('booth.couldNotListen'));
      })
      .finally(() => { if (!ctrl.signal.aborted) setBusy(false); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is read only to word a failure; re-running on a language change would re-fetch the analysis and throw away the traits already chosen.
  }, [open, session, trackId, quick]);

  const chosen = useMemo(
    () => analysis?.traits.filter((trait) => selected.has(trait.id)) ?? [],
    [analysis, selected],
  );

  const generate = async (traits: DjTrait[] = chosen) => {
    if (!session || trackId === null || traits.length === 0 || !play) return;
    setBusy(true);
    setError(null);
    try {
      const result = await generateDjTraitQueue(session, trackId, traits);
      const byId = new Map<number, Track>();
      for (const item of tracks) {
        const id = trackIdFromPath(item.path);
        if (id !== null) byId.set(id, item);
      }
      const queue = result.trackIds.map((id) => byId.get(id)).filter((item): item is Track => item !== undefined);
      const opener = queue[0];
      if (!opener) throw new Error(t('booth.noPlayableTracks'));
      play(opener, queue);
      const reason = result.explanations.find((item) => item.trackId === trackIdFromPath(opener.path));
      if (reason) toast({ message: t('booth.whyStartedHere', { reason: reason.reason }) });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('booth.couldNotBuildQueue'));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!quick || !analysis || busy || quickStarted.current) return;
    quickStarted.current = true;
    const automatic = [...analysis.traits]
      .sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)
      .slice(0, 3);
    void generate(automatic);
    // `generate` deliberately closes over the current library/session. This
    // effect is gated by quickStarted, so those changing cannot double-launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `generate` deliberately closes over the current library/session. This effect is gated by quickStarted, so those changing cannot double-launch
  }, [analysis, busy, quick]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="bottom"
      size="lg"
      className="djTraitSheet"
      title={<>{quick ? t('booth.generatingQueue') : t('booth.buildMixFromSong')}</>}
      description={t('booth.trackByArtist', { title: track.title, artist: track.artist })}
      footer={!quick ? (
        <Button variant="solid" disabled={busy || chosen.length === 0} onClick={() => void generate()}>
          {busy && analysis ? <Spinner size="sm" /> : <Play size={15} fill="currentColor" />}
          {chosen.length > 0
            ? t('booth.buildMyQueueCount', { count: chosen.length })
            : t('booth.buildMyQueue')}
        </Button>
      ) : undefined}
    >
      <div className="djTraitSheet__body">
        {!analysis && busy && (
          <div className="djTraitListening" role="status">
            <Sparkles size={22} />
            <span>{quick ? t('booth.chooseStrongest') : t('booth.listeningToSong')}</span>
          </div>
        )}
        {error && (
          <Text tone="danger" size="sm" className="djTraitError">{error}</Text>
        )}
        {analysis && !quick && (
          <>
            <Text tone="muted" size="sm" className="djTraitSummary">{analysis.summary}</Text>
            <div className="djTraitCloud" aria-label={t('booth.musicalTraits')}>
              {analysis.traits.map((trait: DjTrait) => {
                const active = selected.has(trait.id);
                return (
                  <Button
                    type="button"
                    variant={active ? 'solid' : 'outline'}
                    size="sm"
                    key={trait.id}
                    className="djTrait"
                    data-selected={active || undefined}
                    aria-pressed={active}
                    title={trait.description}
                    onClick={() => setSelected((previous) => {
                      const next = new Set(previous);
                      if (next.has(trait.id)) next.delete(trait.id); else next.add(trait.id);
                      return next;
                    })}
                  >
                    <span className="djTrait__label">{trait.label}</span>
                    <span className="djTrait__category">{trait.category.replace('_', ' ')}</span>
                  </Button>
                );
              })}
            </div>
            <div className="djNoteEditor">
              <label htmlFor={`dj-note-${trackId}`}>{t('booth.yourDjNote')}</label>
              <Textarea id={`dj-note-${trackId}`} value={djNote} maxLength={2000}
                placeholder={t('booth.djNotePlaceholder')}
                onChange={(event) => { setDjNote(event.target.value); setNoteSaved(false); }} />
              <Button variant="outline" size="sm" disabled={noteSaved || busy} onClick={() => {
                if (!session || trackId === null) return;
                setBusy(true);
                void saveDjNote(session, trackId, djNote)
                  .then(async (result) => {
                    setDjNote(result.note); setNoteSaved(true);
                    const refreshed = await analyzeDjTrack(session, trackId);
                    setAnalysis(refreshed);
                    setSelected(new Set([...refreshed.traits]
                      .sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)
                      .slice(0, 3).map((trait) => trait.id)));
                  })
                  .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t('booth.couldNotSaveNote')))
                  .finally(() => setBusy(false));
              }}>{noteSaved ? t('booth.noteSaved') : t('booth.saveNote')}</Button>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}

/** Two entries rather than one sentence with the noun poured in: "this album"
 *  and "this playlist" stop sharing a shape the moment the article has to
 *  agree with the noun. */
const COLLECTION_TITLE = {
  album: 'booth.buildMixFromAlbum',
  playlist: 'booth.buildMixFromPlaylist',
} as const;

export function DjCollectionTraitSheet({ source, name, seedTracks, open, onClose }: {
  source: 'album' | 'playlist'; name: string; seedTracks: Track[];
  open: boolean; onClose: () => void;
}) {
  const t = useT();
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const play = useDjPlay();
  const { toast } = useToast();
  const seedIds = useMemo(() => seedTracks.map((t) => trackIdFromPath(t.path))
    .filter((id): id is number => id !== null), [seedTracks]);
  const seedKey = seedIds.join(',');
  const [analysis, setAnalysis] = useState<DjTraitAnalysis | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !session || seedIds.length === 0) return;
    const ctrl = new AbortController();
    setAnalysis(null); setSelected(new Set()); setError(null); setBusy(true);
    void analyzeDjCollection(session, source, name, seedIds, ctrl.signal)
      .then((value) => {
        setAnalysis(value);
        setSelected(new Set([...value.traits]
          .sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)
          .slice(0, 3).map((t) => t.id)));
      })
      .catch((reason: unknown) => {
        if (!ctrl.signal.aborted) setError(reason instanceof Error ? reason.message : t('booth.couldNotReadCollection'));
      })
      .finally(() => { if (!ctrl.signal.aborted) setBusy(false); });
    return () => ctrl.abort();
    // seedKey is the stable identity; seedIds itself is rebuilt during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seedKey is the stable identity; seedIds itself is rebuilt during render
  }, [open, session, source, name, seedKey]);

  const chosen = analysis?.traits.filter((trait) => selected.has(trait.id)) ?? [];
  const generate = async () => {
    if (!session || chosen.length === 0 || !play) return;
    setBusy(true); setError(null);
    try {
      const result = await generateDjCollectionQueue(session, seedIds, chosen);
      const byId = new Map<number, Track>();
      for (const item of tracks) {
        const id = trackIdFromPath(item.path); if (id !== null) byId.set(id, item);
      }
      const queue = result.trackIds.map((id) => byId.get(id)).filter((item): item is Track => item !== undefined);
      const first = queue[0];
      if (!first) throw new Error(t('booth.noPlayableMatches'));
      play(first, queue);
      rememberDjReasons(result.explanations);
      const reason = result.explanations.find((item) => item.trackId === trackIdFromPath(first.path));
      if (reason) toast({ message: t('booth.whyStartedHere', { reason: reason.reason }) });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('booth.couldNotBuildMix'));
    } finally { setBusy(false); }
  };

  return <Drawer open={open} onClose={onClose} side="bottom" size="lg" className="djTraitSheet"
    title={<>{t(COLLECTION_TITLE[source])}</>}
    description={t('booth.collectionSongs', { name, count: seedIds.length })}
    footer={<Button variant="solid" disabled={busy || chosen.length === 0} onClick={() => void generate()}>
      {busy && analysis ? <Spinner size="sm" /> : <Play size={15} fill="currentColor" />}
      {chosen.length > 0
        ? t('booth.buildMyQueueCount', { count: chosen.length })
        : t('booth.buildMyQueue')}
    </Button>}>
    <div className="djTraitSheet__body">
      {!analysis && busy && <div className="djTraitListening" role="status"><Sparkles size={22} />
        <span>{t('booth.findingCenter')}</span></div>}
      {error && <Text tone="danger" size="sm" className="djTraitError">{error}</Text>}
      {analysis && <><Text tone="muted" size="sm" className="djTraitSummary">{analysis.summary}</Text>
        <div className="djTraitCloud" aria-label={t('booth.musicalTraits')}>{analysis.traits.map((trait) => {
          const active = selected.has(trait.id);
          return <Button type="button" variant={active ? 'solid' : 'outline'} size="sm" key={trait.id} className="djTrait" data-selected={active || undefined}
            aria-pressed={active} title={trait.description} onClick={() => setSelected((previous) => {
              const next = new Set(previous); if (next.has(trait.id)) next.delete(trait.id); else next.add(trait.id); return next;
            })}><span className="djTrait__label">{trait.label}</span>
            <span className="djTrait__category">{trait.category.replace('_', ' ')}</span></Button>;
        })}</div></>}
    </div>
  </Drawer>;
}
