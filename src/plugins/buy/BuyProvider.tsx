import { createContext, useContext, useState, type ReactNode } from 'react';
import { Modal } from '@glacier/react';
import { ExternalLink } from '@glacier/icons';
import type { AcquireTarget } from '../types.ts';
import { openExternal } from '../../app/core/openExternal.ts';

/**
 * The Buy plugin's opener: the acquire handler calls `open` with a song or
 * album, and this puts up the store sheet. A context (not a prop) because the
 * handler lives in a hook the runtime calls, nowhere near this component.
 */
interface BuyContextValue {
  open: (target: AcquireTarget) => void;
}

const BuyContext = createContext<BuyContextValue | null>(null);

/** The opener if the Buy plugin is mounted, else null. Never throws, so the
 *  handler hook can bail cleanly when the provider is somehow absent. */
export function useBuy(): BuyContextValue | null {
  return useContext(BuyContext);
}

/** One storefront, and the download formats it is worth naming. The search URL
 *  is built from the artist and title - a store cannot be linked straight to a
 *  purchase from outside, but it can be dropped on the right search. */
interface Store {
  name: string;
  formats: string;
  search: (query: string) => string;
}

// Ordered roughly best-quality-first for someone after a lossless file: the
// FLAC/hi-res stores lead, the MP3/AAC ones follow.
const STORES: readonly Store[] = [
  { name: 'Bandcamp', formats: 'MP3 · FLAC', search: (q) => `https://bandcamp.com/search?q=${q}` },
  {
    name: 'Qobuz',
    formats: 'FLAC · Hi-Res',
    search: (q) => `https://www.qobuz.com/us-en/search?q=${q}`,
  },
  { name: '7digital', formats: 'MP3 · FLAC', search: (q) => `https://us.7digital.com/search?q=${q}` },
  {
    name: 'HDtracks',
    formats: 'FLAC · Hi-Res',
    search: (q) => `https://www.hdtracks.com/#/search?q=${q}`,
  },
  {
    name: 'iTunes Store',
    formats: 'AAC',
    search: (q) => `https://music.apple.com/us/search?term=${q}`,
  },
  {
    name: 'Amazon Music',
    formats: 'MP3',
    search: (q) => `https://www.amazon.com/s?k=${q}&i=digital-music`,
  },
];

/**
 * Holds the store sheet. Mounted as the Buy plugin's Provider, so its opener is
 * in scope for the plugin's acquire handler; renders nothing until a song or
 * album is handed to `open`.
 */
export function BuyProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<AcquireTarget | null>(null);
  const query = target
    ? encodeURIComponent([target.artist, target.title].filter(Boolean).join(' ').trim())
    : '';

  return (
    <BuyContext.Provider value={{ open: setTarget }}>
      {children}
      {target && (
        <Modal open onClose={() => setTarget(null)} title={`Buy “${target.title}”`} size="sm">
          <div className="buyModal">
            <p className="buyModal__blurb">
              {target.artist ? `${target.title} · ${target.artist}` : target.title} — open a store to
              buy it as a download, then drop the file into your library folder.
            </p>
            <div className="buyModal__stores">
              {STORES.map((store) => (
                <button
                  key={store.name}
                  type="button"
                  className="buyStore"
                  onClick={() => void openExternal(store.search(query))}
                >
                  <span className="buyStore__text">
                    <span className="buyStore__name">{store.name}</span>
                    <span className="buyStore__formats">{store.formats}</span>
                  </span>
                  <ExternalLink size={16} className="buyStore__go" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </BuyContext.Provider>
  );
}
