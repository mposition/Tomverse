// The statement ceiling (docs/policy/sre-ops.md §6): calls are counted before
// they run, the (A)+1th throws without reaching the client, and a method not
// known to be one statement is refused rather than guessed at.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ONE_STATEMENT_DELEGATE_METHODS,
  StatementCeilingError,
  countingClient,
} from "../scripts/ops-observer/statement-ceiling-core.mjs";

function fakeTx() {
  const sent = [];
  const delegateMethods = Object.fromEntries(
    [...ONE_STATEMENT_DELEGATE_METHODS, "upsert", "createManyAndReturn"].map((m) => [m, (...args) => (sent.push(`model.${m}`), args)]),
  );
  return {
    sent,
    tx: {
      opsObserverState: delegateMethods,
      $queryRaw: (...args) => (sent.push("$queryRaw"), args),
      $executeRaw: (...args) => (sent.push("$executeRaw"), args),
      $transaction: () => sent.push("$transaction"),
    },
  };
}

test("calls up to the allowance pass through and are counted", () => {
  const { tx, sent } = fakeTx();
  const { client, used } = countingClient(tx, 3);
  client.opsObserverState.findUnique({ where: {} });
  void client.$queryRaw("SELECT 1");
  client.opsObserverState.update({});
  assert.equal(used(), 3);
  assert.deepEqual(sent, ["model.findUnique", "$queryRaw", "model.update"]);
});

test("the call past the allowance throws before it reaches the client", () => {
  const { tx, sent } = fakeTx();
  const { client } = countingClient(tx, 1);
  void client.$executeRaw("UPDATE x");
  assert.throws(() => client.opsObserverState.findMany({}), (e) => e instanceof StatementCeilingError && e.code === "statement_ceiling_exceeded");
  assert.deepEqual(sent, ["$executeRaw"]);
});

test("a method not known to be one statement is refused, not counted as one", () => {
  const { tx, sent } = fakeTx();
  const { client, used } = countingClient(tx, 10);
  for (const call of [
    () => client.opsObserverState.upsert({}),
    () => client.opsObserverState.createManyAndReturn({}),
    () => client.$transaction(),
  ]) {
    assert.throws(call, (e) => e instanceof StatementCeilingError && e.code === "statement_ceiling_unknown_method");
  }
  assert.equal(used(), 0);
  assert.deepEqual(sent, []);
});

test("an invalid allowance is a programming error", () => {
  assert.throws(() => countingClient({}, -1), /allowance_invalid/);
  assert.throws(() => countingClient({}, 1.5), /allowance_invalid/);
});
