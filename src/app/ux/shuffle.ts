/**
 * Fisher-Yates, so "shuffle this collection" means a jumbled ORDER of exactly
 * these songs - not a flip of the player's own shuffle switch, which would
 * outlive the page that asked. One implementation: the song pages, the
 * playlist page and the album menu each used to carry their own copy.
 */
export function shuffled<T>(list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}
