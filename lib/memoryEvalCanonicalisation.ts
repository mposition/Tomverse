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
    // Renamed in `mem-score-v3.5`, and the name is the change: the step now
    // rewrites the reviewed rows of `KOREAN_NUMERAL_EXPRESSIONS` plus the
    // English numeral words, and nothing else. Until then it rewrote every
    // Korean numeral crossed with every counter, which reached inside words.
    "reviewed_expressions_and_english_numerals",
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
 * Rewriting them wherever a counter followed would corrupt the text being
 * compared, and did — see `KOREAN_NUMERAL_EXPRESSIONS` for what it did to
 * 토요일 and to 이십일.
 *
 * From `mem-score-v3.5` this list no longer generates the rewrite. It is the
 * vocabulary a reviewed expression may draw its counter from, which is what
 * keeps a new row to a shape the contract already describes.
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

/**
 * The Korean numeral equivalences this contract collapses, one row each.
 *
 * ## Why a table and not a rule
 *
 * Because the step has to be **context-free**, and only a table can be.
 *
 * A gold token is matched as a *substring* of the candidate's statement, so
 * the token standing alone and the same token inside a sentence must
 * canonicalise identically. Any rule with a lookaround breaks that by
 * construction, and both attempts at one did:
 *
 *   * `mem-score-v3.4` had no left condition, which is context-free — its bug
 *     was its table, not the missing boundary. Built from every numeral
 *     crossed with every counter, it read the 일 ending 토요일 as the numeral
 *     one and the 일 beginning 일정 as the day counter, so `토요일 일정` became
 *     `토요1일정` and the gold token 격주토요일 existed in no candidate that
 *     phrased it that way (`succ-durable-ko-611`). `이십일` became `이10일`
 *     the same way.
 *   * A `(?<![가-힣])` lookbehind fixed those two and broke something wider.
 *     It consults spacing, and Korean matching drops spacing, so **82 of the
 *     2,250 Korean strings in this corpus** canonicalised differently
 *     depending on how they were typed. Widening it to `(?<![가-힣]\s*)` cured
 *     the spacing half and left the fatal half: `육 개월` alone became 6개월
 *     while `저는 육 개월씩` became …육개월씩, so the gold no longer occurred in
 *     the sentence it was drawn from. That is not a scoring edge case —
 *     `succ-4` stops assembling, because its `gold-evidence-covers-fact`
 *     anchor asks exactly that question.
 *
 * So: no lookaround, and a table narrow enough to be safe without one.
 *
 * ## What earns a row
 *
 * **A frozen gold that cannot be satisfied without it.** Not a gold that
 * happens to contain a numeral — that was the first draft's test, and it
 * registered two rows nothing needed. `succ-durable-ko-35` (`육 개월`) and
 * `succ-durable-ko-36` (`새벽 세 시`) both state their facts in the same words
 * their evidence does, so they match verbatim; a row for them bought nothing
 * and licensed everything below.
 *
 * ## What a row costs, and why this one costs nothing
 *
 * A row rewrites its forms **everywhere**, including inside other words, so
 * the question a reviewer has to answer is whether that can make two different
 * facts equal. For the discarded `세`+`시` row it could, and did: it turned
 * `세 시간` — three *hours* — into `3시간`, and a gold asking for three
 * *o'clock* is a substring of that. Two different facts, one value, which is
 * exactly what this contract's canonicalisation rule forbids.
 *
 * This row avoids it by collapsing toward the **word** form rather than the
 * digit. `아홉 시간` becomes 아홉시간, which is what it becomes with no rule at
 * all, so the row adds no equality that plain Korean matching did not already
 * have. Rewriting to `9시` instead would have made 아홉 시간 into 9시간 and let
 * a `9시` gold reach it — the same defect as `세`+`시`, one numeral over.
 *
 * The direction is per row and reviewed per row. There is no general rule that
 * the word form wins; there is one row, and for it the word form is the one
 * that collides with nothing.
 */
export const KOREAN_NUMERAL_EXPRESSIONS: readonly {
    /** The form every variant collapses to. */
    canonical: string;
    /**
     * The forms rewritten to `canonical`. A space inside a variant matches a
     * run of whitespace or none, so `아홉 시` covers `아홉시` as well.
     */
    variants: readonly string[];
    /** The frozen gold that cannot be satisfied without this row. */
    requiredBy: string;
    /** What else this row rewrites. Reviewed, not accidental. */
    rejects: readonly string[];
}[] = [
    {
        // succ-durable-ko-401: factValueAll ["9시"], evidence
        // `가게 문을 아홉 시에 열어서`. The gold is written as a digit and the
        // only statement of the fact is written in words, so without this row
        // the gold is satisfiable by nothing. It is the only gold in the corpus
        // that answers that description.
        canonical: "아홉시",
        variants: ["아홉 시", "9시"],
        requiredBy: "succ-durable-ko-401",
        // 아홉 시간 (nine hours) becomes 아홉시간 — identical to what it becomes
        // with no rule at all, so an 아홉시 gold reaches it exactly as far as
        // plain Korean substring matching already let it, and no further.
        // Nothing else in the corpus contains either variant.
        rejects: ["아홉 시간"],
    },
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ENGLISH_NUMERALS = Object.keys(NUMERAL_TABLE).filter(
    (word) => !/[가-힣]/.test(word)
);

/**
 * Each variant as a pattern, paired with the canonical form it collapses to.
 *
 * A space in a variant becomes `\s*`, so one written form covers the spaced
 * and unspaced spellings without a second row — Korean spacing is not stable
 * and a reviewer registering `아홉 시` is registering the equivalence, not the
 * typing.
 */
const KOREAN_NUMERAL_EXPRESSION_RE = KOREAN_NUMERAL_EXPRESSIONS.flatMap((entry) =>
    entry.variants.map(
        (variant) =>
            [
                new RegExp(
                    variant.split(/\s+/).map(escape).join("\\s*"),
                    "g"
                ),
                entry.canonical,
            ] as const
    )
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
    for (const [pattern, replacement] of KOREAN_NUMERAL_EXPRESSION_RE) {
        pattern.lastIndex = 0;
        out = out.replace(pattern, replacement);
    }
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
