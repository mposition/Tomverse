/**
 * The Korean uniqueness claim, read by walking the noun phrase.
 *
 * Contract: docs/policy/marketing-automation.md §7.1, third item. 유일한 means
 * "the only", and the policy refuses "the only AI that ...". The word itself is
 * ordinary Korean -- 유일한 식별자 is a unique identifier -- so the rule is
 * about what it qualifies.
 *
 * **Not a regular expression, because every bound on one was wrong.** A regex
 * has to say how many words may sit between 유일한 and the noun, and Korean
 * modifiers stack: "유일한 사용하기 쉽고 안전하며 빠른 AI 비교 도구" has four,
 * and a real claim can have a dozen. Raising the number let "각 요청에는 유일한
 * 식별자가 있으며 이 도구가 이를 표시합니다" back in, where the 도구 is two
 * clauses away and the sentence is about identifiers.
 *
 * The boundary is not a count. A noun phrase in Korean ends when a word takes
 * a case particle -- 이, 가, 은, 는, 을, 를, 로, 으로, 에, 에서, 에게, 와, 과,
 * 도 -- and the walk stops there. So 식별자가 ends the phrase before any target
 * noun is reached, and 빠른 does not.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

/** The nouns a uniqueness claim is refused for qualifying. */
const TARGET_NOUNS: readonly string[] = Object.freeze([
  "AI",
  "ai",
  "도구",
  "서비스",
  "플랫폼",
  "제품",
  "앱",
  "솔루션",
  "비교",
  "교차검토",
  "워크스페이스",
]);

/**
 * The endings that close a noun phrase.
 *
 * Case and topic particles. 의 is deliberately absent: it is possessive and
 * the phrase carries on through it -- "유일한 우리의 도구" is one phrase.
 */
const PHRASE_CLOSING_PARTICLES: readonly string[] = Object.freeze([
  "으로",
  "에서",
  "에게",
  "로",
  "에",
  "와",
  "과",
  "이",
  "가",
  "은",
  "는",
  "을",
  "를",
  "도",
]);

const OPENERS: readonly string[] = Object.freeze(["유일한", "유일하게"]);

/** A token is the target if it is the noun, with or without a particle on it. */
const isTarget = (token: string): boolean =>
  TARGET_NOUNS.some((noun) => token.startsWith(noun));

const closesPhrase = (token: string): boolean =>
  PHRASE_CLOSING_PARTICLES.some((particle) => token.endsWith(particle));

export type MarketingKoreanUniquenessFinding = {
  /** The opener and the noun it was found to qualify. */
  readonly match: string;
};

/**
 * Every 유일한 in `text` that is qualifying a noun the policy refuses.
 *
 * The walk stops at the first of: the target noun (a finding), a word that
 * closes the noun phrase (not a finding), or the end of the clause -- which is
 * any punctuation, because the tokens are split on whitespace and a token
 * carrying a comma or a full stop is not part of the phrase either.
 */
export function findKoreanUniquenessClaims(
  text: string,
): MarketingKoreanUniquenessFinding[] {
  const findings: MarketingKoreanUniquenessFinding[] = [];

  for (const opener of OPENERS) {
    let at = text.indexOf(opener);
    while (at !== -1) {
      const rest = text.slice(at + opener.length);
      // Split on whitespace, and stop at the first token carrying punctuation:
      // a comma or a full stop ends the phrase as surely as a particle does.
      const tokens = rest.split(/\s+/u).filter((token) => token.length > 0);

      for (const token of tokens) {
        if (/[^\p{L}\p{N}]/u.test(token)) {
          const head = token.replace(/[^\p{L}\p{N}][^]*$/u, "");
          if (head.length > 0 && isTarget(head)) {
            findings.push({ match: `${opener} ${head}` });
          }
          break;
        }
        if (isTarget(token)) {
          findings.push({ match: `${opener} ${token}` });
          break;
        }
        if (closesPhrase(token)) break;
      }

      at = text.indexOf(opener, at + opener.length);
    }
  }

  return findings;
}
