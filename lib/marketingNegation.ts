/**
 * Whether the clause a match sits in is asserting it or denying it.
 *
 * Contract: docs/policy/marketing-automation.md §7.1, and
 * docs/policy/external-conversation-import-and-memory.md §17, which is the
 * memory policy the first one points at. Two rules need this and both got it wrong on their own,
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

import { MARKETING_CLAUSE_VERBS } from "@/lib/marketingClaimVerbs";

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
  // A spaced ASCII hyphen is a dash somebody typed without reaching for the
  // dash key, and "We do not lose files - we clone your memories." read as one
  // denial until it was here. Unspaced, it is part of a compound word.
  " - ",
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
/**
 * A comma followed by a proper noun that is itself the subject of a verb.
 *
 * "We do not lose files, Tomverse clones your memories." is a comma splice
 * whose second subject is a name, and a list of pronouns could not see it. The
 * verb is what tells it apart from a predicate carrying on: in "not affiliated
 * with, or endorsed by, OpenAI" the name is the object and no lower-case word
 * follows it, so that sentence keeps its one negation.
 */
/**
 * The verbs a new clause can start with.
 *
 * A closed list, because the guess it replaces was wrong in both directions.
 * "any lower-case word ending in s or ed" read "Anthropic services partner" as
 * a subject and a verb and cut a real negation in half, and it would have read
 * any plural noun the same way.
 */
const CLAUSE_VERB =
  "(?:" +
  MARKETING_CLAUSE_VERBS.join("|") +
  ")(?![\\p{L}\\p{N}])";

/**
 * A comma followed by a proper noun that is itself the subject of a verb.
 *
 * "We do not lose files, Tomverse clones your memories." is a comma splice
 * whose second subject is a name, and a list of pronouns could not see it. The
 * verb is what tells it apart from a predicate carrying on: in "not affiliated
 * with, or endorsed by, OpenAI" the name is the object and no verb follows it,
 * so that sentence keeps its one negation.
 */
const NAMED_SUBJECT_SPLICE = new RegExp(
  // The subject may be an acronym (`ACME`), a CamelCase name or an ordinary
  // one. Requiring a lower-case letter after the first capital meant a
  // company written in capitals was not a subject at all.
  "[,\\uff0c]\\s*(?=\\p{Lu}[\\p{L}\\p{N}]*[\\p{L}\\p{N}]\\s+" + CLAUSE_VERB + ")",
  "gu",
);

/**
 * The same, for a subject that is a determiner and a noun.
 *
 * "We do not lose files, the service clones your memories." has no name in it
 * at all, and the rule above wanted one.
 */
const DETERMINER_SPLICE = new RegExp(
  "[,\\uff0c]\\s*(?=(?:the|a|an|our|its|their|this|that|these|those|every|each)" +
    "\\s+[\\p{Ll}\\p{N}-]+\\s+" +
    CLAUSE_VERB +
    ")",
  "giu",
);

const KOREAN_COMMA_SPLICE =
  /[,\uff0c]\s*(?=[\uac00-\ud7a3]{1,10}(?:\ub294|\uc740|\uc774|\uac00|\ub3c4)\s)/g;

/**
 * Openers that make a question a sales line rather than a question.
 *
 * "Is Tomverse affiliated with OpenAI?" is an FAQ entry and asserts nothing;
 * the answer below it is scanned on its own. "Want an AI that clones your
 * memories?" is the claim with a question mark on the end, and treating the
 * two the same let every forbidden claim through by adding one character.
 *
 * Written as the promotional openers rather than as the interrogative ones,
 * which matters for the two languages that do not have interrogative openers:
 * a Korean question marks itself at the end of the sentence, so a list of
 * English auxiliaries read every Korean FAQ entry as an assertion -- including
 * the affiliation disclaimer on the ChatGPT-vs-Claude page, which then failed
 * the repository's own copy check.
 */
const SELLING_OPENER = new RegExp(
  "^\\s*(?:" +
    [
      // A verb of desire, which only a sales line opens with.
      "want|need|needs|looking|ready|tired|imagine|fancy|wish|curious|love",
      // A modal or auxiliary addressed to the reader. This is the shape,
      // rather than the handful of phrases a list could hold: "Would you
      // like", "Wouldn't you like", "Would you love" and "Could you use" are
      // one form, and an FAQ entry is "Is Tomverse …?" or "How do I …?" --
      // a third or first person subject, never a second.
      "(?:would|wouldn't|could|couldn't|can|can't|don't|do|did|didn't|will|won't|" +
        "should|shouldn't|have|haven't|are|aren't|ready)\\s+(?:you|your)\\b",
      "how\\s+about|what\\s+if|who\\s+wants|why\\s+not|ever\\s+wanted|got\\s+a",
    ].join("|") +
    ")\\b",
  "iu",
);

const isAskingRatherThanSelling = (text: string, start: number): boolean =>
  !SELLING_OPENER.test(text.slice(start));

/**
 * Whether the comma at `at` opens an aside rather than a clause.
 *
 * "Tomverse does not, the benchmark runs aside, clone your memories." is one
 * sentence with one negation and something parked in the middle of it. A comma
 * that has a closing comma a few words later, with the sentence carrying on
 * afterwards, is that shape -- and reading it as a clause boundary threw the
 * negation away and reported the denial as the claim.
 */
const isParenthetical = (sentence: string, at: number): boolean => {
  const rest = sentence.slice(at + 1);
  const closing = rest.search(/[,，]/u);
  if (closing === -1) return false;
  const inside = rest.slice(0, closing).trim();
  const after = rest.slice(closing + 1).trim();

  // An aside is short and is not the end of the sentence.
  if (inside.split(/\s+/u).length > 8 || after.length === 0) return false;

  // And what follows it resumes the first clause rather than beginning another
  // one. "…, Tomverse clones your memories, and you stay in control." is two
  // clauses joined by a comma and a conjunction, not one clause with an aside
  // in it, and reading it as an aside threw away a splice already proved.
  return !/^(?:and|but|or|nor|so|yet|then|while)\b/iu.test(after);
};

/**
 * Where the clause holding `offset` begins, as an index into `sentence`.
 *
 * The whole sentence is scanned, not just the part before the match. A comma
 * splice is recognised by what *follows* the comma -- "…, Tomverse clones your
 * memories." needs the verb to tell a new subject from a name in a list -- and
 * a scan that stopped at the match could never see it.
 */
const lastBoundaryIndex = (sentence: string, offset: number): number => {
  let latest = -1;
  const consider = (at: number, length: number) => {
    if (at === -1) return;
    const boundary = at + length;
    if (boundary <= offset) latest = Math.max(latest, boundary);
  };

  for (const token of HARD_BOUNDARIES) {
    consider(sentence.lastIndexOf(token, offset), token.length);
  }

  const lower = sentence.toLowerCase();
  for (const token of CONJUNCTIONS) {
    consider(lower.lastIndexOf(token, offset), token.length);
  }

  for (const expression of [
    COMMA_SPLICE,
    NAMED_SUBJECT_SPLICE,
    DETERMINER_SPLICE,
    KOREAN_COMMA_SPLICE,
  ]) {
    // A fresh matcher each time: a `g` expression carries `lastIndex`, and a
    // shared one would start the next call wherever the previous one stopped.
    const scan = new RegExp(expression.source, expression.flags);
    for (let hit = scan.exec(sentence); hit; hit = scan.exec(sentence)) {
      if (!isParenthetical(sentence, hit.index)) {
        consider(hit.index, hit[0].length);
      }
      if (scan.lastIndex === hit.index) scan.lastIndex += 1;
    }
  }

  return latest;
};

/**
 * Where the clause holding `offset` ends, as an index into `sentence`.
 *
 * The mirror of the function above, and needed for the same reason from the
 * other side: a Korean negator closes the clause it is in, and one in the
 * *next* clause denies that clause rather than this one.
 */
const nextBoundaryIndex = (sentence: string, offset: number): number => {
  let earliest = sentence.length;
  const consider = (at: number) => {
    if (at !== -1 && at >= offset) earliest = Math.min(earliest, at);
  };

  for (const token of HARD_BOUNDARIES) consider(sentence.indexOf(token, offset));

  const lower = sentence.toLowerCase();
  for (const token of CONJUNCTIONS) consider(lower.indexOf(token, offset));

  for (const expression of [
    COMMA_SPLICE,
    NAMED_SUBJECT_SPLICE,
    DETERMINER_SPLICE,
    KOREAN_COMMA_SPLICE,
  ]) {
    const scan = new RegExp(expression.source, expression.flags);
    for (let hit = scan.exec(sentence); hit; hit = scan.exec(sentence)) {
      consider(hit.index);
      if (scan.lastIndex === hit.index) scan.lastIndex += 1;
    }
  }

  return earliest;
};

/**
 * Whether the clause containing `match` at `matchIndex` asserts it.
 *
 * `false` for a question -- "Is Tomverse affiliated with OpenAI?" asserts
 * nothing and the answer below it is scanned on its own -- and `false` when the
 * clause is negated on either side.
 */
export type MarketingClauseOptions = {
  /**
   * Whether a question mark ends the matter.
   *
   * It does for a claim: "Is Tomverse affiliated with OpenAI?" asserts nothing,
   * and the answer below it is scanned on its own. It does not for copy aimed
   * at a child -- "Kids, sign up now?" is the call to action with a question
   * mark on the end, and treating the two the same let it through.
   */
  readonly questionsAssertNothing?: boolean;
};

export function marketingClauseAsserts(
  text: string,
  matchIndex: number,
  match: string,
  options: MarketingClauseOptions = {},
): boolean {
  const questionsAssertNothing = options.questionsAssertNothing !== false;
  let start = matchIndex;
  while (start > 0 && !MARKETING_SENTENCE_BOUNDARY.test(text[start - 1])) {
    start -= 1;
  }
  let end = matchIndex + match.length;
  while (end < text.length && !MARKETING_SENTENCE_BOUNDARY.test(text[end])) {
    end += 1;
  }

  if (questionsAssertNothing && text[end] === "?" && isAskingRatherThanSelling(text, start)) {
    return false;
  }

  const sentence = text.slice(start, end);
  const offset = matchIndex - start;
  const boundary = lastBoundaryIndex(sentence, offset);
  const before = (
    boundary > 0 ? sentence.slice(boundary, offset) : sentence.slice(0, offset)
  )
    // "not only X but also Y" asserts X. Removing the phrase before the
    // negation test is simpler than teaching the negator list about it, and
    // "Tomverse not only clones your memories but also organises them." was
    // reported as nothing at all.
    .replace(/\bnot\s+(?:only|just|merely|simply)\b/giu, " ");

  // The clause after the match ends at the next hard boundary too: a Korean
  // negator closes its own clause, and one in the *next* clause does not deny
  // this one.
  // The clause *after* the match ends at the next boundary, computed the same
  // way the one before it is. Reading to the end of the sentence let the
  // following clause deny this one: "기억을 복제합니다, 파일은 잃지 않습니다."
  // is a forbidden claim followed by an unrelated denial, and the 않 in the
  // second clause was covering the first.
  const afterStart = matchIndex + match.length - start;
  const afterEnd = nextBoundaryIndex(sentence, afterStart);
  const after = sentence.slice(afterStart, afterEnd);

  return !PRECEDING_NEGATION.test(before) && !FOLLOWING_NEGATION.test(after);
}
