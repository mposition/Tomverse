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
 * **An equivalence a frozen gold requires**, which is two things and not one.
 * Getting it wrong in each direction produced two of the tables before this.
 *
 *   1. The gold cannot be satisfied by its own evidence without it —
 *      `succ-durable-ko-401` says `9시` and its evidence says `아홉 시`.
 *   2. The gold cannot accept the model's other spelling without it —
 *      `succ-durable-ko-35` says `육 개월` and a model may answer `6개월`.
 *
 * "The gold contains a numeral" was the first test and registered rows nothing
 * needed. "The gold cannot be satisfied without it" was the second and dropped
 * (2), so a model answering `6개월` scored wrong where it had scored right.
 *
 * ## What a row costs, and what pays for it
 *
 * A row rewrites where it matches, so the question a reviewer has to answer is
 * whether that can make two different facts equal, or stop one fact meeting
 * itself. Four shapes were tried and each failed differently:
 *
 *   * `세`+`시` with no boundary turned `세 시간` — three *hours* — into
 *     `3시간`, which a gold asking for three *o'clock* is a substring of.
 *   * Collapsing toward the word form instead put the gold inside 아홉시간;
 *     collapsing to `9시` puts it inside 9시간. The prefix relation is the
 *     problem, not the script.
 *   * Guard rows for the durations fixed that pair and left the open one:
 *     시 begins 시장, 시청, 시절 and 시작 too, so `아홉 시장` still read as
 *     the hour, and no closed list of nouns can be written.
 *   * Registering the whole phrase `아홉 시에` closed that, and was narrower
 *     than the contract it replaced: `아홉 시부터` and `새벽 3시에` — answers
 *     `mem-score-v3.4` accepted — stopped scoring.
 *
 * What pays for it is a boundary on **both** sides, in `koreanAlternatives`
 * below: no Hangul syllable before the numeral, and the counter ends the
 * expression unless a reviewed continuation follows. The continuations are a
 * closed set (particles), where the nouns to exclude are not.
 *
 * The invariant is still stated once and enforced rather than argued —
 * `canonicalFormsAreDisjoint()`, run in CI by `check:memory-eval-succ8` — but
 * it is a floor, not the argument. It reported nothing while 시장 was being
 * read as the hour, because 시장 is not a canonical form. The check that
 * decides is `tests/memoryEvalCanonicalisationScoring.test.mjs`, which runs
 * candidates through `scoreCaseV3()` in both directions and over the whole
 * corpus. Every shape above carried a comment explaining why it was fine; a
 * comment cannot fail a build.
 *
 * ## What the rows do not change
 *
 * A digit spelling can still be matched inside a longer number — `6개월`
 * inside `16개월`, `9시` inside `19시` — so a gold naming the shorter is
 * satisfied by text naming the longer. That is **not** something these rows
 * introduce: substring matching over digits already had it, because `6개월` is
 * literally inside `16개월` with no canonicalisation at all. The rows change
 * the spelling on both sides and leave the relation where they found it. The
 * left boundary excludes the Hangul form of the same shape (`열아홉 시에` is
 * not nine o'clock); the digit form would need a "not preceded by a digit"
 * test, which is recorded in each row's `rejects` instead.
 */
export const KOREAN_NUMERAL_EXPRESSIONS: readonly {
    /** The form both spellings collapse to. */
    canonical: string;
    /** The Korean numeral word. Its digit comes from `NUMERAL_TABLE`. */
    numeral: string;
    /** The counter, drawn from `KOREAN_COUNTERS`. */
    counter: string;
    /**
     * What may follow the counter and still be this expression.
     *
     * The right-hand half of the boundary, and reviewed per row because it has
     * to be. `시` is one syllable and begins 시장, 시청, 시절 and 시간, so a row
     * that stopped at the counter read nine *markets* as nine *o'clock*. The
     * set of nouns starting with 시 is open and cannot be guarded; the set of
     * particles that may follow a time is closed, so the rule is stated that
     * way round.
     *
     * A following character that is not Hangul — a space, punctuation, the end
     * of the string — always continues the expression, so `아홉 시 정각에`
     * needs no entry. Only a Hangul syllable immediately after the counter has
     * to be listed.
     *
     * The lists differ by row on purpose. `간` continues 개월 (개월간, "for six
     * months") and must not continue 시, where 시간 is a different counter.
     */
    followedBy: readonly string[];
    /** The frozen gold that cannot be scored without this row. */
    requiredBy: string;
    /** What else this row rewrites. Reviewed, not accidental. */
    rejects: readonly string[];
}[] = [
    {
        // succ-durable-ko-35 states `육 개월`; a model may answer `6개월`.
        canonical: "6개월",
        numeral: "육",
        counter: "개월",
        followedBy: ["씩", "째", "간", "치"],
        requiredBy: "succ-durable-ko-35",
        // `16개월` still contains `6개월`, as it does with no rule at all.
        rejects: ["16개월"],
    },
    {
        // succ-durable-ko-36 states `새벽 세 시`; a model may answer `새벽 3시`.
        canonical: "3시",
        numeral: "세",
        counter: "시",
        followedBy: ["에", "부터", "까지", "쯤", "경", "께"],
        requiredBy: "succ-durable-ko-36",
        // `13시` contains `3시` before and after this row alike. `전세 시장`
        // and `세 시간` are left alone by the boundary, which is what the row
        // is bounded for.
        rejects: ["13시"],
    },
    {
        // succ-durable-ko-401: factValueAll ["9시"], evidence
        // `가게 문을 아홉 시에 열어서`. The gold is written as a digit and the
        // only statement of the fact is written in words, so without this row
        // the gold is satisfiable by nothing.
        canonical: "9시",
        numeral: "아홉",
        counter: "시",
        followedBy: ["에", "부터", "까지", "쯤", "경", "께"],
        requiredBy: "succ-durable-ko-401",
        // `19시` contains `9시` before and after this row alike.
        rejects: ["19시"],
    },
];

/**
 * No canonical form may be a substring of another.
 *
 * A cheap structural floor, and a narrow one: it compares the registered
 * canonical forms with each other, so it cannot see an unregistered noun that
 * one of them sits inside. That blind spot is real — it reported nothing while
 * `아홉 시` was reading 시장 as the hour — so the check that decides the design
 * is the behavioural one in
 * `tests/memoryEvalCanonicalisationScoring.test.mjs`, which runs candidates
 * through `scoreCaseV3()`. This stays as the floor it is.
 */
export function canonicalFormsAreDisjoint(): readonly string[] {
    const forms = KOREAN_NUMERAL_EXPRESSIONS.map((entry) => entry.canonical);
    const problems: string[] = [];
    for (const a of forms) {
        for (const b of forms) {
            if (a !== b && b.includes(a)) {
                problems.push(
                    `the canonical form ${a} is inside ${b}, so a gold carrying ` +
                        `${a} is satisfied by text carrying ${b}`
                );
            }
        }
    }
    for (const entry of KOREAN_NUMERAL_EXPRESSIONS) {
        if (!KOREAN_COUNTERS.includes(entry.counter)) {
            problems.push(`${entry.counter} is not a registered counter`);
        }
        if (!Object.hasOwn(NUMERAL_TABLE, entry.numeral)) {
            problems.push(`${entry.numeral} is not a registered numeral`);
        }
    }
    return problems;
}

/**
 * The rule, as one ordered alternation applied in a single pass.
 *
 * Both boundaries are here, and each was learned from a defect:
 *
 *   * **Left** — `(?<![가-힣])`. Without it the numeral is read off the end of
 *     the preceding word: `교육 개월` became 교6개월 and scored as six months,
 *     `전세 시장` became 전3시장 and destroyed the gold 전세, and `열아홉 시에`
 *     became 열9시에.
 *   * **Right** — the counter must end the expression, unless what follows is
 *     one of the row's reviewed continuations. Without it `아홉 시장` became
 *     9시장 and nine markets scored as nine o'clock.
 *
 * Longest first and one pass, so `아홉 시간` is not reached by the `아홉 시`
 * alternative after some earlier rewrite has moved the text under it.
 *
 * ## The assumption this rule makes, stated rather than buried
 *
 * The left boundary reads the character before the numeral, so the canonical
 * form depends on **the space between the numeral and the word before it**.
 * That space is assumed present. It is a different space from the one inside
 * the expression: `육 개월` and `육개월` both canonicalise to 6개월, because
 * `\s*` covers that one, and it is the unstable one. The inter-word space is
 * the stable one — a Korean numeral is its own word — but "stable" is a claim
 * about orthography, not a proof, and `저는육 개월씩` does canonicalise
 * differently from `저는 육 개월씩`.
 *
 * That is the whole cost of the rule and it is a policy question, not an
 * implementation detail: `mem-score-v3.5` cannot have both this boundary and
 * total spacing invariance, and without the boundary it scores 교육 개월 as
 * six months.
 */
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ENGLISH_NUMERALS = Object.keys(NUMERAL_TABLE).filter(
    (word) => !/[가-힣]/.test(word)
);

const koreanAlternatives = KOREAN_NUMERAL_EXPRESSIONS.flatMap((entry) => {
    const digit = NUMERAL_TABLE[entry.numeral];
    const right =
        entry.followedBy.length > 0
            ? `(?:(?![가-힣])|(?=${entry.followedBy.map(escape).join("|")}))`
            : "(?![가-힣])";
    return [entry.numeral, digit].map((form) => ({
        source: `(?<![가-힣])${escape(form)}\\s*${escape(entry.counter)}${right}`,
        key: `${form}${entry.counter}`,
        canonical: entry.canonical,
    }));
}).sort((a, b) => b.key.length - a.key.length);

const KOREAN_CANONICAL_BY_FORM = new Map(
    koreanAlternatives.map((entry) => [entry.key, entry.canonical] as const)
);
const KOREAN_NUMERAL_EXPRESSION_RE = new RegExp(
    koreanAlternatives.map((entry) => entry.source).join("|"),
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
    KOREAN_NUMERAL_EXPRESSION_RE.lastIndex = 0;
    out = out.replace(
        KOREAN_NUMERAL_EXPRESSION_RE,
        (match) =>
            KOREAN_CANONICAL_BY_FORM.get(match.replace(/\s+/g, "")) ?? match
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
