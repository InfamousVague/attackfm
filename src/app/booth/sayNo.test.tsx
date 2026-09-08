import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SayNoItems } from './sayNo.tsx';

/**
 * The rows a hold reveals over a song the machine chose.
 *
 * Worth pinning because the queue's now row LOST its thumbs: the pair that
 * used to ride the far end of that row lives in the DJ's popover now, and the
 * only thing that kept the queue's approval reachable at all is the optional
 * "more like this song" row below. If that row ever stops rendering when a
 * surface asks for it, the queue silently becomes a place where a listener
 * can refuse a song but never approve one - which is exactly the asymmetry
 * sayNo.tsx's header says must not happen by accident.
 *
 * The Date deck is the other half of the contract, and the reason `onUp` is
 * optional rather than always on: a card there is already being passed, and a
 * menu offering "more like this" on the way out would be nonsense.
 *
 * `t` is the identity function, so the assertions read as catalogue keys -
 * this suite should not fail because somebody rewords a menu item. MenuItem
 * is a plain button and needs no menu around it, which is what makes these
 * rows renderable on their own (see npArtMenu.test.tsx).
 */

const translate = (key: string) => key;
vi.mock('../i18n/LocaleShell.tsx', () => ({ useT: () => translate }));

function open(extra: { onUp?: () => void; artist?: string; why?: string } = {}) {
  const { container } = render(
    <SayNoItems
      why={extra.why}
      artist={extra.artist ?? 'Radiohead'}
      onTrack={vi.fn()}
      onArtist={vi.fn()}
      onUp={extra.onUp}
    />,
  );
  return [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
    (r) => r.textContent ?? '',
  );
}

describe('the verdict rows', () => {
  it('offers only the refusals when the surface asks for no approval', () => {
    expect(open()).toEqual(['booth.notThisSong', 'booth.lessLikeArtist']);
  });

  it('puts the approval FIRST when the surface asks for one', () => {
    // Order is the point, not just presence: a hold is deliberate, and the
    // destructive rows must not be the ones sitting under the finger.
    expect(open({ onUp: vi.fn() })).toEqual([
      'booth.moreLikeThisSong',
      'booth.notThisSong',
      'booth.lessLikeArtist',
    ]);
  });

  it('calls back the surface that owns the approval', () => {
    const onUp = vi.fn();
    const { container } = render(
      <SayNoItems why={null} artist="Radiohead" onTrack={vi.fn()} onArtist={vi.fn()} onUp={onUp} />,
    );
    container.querySelector<HTMLElement>('[role="menuitem"]')?.click();
    expect(onUp).toHaveBeenCalledOnce();
  });

  it('still drops the artist row for a song with no act named', () => {
    // The approval is about the SONG, so it survives where the artist row
    // cannot - a track with a blank artist can still be asked for more of.
    expect(open({ artist: '   ', onUp: vi.fn() })).toEqual([
      'booth.moreLikeThisSong',
      'booth.notThisSong',
    ]);
  });
});
