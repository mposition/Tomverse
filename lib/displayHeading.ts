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
 *
 * A global `:where(:lang(ko), :lang(zh)) { word-break: keep-all }` rule has now
 * been tried twice and reverted twice, so the reasons are worth keeping here
 * rather than in the pull requests:
 *
 *   * Chinese does not put spaces between words. `keep-all` only permits breaks
 *     at spaces, so a Chinese sentence becomes one unbreakable token and
 *     overflows -- the `/pricing` heading measured 367px in a 320px viewport.
 *     The first attempt hid this behind `overflow-wrap: anywhere`, which then
 *     split Korean words at 200% zoom, because `anywhere` (unlike
 *     `break-word`) also applies while min-content width is computed. Each half
 *     of that pair covers for the other's damage.
 *   * Applying it to body copy contradicts the scoping decision above. It is
 *     not an oversight that the chat disclaimer may break 입력 / 은: paragraphs
 *     were weighed and left on the default.
 *
 * If a specific surface needs the 어절 kept whole, give that element this
 * class. Do not reintroduce the global rule.
 */
export function displayHeadingClass(lang: string): string {
  // `break-word` is not Korean-specific: it is the overflow escape hatch for
  // every language. UI-005 found the English comparison heading pushing
  // `/pricing` sideways at 320px with 200% zoom, where a 30px word is wider
  // than the whole column -- without it the browser has no legal break point
  // and overflows the page instead.
  return lang === "ko" ? "break-keep break-words" : "break-words";
}
