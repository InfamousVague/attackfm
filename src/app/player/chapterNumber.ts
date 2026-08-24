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
 * The number the FIRST chapter wears, given every chapter's name in order.
 *
 * Anchored on the first chapter that states a number, then applied to all of
 * them - so one unnumbered "Prologue" in front of "Chapter 1" does not throw the
 * rest off, and a book whose tags say nothing keeps the 1-based counting it has
 * always had.
 *
 * ANCHORING ON ONE CHAPTER IS THE POINT. Reading each row's own number instead
 * would let a single odd heading ("Chapter 12" sitting at position 3, because a
 * tagger got creative) put a hole in the sequence, and the list would count
 * 1, 2, 12, 4. A book numbers itself one way or not at all.
 */
export function chapterNumberBase(titles: readonly string[]): number {
  for (let i = 0; i < titles.length; i += 1) {
    const stated = statedChapterNumber(titles[i] ?? '');
    if (stated !== null) return stated - i;
  }
  return 1;
}
