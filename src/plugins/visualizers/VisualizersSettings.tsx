import { useEffect, useState } from 'react';
import { useT } from '../../app/i18n/LocaleShell.tsx';
import { OptionCards, PaneSection, SettingsFootnote } from '../../app/settings/kit/settingsKit.tsx';
import { VISUALIZERS } from './visualizers.ts';
import { VizThumb } from './VizThumb.tsx';
import { VIZ_EVENT, readVizIndex, writeVizIndex } from './vizPref.ts';

/**
 * The picker: every visualizer as a card with a still of it, one checked.
 * The same choice the art square cycles with a tap, so picking here changes
 * the square that is already on screen.
 */
export function VisualizersSettings() {
  const t = useT();
  const [index, setIndex] = useState(readVizIndex);
  useEffect(() => {
    const on = () => setIndex(readVizIndex());
    window.addEventListener(VIZ_EVENT, on);
    return () => window.removeEventListener(VIZ_EVENT, on);
  }, []);
  const current = VISUALIZERS[index % VISUALIZERS.length] ?? VISUALIZERS[0];

  return (
    <>
      <PaneSection
        title={t('visualizers.paneTitle')}
        description={t('visualizers.paneDescription')}
      >
        <OptionCards
          value={current?.id ?? ''}
          onChange={(id) => {
            const i = VISUALIZERS.findIndex((v) => v.id === id);
            if (i < 0) return;
            setIndex(i);
            writeVizIndex(i);
          }}
          options={VISUALIZERS.map((v) => ({
            id: v.id,
            preview: <VizThumb def={v} />,
            label: t(v.nameKey),
            note: t(v.noteKey),
          }))}
        />
      </PaneSection>
      <SettingsFootnote>{t('visualizers.footnote')}</SettingsFootnote>
    </>
  );
}
