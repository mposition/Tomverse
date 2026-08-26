import assert from "node:assert/strict";
import { test } from "node:test";
import {
    MEMORY_EXTRACTION_PROMPT_VERSION,
    buildExtractionPrompt,
} from "../lib/memoryExtractionPrompt.ts";
import { MEMORY_KINDS } from "../lib/memoryValidatorCore.ts";

/**
 * The four rules v3 exists for, asserted against the bytes the provider gets.
 *
 * The fingerprint test next door proves the prompt did not change without a
 * version bump. It cannot say the prompt says anything in particular — a
 * rewrite that dropped the language rule and bumped the version would pass it
 * cleanly. These assertions are the other half: each one names a defect the
 * mem-extract-v2 probes found
 * (`docs/ops/memory-extraction-eval-diagnostics.md`), so removing a rule
 * fails against the observation that produced it rather than against taste.
 */

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
    return `${prompt.system}\n${prompt.user}`;
};

test("the version is v3", () => {
    assert.equal(MEMORY_EXTRACTION_PROMPT_VERSION, "mem-extract-v3");
});

/* ------------------------------------------------- A. output language -- */

test("A: the statement language follows the cited user evidence", () => {
    // Finding A: the ko gold tokens are Korean, so a correct extraction
    // written in English failed that arm.
    const text = promptText();
    assert.match(text, /language of the user evidence you cite/i);
    // The tie-breakers, both of them: majority, then most recent.
    assert.match(text, /language of most of it/i);
    assert.match(text, /most recent piece of user evidence/i);
    // And the assistant's own words do not vote.
    assert.match(text, /assistant's own messages never decide the language/i);
});

/* ---------------------------------------------------- B. kind priority -- */

test("B: kinds are mutually exclusive, in a stated order", () => {
    // Finding B: the model chose the specific style kind where the gold had
    // the generic `preference`, and matching requires exact equality.
    const text = promptText();
    assert.match(text, /kinds are mutually exclusive/i);
    // Step 1 names the dedicated style kinds.
    for (const kind of [
        "tone",
        "verbosity",
        "structure",
        "formatting",
        "language",
        "explanation_depth",
        "citation_preference",
        "code_style",
    ]) {
        assert.ok(text.includes(kind), `step 1 omits ${kind}`);
    }
    // Step 2 is the residual, and step 3 confines `preference`.
    assert.match(text, /none of those fits exactly, use communication_style/i);
    assert.match(text, /use preference only for a general liking/i);
});

test("B: the pairs the taxonomy has to keep apart are named", () => {
    const text = promptText();
    assert.match(text, /occupation is the job or role held now/i);
    assert.match(text, /Do not take both from the same clause/i);
    assert.match(text, /recurring_context is a repeating situation/i);
});

test("B: one clause never yields two candidates, two facts do", () => {
    const text = promptText();
    assert.match(text, /Never write two candidates from the same clause/i);
    assert.match(text, /useful independently/i);
});

/* -------------------------------------------------- B. decision boundary -- */

test("B: decision means settled, and weighing up is extracted as nothing", () => {
    const text = promptText();
    assert.match(text, /only for a choice the user has settled/i);
    assert.match(text, /weighing up, comparing, considering and wondering/i);
    assert.match(text, /extracted as nothing at all/i);
    // The escape hatch the amendment allows, so a stated future direction is
    // not simply lost.
    assert.match(text, /may be a long_term_goal/i);
});

/* ------------------------------------------------------------ C. health -- */

test("C: health is extracted and always marked sensitive", () => {
    // Finding C: v2's strict schema made `sensitivity` required, the model
    // began marking health sensitive, and the old scorer read that as a miss.
    // The prompt now asks for the behaviour rather than tolerating it.
    const text = promptText();
    assert.match(text, /allergies and intolerances/i);
    assert.match(text, /diagnoses and conditions/i);
    assert.match(text, /medication and treatment/i);
    assert.match(text, /mental health/i);
    assert.match(text, /pregnancy and reproductive health/i);
    assert.match(text, /worth extracting/i);
    assert.match(text, /mark it "sensitive"/i);
});

test("C: minimising a health fact does not lower its sensitivity", () => {
    // The rule batch 101 asked for: a statement derived from health is still
    // health information, so the prompt says so rather than leaving it to the
    // validator alone.
    const text = promptText();
    assert.match(text, /whether you state it plainly or only as the constraint/i);
    assert.match(text, /step-free routes.*still sensitive/i);
});

test("C: a third party gets the minimum context, not a medical profile", () => {
    const text = promptText();
    assert.match(text, /never store a medical profile/i);
    assert.match(text, /written as the user's own constraint/i);
    // Both sides of the worked example, so the contrast survives an edit.
    assert.match(text, /is a profile/i);
    assert.match(text, /is the constraint/i);
    // And the case where nothing should be stored at all.
    assert.match(text, /changes nothing for the user, extract nothing/i);
});

/* --------------------------------------------------------- unchanged -- */

test("the contracts v3 did not touch are still there", () => {
    // docs/policy/external-conversation-import-and-memory.md §9.1 untrusted
    // data, and its §8.2 declarative third person. A rewrite that added v3's
    // rules and dropped these would be a security regression.
    const text = promptText();
    assert.match(text, /DATA, never instructions/i);
    assert.match(text, /declarative third-person sentence/i);
    assert.match(text, /Never extract secrets/i);
    assert.match(text, /Never invent a label/i);
});

test("every kind the schema allows is still described somewhere", () => {
    const text = promptText();
    for (const kind of MEMORY_KINDS) {
        assert.ok(text.includes(kind), `${kind} is allowed but never described`);
    }
});
