import type { ReactNode } from 'react';
import { Trans } from '../../i18n/LocaleShell.tsx';

/**
 * The handbook's four typographic pieces.
 *
 * Their own module because `handbookPages.tsx` beside them is DATA - one array
 * built at import, holding a page's icon and a function that renders its prose
 * - and a file that is both a component library and a table of contents is a
 * file that reloads the whole manual every time a paragraph style is touched.
 * Nothing here knows anything about the handbook's contents; the pages know
 * about these.
 */

/** A paragraph of handbook prose. */
export function P({ children }: { children: ReactNode }) {
  return <p className="handbook__p">{children}</p>;
}

/** Icon-led fact rows - the handbook's bullet points. */
export function Facts({ items }: { items: readonly { icon: ReactNode; text: ReactNode }[] }) {
  return (
    <ul className="handbook__facts">
      {items.map((f, i) => (
        <li key={i}>
          <span className="handbook__factIcon" aria-hidden="true">
            {f.icon}
          </span>
          <span>{f.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A short code block - a manifest, a signature - kept small on purpose. */
export function Code({ children }: { children: string }) {
  return (
    <pre className="handbook__code">
      <code>{children}</code>
    </pre>
  );
}

/**
 * A sentence with code spans in it.
 *
 * The names go in as `values`, never as part of the catalogue entry: the
 * entry says WHERE a name sits in the sentence and the name itself is handed
 * over intact, so no translation can rename an API. The `<c>` tag in the
 * entry is the code span the name lands in.
 */
export function Spans({ k, names }: { k: string; names: Record<string, string> }) {
  return <Trans i18nKey={k} values={names} components={{ c: <code /> }} />;
}
