/*
 * What number a chapter should WEAR.
 *
 * Every chapter surface used to count from its position in the list: the row in
 * chapter select, "Chapter 2 of 50" in the transport, the headings folded into
 * the reading flow. That is right for most books and wrong for every book that
 * opens at zero - a prologue tagged "Chapter 0", which plenty of series do - and
 * when it is wrong it is wrong for the WHOLE book, not one row. Chapter 0 reads
 * as 1, chapter 1 reads as 2, and the number beside the words you are hearing
 * disagrees with the words themselves for thirteen hours.
 *
 * So the book is asked how it numbers itself, once, and every surface counts
 * from that.
 */

/**
 * The number a chapter claims in its own name, or null when it claims none.
 *
 * Deliberately narrow. It reads "Chapter 7", "Ch. 07", "Part 3", and a leading
 * "03 - " of the kind rippers write - and nothing else. A looser pattern starts
 * finding numbers in titles that merely contain one ("Ten Green Bottles"), and a
 * wrong anchor is worse than no anchor: it would renumber an entire book off one
 * misread heading.
 */
export function statedChapterNumber(title: string): number | null {
  const named = /^\s*(?:chapters?|chap\.?|ch\.?|parts?|books?)\s*0*(\d{1,4})\b/i.exec(title);
  if (named) return Number.parseInt(named[1]!, 10);
  // "03 - The Vault", "12. Ascent" - a number that is clearly a label because
  // punctuation and a word follow it.
  const leading = /^\s*0*(\d{1,4})\s*[—–:.)-]\s*\S/.exec(title);
  return leading ? Number.parseInt(leading[1]!, 10) : null;
}

/**
 * The number each chapter wears, in order - null for front matter.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 * 1. The book is ANCHORED on the first chapter that states a number in its own
 *    name, and every chapter counts from there. Anchoring on one chapter is
 *    deliberate: reading each row's own number instead would let a single odd
 *    heading ("Chapter 12" sitting third, because a tagger got creative) put a
 *    hole in the sequence and count 1, 2, 12, 4. A book numbers itself one way
 *    or not at all.
 *
 * 2. A row BEFORE the anchor that states no number of its own is front matter -
 *    a Preamble, a Prologue, an Author's Note - and it carries NO number. It
 *    already has a real name. Numbering it by arithmetic produces "Chapter 0"
 *    for a prologue that the book never called chapter zero, or "-1" for one
 *    sitting ahead of a genuine Chapter 0, and both are inventions.
 *
 * A book whose titles say nothing anywhere keeps the 1-based counting by
 * position that every chapter surface has always used.
 */
export function chapterNumbers(titles: readonly string[]): (number | null)[] {
  const stated = titles.map((t) => statedChapterNumber(t ?? ''));
  const anchor = stated.findIndex((n) => n !== null);
  if (anchor === -1) return titles.map((_, i) => i + 1);
  const base = stated[anchor]! - anchor;
  return titles.map((_, i) => {
    if (i < anchor && stated[i] === null) return null;
    const n = i + base;
    return n >= 0 ? n : null;
  });
}
