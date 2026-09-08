/**
 * The four pieces every handbook page is written out of.
 *
 * They are three lines each, which is exactly why they are worth pinning: 60
 * pages are built from them, nobody re-reads them, and each carries one
 * decision that a tidy-up would quietly undo. The class names are the whole
 * of the handbook's typography (HandbookPane.css styles nothing else), the
 * decorative icon beside a fact must not be read out by a screen reader
 * alongside the fact itself, and `Code` renders its child as TEXT - a code
 * sample interpolated into markup instead is how a manifest example becomes
 * markup.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

/* `Trans` is i18next's, and what `Spans` is FOR is what it hands over: a key,
   the names as values, and a `<c>` component for the span they land in. The
   stand-in reports those three so a case can assert on them; the real one
   would need a whole i18next instance to say anything at all. */
vi.mock('../../i18n/LocaleShell.tsx', () => ({
  Trans: ({
    i18nKey,
    values,
    components,
  }: {
    i18nKey: string;
    values: Record<string, string>;
    components: Record<string, ReactNode>;
  }) => (
    <span data-key={i18nKey} data-values={JSON.stringify(values)} data-tags={Object.keys(components).join(',')} />
  ),
}));

const { Code, Facts, P, Spans } = await import('./handbookBits.tsx');

describe('P', () => {
  it('is a paragraph wearing the handbook class', () => {
    // The class is the styling; a <p> without it is unstyled body text in the
    // middle of the manual, which reads as a broken page rather than as a
    // missing className.
    //
    // The child goes in as an expression rather than as JSX text because
    // `npm run i18n:gate` scans this tree for hard-coded English, and a
    // literal here is one more hit on a ceiling other people are working down.
    render(<P>{'Prose.'}</P>);
    const p = screen.getByText('Prose.');
    expect(p.tagName).toBe('P');
    expect(p).toHaveClass('handbook__p');
  });
});

describe('Facts', () => {
  it('draws one row per fact, in the order given', () => {
    render(
      <Facts
        items={[
          { icon: <i data-testid="glyph" />, text: 'First' },
          { icon: <i data-testid="glyph" />, text: 'Second' },
        ]}
      />,
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.textContent)).toEqual(['First', 'Second']);
  });

  it('HIDES THE GLYPH from a screen reader', () => {
    // The icon repeats what the sentence beside it already says. Read out, a
    // fact list becomes twice as long and half of it is noise - and this is
    // an accessibility regression nothing on screen would show.
    const { container } = render(<Facts items={[{ icon: <i data-testid="glyph" />, text: 'A fact' }]} />);
    const glyph = container.querySelector('.handbook__factIcon');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph!.contains(screen.getByTestId('glyph'))).toBe(true);
  });

  it('is a real list, so it is navigable as one', () => {
    render(<Facts items={[{ icon: null, text: 'Only' }]} />);
    expect(screen.getByRole('list')).toHaveClass('handbook__facts');
  });

  it('draws nothing but the empty list for no facts', () => {
    render(<Facts items={[]} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});

describe('Code', () => {
  it('renders its sample as TEXT, never as markup', () => {
    /*
     * The handbook's plugin chapter shows manifests and signatures. Anything
     * with a `<` in it - a generic, an element name, an XML snippet - would
     * be parsed away if this were ever "improved" into a
     * dangerouslySetInnerHTML, and the reader would see a sample that is
     * missing the part they came for.
     */
    const sample = '{ "slots": { "titlebar-end": "<Widget />" } }';
    const { container } = render(<Code>{sample}</Code>);
    const pre = container.querySelector('pre.handbook__code');
    expect(pre).not.toBeNull();
    expect(pre!.querySelector('code')!.textContent).toBe(sample);
    // One <code>, not a tree parsed out of the sample.
    expect(pre!.querySelectorAll('*')).toHaveLength(1);
  });

  it('keeps the whitespace a sample was written with', () => {
    // A <pre>, not a <div>: a two-line manifest collapsed onto one line is a
    // manifest nobody can copy.
    const { container } = render(<Code>{'{\n  "id": "x"\n}'}</Code>);
    expect(container.querySelector('code')!.textContent).toContain('\n  "id"');
  });
});

describe('Spans', () => {
  it('hands the NAMES over as values rather than into the key', () => {
    // The rule the component exists for: a catalogue entry says where a name
    // sits in a sentence, and the name itself travels intact - so no
    // translation of any language can rename an API.
    const { container } = render(<Spans k="settings.handbookSlots" names={{ slot: 'titlebar-end' }} />);
    const span = container.querySelector('span')!;
    expect(span.getAttribute('data-key')).toBe('settings.handbookSlots');
    expect(span.getAttribute('data-values')).toBe('{"slot":"titlebar-end"}');
  });

  it('offers the <c> tag the entry writes its code span with', () => {
    // The entry reads "... <c>{{slot}}</c> ...". Rename the tag here and the
    // sentence renders with the literal markup showing, or with the span
    // dropped - i18next does not warn either way.
    const { container } = render(<Spans k="settings.handbookSlots" names={{ slot: 'titlebar-end' }} />);
    expect(container.querySelector('span')!.getAttribute('data-tags')).toBe('c');
  });
});
