/**
 * The canonical form gold tokens and candidate statements are compared under,
 * from `mem-score-v3` onwards.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §1③ and §3. It is
 * owned here rather than by the calibration module that first wrote it,
 * because from v3 the table is **part of the scoring contract** and goes into
 * `scoringContractDigest()`. The calibration module is a diagnostic (§9.4) and
 * a diagnostic may not own a contract term; it imports from here.
 *
 * ## What this may and may not do
 *
 * > Normalisation rewrites a token to a canonical form by a fixed table. It
 * > never decides that two different facts are the same.
 *
 * So: NFC, case, contractions, thousands separators, numerals, punctuation,
 * whitespace. Not: edit distance, stemming beyond the reviewed list below,
 * synonyms, embeddings, a model. A matcher that can answer differently on the
 * same artifact attaches the verdict to when it ran rather than to the sample.
 *
 * `mem-score-v2.3` used `normalizeEvalToken()` — NFC, lowercase, whitespace —
 * and that function stays where it is. Schema-2 datasets keep being read the
 * way they were scored; this is the schema-3 replacement, not a migration of
 * the old one.
 */

/**
 * The steps, in the order they run. Part of the contract, and in the digest:
 * `2,000` has to lose its comma before punctuation becomes a space, or step 6
 * leaves `2 000` and nothing matches `2000` again.
 */
export const CANON_STEP_ORDER: readonly string[] = [
    "nfc",
    "lowercase",
    "contraction_nt_to_not",
    "digit_group_separators",
    // Renamed in `mem-score-v3.5`, and the name is the change: the step
    // rewrites numeral *words*, and until then it also rewrote numeral
    // syllables sitting at the end of ordinary ones.
    "numeral_words_at_word_start_to_digits",
    "punctuation_to_space",
    "collapse_whitespace_trim",
];

/**
 * Numeral words to digits.
 *
 * Only the forms the datasets actually use. A general numeral parser would
 * bring in a grammar nobody reviewed, and `succ-3`'s failures were five
 * specific spellings rather than a general problem
 * (`twelve-hour`, `육 개월`, `새벽 세 시`, `여섯`, `2,000`).
 *
 * Korean native and Sino-Korean numerals are both present because the two are
 * used for different things — 세 시 for the hour, 육 개월 for a duration — and
 * a model writes the digit for both.
 */
export const NUMERAL_TABLE: Readonly<Record<string, string>> = {
    // English
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    eleven: "11",
    twelve: "12",
    // Korean, native
    하나: "1",
    한: "1",
    둘: "2",
    두: "2",
    셋: "3",
    세: "3",
    넷: "4",
    네: "4",
    다섯: "5",
    여섯: "6",
    일곱: "7",
    여덟: "8",
    아홉: "9",
    열: "10",
    // Korean, Sino
    일: "1",
    이: "2",
    삼: "3",
    사: "4",
    오: "5",
    육: "6",
    칠: "7",
    팔: "8",
    구: "9",
    십: "10",
};

/**
 * Korean numerals that are also ordinary syllables.
 *
 * `세` is 셋 and also 세상·세계·세금; `이` is 2 and also the subject particle.
 * Rewriting them wherever they appear would corrupt the text being compared,
 * so a Korean numeral is rewritten **only when a counter follows it and no
 * syllable precedes it** — the shape a numeral actually takes in these
 * sentences. The second half was added in `mem-score-v3.5`; see
 * `KOREAN_NUMERAL_RE` for what its absence did to 토요일.
 */
export const KOREAN_COUNTERS: readonly string[] = [
    "시",
    "분",
    "초",
    "개",
    "개월",
    "달",
    "주",
    "년",
    "명",
    "번",
    "마리",
    "권",
    "장",
    "시간",
    "일",
];

/**
 * The reviewed stems a gold may write instead of one inflected form.
 *
 * §2.1. **Narrow on purpose, and empty at freeze.** A stem is registered when
 * `succ-4` actually needs it and a reviewer has signed off its positive and
 * negative examples — what it must catch and what it must not. Nothing has
 * been authored against `mem-score-v3` yet, so nothing is registered, and the
 * empty list is the honest record of that rather than a placeholder.
 *
 * Registering the first stem moves this digest, which under §5 means a new
 * scoring contract version. That is the intended cost: a stem is a matching
 * rule, and a matching rule appearing mid-flight is what §5 closed.
 *
 * Over-matching by a short stem is caught in review, not by a length floor.
 * `없` is the counter-example — a two-character stem the contract wants.
 */
export const APPROVED_STEMS: Readonly<
    Record<"ko" | "en", readonly { stem: string; matches: readonly string[]; rejects: readonly string[] }[]>
> = {
    ko: [],
    en: [],
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const KOREAN_NUMERALS = Object.keys(NUMERAL_TABLE).filter((word) =>
    /[가-힣]/.test(word)
);
const ENGLISH_NUMERALS = Object.keys(NUMERAL_TABLE).filter(
    (word) => !/[가-힣]/.test(word)
);

/**
 * A Korean numeral, when a counter follows it **and a syllable does not
 * precede it**.
 *
 * The counter condition was here from the start; the left-hand one was not,
 * and without it the rule reached inside words. `토요일 일정` — Saturday, a
 * schedule — became `토요1일정`: the 일 ending 토요일 was read as the numeral
 * one and the 일 beginning 일정 as the counter for days. The token 격주토요일
 * then existed in no candidate that phrased it that way, so
 * `succ-durable-ko-611` could only ever score a false negative for three of
 * five plausible phrasings of the fact it tests.
 *
 * `이십일` was the same defect on a number: 십 preceded by 이 matched as ten
 * plus the day counter, and twenty-one canonicalised to `이10일`.
 *
 * The lookbehind says what the rule always meant — a numeral is a word, not a
 * syllable — and it costs nothing the datasets use: every legitimate form is
 * a numeral at a word boundary, whether or not a space follows it
 * (`육 개월`, `육개월`, `새벽 세 시`, `삼 일`, `여섯 개` are all unchanged).
 */
const KOREAN_NUMERAL_RE = new RegExp(
    `(?<![가-힣])(${KOREAN_NUMERALS.map(escape).join("|")})\\s*(${KOREAN_COUNTERS.map(escape).join("|")})`,
    "g"
);
const ENGLISH_NUMERAL_RE = new RegExp(
    `\\b(${ENGLISH_NUMERALS.map(escape).join("|")})\\b`,
    "g"
);

/** The canonical form. `CANON_STEP_ORDER` names the steps and fixes the order. */
export const canon = (value: string): string => {
    let out = value.normalize("NFC").toLowerCase();
    out = out.replace(/n['’]t\b/g, " not");
    out = out.replace(/(\d)[,  ](?=\d{3}\b)/g, "$1");
    out = out.replace(KOREAN_NUMERAL_RE, (_m, numeral: string, counter: string) =>
        `${NUMERAL_TABLE[numeral]}${counter}`
    );
    out = out.replace(ENGLISH_NUMERAL_RE, (word) => NUMERAL_TABLE[word] ?? word);
    out = out.replace(/[^\p{L}\p{N}\s]/gu, " ");
    return out.replace(/\s+/g, " ").trim();
};

/** `canon`, with every space removed. Korean's matching form. */
export const canonNS = (value: string): string => canon(value).replace(/\s+/g, "");

/**
 * The form a match is performed in, per language.
 *
 * Korean spacing is not stable — `6 개월` and `6개월` are the same fact and a
 * reviewer cannot know which the model will write — so Korean drops spaces.
 * English delimits its words with them, and dropping them joins words into
 * strings nobody wrote: `lives in Ottawa` becomes `livesinottawa`, which
 * contains `not`. Both sides of a comparison go through the same call, so
 * substring matching stays sound within a language.
 */
export const canonMatch = (value: string, language: "ko" | "en"): string =>
    language === "ko" ? canonNS(value) : canon(value);
