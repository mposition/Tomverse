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
        "\\b(?:kids|children|teens|teenagers|students|schoolkids)\\b[^\\p{L}\\p{N}]{0,3}\\s*(?:sign\\s*up|join|try|get\\s+started|download|start\\s+now|come\\s+and)\\b",
      flags: "iu",
    }),
    // An age that is under sixteen, however it is written.
    Object.freeze({
      source:
        "\\b(?:[5-9]|1[0-5])\\s*[-\\u2010-\\u2015]?\\s*year\\s*[-\\u2010-\\u2015]?\\s*olds?\\b",
      flags: "iu",
    }),
    Object.freeze({
      source: "\\bages?\\s+(?:[5-9]|1[0-5])(?:\\s*(?:[-\\u2010-\\u2015]|to|\\u2013)\\s*\\d{1,2})?\\b",
      flags: "iu",
    }),
    Object.freeze({
      source: "\\bunder\\s*(?:13|16|18)s?\\b",
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
      if (marketingClauseAsserts(text, hit.index, hit[0])) {
        findings.push({ match: hit[0] });
      }
      if (scanner.lastIndex === hit.index) scanner.lastIndex += 1;
    }
  }

  return findings;
}
