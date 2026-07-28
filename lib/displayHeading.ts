/**
 * UI-006. Korean writes in 어절 -- space-delimited chunks of a stem plus its
 * particles -- and the default `word-break: normal` treats every Hangul
 * syllable as its own break opportunity. On a display heading that produces
 * breaks *inside* a chunk ("선택하\n세요"), which reads to a Korean speaker the
 * way "Choo\nse" reads in English.
 *
 * `keep-all` restores the 어절 as the atomic unit. `break-word` stays alongside
 * it as the escape hatch the spec intends: a chunk that cannot fit on a line of
 * its own -- a long URL, a pasted identifier, a 200%-zoomed 320px viewport --
 * still breaks rather than overflowing its container.
 *
 * Deliberately scoped to display headings. Body copy, legal copy, user content
 * and model answers keep the default wrapping: `keep-all` over a paragraph
 * trades a rare bad break for consistently ragged lines.
 */
export function displayHeadingClass(lang: string): string {
  // `break-word` is not Korean-specific: it is the overflow escape hatch for
  // every language. UI-005 found the English comparison heading pushing
  // `/pricing` sideways at 320px with 200% zoom, where a 30px word is wider
  // than the whole column -- without it the browser has no legal break point
  // and overflows the page instead.
  return lang === "ko" ? "break-keep break-words" : "break-words";
}
