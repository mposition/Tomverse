/**
 * Copy that addresses someone under sixteen as the buyer.
 *
 * Contract: docs/policy/marketing-automation.md §7.1, fifth item, second half.
 * Australian Consumer Law and the Privacy Act treat a child as a person who
 * cannot be sold to, so the rule is not about mentioning young people -- a post
 * about a classroom is ordinary -- but about addressing them.
 *
 * **A detector rather than patterns, because the answer needs the clause.** The
 * first version used a fixed-length negative lookbehind, and it was wrong in
 * both directions at once: "Children, sign up and try it." went through because
 * the comma was not in the pattern, while "Tomverse is not intended for
 * children." was refused because the negator sat further from the match than
 * the lookbehind could reach. `lib/marketingNegation.ts` reads the clause
 * instead, which is the same answer the memory rule needs and now the same
 * code.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

import { marketingClauseAsserts } from "@/lib/marketingNegation";

/**
 * The shapes that address a minor, as sources compiled per call.
 *
 * Sources rather than `RegExp` objects for the reason the rules file gives:
 * `RegExp.prototype.compile` replaces a pattern in place and `Object.freeze`
 * does not stop it, so an exported matcher is a decision anything sharing this
 * module could change.
 */
/** Nought to fifteen, in numerals and in words. */
const AGE_UNDER_SIXTEEN =
  "(?:" +
  [
    "[0-9]|1[0-5]",
    "zero|one|two|three|four|five|six|seven|eight|nine",
    "ten|eleven|twelve|thirteen|fourteen|fifteen",
  ].join("|") +
  ")";

/**
 * The bound in "under-N", from one to eighteen.
 *
 * Three values were listed -- 13, 16 and 18 -- so "Under-15s, sign up now."
 * addressed exactly the people the rule is for and matched nothing. Any bound
 * a post writes is a bound somebody chose, and the rule is about the shape.
 */
const UNDER_AGE = "(?:1[0-8]|[1-9])";

/** "-year-old", however it is punctuated. */
const YEAR_OLDS =
  "\\s*[-\\u2010-\\u2015]?\\s*year\\s*[-\\u2010-\\u2015]?\\s*olds?";

/** The call to action that turns an audience into a sales line. */
const CALL_TO_ACTION =
  "[,\\uff0c]?\\s+(?:sign\\s*up|join|try|get\\s+started|download|start\\s+now)\\b";

/**
 * A sentence that opens by naming who it is talking to.
 *
 * "Under-15s, create your account today.", "Under-15s, subscribe today.",
 * "Under-15s, buy now." -- three sales lines and three verbs, and a list of
 * six verbs had none of them. The vocative is the signal: a sentence that
 * begins with an audience and a comma is addressing it, whatever comes next.
 *
 * Only at the start of a sentence, which is where a vocative goes. "For
 * under-16s, parental consent is required." is a notice about them rather than
 * a line aimed at them, and its audience is not in that position.
 */
const SENTENCE_START = "(?:^|[.!?\\n。]\\s*)";
const VOCATIVE = "[,\\uff0c]\\s*[\\p{L}\\p{N}]";

const MINORS_TARGETING_SOURCES: readonly { source: string; flags: string }[] =
  Object.freeze([
    // "for kids", "aimed at teenagers", "designed for children".
    Object.freeze({
      source:
        "\\b(?:for|at|to)\\s+(?:kids|children|child|teens|teenagers|minors|under-?ages?|preteens|tweens|schoolkids|schoolchildren)\\b",
      flags: "iu",
    }),
    // Direct address: "Kids, sign up", "Children — try it", "Teens: get started".
    Object.freeze({
      source:
        "\\b(?:kids|children|teens|teenagers|schoolkids|schoolchildren|preteens|tweens)\\b[^\\p{L}\\p{N}]{0,3}\\s*(?:sign\\s*up|join|try|get\\s+started|download|start\\s+now|come\\s+and)\\b",
      flags: "iu",
    }),
    // An age under sixteen, *and* the phrase that aims copy at it. The age on
    // its own is not targeting: "12-year-olds cannot sign up." is the rule
    // being stated, and a pattern matching the bare noun phrase refused it. So
    // the preposition or the call to action has to be there too.
    //
    // The range starts at zero, not at five -- "4-year-olds, sign up now." was
    // outside it -- and the words are here as well as the numerals, because
    // "Fourteen-year-olds" is the same sentence typed differently.
    Object.freeze({
      source:
        "\\b(?:for|to|at|aimed at|built for|designed for|perfect for|great for|made for|suited to)\\s+" +
        AGE_UNDER_SIXTEEN +
        YEAR_OLDS,
      flags: "iu",
    }),
    Object.freeze({
      source:
        AGE_UNDER_SIXTEEN + YEAR_OLDS + CALL_TO_ACTION,
      flags: "iu",
    }),
    Object.freeze({
      source: "\\b(?:for|to)\\s+ages?\\s+" + AGE_UNDER_SIXTEEN + "(?:\\s*(?:[-\\u2010-\\u2015]|to)\\s*\\d{1,2})?\\b",
      flags: "iu",
    }),
    Object.freeze({
      source: "\\b(?:for|to)\\s+under[-\\u2010-\\u2015\\s]?" + UNDER_AGE + "s?\\b",
      flags: "iu",
    }),
    // "Under-16s, sign up now." addresses them directly rather than naming an
    // audience, and the "for under 16s" shape above could not see it.
    Object.freeze({
      source: "\\bunder[-\\u2010-\\u2015\\s]?" + UNDER_AGE + "s?" + CALL_TO_ACTION,
      flags: "iu",
    }),
    // The same, as a vocative: whatever the sentence goes on to ask for.
    Object.freeze({
      source:
        SENTENCE_START + "under[-\\u2010-\\u2015\\s]?" + UNDER_AGE + "s?" + VOCATIVE,
      flags: "iu",
    }),
    Object.freeze({
      source:
        SENTENCE_START +
        "(?:kids|children|teens|teenagers|schoolkids|schoolchildren|preteens|tweens)" +
        VOCATIVE,
      flags: "iu",
    }),
    Object.freeze({
      source: SENTENCE_START + AGE_UNDER_SIXTEEN + YEAR_OLDS + VOCATIVE,
      flags: "iu",
    }),
    Object.freeze({
      source: "\\bhigh\\s?school(?:ers)?\\s*(?:can|should|get|sign|try|join)\\b",
      flags: "iu",
    }),
    // Korean: the audience named, with or without the particle.
    Object.freeze({
      source:
        "(?:어린이|청소년|중학생|초등학생|미성년자)(?:들)?(?:을|를|도|은|는|이|가)?\\s*(?:위한|위해|대상|전용|맞춤)",
      flags: "u",
    }),
    Object.freeze({
      source: "(?:어린이|청소년|중학생|초등학생)(?:들)?(?:아|야|여러분)?[,\\uff0c]\\s*(?:지금|바로|가입|시작)",
      flags: "u",
    }),
    // Chinese, Simplified and Traditional. 專用 and 专用 are the same word.
    Object.freeze({
      source: "(?:青少年|中[学學]生|小[学學]生|儿童|兒童)\\s*(?:[专專]用|[适適]用|快[来來]|[专專][属屬])",
      flags: "u",
    }),
    Object.freeze({
      source: "(?:面向|[针針][对對])\\s*(?:青少年|中[学學]生|小[学學]生|儿童|兒童)",
      flags: "u",
    }),
  ]);

/**
 * Words that make a sentence about minors a restriction rather than a pitch.
 *
 * "For under-16s, parental consent is required." names the audience in the
 * same shape a sales line does, and it is the notice the policy wants written.
 * A rule that refused it would make the product harder to label honestly --
 * the same reason the negation is read at all.
 *
 * The sentence, not the draft: a notice in one sentence does not license a
 * pitch in the next.
 */
const RESTRICTION = new RegExp(
  "\\b(?:consent|permission|guardian|guardians|parent|parental|prohibited|" +
    "restricted|required|verification|verify|eligible|ineligible|minimum age|" +
    "age limit|not available|cannot|can't|may not|must not)\\b",
  "iu",
);

const SENTENCE_EDGE = /[.!?\n。]/u;

const sentenceAround = (text: string, at: number): string => {
  let start = at;
  while (start > 0 && !SENTENCE_EDGE.test(text[start - 1])) start -= 1;
  let end = at;
  while (end < text.length && !SENTENCE_EDGE.test(text[end])) end += 1;
  return text.slice(start, end);
};

export type MarketingMinorsFinding = {
  /** The matched text, so a failure points at the sentence rather than here. */
  readonly match: string;
};

/**
 * Every clause in `text` that addresses a minor and means it.
 *
 * A clause that denies it -- "Tomverse is not intended for children.",
 * "청소년을 위한 제품이 아닙니다." -- is not a finding. That sentence is the
 * safety notice the policy wants written, and a rule that refused it would be a
 * rule making the product harder to label honestly.
 */
export function findMarketingMinorsTargeting(
  text: string,
): MarketingMinorsFinding[] {
  const findings: MarketingMinorsFinding[] = [];

  for (const entry of MINORS_TARGETING_SOURCES) {
    const flags = entry.flags.includes("g") ? entry.flags : `${entry.flags}g`;
    const scanner = new RegExp(entry.source, flags);
    for (let hit = scanner.exec(text); hit; hit = scanner.exec(text)) {
      const isNotice = RESTRICTION.test(sentenceAround(text, hit.index));
      if (
        !isNotice &&
        marketingClauseAsserts(text, hit.index, hit[0], {
          // "Kids, sign up now?" is the call to action with a question mark on
          // the end. A question asserts nothing about a *claim*; it addresses a
          // child exactly as a statement would.
          questionsAssertNothing: false,
        })
      ) {
        findings.push({ match: hit[0] });
      }
      if (scanner.lastIndex === hit.index) scanner.lastIndex += 1;
    }
  }

  return findings;
}
