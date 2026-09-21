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

const OPENERS: readonly string[] = Object.freeze(["유일한", "유일하게"]);

/**
 * What may follow a target noun and still be that noun.
 *
 * A particle, a copula, or nothing. `비교적` starts with `비교` and is not the
 * noun -- it is "relatively" -- so a bare `startsWith` read an ordinary
 * sentence about a small difference as a uniqueness claim.
 */
/**
 * The particles and copulas a target noun may carry, as whole tokens.
 *
 * Built from the same list `closesPhrase()` reads, because they are the same
 * grammar: 으로 is a correct particle after a syllable with a final consonant,
 * and a tail list that held only the single-syllable ones did not recognise
 * 플랫폼으로 as the noun 플랫폼 at all.
 */
const NOUN_TAIL_PARTICLES: readonly string[] = Object.freeze([
  "\uc73c\ub85c", "\uc5d0\uc11c", "\uc5d0\uac8c", "\ub85c", "\uc5d0",
  "\uc640", "\uacfc", "\uac00", "\uc774", "\ub294", "\uc740", "\ub97c",
  "\uc744", "\ub3c4", "\uc758", "\uba70", "\uace0", "\ub9cc", "\ubd80\ud130",
]);

const NOUN_TAIL = new RegExp(
  "^(?:" +
    [
      // A copula, with or without the quotative that follows it. "유일한
      // 서비스라는 점" is a uniqueness claim reported as a fact about itself.
      "[\uac00-\ud7a3]{0,2}(?:\uc785\ub2c8\ub2e4|\uc774\ub2e4|\uc784)",
      "(?:\uc774)?(?:\ub77c\ub294|\ub77c\uace0|\ub77c\uba74|\ub77c\uc11c)",
      // The copula joining one clause to the next: 서비스이며, 서비스이고,
      // 서비스이지만. A uniqueness claim that runs straight on into the next
      // clause is the same claim, and a tail list holding only the
      // sentence-final forms did not see it.
      // The copula joining one clause to the next, with and without the
      // 이 that a vowel-final noun drops: 서비스이며 and 서비스며,
      // 서비스이지만 and 서비스지만, 서비스인데. A list of three forms
      // covered three sentences and missed the ones people write.
      "(?:\uc774)?(?:\uba70|\uace0|\uc9c0\ub9cc|\uc778\ub370|\ub370|\uba74\uc11c|\uc790|\ub2c8|\uc5b4\uc11c|\uc5ec\uc11c|\ub77c\uc11c|\uace0\uc694|\uad6c\uc694)",
      // A particle, longest first so 으로 is not read as 로.
      NOUN_TAIL_PARTICLES.join("|"),
    ].join("|") +
    ")?$",
  "u",
);

/** A token is the target if it is the noun, with a particle or a copula on it. */
const isTarget = (token: string): boolean =>
  TARGET_NOUNS.some(
    (noun) => token.startsWith(noun) && NOUN_TAIL.test(token.slice(noun.length)),
  );

/**
 * Whether a token closes the noun phrase.
 *
 * The particle has to be a particle rather than the last syllable of a word.
 * `속도` ends in `도` and is one word -- "speed" -- and reading that `도` as
 * the auxiliary particle stopped the walk in the middle of
 * "유일한 속도 최적화 AI 비교 도구". So the stem left after the particle has
 * to be a word in its own right, which for Korean means at least two
 * syllables.
 */
/**
 * The final consonant of a Hangul syllable, or 0 when it has none.
 *
 * Korean case particles come in pairs that agree with it: 을 after a syllable
 * that has one, 를 after a syllable that does not, and the same for 은/는,
 * 이/가 and 과/와. That agreement is a far better test than counting
 * syllables, and it is what the first version was missing: "길을" has a
 * one-syllable stem, so the count said it was not a particle and the walk ran
 * on to the AI in "유일한 길을 찾는 AI 도구".
 */
const finalConsonant = (syllable: string): number => {
  const code = syllable.codePointAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return -1;
  return (code - 0xac00) % 28;
};

/** The particles that agree, and which side of the pair each one takes. */
const AGREEING_PARTICLES: ReadonlyArray<readonly [string, boolean]> =
  Object.freeze([
    ["\uc744", true], ["\ub97c", false],
    ["\uc740", true], ["\ub294", false],
    ["\uc774", true], ["\uac00", false],
    ["\uacfc", true], ["\uc640", false],
    ["\uc73c\ub85c", true],
  ]);

const closesPhrase = (token: string): boolean => {
  const syllables = Array.from(token);

  for (const [particle, needsFinal] of AGREEING_PARTICLES) {
    if (!token.endsWith(particle)) continue;
    const stem = syllables.slice(0, syllables.length - Array.from(particle).length);
    if (stem.length === 0) continue;
    const final = finalConsonant(stem[stem.length - 1]);
    if (final === -1) continue;
    if ((final !== 0) === needsFinal) return true;
  }

  // 로 takes no final consonant, or ㄹ, which is index 8.
  if (token.endsWith("\ub85c") && !token.endsWith("\uc73c\ub85c")) {
    const stem = syllables.slice(0, -1);
    const final = stem.length > 0 ? finalConsonant(stem[stem.length - 1]) : -1;
    if (final === 0 || final === 8) return true;
  }

  // The particles with no partner to agree with. Here the stem has to be a
  // word in its own right, which for Korean means at least two syllables --
  // 속도 is "speed" and its 도 is the last syllable of it, not the particle.
  for (const particle of ["\uc5d0\uc11c", "\uc5d0\uac8c", "\uc5d0", "\ub3c4", "\uc758"]) {
    if (!token.endsWith(particle)) continue;
    const stem = syllables.slice(0, syllables.length - Array.from(particle).length);
    if (stem.length >= 2) return true;
  }

  return false;
};

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

      for (const raw of tokens) {
        // Brackets are not a boundary: "유일한 (검증된) AI 비교 도구" is one
        // noun phrase with an aside in it, and treating the bracket as the end
        // of the phrase stopped the walk before the noun.
        const token = raw.replace(/[()\[\]{}\u3008-\u3011\uff08\uff09\u300c-\u300f]/gu, "");
        if (token.length === 0) continue;

        // A comma, a full stop or any other punctuation *is* the end. What is
        // in front of it may still be the noun.
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
