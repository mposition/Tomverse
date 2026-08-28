/**
 * The prompt must not contain the eval's own inputs.
 *
 * A prompt that quotes a case's utterance shows the model the answer to that
 * case, and the case stops measuring anything. The dataset freeze and the
 * test-set separation contract exist for exactly this, and neither catches it:
 * the digest covers the dataset and the fingerprint covers the prompt, so a
 * sentence copied from one into the other moves both legitimately.
 *
 * This has already happened once. Rendering rule 3 of
 * `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md` into
 * `mem-extract-v5`, two examples were written from cases sitting in the
 * frozen set — a twelve-word run of `succ-durable-en-29` and the whole of
 * `succ-durable-en-79`'s opening clause. Both were caught before the pair was
 * ever run, and this is the check that caught them, kept.
 *
 * Five words, because that is short enough to catch a lifted example and long
 * enough that ordinary English and Korean phrasing does not collide with it.
 * A failure here is not a style note: fix the prompt, never the dataset.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";
import { buildExtractionPrompt } from "../lib/memoryExtractionPrompt.ts";

/** Punctuation and case carry no meaning for a lifted phrase. */
const normalise = (value) =>
    value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

const RUN_LENGTH = 5;

const promptText = () => {
    const prompt = buildExtractionPrompt({
        conversations: [
            {
                label: "c1",
                title: "t",
                messages: [{ label: "m1", role: "user", content: "hello" }],
            },
        ],
    });
    return normalise(`${prompt.system}\n${prompt.user}`);
};

test("no case utterance appears in the prompt", () => {
    const prompt = promptText();
    const leaks = [];
    for (const testCase of MEMORY_EVAL_SUCC3_CASES) {
        for (const conversation of testCase.conversations) {
            for (const message of conversation.messages) {
                // Assistant turns are this repository's own writing and are
                // not what the model is asked to reason about.
                if (message.role !== "user") continue;
                const words = normalise(message.content).split(" ");
                for (let at = 0; at + RUN_LENGTH <= words.length; at += 1) {
                    const run = words.slice(at, at + RUN_LENGTH).join(" ");
                    if (!prompt.includes(run)) continue;
                    leaks.push(`${testCase.id}: "${run}"`);
                    at = words.length;
                }
            }
        }
    }
    assert.deepEqual(
        leaks,
        [],
        `the prompt quotes ${leaks.length} case utterance(s), so those cases no longer measure anything:\n  ${leaks.join("\n  ")}\n` +
            "Rewrite the prompt's example. Never edit the frozen case to make this pass."
    );
});

test("the check would catch a lifted example", () => {
    // A guard that cannot fail is not a guard. This asserts the mechanism on
    // a real utterance rather than trusting that the empty result above means
    // the comparison ran.
    const [sample] = MEMORY_EVAL_SUCC3_CASES.flatMap((testCase) =>
        testCase.conversations
            .flatMap((conversation) => conversation.messages)
            .filter((message) => message.role === "user")
            .map((message) => normalise(message.content))
            .filter((text) => text.split(" ").length >= RUN_LENGTH)
    );
    assert.ok(sample, "the dataset has no utterance long enough to test with");
    const lifted = `a prompt that said ${sample} would be quoting the set`;
    const words = sample.split(" ");
    const run = words.slice(0, RUN_LENGTH).join(" ");
    assert.ok(lifted.includes(run));
});
