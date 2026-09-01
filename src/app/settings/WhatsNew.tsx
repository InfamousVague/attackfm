import { Text } from '@glacier/react';
import { useMemo, useState } from 'react';
import { APP_VERSION } from '../core/version.ts';
// The changelog rides inside the bundle: every device already downloads these
// words with the app, so the timeline costs no request and works offline.
import changelog from '../../../CHANGELOG.md?raw';

/**
 * What's new, as a timeline.
 *
 * The changelog has always shipped - one version's lines in the update banner,
 * then gone. This reads the whole file back out and stands it up in About, so
 * "what changed lately" has an answer that survives the banner's dismissal.
 * The prose preamble above the first heading is the file's own documentation
 * and stays out; a section with no lines (shipped --no-notes) is skipped
 * rather than shown as an empty promise.
 */

interface Release {
  version: string;
  lines: string[];
}

function parse(md: string): Release[] {
  const out: Release[] = [];
  let current: Release | null = null;
  for (const raw of md.split('\n')) {
    const heading = raw.match(/^## (\d+\.\d+\.\d+)\s*$/);
    if (heading) {
      current = { version: heading[1]!, lines: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    // A bullet wraps across physical lines in the source, its continuations
    // indented under the "- ". Start a new line on "- ", and fold anything
    // else onto the one above it - without this the timeline showed only the
    // first physical line of every multi-line entry.
    if (raw.startsWith('- ')) current.lines.push(raw.slice(2).trim());
    else if (raw.trim() && current.lines.length) {
      current.lines[current.lines.length - 1] += ' ' + raw.trim();
    }
  }
  return out.filter((r) => r.lines.length > 0);
}

/** How many releases stand shown before the rest wait behind one press. */
const FOLD = 5;

export function WhatsNew() {
  const releases = useMemo(() => parse(changelog), []);
  const [all, setAll] = useState(false);
  if (releases.length === 0) return null;
  const shown = all ? releases : releases.slice(0, FOLD);

  return (
    <div className="prefsSection">
      <div className="whatsNew" role="list">
        {shown.map((release) => (
          <div className="whatsNew__release" role="listitem" key={release.version}>
            <div className="whatsNew__stamp">
              <span className="whatsNew__version">v{release.version}</span>
              {release.version === APP_VERSION && (
                <span className="whatsNew__here">you are here</span>
              )}
            </div>
            <ul className="whatsNew__lines">
              {release.lines.map((line, i) => (
                <li key={i}>
                  <Text size="sm" tone="muted">
                    {line}
                  </Text>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {releases.length > FOLD && (
        <button type="button" className="whatsNew__more" onClick={() => setAll((v) => !v)}>
          {all ? 'Fewer' : `All ${releases.length} releases`}
        </button>
      )}
    </div>
  );
}
