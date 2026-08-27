/**
 * The one normalisation the polarity distance is measured on.
 *
 * Fixed before the corpus was written, because a distance measured against a
 * moving definition measures nothing
 * (`.github/audits/memory-eval-gold-contract-2026-08-27.md` §②-1).
 *
 * It is the *same* string matching uses. A distance measured on a different
 * string than the match cannot be located back in the match: the fact value's
 * offset in one form says nothing about its offset in the other.
 *
 * ## What this may and may not do
 *
 * > Normalisation rewrites a token to a canonical form by a fixed table. It
 * > never decides that two different facts are the same.
 *
 * So: NFC, case, thousands separators, numerals, punctuation, whitespace. Not:
 * edit distance, stemming, synonyms, embeddings, a model. A matcher that can
 * answer differently on the same artifact attaches the verdict to when it ran
 * rather than to the sample.
 */

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
 * Rewriting them wherever they appear would corrupt the text the distance is
 * measured on, so a Korean numeral is rewritten **only when a counter follows
 * it** — the shape a numeral actually takes in these sentences.
 *
 * English needs no such guard: `two` is not a fragment of ordinary words in a
 * way that survives the word-boundary match below.
 */
const KOREAN_COUNTERS = [
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

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const KOREAN_NUMERALS = Object.keys(NUMERAL_TABLE).filter((word) =>
    /[가-힣]/.test(word)
);
const ENGLISH_NUMERALS = Object.keys(NUMERAL_TABLE).filter(
    (word) => !/[가-힣]/.test(word)
);

const KOREAN_NUMERAL_RE = new RegExp(
    `(${KOREAN_NUMERALS.map(escape).join("|")})\\s*(${KOREAN_COUNTERS.map(escape).join("|")})`,
    "g"
);
const ENGLISH_NUMERAL_RE = new RegExp(
    `\\b(${ENGLISH_NUMERALS.map(escape).join("|")})\\b`,
    "g"
);

/**
 * The canonical form. Order matters and is part of the contract:
 *
 *   1. NFC — one code point per character before anything looks at it.
 *   2. lowercase.
 *   3. `n't` to ` not` — before step 6 turns the apostrophe into a space and
 *      leaves `doesn t`, which no marker and no fact value can be written
 *      against. This is the one contraction English negates with.
 *   4. thousands separators inside digit runs — `2,000` becomes `2000` before
 *      step 6 turns the comma into a space and leaves `2 000`.
 *   5. numerals to digits.
 *   6. punctuation and symbols to a space — this is what makes `twelve-hour`
 *      and `twelve hours` comparable, and `$2,000` and `2000`.
 *   7. collapse whitespace, trim.
 *
 * Amended 2026-08-27, after the first calibration run: step 3 is new. `n't`
 * was in the marker list from the start and could never have matched, because
 * the apostrophe had already become a space by the time anything looked. The
 * amendment is recorded rather than quietly applied —
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §9.1.
 */
export const canon = (value: string): string => {
    let out = value.normalize("NFC").toLowerCase();
    out = out.replace(/n['’]t\b/g, " not");
    out = out.replace(/(\d)[,  ](?=\d{3}\b)/g, "$1");
    out = out.replace(KOREAN_NUMERAL_RE, (_m, numeral: string, counter: string) =>
        `${NUMERAL_TABLE[numeral]}${counter}`
    );
    out = out.replace(ENGLISH_NUMERAL_RE, (word) => NUMERAL_TABLE[word] ?? word);
    out = out.replace(/[^\p{L}\p{N}\s]/gu, " ");
    return out.replace(/\s+/g, " ").trim();
};

/**
 * The space-free form.
 *
 * Spaces are removed because Korean spacing is not stable — `6 개월` and
 * `6개월` are the same fact and a reviewer cannot know which the model will
 * write. Removing them on **both** sides keeps substring matching sound, and
 * keeps one string for offsets to live in.
 *
 * **Korean only.** Amended 2026-08-27, after the first calibration run
 * (`.github/audits/memory-eval-gold-contract-2026-08-27.md` §9.1): removing
 * spaces from English manufactures markers nobody wrote. `The user lives in
 * Ottawa.` becomes `theuserlivesinottawa`, which contains `not` — spanning the
 * boundary between `in` and `Ottawa` — flush against the fact value, so every
 * K read that sentence as a denial. English is measured on `canon`, where its
 * own word boundaries still exist.
 */
export const canonNS = (value: string): string => canon(value).replace(/\s+/g, "");
