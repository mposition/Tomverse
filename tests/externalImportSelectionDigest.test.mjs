import assert from "node:assert/strict";
import { test } from "node:test";
import { externalImportDigest } from "../lib/externalImportDigest.ts";
import { externalImportSelectionDigest } from "../lib/externalImportSelectionDigest.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §4.1.
 *
 * The wizard computes `expectedImportDigest` in the browser (WebCrypto) and
 * the server recomputes it from its own rows (node:crypto). If the two ever
 * disagree, every legitimate subset finalize starts failing with
 * EXTERNAL_IMPORT_SELECTION_CHANGED — a failure that would look like a
 * selection bug rather than a digest bug. So they are checked against each
 * other directly.
 */

const digestOf = (value) =>
    Array.from({ length: 64 }, (_, index) =>
        "0123456789abcdef"[(value * 7 + index * 3) % 16]
    ).join("");

test("the browser helper reproduces the server import digest", async () => {
    const cases = [
        [],
        [digestOf(1)],
        [digestOf(1), digestOf(2), digestOf(3)],
        Array.from({ length: 50 }, (_, index) => digestOf(index)),
    ];
    for (const conversationDigests of cases) {
        assert.equal(
            await externalImportSelectionDigest(conversationDigests),
            externalImportDigest(conversationDigests),
            `parity must hold for ${conversationDigests.length} conversations`
        );
    }
});

test("both implementations are order-independent", async () => {
    const digests = [digestOf(9), digestOf(4), digestOf(7)];
    const reversed = [...digests].reverse();
    assert.equal(
        await externalImportSelectionDigest(digests),
        await externalImportSelectionDigest(reversed)
    );
    assert.equal(
        externalImportDigest(digests),
        externalImportDigest(reversed)
    );
});

test("a narrowed subset produces a different digest than the sealed set", async () => {
    // The reason the sealed digest must never be replayed for a subset
    // finalize: the two values are genuinely different.
    const sealed = [digestOf(1), digestOf(2), digestOf(3)];
    const subset = [digestOf(1), digestOf(3)];
    assert.notEqual(
        await externalImportSelectionDigest(sealed),
        await externalImportSelectionDigest(subset)
    );
    assert.equal(
        await externalImportSelectionDigest(subset),
        externalImportDigest(subset)
    );
});
