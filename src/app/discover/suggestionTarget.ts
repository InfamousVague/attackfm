import type { Suggestion } from '../api/curator.ts';
import type { AcquireTarget } from '../../plugins/types.ts';

/** A suggestion as the importer wants it named. Every suggestion is a link
 *  to a list; `kind` says which shape when the server knows. */
export function suggestionTarget(item: Suggestion): AcquireTarget {
  const kind: AcquireTarget['kind'] =
    item.kind === 'album' ? 'album' : item.kind === 'track' ? 'track' : 'playlist';
  return { kind, title: item.title, url: item.url };
}
