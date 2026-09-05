/**
 * The worked examples `mem-extract-v8` adds: that they parse, that their
 * citation cannot be copied into a real one, and that they teach nothing the
 * eval scores.
 *
 * An example is text the model reads before it reads the input. That makes it
 * unlike every other line in the prompt: a rule states how to decide, while an
 * example supplies a decided case, and if that case is drawn from a scored
 * dataset the model has been handed the answer. The eval then measures how
 * well the prompt remembers its own examples.
 *
 * Four rounds of getting these examples wrong are behind the checks below, and
 * each check is shaped by the round it would have caught.
 *
 *   1. **Lexical.** `낚시` is the gold token of a frozen durable-facts case
 *      and the obvious subject for a Korean negated example.
 *   2. **Structural, and invisible to a term scan.** Changing the subjects to
 *      `kitesurfing` and `드론` kept the scenario — an activity tried and
 *      abandoned — which is the core judgement of `succ-durable-en-608` and
 *      `succ-durable-ko-602`, both `polarity44` replacements whose originals
 *      were retired to buy an independent holdout for exactly this rule.
 *   3. **Classification.** A Korean `code_style` candidate was marked negated,
 *      two paragraphs below the rule establishing that a preference against
 *      something is affirmed. Every answer-style kind negates that way, so the
 *      family is refused by name.
 *   4. **Justification.** `long_term_goal` was then chosen because its cell was
 *      unscored — a safety measurement standing in for a taxonomy judgement,
 *      and a mapping the approved prompt makes nowhere.
 *
 * So the kind is checked against the prompt's own sentences, and the cell is
 * checked separately as what it is: a measurement, with every gold in it named
 * rather than tolerated by a count.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
    MEMORY_EXTRACTION_EXAMPLE_SELECTION_GOLDS,
    MEMORY_EXTRACTION_EXAMPLE_LABEL,
    MEMORY_EXTRACTION_EXAMPLE_TERMS,
    MEMORY_EXTRACTION_NEGATED_EXAMPLES,
    MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES,
    MEMORY_EXTRACTION_POLARITY_RULE,
    MEMORY_EXTRACTION_PROMPT_VERSION,
    buildExtractionPrompt,
    toExtractionPromptInput,
} from "../lib/memoryExtractionPrompt.ts";
import { parseExtractionOutput } from "../lib/memoryExtractionOutput.ts";
import {
    harnessTarget,
    harnessTargetBindingFailures,
    harnessTargetVersions,
} from "../lib/memoryEvalHarnessTarget.ts";
import { schema3DatasetVersions } from "../lib/memoryEvalDatasetRegistry.ts";
import { SUCC7_REGRESSION_CORPUS } from "../lib/memoryEvalSucc7Regression.ts";
import { SUCC7_TRANSITION } from "../lib/memoryEvalSucc7Transition.ts";
import { MEMORY_EVAL_SUCC9_CASES } from "../lib/memoryEvalSucc9.ts";
import { SUCC9_REGRESSION_CORPUS } from "../lib/memoryEvalSucc9Regression.ts";

/**
 * The schema-3 datasets, derived rather than listed.
 *
 * This was a hand-written array and it drifted the first time it could: succ-9
 * was assembled, registered and pushed while the scan still stopped at succ-8,
 * so the newest decision set — the one whose replacement cases were written
 * *after* these examples were fixed, which is the direction contamination
 * enters from — was the only corpus nobody checked.
 *
 * ## What this list is and is not
 *
 * It is every schema-3 dataset. It is **not** every dataset that resolves:
 * seed-11, succ-2 and succ-3 still resolve, still hold 1,150 cases each, and
 * are not here. That is a decision rather than an oversight, and `dependants`'
 * Korean counterpart makes it one worth stating — `부양가족` occurs in
 * `succ-assistant-ko-306`, a succ-3 case, which is the ancestor of the very
 * line this version retires (306 → 407 → regression).
 *
 * The reason it is not contamination is that no answer can be scored against
 * those three. succ-3 is in `harnessTargetVersions()` but
 * `harnessTargetBindingFailures()` refuses it — schema 2, bound to
 * `mem-score-v2.3`, contract digest disagreeing with the tree — and seed-11
 * and succ-2 have no target entry at all. That is checked below rather than
 * asserted here, because a contract change has made a refused dataset runnable
 * before: `mem-score-v3.5` is exactly what turned succ-7's sample back into a
 * run target as succ-8.
 */
const CORPORA = schema3DatasetVersions();

const built = () =>
    buildExtractionPrompt({
        conversations: [
            {
                label: "c1",
                title: "t",
                messages: [{ label: "m1", role: "user", content: "hello" }],
            },
        ],
    });

/* ------------------------------------------- the rule this did not touch -- */

test("v8 leaves the polarity rule byte-identical to v7's", () => {
    // The approval for this version was explicit that the polarity rule's
    // sentences and the scorer's criteria do not move; only examples are
    // added. That is checkable rather than a matter of trust.
    //
    // The digest is v7's, computed from the tree at 0209776d. If a future
    // change means to reword the rule, this value moves and the change stops
    // being "examples only" — which is the distinction a reviewer of the next
    // version needs.
    assert.equal(
        createHash("sha256")
            .update(MEMORY_EXTRACTION_POLARITY_RULE, "utf8")
            .digest("hex"),
        "6351bec6f5892552882aaf43dbe8fa0797d47b9b42753b2539d1ed31cf8ed23e"
    );
    // And the examples are a separate constant rather than an edit to the
    // rule, which is what makes the assertion above possible at all.
    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        assert.ok(
            !MEMORY_EXTRACTION_POLARITY_RULE.includes(example.candidate.statement),
            "an example was folded into the rule, so nothing pins the rule any more"
        );
    }
});

/* ----------------------------------------------------- complete, and valid -- */

const REQUIRED_FIELDS = [
    "kind",
    "polarity",
    "statement",
    "confidence",
    "sensitivity",
    "expiresAt",
    "evidence",
];

test("each example is a whole candidate, with every required field", () => {
    // The gap this closes. The first version of these examples was prose that
    // named the statement and the polarity, leaving `kind`, `confidence`,
    // `sensitivity`, `expiresAt` and the evidence shape to be inferred from a
    // schema shown elsewhere — which is the inference an example exists to
    // remove.
    assert.equal(MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES.length, 2);
    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        assert.deepEqual(
            Object.keys(example.candidate).sort(),
            [...REQUIRED_FIELDS].sort(),
            `${example.language} example does not carry exactly the required fields`
        );
        assert.equal(example.candidate.polarity, "negated");
        // The quote is a span of the message, not the whole of it: the prompt
        // asks for a copied span and an example that quoted everything would
        // teach the opposite.
        const quote = example.candidate.evidence[0].quote;
        assert.ok(example.message.includes(quote), quote);
        assert.notEqual(example.message, quote);
    }
});

test("each example parses, against the real parser and a real label map", () => {
    // Not a schema re-implementation: `parseExtractionOutput()` is the
    // function the pipeline calls, and an example the pipeline would reject is
    // an example teaching the model to produce rejected output.
    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        const { labels } = toExtractionPromptInput([
            {
                title: "t",
                messages: [
                    {
                        externalMessageId: "x1",
                        contentDigest: "d1",
                        role: "user",
                        content: example.message,
                    },
                ],
            },
        ]);
        // The example cites `m0`; the real map has `m1`. Rebind the citation
        // to the label this input actually produced, which is the only edit
        // made, so what is under test is the candidate's own shape.
        const asReturned = {
            candidates: [
                {
                    ...example.candidate,
                    evidence: [
                        { ...example.candidate.evidence[0], messageLabel: "m1" },
                    ],
                },
            ],
        };
        const parsed = parseExtractionOutput(asReturned, labels);
        assert.deepEqual(
            [...parsed.problems],
            [],
            `${example.language} example: ${parsed.problems.join(", ")}`
        );
        assert.equal(parsed.candidates.length, 1);
        assert.equal(parsed.candidates[0].polarity, "negated");
        assert.equal(parsed.candidates[0].kind, example.candidate.kind);
    }
});

test("a copied citation resolves to nothing and is discarded", () => {
    // The risk an example carries that a rule does not: the model may copy it.
    // `toExtractionPromptInput()` numbers messages from 1, so `m0` is a label
    // it cannot produce, and a copied citation therefore names no message.
    //
    // Asserted through the parser rather than by reading the label, because
    // what matters is the outcome — the candidate is dropped — and not the
    // numbering convention that produces it.
    const { labels } = toExtractionPromptInput([
        {
            title: "t",
            messages: [
                {
                    externalMessageId: "x1",
                    contentDigest: "d1",
                    role: "user",
                    content: "Something else entirely.",
                },
            ],
        },
    ]);
    assert.ok(!labels.has(MEMORY_EXTRACTION_EXAMPLE_LABEL));
    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        const parsed = parseExtractionOutput(
            { candidates: [example.candidate] },
            labels
        );
        assert.equal(
            parsed.candidates.length,
            0,
            `${example.language} example survived being copied verbatim`
        );
    }
});

test("no real input can produce the example's label", () => {
    // The other half of the same guarantee, over the generator rather than one
    // sample of it: whatever the input, `m0` is never handed out.
    for (const count of [1, 2, 5, 20]) {
        const { labels } = toExtractionPromptInput([
            {
                title: "t",
                messages: Array.from({ length: count }, (_unused, index) => ({
                    externalMessageId: `x${index}`,
                    contentDigest: `d${index}`,
                    role: "user",
                    content: "c",
                })),
            },
        ]);
        assert.ok(
            !labels.has(MEMORY_EXTRACTION_EXAMPLE_LABEL),
            `${count} messages produced ${MEMORY_EXTRACTION_EXAMPLE_LABEL}`
        );
    }
});

/* --------------------------------------------------- where they may sit -- */

test("the examples are instructions, not citable content", () => {
    const prompt = built();
    const text = `${prompt.system}\n${prompt.user}`;

    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        assert.ok(text.includes(example.message), example.message);
        assert.ok(prompt.system.includes(example.candidate.statement));
    }

    // Outside the fenced region, so nothing in them can be read as imported
    // conversation. A worked example inside the fence would be content the
    // prompt itself told the model to describe.
    const fenced = prompt.user.slice(
        prompt.user.indexOf("<<<IMPORTED_CONVERSATIONS>>>"),
        prompt.user.indexOf("<<<END_IMPORTED_CONVERSATIONS>>>")
    );
    assert.ok(fenced.length > 0, "the fence markers moved");
    for (const term of MEMORY_EXTRACTION_EXAMPLE_TERMS) {
        assert.ok(!fenced.includes(term), `${term} is inside the content fence`);
    }

    // And the prompt says in terms that an example's label is not citable, so
    // the guarantee does not rest only on the label being unresolvable.
    assert.match(
        MEMORY_EXTRACTION_NEGATED_EXAMPLES,
        /never a label you saw in an example/
    );
});

/* ------------------------------------------------------- contamination -- */

/** Case-folded, NFC-normalised, as the scorer compares. */
const fold = (value) => value.normalize("NFC").toLowerCase();

/** Every text a scorer reads, across every dataset that still resolves. */
const corpusText = () => {
    const parts = [];
    for (const version of CORPORA) {
        for (const testCase of harnessTarget(version).cases) {
            for (const conversation of testCase.conversations ?? []) {
                parts.push(conversation.title ?? "");
                for (const message of conversation.messages ?? []) {
                    parts.push(message.content);
                }
            }
            for (const gold of testCase.expected ?? []) {
                parts.push(
                    ...(gold.factValueAll ?? []),
                    ...(gold.factValueAny ?? []),
                    gold.evidence?.evidenceQuote ?? ""
                );
            }
        }
    }
    // Both regression corpora too. Retired text is not scored, so this is
    // stricter than the rule needs — and it is the cheap half of the rule,
    // because a retired case can be recalled and an example that collided with
    // one would then be a collision nobody re-checked.
    parts.push(JSON.stringify(SUCC7_REGRESSION_CORPUS));
    parts.push(JSON.stringify(SUCC9_REGRESSION_CORPUS));
    return fold(parts.join("\n"));
};

test("every dataset a run could be scored against is in the scanned set", () => {
    // The guard the scope note above depends on. `CORPORA` covers the
    // schema-3 datasets; the datasets left out are left out because nothing
    // can be run against them, and that is a runtime fact about contract
    // binding rather than a property of the version string.
    //
    // `mem-eval-succ-3` is the one that matters: it is a selectable target and
    // it contains `부양가족`, so if a future contract change ever made it
    // runnable this fails here rather than in a run whose Korean example had
    // been sitting in the corpus all along.
    const scanned = new Set(CORPORA);
    const runnable = harnessTargetVersions().filter(
        (version) => harnessTargetBindingFailures(harnessTarget(version)).length === 0
    );
    // The guard says what it saw, and that is how its one failure was
    // diagnosed. "No dataset is runnable" alone sent a reader looking for a
    // logic error; the refusals it now prints said every schema-3 dataset was
    // computing a dataset digest its manifest never recorded — the same wrong
    // value each time, which is a stale module rather than a race.
    //
    // It is tsx's transpile cache, and it is local: the failure reproduces
    // when the whole suite runs concurrently with a warm cache, disappears
    // when the cache is cleared, and returns once it refills. Standalone runs
    // and CI, which starts from a cold cache, never see it. Nothing here is
    // wrong; the instrument was. Clear it with
    // `rm -rf $LOCALAPPDATA/Temp/tsx-*` before trusting a local sweep.
    assert.ok(
        runnable.length > 0,
        "no dataset is runnable, so this proves nothing: " +
            JSON.stringify(
                harnessTargetVersions().map((version) => [
                    version,
                    [...harnessTargetBindingFailures(harnessTarget(version))],
                ])
            )
    );
    for (const version of runnable) {
        assert.ok(
            scanned.has(version),
            `${version} can be run against and is not scanned for example terms`
        );
    }
    // And the refusal that keeps succ-3 out is real, not assumed.
    assert.ok(
        harnessTargetBindingFailures(harnessTarget("mem-eval-succ-3")).length > 0,
        "mem-eval-succ-3 is runnable now; it holds 부양가족 and must be scanned"
    );
});

test("no example term occurs in a scored corpus, whatever its case", () => {
    const corpus = corpusText();
    // A floor on the scan itself: an empty or tiny haystack would pass every
    // assertion below while checking nothing.
    assert.ok(corpus.length > 100_000, `corpus is ${corpus.length} chars`);
    for (const term of MEMORY_EXTRACTION_EXAMPLE_TERMS) {
        assert.ok(
            !corpus.includes(fold(term)),
            `${term} appears in a scored corpus, so the prompt teaches a case it is measured on`
        );
    }
});

test("the scan is case-folded, and would catch the term this version avoided", () => {
    // Red-before-green, in both directions. `낚시` is the gold token of a
    // frozen durable-facts case; if the scan cannot see it, it sees nothing.
    // And a term differing only in case must not slip past, which a plain
    // `includes` on raw text would have allowed — `Kitesurfing` passed a check
    // written for `kitesurfing`.
    const corpus = corpusText();
    assert.ok(corpus.includes(fold("낚시")));
    assert.ok(corpus.includes(fold("Philately")), "case folding is not applied");
});

test("every registered term is one the prompt actually uses", () => {
    // A list that keeps entries the examples dropped reads as coverage while
    // protecting nothing.
    for (const term of MEMORY_EXTRACTION_EXAMPLE_TERMS) {
        assert.ok(
            MEMORY_EXTRACTION_NEGATED_EXAMPLES.includes(term),
            `${term} is registered but appears in no example`
        );
    }
});

test("no content word in either example escapes registration", () => {
    // The half that generalises, and it covers both languages now. The Korean
    // half existed from the start; the English half did not, so an English
    // example could have introduced a subject with nobody adding it to the
    // list and nothing scanning it.
    //
    // Only the examples' own subject matter is walked — the message, the
    // statement and the quote — not the instructional prose around them, which
    // is where the framing words live and carries no subject.
    //
    // A word passes on one of three grounds, in this order:
    //
    //   1. a registered term covers it, so the scan above checked it;
    //   2. it does not occur in any corpus, so it cannot teach a case;
    //   3. it is in the reviewed allowlist below.
    //
    // Ground 2 is what makes this general rather than a second registry: a new
    // example may introduce whatever vocabulary it needs, and anything that
    // also appears in a scored corpus has to be justified rather than merely
    // absent from a list somebody forgot to update.
    //
    // The allowlist is grammar, framing, and the two domain words any
    // `code_style` example must use. `코드` and `예시` occur throughout the
    // corpus because every code_style case is about code examples; they are
    // the category, not the subject. The subject is `의사코드`, which is
    // registered and scanned.
    // The allowlist is the examples' context clause and their grammar, never
    // their subject. Both messages set the scene with a form that lists a
    // number of dependants and then state the fact; the scene is what these
    // words are, and `dependants` / `부양가족` is the subject, registered above
    // and absent from every corpus.
    //
    // Two entries overlap a gold as substrings and neither is that gold's
    // subject: `form` occurs inside the gold `formal`, and `two` inside the
    // gold `two passports`, which is a different fact about a different thing.
    // Whole-word identity with a gold token would be a different matter and is
    // not what these are.
    const ALLOWED = new Set([
        // English context clause and grammar
        "the", "user", "have", "has", "no", "i", "registration", "form",
        "lists", "two",
        // Korean context clause and grammar
        "가입", "서류에는", "둘로", "적혀", "있는데", "저는", "사용자는",
        "없습니다",
    ]);
    const corpus = corpusText();
    const registered = MEMORY_EXTRACTION_EXAMPLE_TERMS.map(fold);
    let checked = 0;

    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        const subject = [
            example.message,
            example.candidate.statement,
            example.candidate.evidence[0].quote,
        ].join(" ");
        const words =
            example.language === "ko"
                ? (subject.match(/[가-힣]+/g) ?? [])
                : (subject.match(/[A-Za-z]{2,}/g) ?? []);
        for (const word of words) {
            checked += 1;
            const folded = fold(word);
            if (registered.some((term) => folded.includes(term))) continue;
            if (!corpus.includes(folded)) continue;
            assert.ok(
                ALLOWED.has(folded),
                `"${word}" (${example.language}) occurs in a scored corpus and is ` +
                    "neither a registered term nor reviewed as a non-subject"
            );
        }
    }
    assert.ok(checked > 10, `only ${checked} words were walked`);
});


test("the kind each example uses is one the approved prompt licenses", () => {
    // The finding this closes, and it is about what justifies a judgement
    // rather than about safety. "The cell is unscored" and "this is the right
    // kind" are different claims: a draft chose `long_term_goal` on the first
    // and thereby introduced the second as new policy, in a prompt whose whole
    // point is to state policy explicitly.
    //
    // So the kind is checked against the prompt's own sentences. If the
    // boundary rule or the kind guide stops saying these, this fails rather
    // than the examples quietly becoming the only place the mapping lives.
    const text = `${built().system}\n${built().user}`;
    assert.match(
        text,
        /"The registration form lists two dependants; I have no dependants" establishes a negated relationship fact/
    );
    assert.match(
        text,
        /How many siblings a user has, or has none, is a relationship/
    );
    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        assert.equal(
            example.candidate.kind,
            "relationship",
            "the examples use a kind the prompt does not license for a negation"
        );
    }
});

test("the golds that chose this kind have left the decision set", () => {
    // The replacement for the "reviewed exception" this file used to carry.
    // Naming a contaminated case records it; it does not remove it, and the
    // established remedy in this repository is a B+ retirement — which is what
    // succ-7 did for the forty-four cases v8's wording was selected from.
    //
    // All five go, not just the one in the chosen cell. The kind was picked by
    // comparing counts, so the four on the losing side are as much part of the
    // decision as the one that won.
    assert.equal(MEMORY_EXTRACTION_EXAMPLE_SELECTION_GOLDS.length, 5);

    const succ9 = new Set(
        MEMORY_EVAL_SUCC9_CASES.flatMap((testCase) =>
            (testCase.expected ?? []).map((gold) => `${testCase.id}#${gold.id}`)
        )
    );
    const preserved = new Set(
        SUCC9_REGRESSION_CORPUS.flatMap((entry) =>
            (entry.originalCase.expected ?? []).map(
                (gold) => `${entry.originalCase.id}#${gold.id}`
            )
        )
    );

    for (const gold of MEMORY_EXTRACTION_EXAMPLE_SELECTION_GOLDS) {
        assert.ok(
            !succ9.has(gold),
            `${gold} still scores in mem-eval-succ-9, so it both chose the prompt and measures it`
        );
        assert.ok(
            preserved.has(gold),
            `${gold} left the decision set without being preserved, which is a deletion rather than a retirement`
        );
    }

    // Red-before-green: the scan can see golds that are still scored, so the
    // absence above is a fact about these five and not about the lookup. The
    // floor is on golds, not cases: most cases are "extract nothing" and
    // carry none, so 1,150 cases expose 485 golds.
    assert.ok(succ9.size > 400, `succ-9 exposed only ${succ9.size} golds`);
});

test("succ-8 is left exactly as it was signed", () => {
    // The retirement is a new dataset, never an edit to the frozen one. succ-8
    // was signed on 2026-09-04 against two digests, and a case removed from it
    // would move both and quietly void that signature.
    const stillThere = MEMORY_EXTRACTION_EXAMPLE_SELECTION_GOLDS.filter((gold) => {
        const [caseId, goldId] = gold.split("#");
        const testCase = harnessTarget("mem-eval-succ-8").cases.find(
            (entry) => entry.id === caseId
        );
        return (testCase?.expected ?? []).some((entry) => entry.id === goldId);
    });
    assert.deepEqual(
        stillThere,
        [...MEMORY_EXTRACTION_EXAMPLE_SELECTION_GOLDS],
        "succ-8 was edited; it is a signed historical dataset and must not be"
    );
});

test("both examples are the same kind, differing only in language", () => {
    // The pair teaches one mapping twice rather than two mappings once, and
    // what it isolates is that a statement is written in the language of the
    // evidence it cites. A draft had `relationship` in English and
    // `code_style` in Korean, which taught two mappings and isolated nothing.
    const kinds = new Set(
        MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES.map((example) => example.candidate.kind)
    );
    assert.equal(kinds.size, 1, `the examples span kinds: ${[...kinds].join(", ")}`);
    const languages = MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES.map(
        (example) => example.language
    ).sort();
    assert.deepEqual(languages, ["en", "ko"]);
});

test("a negated example is a fact that is not so, never a preference against", () => {
    // `MEMORY_EXTRACTION_POLARITY_RULE` settles that "The user dislikes
    // open-plan offices" is *affirmed*, because the dislike holds of them. So
    // the natural negation of any answer-style kind — "does not want
    // citations", "does not want pseudocode" — is a preference against
    // something, which is affirmed, not negated.
    //
    // A draft shipped exactly that: a `code_style` candidate marked negated,
    // two paragraphs below the rule saying it is not. The kinds are enumerated
    // rather than the wording inspected, because the wording is what fooled
    // the draft.
    const ANSWER_STYLE = new Set([
        "communication_style",
        "tone",
        "verbosity",
        "structure",
        "formatting",
        "language",
        "explanation_depth",
        "citation_preference",
        "code_style",
    ]);
    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        assert.equal(example.candidate.polarity, "negated");
        assert.ok(
            !ANSWER_STYLE.has(example.candidate.kind),
            `${example.candidate.kind} is an answer-style kind, whose negation is a ` +
                "preference against something and therefore affirmed"
        );
    }
    // And the rule really does say so, so this test fails if that precedent is
    // ever reworded rather than silently disagreeing with it.
    assert.match(MEMORY_EXTRACTION_POLARITY_RULE, /Polarity is not sentiment/);
    assert.match(
        MEMORY_EXTRACTION_POLARITY_RULE,
        /"The user dislikes open-plan offices" is affirmed/
    );
});

test("each example's message is a single sentence", () => {
    // A **necessary** condition for the completeness the examples claim, and
    // not a sufficient one. It is worth being exact about which, because the
    // earlier name for this test ("carries exactly one fact") asserted
    // something it does not check: a single sentence can carry two
    // independently useful facts, and `KIND_GUIDE` says such a sentence yields
    // two candidates.
    //
    // What it does close is the way the defect actually arrived. The draft
    // message was "코드 예시는 의사코드로 주지 말아 주세요. 바로 돌려볼 수
    // 있어야 합니다." — two sentences, two claims, one candidate shown. One
    // sentence per example makes a second claim visible in review instead of
    // hiding behind a full stop.
    //
    // That the sentence carries one fact is a reviewed judgement, recorded in
    // section 1 of the implementation record: the clause before the semicolon
    // describes the form rather than the user, so the only durable fact is the
    // one the candidate states. No test here proves that, and this comment is
    // the honest version of what the assertion below is worth.
    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        const terminators = example.message.match(/[.!?。]/g) ?? [];
        assert.equal(
            terminators.length,
            1,
            `the ${example.language} message has ${terminators.length} sentence terminators: ${example.message}`
        );
        assert.ok(
            example.message.trimEnd().endsWith(terminators[0]),
            `the ${example.language} message continues past its only terminator`
        );
        // And exactly one candidate is shown for it, so a message that grows a
        // second fact has to grow a second candidate deliberately.
        assert.equal(typeof example.candidate.statement, "string");
    }
});

test("no example reproduces a polarity44 replacement's verdict shape", () => {
    // Named directly, because the holdout is the thing the examples must not
    // erode: those 44 cases exist because their originals were retired to
    // measure this rule independently. An example matching one of their
    // (language, kind, polarity) shapes hands back what retiring them bought.
    const holdout = new Set();
    const byId = new Map();
    for (const version of CORPORA) {
        for (const testCase of harnessTarget(version).cases) {
            byId.set(testCase.id, testCase);
        }
    }
    for (const move of SUCC7_TRANSITION) {
        if (move.basis !== "polarity44") continue;
        const testCase = byId.get(move.replacement);
        if (!testCase) continue;
        for (const gold of testCase.expected ?? []) {
            holdout.add(`${testCase.language}|${gold.kind}|${gold.polarity}`);
        }
    }
    assert.ok(holdout.size > 5, `only ${holdout.size} holdout shapes found`);
    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        const cell = `${example.language}|${example.candidate.kind}|${example.candidate.polarity}`;
        assert.ok(
            !holdout.has(cell),
            `the ${example.language} example reproduces polarity44 shape ${cell}`
        );
    }
    // Red-before-green: the shape the withdrawn examples used is in the set.
    assert.ok(holdout.has("en|decision|negated"));
    assert.ok(holdout.has("ko|decision|negated"));
});

/* -------------------------------------------------------------- version -- */

test("the examples ship under a version of their own", () => {
    // Prompt text is identified by `promptVersion`, and a register entry, an
    // approved budget and any archived verdict are keyed to it. Adding
    // examples changes what every chunk is asked, so it is a version bump and
    // not an edit in place.
    assert.equal(MEMORY_EXTRACTION_PROMPT_VERSION, "mem-extract-v8");
});
