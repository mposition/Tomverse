import assert from "node:assert/strict";
import test from "node:test";

import { staticModelRegistrySeedRows } from "../lib/modelRegistryShared.ts";
import {
  assertPromptRefinerVnextOneShotPriceForAdmission,
  PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
} from "../lib/promptRefinerVnextOneShotPriceBinding.ts";

const stage = {
  id: "prompt-refiner-vnext-one-shot-v4",
  status: "run_approved",
  pricePinDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
  perRequestCostMicroUsd: 29_918n,
  slotCount: 80,
  costCeilingMicroUsd: 2_393_440n,
};
const registryRow = () => ({
  ...staticModelRegistrySeedRows().find((row) => row.id === "gpt-5-6-luna"),
});

function transaction(rows = [stage], model = registryRow()) {
  const calls = [];
  return {
    calls,
    tx: {
      $queryRaw: async (sql, id) => {
        assert.match(sql.join("?"), /FOR NO KEY UPDATE NOWAIT/);
        assert.equal(id, stage.id);
        calls.push("stage-lock");
        return rows;
      },
      $executeRaw: async (sql) => {
        assert.deepEqual([...sql], ['LOCK TABLE "ModelRegistryEntry" IN SHARE MODE']);
        calls.push("registry-lock");
        return 0;
      },
      modelRegistryEntry: { findUnique: async ({ where }) => {
        assert.equal(where.id, "gpt-5-6-luna");
        calls.push("registry-read");
        return model;
      } },
    },
  };
}

test("approved price digest and locked current registry rate match in one transaction", async () => {
  const { tx, calls } = transaction();
  assert.match(PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST, /^[0-9a-f]{64}$/);
  assert.equal(await assertPromptRefinerVnextOneShotPriceForAdmission(tx), undefined);
  assert.deepEqual(calls, ["stage-lock", "registry-lock", "registry-read"]);
});

test("missing, closed, or altered approval refuses before registry access", async () => {
  for (const [rows, code] of [
    [[], "vnext_one_shot_approved_stage_unavailable"],
    [[{ ...stage, status: "closed" }], "vnext_one_shot_approved_stage_inactive"],
    [[{ ...stage, pricePinDigest: "f".repeat(64) }], "vnext_one_shot_approved_price_mismatch"],
    [[{ ...stage, perRequestCostMicroUsd: 29_919n }], "vnext_one_shot_approved_price_mismatch"],
    [[{ ...stage, slotCount: 79 }], "vnext_one_shot_approved_price_mismatch"],
  ]) {
    const { tx, calls } = transaction(rows);
    await assert.rejects(() => assertPromptRefinerVnextOneShotPriceForAdmission(tx),
      { message: code });
    assert.deepEqual(calls, ["stage-lock"]);
  }
});

test("changed, missing, or disabled registry rate refuses admission", async () => {
  for (const row of [
    { ...registryRow(), inputUsdPerMillionTokens: 0.01 },
    { ...registryRow(), maxOutputTokens: 1_000 },
    { ...registryRow(), enabled: false },
    null,
  ]) {
    const { tx, calls } = transaction([stage], row);
    await assert.rejects(() => assertPromptRefinerVnextOneShotPriceForAdmission(tx),
      { message: "vnext_one_shot_registry_price_mismatch" });
    assert.deepEqual(calls, ["stage-lock", "registry-lock", "registry-read"]);
  }
});

test("stage or registry lock failure stops without fallback", async () => {
  const { tx, calls } = transaction();
  tx.$queryRaw = async () => { calls.push("stage-lock"); throw Error("lock unavailable"); };
  await assert.rejects(() => assertPromptRefinerVnextOneShotPriceForAdmission(tx),
    /lock unavailable/);
  assert.deepEqual(calls, ["stage-lock"]);

  const unavailable = transaction();
  unavailable.tx.$executeRaw = async () => { unavailable.calls.push("registry-lock");
    throw Error("lock unavailable"); };
  await assert.rejects(() => assertPromptRefinerVnextOneShotPriceForAdmission(unavailable.tx),
    { message: "vnext_one_shot_price_read_failed" });
  assert.deepEqual(unavailable.calls, ["stage-lock", "registry-lock"]);
});
