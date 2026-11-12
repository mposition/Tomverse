import assert from "node:assert/strict";
import test from "node:test";
import {
    decodePassages,
    encodePassages,
    selectPassageText,
} from "../lib/continuationPassages.ts";
import { planContinuationSeed } from "../lib/externalContinuationSeedCore.ts";

test("a bounded Korean tail recovers an exact decision that the automatic window cannot carry", () => {
    const last = "결정: 첫 주에는 좌석을 운영하지 않는다.";
    const content = "가".repeat(5000) + last;
    const rows = [{ role: "user", ordinal: 5, content, truncated: false }];
    assert.equal(planContinuationSeed({ messages: rows }).turns.length, 0);
    const wire = encodePassages([
        { ordinal: 5, start: 5000, end: content.length },
    ]);
    assert.ok(!wire.includes(last));
    const plan = planContinuationSeed({
        messages: selectPassageText(rows, decodePassages(wire)),
    });
    assert.equal(plan.turns[0].text, last);
    assert.equal(plan.truncatedCount, 1);
    assert.deepEqual(selectPassageText([], decodePassages(wire)), []);
});
test("missing header selects automatic context; malformed or oversized coordinates select nothing", () => {
    assert.equal(decodePassages(null), null);
    for (const wire of [
        "",
        "9:2:1",
        "1:0:501",
        "-1:0:4",
        "1:0:1,1:2:3",
        "0:0:1,1:0:1,2:0:1,3:0:1",
        "0:0:1:2",
    ]) {
        assert.deepEqual(decodePassages(wire), []);
    }
    assert.deepEqual(
        selectPassageText(
            [{ ordinal: 0, content: "a", truncated: false }],
            decodePassages("0:0:2"),
        ),
        [],
    );
});

test("partial emoji at passage boundaries never reaches the model", () => {
    const rows = [{ ordinal: 0, content: "😀K😀", truncated: false }];
    const select = (start, end) => selectPassageText(rows, [{ ordinal: 0, start, end }]);
    assert.equal(select(1, 4)[0].content, "K");
    assert.deepEqual(select(0, 1), []);
    assert.equal(select(0, 5)[0].content, rows[0].content);
});
