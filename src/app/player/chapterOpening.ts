/*
 * What a chapter LOOKS like, from its own opening.
 *
 * This is not a summary and is not pretending to be one. A summary of a chapter
 * has to be written by something that has read it - that is the hub's job, and
 * with a model configured it writes a real non-spoiler line per chapter. This is
 * what a book can say about itself when there is no model: enough of the opening
 * to recognise a chapter you have already heard.
 *
 * Which means the job is mostly SUBTRACTION. The literal first words of a file
 * are the publisher's card ("This is Audible... written by... narrated by...")
 * and the narrator announcing the number - text that is identical across every
 * chapter and tells you nothing about any of them. Cutting that away is the
 * difference between a preview and a label.
 */

/** Phrases that belong to the edition rather than the book. */
const BOILERPLATE = [
  /^this is audible[^.]*\.?\s*/i,
  /^audible(?:\.com)? (?:presents|originals?)[^.]*\.?\s*/i,
  /^[a-z0-9' -]{0,60}sound booth theater presents\s*/i,
  /^brilliance audio presents\s*/i,
  /^tantor audio presents\s*/i,
  /^blackstone (?:audio|publishing) presents\s*/i,
  /^written by [^.]*?\.\s*/i,
  /^narrated by [^.]*?\.\s*/i,
  /^a (?:presentation|production) of [^.]*?\.\s*/i,
];

/** A chapter announcement at the head - "Chapter twelve:", "Chapter 4." */
const ANNOUNCEMENT =
  /^(?:and\s+now,?\s+)?chapters?\s+(?:[a-z]+(?:[-\s][a-z]+)?|\d{1,4})\s*[.:,!?-]*\s*/i;

/**
 * A spoken number left stranded at the head.
 *
 * The recogniser breaks its lines on pauses, not on sense, so "Chapter one." is
 * routinely split across two of them - the announcement ends one segment and the
 * NUMBER opens the next. Whatever picked the segment up then began "one the
 * transformation occurred...", which reads as a transcription fault rather than
 * the chapter it is.
 */
const STRANDED_NUMBER =
  /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|\d{1,4})(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?\s*[.:,]?\s+/;

const MAX = 150;

/**
 * The preview for one chapter, or null when there is nothing worth showing.
 *
 * Cut at a sentence where possible: an ellipsis mid-clause reads as truncation,
 * where a whole sentence reads as a choice - and it is also the safer place to
 * stop, since the less of the chapter shown the less of it is given away.
 */
export function chapterPreview(opening: string): string | null {
  let t = (opening ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // Repeatedly, because editions stack them: a card, then the title, then the
  // narrator, then the announcement.
  for (let pass = 0; pass < 6; pass += 1) {
    const before = t;
    for (const re of BOILERPLATE) t = t.replace(re, '');
    t = t.replace(ANNOUNCEMENT, '');
    t = t.trim();
    if (t === before) break;
  }
  /*
   * CASE IS THE TELL, which is why the pattern above is not case-insensitive.
   *
   * A recogniser writes in lower case throughout, so the half of a split
   * "Chapter one." that lands here arrives as a lower-case "one". A capitalised
   * "One" did not come from the recogniser breaking a sentence in half - it is
   * prose, and "One morning in April" is a sentence that begins with a number
   * word rather than a stray ordinal. Stripping it left chapters opening on
   * "Morning in April".
   *
   * The direction of the risk is the right one: a cased transcript keeps a
   * stranded number it could have dropped, which is a blemish, where the other
   * way round eats the first word of the book.
   */
  const stranded = t.replace(STRANDED_NUMBER, '').trim();
  if (stranded && /^[a-z]/.test(stranded)) t = stranded;

  if (t.length < 24) return null;

  if (t.length <= MAX) return upper(t);
  const cut = t.slice(0, MAX);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (stop > 60) return upper(cut.slice(0, stop + 1).trim());
  const space = cut.lastIndexOf(' ');
  return `${upper((space > 60 ? cut.slice(0, space) : cut).trim())}…`;
}

/** Recogniser output is lower-case throughout; a preview starting mid-case
 *  reads as broken even though the words are right. */
function upper(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
