import assert from "node:assert/strict";
import test from "node:test";
import { staticModelRegistrySeedRows } from "../lib/modelRegistryShared.ts";
import { readPromptRefinerVnextOneShotPrice } from "../lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback.ts";

const pinnedRow = () => ({
    ...staticModelRegistrySeedRows().find((row) => row.id === "gpt-5-6-luna"),
});

const read = (row) => readPromptRefinerVnextOneShotPrice({
    $executeRaw: async (query) => {
        assert.deepEqual([...query], ['LOCK TABLE "ModelRegistryEntry" IN SHARE MODE']);
        return 0;
    },
    modelRegistryEntry: {
        findUnique: async ({ where }) => {
            assert.equal(where.id, "gpt-5-6-luna");
            return row;
        },
    },
});

test("server reads the exact registry row and current pricing without granting dispatch", async () => {
    assert.deepEqual(await read(pinnedRow()), {
        pricePinMatchesRegistry: true,
        providerPriceObserved: false,
        dispatchAuthorized: false,
        problems: [],
    });
});

test("registry lock is acquired before read and held by the caller transaction", async () => {
    const order = [];
    const result = await readPromptRefinerVnextOneShotPrice({
        $executeRaw: async (query) => {
            assert.deepEqual([...query], ['LOCK TABLE "ModelRegistryEntry" IN SHARE MODE']);
            order.push("lock");
            return 0;
        },
        modelRegistryEntry: { findUnique: async () => {
            order.push("read");
            return pinnedRow();
        } },
    });
    assert.deepEqual(order, ["lock", "read"]);
    assert.equal(result.pricePinMatchesRegistry, true);
    assert.equal(result.dispatchAuthorized, false);
});

test("missing, disabled, remapped and price-overridden rows fail closed", async () => {
    for (const row of [
        null,
        { ...pinnedRow(), enabled: false },
        { ...pinnedRow(), publiclyListed: false, replacementModelId: "gpt-5-6-terra" },
        { ...pinnedRow(), maxOutputTokens: 1_000 },
        { ...pinnedRow(), maxOutputTokens: 0 },
        { ...pinnedRow(), reservationOutputTokens: 1_000 },
        { ...pinnedRow(), apiModel: "other-model" },
        { ...pinnedRow(), inputUsdPerMillionTokens: 0.01 },
        { ...pinnedRow(), cachedInputPriceMultiplier: 0 },
    ]) {
        const result = await read(row);
        assert.equal(result.pricePinMatchesRegistry, false);
        assert.equal(result.dispatchAuthorized, false);
        assert.ok(result.problems.length > 0);
    }
});

test("read-back reports remapping and a lowered output cap accurately", async () => {
    assert.deepEqual(
        (await read({ ...pinnedRow(), replacementModelId: "gpt-5-6-terra" })).problems,
        ["model_remapped"],
    );
    assert.deepEqual(
        (await read({ ...pinnedRow(), maxOutputTokens: 1_000 })).problems,
        ["output_cap_below_contract", "reservation_output_below_contract"],
    );
    assert.deepEqual(
        (await read({ ...pinnedRow(), reservationOutputTokens: 1_000 })).problems,
        ["reservation_output_below_contract"],
    );
});

test("database read failure is not replaced with a static catalogue fallback", async () => {
    await assert.rejects(
        readPromptRefinerVnextOneShotPrice({
            $executeRaw: async () => 0,
            modelRegistryEntry: { findUnique: async () => { throw new Error("db down"); } },
        }),
        /vnext_one_shot_price_read_failed/,
    );
    await assert.rejects(
        readPromptRefinerVnextOneShotPrice({
            $executeRaw: async () => { throw new Error("lock unavailable"); },
            modelRegistryEntry: { findUnique: async () => {
                assert.fail("read must not run after lock failure");
            } },
        }),
        /vnext_one_shot_price_read_failed/,
    );
});
