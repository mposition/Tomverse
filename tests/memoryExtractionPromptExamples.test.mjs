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
 * Two rounds of that happened while this version was being written, and the
 * second is why the checks below are shaped as they are.
 *
 *   1. **Lexical.** `낚시` is the gold token of a frozen durable-facts case
 *      and the obvious subject for a Korean negated example.
 *   2. **Structural, and invisible to a term scan.** Changing the subjects to
 *      `kitesurfing` and `드론` kept the scenario — an activity tried and
 *      abandoned — which is the core judgement of `succ-durable-en-608` and
 *      `succ-durable-ko-602`. Both are `polarity44` replacements, cases that
 *      exist because their originals were retired to buy an independent
 *      holdout for exactly this rule.
 *
 * So there are two contamination checks and not one: a case-folded term scan
 * over every resolvable corpus, and a structural check that the (language,
 * kind, polarity) cell an example occupies is one the corpus does not score.
 * The second is what would have caught round two.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
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
import { harnessTarget } from "../lib/memoryEvalHarnessTarget.ts";
import { SUCC7_REGRESSION_CORPUS } from "../lib/memoryEvalSucc7Regression.ts";
import { SUCC7_TRANSITION } from "../lib/memoryEvalSucc7Transition.ts";

const CORPORA = [
    "mem-eval-succ-4",
    "mem-eval-succ-5",
    "mem-eval-succ-6",
    "mem-eval-succ-7",
    "mem-eval-succ-8",
];

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
    parts.push(JSON.stringify(SUCC7_REGRESSION_CORPUS));
    return fold(parts.join("\n"));
};

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
    const ALLOWED = new Set([
        // English framing
        "the", "user", "have", "has", "no", "plans", "plan", "to", "open",
        "does", "not", "now", "or", "later",
        // Korean grammar and framing
        "저는", "사용자는", "여는", "계획은", "계획하고", "지금도", "앞으로도",
        "없습니다", "것을", "있지", "않습니다",
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

const cellCounts = (versions) => {
    const scored = new Map();
    for (const version of versions) {
        for (const testCase of harnessTarget(version).cases) {
            for (const gold of testCase.expected ?? []) {
                const cell = `${testCase.language}|${gold.kind}|${gold.polarity}`;
                scored.set(cell, (scored.get(cell) ?? 0) + 1);
            }
        }
    }
    return scored;
};

test("neither example sits in a cell any corpus scores, on either basis", () => {
    // The structural check, and the one that would have caught the second
    // round. `kitesurfing` and `드론` were absent from every corpus as strings
    // while their scenario — an activity tried and abandoned — was the core
    // judgement of two `polarity44` replacements.
    //
    // A (language, kind, polarity) cell is a coarse stand-in for "scenario",
    // but it is a checkable one, and it is the axis the eval actually scores.
    //
    // **Zero, not "at most one".** This read `<= 1` for one revision, and the
    // slack was not harmless: `ko|relationship|negated` is scored exactly once
    // in the live target, so the tolerance would have admitted the one cell
    // that made the pair same-kind. A cell the corpus scores once is a cell
    // the corpus scores.
    //
    // Both bases are checked. The live target is what a run is measured on;
    // the union is what any resolvable artifact was measured on, and an
    // example contaminating a retired case still misleads whoever reads that
    // artifact later.
    for (const [label, versions] of [
        ["every resolvable corpus", CORPORA],
        ["the live target", ["mem-eval-succ-8"]],
    ]) {
        const scored = cellCounts(versions);
        for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
            const cell = `${example.language}|${example.candidate.kind}|${example.candidate.polarity}`;
            assert.equal(
                scored.get(cell) ?? 0,
                0,
                `the ${example.language} example sits in ${cell}, scored ${scored.get(cell)} times in ${label}`
            );
        }
    }

    // And the cell the retired scenario occupies is populated, so the
    // assertion above is not vacuously true of every cell.
    const all = cellCounts(CORPORA);
    assert.ok((all.get("en|decision|negated") ?? 0) > 1);
    assert.ok((all.get("ko|decision|negated") ?? 0) > 1);
    // The cell that the `<= 1` tolerance used to admit, named so the tightening
    // cannot be undone without this line failing.
    assert.equal(all.get("ko|relationship|negated"), 5);
    assert.equal(cellCounts(["mem-eval-succ-8"]).get("ko|relationship|negated"), 1);
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

test("each example's message carries exactly one fact", () => {
    // The completeness half. `KIND_GUIDE` says a sentence carrying two
    // independently useful facts yields two candidates, so an example whose
    // message carries two and shows one teaches the model to drop the second.
    //
    // A draft did that: "코드 예시는 의사코드로 주지 말아 주세요. 바로 돌려볼
    // 수 있어야 합니다." is two claims and it showed one candidate.
    //
    // Enforced as one sentence rather than by counting facts, which is not
    // mechanical: a single sentence with a single candidate cannot be
    // incomplete in that way. An example that needs two facts has to show two
    // candidates, and this assertion is what makes that a deliberate act.
    for (const example of MEMORY_EXTRACTION_NEGATED_EXAMPLE_CASES) {
        const terminators = example.message.match(/[.!?。]/g) ?? [];
        assert.equal(
            terminators.length,
            1,
            `the ${example.language} message has ${terminators.length} sentences: ${example.message}`
        );
        assert.ok(
            example.message.trimEnd().endsWith(terminators[0]),
            `the ${example.language} message continues past its only terminator`
        );
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
