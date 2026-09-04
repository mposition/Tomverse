/**
 * The worked examples `mem-extract-v8` adds, and the contamination they must
 * not cause.
 *
 * An example is text the model reads before it reads the input. That makes it
 * unlike every other line in the prompt: a rule states how to decide, while an
 * example supplies a decided case, and if that case is drawn from a scored
 * dataset the model has been handed the answer. The eval then measures how
 * well the prompt remembers its own examples.
 *
 * The near miss is specific rather than hypothetical. `mem-eval-succ-8` is
 * frozen and contains the exact fact a negated example wants — a hobby the
 * user tried and abandoned — with `낚시` as its gold token. It is the first
 * subject anyone reaches for. These tests are what makes the subject a checked
 * property rather than a lucky choice.
 *
 * The corpus scan below is the general form: it reads every dataset the
 * harness can resolve plus the regression corpus, so a term that becomes
 * contaminated later — because a future dataset adopts a case using it — fails
 * here rather than quietly degrading a score.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
    MEMORY_EXTRACTION_EXAMPLE_TERMS,
    MEMORY_EXTRACTION_NEGATED_EXAMPLES,
    MEMORY_EXTRACTION_POLARITY_RULE,
    MEMORY_EXTRACTION_PROMPT_VERSION,
    buildExtractionPrompt,
} from "../lib/memoryExtractionPrompt.ts";
import { harnessTarget } from "../lib/memoryEvalHarnessTarget.ts";
import { SUCC7_REGRESSION_CORPUS } from "../lib/memoryEvalSucc7Regression.ts";

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
    // added. That is checkable rather than a matter of trust, and it is
    // checked here so the claim survives the next edit to this file.
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
    assert.ok(
        !MEMORY_EXTRACTION_POLARITY_RULE.includes("kitesurfing"),
        "the examples were folded into the rule, so nothing pins the rule any more"
    );
});

/* ------------------------------------------------------- what they say -- */

test("both examples reach the prompt, complete and in their own language", () => {
    const text = `${built().system}\n${built().user}`;

    // English: the span, the statement, the polarity.
    assert.match(text, /I gave kitesurfing a proper go for two summers/);
    assert.match(text, /The user no longer does kitesurfing/);

    // Korean, with the statement in the language of the evidence -- which is
    // the language rule applied to a negated case, and the reason the second
    // example is worth its bytes rather than being the first one translated.
    assert.match(text, /드론은 자격증까지 땄는데 결국 손을 뗐습니다/);
    assert.match(text, /사용자는 더 이상 드론을 하지 않습니다/);

    // Each is stated as negated, so the example cannot be read as showing the
    // affirmed case.
    const negatedMentions = MEMORY_EXTRACTION_NEGATED_EXAMPLES.match(
        /polarity is negated/g
    );
    assert.equal(negatedMentions?.length, 2, MEMORY_EXTRACTION_NEGATED_EXAMPLES);
});

test("the examples restate why polarity is not spelling", () => {
    // The failure the field has: a model reading the evidence for a negation
    // word rather than reading its own statement. The English example carries
    // "never" precisely so it can say that the word is not what decided it.
    assert.match(
        MEMORY_EXTRACTION_NEGATED_EXAMPLES,
        /not because the evidence happens to contain "never"/
    );
});

/* --------------------------------------------------- where they may sit -- */

test("the examples are instructions, not citable content", () => {
    const prompt = built();

    // In the system prompt, which is the half the fence does not enclose.
    assert.ok(prompt.system.includes("kitesurfing"));
    assert.ok(prompt.system.includes("드론"));

    // And outside the fenced region, so nothing in them can be read as
    // imported conversation. A worked example inside the fence would be
    // content the prompt itself told the model to describe.
    const fenced = prompt.user.slice(
        prompt.user.indexOf("<<<IMPORTED_CONVERSATIONS>>>"),
        prompt.user.indexOf("<<<END_IMPORTED_CONVERSATIONS>>>")
    );
    assert.ok(fenced.length > 0, "the fence markers moved");
    for (const term of MEMORY_EXTRACTION_EXAMPLE_TERMS) {
        assert.ok(!fenced.includes(term), `${term} is inside the content fence`);
    }
});

test("nothing in the examples looks like a message label", () => {
    // Labels are what a citation names, and the prompt tells the model to cite
    // only labels that appear in the input. An example carrying a label-shaped
    // token offers one that never will, and an invented label discards the
    // candidate it was meant to support.
    assert.ok(
        !/\[[^\]]+\]/.test(MEMORY_EXTRACTION_NEGATED_EXAMPLES),
        MEMORY_EXTRACTION_NEGATED_EXAMPLES
    );
    // The examples quote the user without ever naming a message, so there is
    // no label in them to copy.
    assert.ok(!MEMORY_EXTRACTION_NEGATED_EXAMPLES.includes("m1"));
});

/* ------------------------------------------------------- contamination -- */

/** Every text a scorer reads, across every dataset that still resolves. */
const corpusText = () => {
    const parts = [];
    for (const version of [
        "mem-eval-succ-4",
        "mem-eval-succ-5",
        "mem-eval-succ-6",
        "mem-eval-succ-7",
        "mem-eval-succ-8",
    ]) {
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
    return parts.join("\n");
};

test("no example term occurs anywhere in a scored corpus", () => {
    const corpus = corpusText();
    // A floor on the scan itself: an empty or tiny haystack would pass every
    // assertion below while checking nothing.
    assert.ok(corpus.length > 100_000, `corpus is ${corpus.length} chars`);
    for (const term of MEMORY_EXTRACTION_EXAMPLE_TERMS) {
        assert.ok(
            !corpus.includes(term),
            `${term} appears in a scored corpus, so the prompt teaches a case it is measured on`
        );
    }
});

test("the scan would catch the term this version avoided", () => {
    // Red-before-green for the assertion above. `낚시` is the gold token of a
    // frozen durable-facts case and the obvious subject for a Korean negated
    // example; if the scan cannot see it, it cannot see anything.
    assert.ok(corpusText().includes("낚시"));
});

test("every registered term is one the prompt actually uses", () => {
    // The other direction: a list that keeps entries the examples dropped
    // reads as coverage while protecting nothing.
    for (const term of MEMORY_EXTRACTION_EXAMPLE_TERMS) {
        assert.ok(
            MEMORY_EXTRACTION_NEGATED_EXAMPLES.includes(term),
            `${term} is registered but appears in no example`
        );
    }
});

test("a Korean content word cannot enter the examples unregistered", () => {
    // The half that generalises. The two tests above check the terms somebody
    // remembered to register; this one checks the examples themselves, so a
    // future Korean example cannot introduce a gold token by simply not being
    // added to the list -- which is exactly how `낚시` would have arrived.
    //
    // The allowlist is grammar and framing, not subjects: particles, the word
    // for "the user", and the vocabulary the sentence needs to say that
    // something stopped. Anything else has to be registered and therefore
    // scanned.
    const ALLOWED = new Set([
        "사용자는",
        "자격증까지",
        "땄는데",
        "결국",
        "손을",
        "뗐습니다",
        "더",
        "이상",
        "하지",
        "않습니다",
    ]);
    const registered = new Set(MEMORY_EXTRACTION_EXAMPLE_TERMS);
    const hangulWords = MEMORY_EXTRACTION_NEGATED_EXAMPLES.match(
        /[가-힣]+/g
    ) ?? [];
    for (const word of hangulWords) {
        if (ALLOWED.has(word)) continue;
        const covered = [...registered].some((term) => word.includes(term));
        assert.ok(
            covered,
            `${word} is a Korean content word in the examples that no registered term covers`
        );
    }
    assert.ok(hangulWords.length > 0, "the Korean example disappeared");
});

/* -------------------------------------------------------------- version -- */

test("the examples ship under a version of their own", () => {
    // Prompt text is identified by `promptVersion`, and a register entry, an
    // approved budget and any archived verdict are keyed to it. Adding
    // examples changes what every chunk is asked, so it is a version bump and
    // not an edit in place.
    assert.equal(MEMORY_EXTRACTION_PROMPT_VERSION, "mem-extract-v8");
});
