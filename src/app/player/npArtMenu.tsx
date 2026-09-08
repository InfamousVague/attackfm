import { MenuItem } from '@glacier/react';
import { AudioLines, BookOpenText, Check, Disc3, EyeOff, Image as ImageIcon, MicVocal, Sparkles } from '@glacier/icons';
import { translate } from '../i18n/LocaleShell.tsx';
import type { ArtView } from './deckShared.ts';

/**
 * One menu, three doorways: the strip's square, the sheet's art, and the
 * Canvas clip itself all open this same chooser, so the setting stays one
 * setting no matter where the press lands.
 */
export function npArtMenuItems(
  artView: ArtView,
  chooseArtView: (next: ArtView) => void,
  book = false,
  /** The song carries synced lyrics, so the reading face is worth offering.
   *  A book never does (it has its Chapters face instead), and a song with
   *  only plain lyrics keeps the mic popover rather than a read-along that
   *  could not light a word. */
  lyrics = false,
  /** Some enabled plugin fills the art square (the visualizers plugin), so
   *  the Visualizer face is worth offering. Absent the plugin the item is
   *  hidden rather than leading to an empty square. */
  visualizer = false,
  /** The translator, when the caller has one. It defaults to the non-reactive
   *  `translate` because this is a plain function, not a component, and cannot
   *  hold a hook of its own - which is safe here only because every caller
   *  builds these items inside a render that itself subscribes to the
   *  language, so the menu is rebuilt when the picker moves. */
  t: (key: string) => string = translate,
) {
  return (
    <>
      <MenuItem
        icon={<Disc3 size={15} />}
        shortcut={artView === 'cd' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('cd')}
      >
        {t('player.artSpinningCd')}
      </MenuItem>
      <MenuItem
        icon={<ImageIcon size={15} />}
        shortcut={artView === 'cover' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('cover')}
      >
        {t('player.artAlbumCover')}
      </MenuItem>
      {book && (
        <MenuItem
          icon={<BookOpenText size={15} />}
          shortcut={artView === 'chapters' ? <Check size={14} /> : undefined}
          onSelect={() => chooseArtView('chapters')}
        >
          {t('books.chapters')}
        </MenuItem>
      )}
      {!book && lyrics && (
        <MenuItem
          icon={<MicVocal size={15} />}
          shortcut={artView === 'lyrics' ? <Check size={14} /> : undefined}
          onSelect={() => chooseArtView('lyrics')}
        >
          {t('player.lyrics')}
        </MenuItem>
      )}
      <MenuItem
        icon={<AudioLines size={15} />}
        shortcut={artView === 'analyser' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('analyser')}
      >
        {t('player.artAnalyser')}
      </MenuItem>
      {visualizer && (
        <MenuItem
          icon={<Sparkles size={15} />}
          shortcut={artView === 'visualizer' ? <Check size={14} /> : undefined}
          onSelect={() => chooseArtView('visualizer')}
        >
          {t('player.artVisualizer')}
        </MenuItem>
      )}
      <MenuItem
        icon={<EyeOff size={15} />}
        shortcut={artView === 'hidden' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('hidden')}
      >
        {t('player.artHidden')}
      </MenuItem>
    </>
  );
}
