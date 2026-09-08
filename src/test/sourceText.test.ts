import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every source file in this room is TEXT, and grep can read it.
 *
 * Not a style rule - a tooling one, and it cost a real hour. `songKey` in
 * `FriendProfilePage.tsx` joins an artist and a title with a zero byte, and
 * for years that byte was written as a literal one inside a template string.
 * A single one of them makes the whole FILE binary:
 *
 *   - `git diff` prints "Bin 22846 -> 22884 bytes" in place of the change, so
 *     a review of that file reviews nothing;
 *   - `grep -r` SKIPS binary files, silently and by default.
 *
 * The second is the expensive half. This codebase is navigated by grep - "who
 * calls this, who imports that" is how every move in the clean-repo programme
 * is planned - so a file grep will not read is a file whose import sites do
 * not exist as far as the search is concerned. Moving `seenAgo` out of
 * `RegistryFriends.tsx`, a grep for it reported two call sites where there
 * were three, and only `tsc` caught the importer that had been sitting
 * invisibly in this directory the whole time.
 *
 * The fix is one character wide: spell the separator as an escape. Identical
 * string at runtime, an ordinary text file on disk. These cases are here so it
 * cannot come back the next time somebody wants a separator a title cannot
 * contain.
 */

/* From the repo root, not from `import.meta.url`: under Vitest that resolves
   against the Vite server rather than the disk, and readFileSync then looks
   for `/src/...` at the filesystem root.

   The whole of `src`, not one room. This started as a guard on `profile/`,
   where the byte was found - and the day it moved up here it caught a second
   one, `ALL_DRAWERS` in `player/fxEditing.tsx`, a sentinel written the same
   way for the same good reason and invisible to grep for just as long. One
   room's rule was never the point. */
const HERE = join(process.cwd(), 'src');

function sourcesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourcesIn(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the source tree on disk', () => {
  it('has no source file that git and grep would read as BINARY', () => {
    const binary = sourcesIn(HERE).filter((path) => readFileSync(path).includes(0));
    expect(binary).toEqual([]);
  });

  it('still keys a song on a separator no title can contain', () => {
    /*
     * The other half of the same fix: the escape has to survive as the
     * CHARACTER it stands for. Had it been written as two literal
     * backslash-u characters, `songKey` would go on producing keys - just
     * different ones - and every cross-hub song lookup on a friend's profile
     * would quietly miss.
     */
    const key = `artist\u0000title`;
    expect(key.charCodeAt(6)).toBe(0);
    expect(key).toHaveLength(12);
    // And the file itself must keep spelling it that way.
    const source = readFileSync(join(HERE, 'app', 'profile', 'FriendProfilePage.tsx'), 'utf8');
    expect(source).toContain('${fold(artist)}' + '\\u0000');
  });
});
