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
export function chapterNumbers(
  titles: readonly string[],
  /**
   * What the NARRATOR said, and where. Outranks every title.
   *
   * Tags are written by whoever ripped the book and routinely count the
   * publisher's own front matter as chapter one - the Audible card that says
   * which book this is takes the first seat, and the whole book reads one
   * ahead of itself from there. The reading itself does not have that problem:
   * the narrator says "Chapter One" at the top of chapter one, whatever the
   * file is called. So when the transcript tells us a number, that is the
   * anchor and the titles only fill in around it.
   */
  spoken?: { index: number; number: number } | readonly (number | null)[] | null,
): (number | null)[] {
  const stated = titles.map((t) => statedChapterNumber(t ?? ''));

  /*
   * An ARRAY means we heard every chapter's opening, not just one.
   *
   * That is the case for a single-file book: its transcript covers the whole
   * thing, so each marker's own opening can be read. It is worth more than one
   * anchor, because it turns "this row announced nothing" into EVIDENCE. A
   * publisher's card at the top of the file announces nothing and is not a
   * chapter; a real Chapter Zero says so out loud. Without that, the two are
   * indistinguishable and the card ends up numbered.
   */
  const heard = Array.isArray(spoken) ? (spoken as readonly (number | null)[]) : null;
  const one = heard ? null : (spoken as { index: number; number: number } | null | undefined) ?? null;

  const anchor = heard
    ? heard.findIndex((n) => n !== null)
    : one
      ? one.index
      : stated.findIndex((n) => n !== null);
  if (anchor === -1 || anchor >= titles.length) return titles.map((_, i) => i + 1);

  const base = (heard ? heard[anchor]! : one ? one.number : stated[anchor]!) - anchor;
  return titles.map((_, i) => {
    // Before the first announced chapter. With a full reading that is proof of
    // front matter; with only titles to go on it is the same rule applied to
    // the weaker evidence - a row that claims no number of its own.
    if (i < anchor && (heard ? heard[i] === null : stated[i] === null)) return null;
    const n = i + base;
    return n >= 0 ? n : null;
  });
}

/*
 * What the narrator says at the top of a section.
 *
 * A port of the hub's `declared_name`, kept narrow: only the NUMBER is wanted
 * here, because the hub is the one that writes names and this only has to place
 * the reading in the book. It exists on this side at all so a book numbers
 * itself correctly from a transcript the app has already fetched, rather than
 * waiting on the hub to have swept it.
 */

const SPOKEN_ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const SPOKEN_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** "twenty-three" / "seven" / "0" -> a number, or null for anything else. */
function spokenNumber(words: string): number | null {
  const w = words.trim().toLowerCase();
  if (/^\d{1,4}$/.test(w)) {
    const n = Number.parseInt(w, 10);
    return n >= 0 && n < 1000 ? n : null;
  }
  const parts = w.split(/[-\s]+/).filter(Boolean);
  const first = parts[0] ?? '';
  // A whole number on its own. Whatever follows is the sentence carrying on
  // ("chapter four, Donut had insisted"), not part of the number.
  if (first in SPOKEN_ONES) return SPOKEN_ONES[first]!;
  const t = SPOKEN_TENS[first];
  if (t === undefined) return null;
  const second = parts[1];
  if (!second) return t;
  const o = SPOKEN_ONES[second];
  // Prose after a tens word - "chapter twenty the darkness closed" - leaves the
  // twenty standing. But "twenty zero" and "twenty ten" are not numbers anybody
  // says, and a mis-heard one is refused rather than guessed at: the anchor
  // renumbers the WHOLE book, so being wrong is far worse than being absent.
  if (o === undefined) return t;
  return o > 0 && o < 10 ? t + o : null;
}

/**
 * The chapter number announced in an opening, or null when none is.
 *
 * Only the OPENING is looked at, and only its first clause: "chapter" turns up
 * constantly inside a reading ("...back in chapter four, Donut had...") and a
 * mention is not an announcement. Front matter - a publisher's card, a preamble
 * - announces nothing, which is exactly how it comes to carry no number.
 */
export function spokenChapterNumber(opening: string): number | null {
  const head = opening.trim().toLowerCase().slice(0, 60);
  const m = /^(?:and\s+now,?\s+)?chapter\s+([a-z]+(?:[-\s][a-z]+)?|\d{1,4})\b/.exec(head);
  return m ? spokenNumber(m[1]!) : null;
}
