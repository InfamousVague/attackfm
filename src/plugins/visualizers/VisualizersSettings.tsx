import { useEffect, useState } from 'react';
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
        title="Visualizer"
        description={
          'Thirteen ways to draw the sound, in the spot where the CD spins. Pick one here, or tap the ' +
          'picture while it plays to cycle through them. Every one paints in the record’s own ' +
          'accent colour.'
        }
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
            label: v.name,
            note: v.note,
          }))}
        />
      </PaneSection>
      <SettingsFootnote>
        Choose Visualizer under Now Playing’s Artwork style menu (long-press the art) to show
        it. Drawn on the device from the live audio - nothing leaves the phone.
      </SettingsFootnote>
    </>
  );
}
