import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
    getMemoryExtractionRevokedPairs,
    MemoryRevocationRequestError,
    setMemoryExtractionRevokedPairs,
} from "@/lib/appSettings";
import {
    isPairRevoked,
    MEMORY_EXTRACTION_REVOKED_PAIRS_KEY,
} from "@/lib/memoryAccess";
import { prisma } from "@/lib/prisma";

/**
 * The §12.1 emergency revocation write path, against a real database.
 *
 * The pure half — what a stored string means — is covered in
 * tests/memoryExtractionCore.test.mjs. What only a database can show is that
 * the value the control writes is the value the extraction path later reads:
 * these are two different modules, and every failure this control could have
 * lives in the gap between them.
 *
 * Before this existed the only way to revoke a pair was a hand-typed `UPDATE`
 * on this table, so the round trip below is exactly the thing that had never
 * been exercised.
 */

const PAIR = {
    extractionModelId: "gpt-5-6-luna",
    promptVersion: "mem-extract-v1",
};
const OTHER_PAIR = {
    extractionModelId: "gpt-5-4-mini",
    promptVersion: "mem-extract-v1",
};

const storedValue = async () =>
    (
        await prisma.appSetting.findUnique({
            where: { key: MEMORY_EXTRACTION_REVOKED_PAIRS_KEY },
            select: { value: true },
        })
    )?.value ?? null;

const clearRevocations = () =>
    prisma.appSetting.deleteMany({
        where: { key: MEMORY_EXTRACTION_REVOKED_PAIRS_KEY },
    });

beforeEach(clearRevocations);
// Also *after*, which the before-hook alone does not cover. This row is
// process-wide state that every other suite reads: `run-db-integration-tests`
// runs them all in one process, and the last test here deliberately leaves an
// unreadable value, which fails closed as "every pair revoked". Without this
// the 31 memory-extraction tests that follow could not resolve an approved
// pair, and reported it as their own failure.
afterEach(clearRevocations);

test("with no row at all, nothing is revoked", async () => {
    assert.deepEqual(await getMemoryExtractionRevokedPairs(), { kind: "none" });
});

test("a revoked pair reads back revoked, and its neighbour does not", async () => {
    await setMemoryExtractionRevokedPairs({
        mode: "pairs",
        labels: ["gpt-5-6-luna::mem-extract-v1"],
    });

    const state = await getMemoryExtractionRevokedPairs();
    assert.equal(isPairRevoked(state, PAIR), true);
    assert.equal(
        isPairRevoked(state, OTHER_PAIR),
        false,
        "revoking one pair must not stop the others"
    );
});

test("the stop-everything control revokes a pair it never names", async () => {
    // The operator's emergency action. It has to cover a pair added after the
    // stop, which is why it is a sentinel rather than an expanded list.
    await setMemoryExtractionRevokedPairs({ mode: "all" });

    const state = await getMemoryExtractionRevokedPairs();
    assert.deepEqual(state, { kind: "revoke_all", reason: "operator" });
    assert.equal(isPairRevoked(state, { ...PAIR, extractionModelId: "anything" }), true);
});

test("a deliberate stop is stored as a stop, not as an unreadable row", async () => {
    await setMemoryExtractionRevokedPairs({ mode: "all" });
    const state = await getMemoryExtractionRevokedPairs();
    assert.equal(
        state.kind === "revoke_all" && state.reason,
        "operator",
        "an operator stop and a corrupted setting revoke identically and mean " +
            "opposite things; the screen reading this has to be able to tell them apart"
    );
});

test("clearing revokes nothing, and leaves a readable row behind", async () => {
    await setMemoryExtractionRevokedPairs({ mode: "all" });
    await setMemoryExtractionRevokedPairs({ mode: "none" });

    assert.deepEqual(await getMemoryExtractionRevokedPairs(), { kind: "none" });
    assert.equal(
        await storedValue(),
        "[]",
        "clearing writes an empty list rather than deleting, so the row's " +
            "existence never carries meaning of its own"
    );
});

test("a request that would read back as revoke-everything is refused, and writes nothing", async () => {
    await setMemoryExtractionRevokedPairs({
        mode: "pairs",
        labels: ["gpt-5-6-luna::mem-extract-v1"],
    });
    const before = await storedValue();

    await assert.rejects(
        () =>
            setMemoryExtractionRevokedPairs({
                mode: "pairs",
                labels: ["gpt-5-6-luna::mem-extract-v1", "typo-without-separator"],
            }),
        (error: unknown) => error instanceof MemoryRevocationRequestError
    );

    assert.equal(
        await storedValue(),
        before,
        "a refused request must not have replaced the revocations already in force"
    );
    assert.equal(isPairRevoked(await getMemoryExtractionRevokedPairs(), PAIR), true);
});

test("a hand-written row still fails closed, and is reported as unreadable", async () => {
    // The state this control exists to stop producing. It must keep meaning
    // "everything revoked" -- and it must not be mistaken for an operator stop.
    await prisma.appSetting.create({
        data: {
            key: MEMORY_EXTRACTION_REVOKED_PAIRS_KEY,
            value: "gpt-5-6-luna::mem-extract-v1",
        },
    });

    const state = await getMemoryExtractionRevokedPairs();
    assert.deepEqual(state, { kind: "revoke_all", reason: "malformed" });
    assert.equal(isPairRevoked(state, OTHER_PAIR), true);
});
