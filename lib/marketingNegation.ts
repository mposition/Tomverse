/**
 * Whether the clause a match sits in is asserting it or denying it.
 *
 * Contract: docs/policy/marketing-automation.md §7.1 and §17 of the memory
 * policy it points at. Two rules need this and both got it wrong on their own,
 * so it lives in one place and each of them calls it.
 *
 * The problem is one sentence with two clauses. A marketing page carries the
 * denial of every claim the policy forbids -- "not affiliated with, or endorsed
 * by, OpenAI" is on a public page today, and it is there precisely to avoid
 * making the claim. A guard that reads a disclaimer as the thing it disclaims
 * would force the disclaimers off the page. But a negation that governs the
 * whole sentence is worse: "We do not lose files, we clone your memories."
 * denies one thing and asserts another, and an earlier version read the second
 * clause as covered by the first and reported nothing at all.
 *
 * So the scan is: find the sentence, find the clause inside it, and ask whether
 * *that clause* is negated.
 *
 * **What counts as a clause boundary, and what does not.** The semicolon, the
 * colon and the dashes always do: nothing continues a predicate across them.
 * A coordinating conjunction does. A bare comma does **only** when what follows
 * it starts a new subject -- "…, we clone…" is a comma splice and a new clause,
 * while "…with, or endorsed by, OpenAI" is one predicate with commas in it.
 * Telling those apart by the word after the comma is crude, and crude in the
 * safe direction: an unrecognised continuation leaves the negation in place
 * only for text that reads like one predicate.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

/** Where one sentence ends and the next begins. */
export const MARKETING_SENTENCE_BOUNDARY = /[.!?\n。]/;

/**
 * English negators, which precede what they deny.
 *
 * The apostrophe-less spellings are here because the Guard checks a form with
 * its interior separators removed, where "isn't" reads as "isnt" -- and a
 * safety notice written "Tomverse isn't for under 16s." was refused in that
 * form for saying the thing it denies.
 *
 * `no`, `neither` and `without` are deliberately absent. They negate a noun
 * rather than the predicate, and including them would read "No other tool
 * clones your memories." -- the claim stated at its strongest -- as a denial.
 */
const PRECEDING_NEGATION =
  /\b(?:not|never|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|cannot|can't|won't|isnt|arent|wasnt|werent|doesnt|dont|didnt|cant|wont)\b/i;

/** Korean negators, which close the clause they deny. */
const FOLLOWING_NEGATION =
  /(?:않|아닙니다|아니다|아니라|아니며|아닌|없습니다|없으며|없다|못합니다)/;

/**
 * Clause openers that always end the previous clause.
 *
 * The dashes are here rather than in the sentence boundary because a dash ends
 * a clause without ending the sentence, and the sentence is still the unit the
 * question mark is read from.
 */
const HARD_BOUNDARIES: readonly string[] = Object.freeze([
  ";",
  ":",
  "\u2014", // em dash
  "\u2013", // en dash
  "\uff1b", // full-width semicolon
  "\uff1a", // full-width colon
  "\uff0c", // full-width comma: Chinese and Japanese clause separator
]);

/** A coordinating conjunction, which joins two clauses of equal standing. */
const CONJUNCTIONS: readonly string[] = Object.freeze([
  " and ",
  " but ",
  " while ",
  " yet ",
  " so ",
  " plus ",
  "그리고 ",
  "하지만 ",
  "그러나 ",
  "또한 ",
]);

/**
 * A comma that starts a new subject rather than continuing a predicate.
 *
 * The list is subjects, not brands. "…, or endorsed by, OpenAI" must not break
 * -- so a proper noun after a comma is never a boundary, and only a pronoun or
 * a determiner that can only begin a clause is.
 */
const COMMA_SPLICE =
  /[,\uff0c]\s*(?=(?:we|it|they|you|i|he|she|this|that|these|those|our|its|their|there|here|everything|everyone|nothing)\b)/gi;

/** The same, for Korean: a comma followed by a topic or subject marker. */
const KOREAN_COMMA_SPLICE =
  /[,\uff0c]\s*(?=[\uac00-\ud7a3]{1,10}(?:\ub294|\uc740|\uc774|\uac00|\ub3c4)\s)/g;

const lastBoundaryIndex = (before: string): number => {
  let latest = -1;

  for (const token of HARD_BOUNDARIES) {
    const at = before.lastIndexOf(token);
    if (at !== -1) latest = Math.max(latest, at + token.length);
  }

  for (const token of CONJUNCTIONS) {
    const at = before.toLowerCase().lastIndexOf(token);
    if (at !== -1) latest = Math.max(latest, at + token.length);
  }

  for (const expression of [COMMA_SPLICE, KOREAN_COMMA_SPLICE]) {
    // A fresh matcher each time: a `g` expression carries `lastIndex`, and a
    // shared one would start the next call wherever the previous one stopped.
    const scan = new RegExp(expression.source, expression.flags);
    for (let hit = scan.exec(before); hit; hit = scan.exec(before)) {
      latest = Math.max(latest, hit.index + hit[0].length);
      if (scan.lastIndex === hit.index) scan.lastIndex += 1;
    }
  }

  return latest;
};

/**
 * Whether the clause containing `match` at `matchIndex` asserts it.
 *
 * `false` for a question -- "Is Tomverse affiliated with OpenAI?" asserts
 * nothing and the answer below it is scanned on its own -- and `false` when the
 * clause is negated on either side.
 */
export function marketingClauseAsserts(
  text: string,
  matchIndex: number,
  match: string,
): boolean {
  let start = matchIndex;
  while (start > 0 && !MARKETING_SENTENCE_BOUNDARY.test(text[start - 1])) {
    start -= 1;
  }
  let end = matchIndex + match.length;
  while (end < text.length && !MARKETING_SENTENCE_BOUNDARY.test(text[end])) {
    end += 1;
  }

  if (text[end] === "?") return false;

  const sentenceBefore = text.slice(start, matchIndex);
  const boundary = lastBoundaryIndex(sentenceBefore);
  const before =
    boundary > 0 ? sentenceBefore.slice(boundary) : sentenceBefore;

  // The clause after the match ends at the next hard boundary too: a Korean
  // negator closes its own clause, and one in the *next* clause does not deny
  // this one.
  const sentenceAfter = text.slice(matchIndex + match.length, end);
  const afterBoundary = HARD_BOUNDARIES.map((token) =>
    sentenceAfter.indexOf(token),
  ).filter((at) => at !== -1);
  const after =
    afterBoundary.length > 0
      ? sentenceAfter.slice(0, Math.min(...afterBoundary))
      : sentenceAfter;

  return !PRECEDING_NEGATION.test(before) && !FOLLOWING_NEGATION.test(after);
}
