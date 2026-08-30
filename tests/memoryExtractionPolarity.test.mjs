/**
 * The production polarity list and the eval contract's are the same two
 * values, and nothing enforces that except this file.
 *
 * `lib/memoryValidatorCore.ts` declares `MEMORY_POLARITIES` rather than
 * importing the eval module's `MEMORY_EVAL_POLARITIES`, because production
 * must not depend on the eval tree — the import boundary is checked
 * elsewhere and is not negotiable. The cost of that boundary is two lists
 * that must agree, and the price of them disagreeing is silent: schema-3
 * scoring compares a candidate's polarity to the gold's field to field, so a
 * value one side accepts and the other does not is not a type error anywhere.
 * It is every candidate carrying it scored as a miss.
 *
 * The eval side's list is frozen inside the `mem-score-v3.3` descriptor
 * digest, so this test is also what keeps a production edit from moving a
 * value the frozen contract already pinned.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    MEMORY_POLARITIES,
    MEMORY_KINDS,
} from "../lib/memoryValidatorCore.ts";
import {
    MEMORY_EVAL_POLARITIES,
    MEMORY_EVAL_POLARITY_MEANINGS,
} from "../lib/memoryEvalDatasetSchemaV3.ts";
import {
    MEMORY_EXTRACTION_OUTPUT_SCHEMA,
    MEMORY_EXTRACTION_POLARITY_RULE,
} from "../lib/memoryExtractionPrompt.ts";

test("the two lists are the same values in the same order", () => {
    // Order as well as membership: both reach a digest as a joined string on
    // the eval side, and a reordering there is a contract change that this
    // side would otherwise not notice.
    assert.deepEqual([...MEMORY_POLARITIES], [...MEMORY_EVAL_POLARITIES]);
    assert.deepEqual([...MEMORY_POLARITIES], ["affirmed", "negated"]);
});

test("the schema offers the model exactly those values", () => {
    // The third copy — the one the provider enforces. A schema that allowed a
    // value the parser rejects would spend a call to produce an answer that
    // could never be stored.
    const polarity =
        MEMORY_EXTRACTION_OUTPUT_SCHEMA.properties.candidates.items.properties
            .polarity;
    assert.deepEqual([...polarity.enum], [...MEMORY_POLARITIES]);
});

test("polarity is not sentiment on either side", () => {
    // The two words the field names were chosen to keep apart: a *negative*
    // fact (the user dislikes something) and a *negated* fact (the fact does
    // not hold of them). The eval contract says so in its meanings; the
    // prompt has to say the same thing to the model, or the two sides will
    // label the same statement differently and the disagreement will read as
    // a model failure.
    for (const meaning of Object.values(MEMORY_EVAL_POLARITY_MEANINGS)) {
        assert.match(meaning, /Not a .*claim about the fact being/i);
    }
    assert.match(MEMORY_EXTRACTION_POLARITY_RULE, /Polarity is not sentiment/i);
    assert.match(
        MEMORY_EXTRACTION_POLARITY_RULE,
        /dislikes open-plan offices" is affirmed/i
    );
});

test("polarity is a field of its own, never a word in the statement", () => {
    // Why v6 exists. If polarity were carried in prose, "the user does not
    // drive" and "the user drives" would differ by a token a substring match
    // does not see -- and both sides would be guessing at the other's reading.
    const items = MEMORY_EXTRACTION_OUTPUT_SCHEMA.properties.candidates.items;
    assert.ok(items.required.includes("polarity"));
    assert.ok(items.required.includes("statement"));
    assert.notEqual(items.properties.polarity, items.properties.statement);
    // And it is not smuggled in as a kind: the kind list has no polarity in
    // it, so a negated fact keeps the kind its affirmed twin would have.
    for (const kind of MEMORY_KINDS) {
        assert.ok(
            !MEMORY_POLARITIES.includes(kind),
            `${kind} is both a kind and a polarity`
        );
    }
});
