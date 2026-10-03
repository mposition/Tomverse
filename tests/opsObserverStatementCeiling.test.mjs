// The statement ceiling (docs/policy/sre-ops.md §6): only tagged single-statement
// raw calls pass and are counted before they run; the (A)+1th throws without
// reaching the client; every model delegate, *Unsafe method, internal entry
// point and nested function is refused; and nothing hands out the real client.

import assert from "node:assert/strict";
import test from "node:test";

import {
  StatementCeilingError,
  countingClient,
  rawCallIsSingleStatement,
} from "../scripts/ops-observer/statement-ceiling-core.mjs";

const tag = (strings, ...values) => [strings, ...values];
const sqlFragment = { strings: ["SELECT 1; DROP TABLE x"], values: [] };

function fakeTx() {
  const sent = [];
  const record = (name) => (...args) => (sent.push(name), args);
  return {
    sent,
    tx: {
      opsObserverState: {
        findUnique: record("model.findUnique"),
        update: record("model.update"),
        nested: { run: record("model.nested.run") },
      },
      $queryRaw: record("$queryRaw"),
      $executeRaw: record("$executeRaw"),
      $executeRawUnsafe: record("$executeRawUnsafe"),
      $queryRawUnsafe: record("$queryRawUnsafe"),
      $transaction: record("$transaction"),
      _request: record("_request"),
      _executeRequest: record("_executeRequest"),
    },
  };
}

const refusedWith = (code) => (e) => e instanceof StatementCeilingError && e.code === code;

test("tagged single-statement raw calls up to the allowance pass and are counted", () => {
  const { tx, sent } = fakeTx();
  const { client, used } = countingClient(tx, 2);
  client.$queryRaw(...tag`SELECT ${1}`);
  client.$executeRaw(...tag`UPDATE x SET y = ${"a;b"}`);
  assert.equal(used(), 2);
  assert.deepEqual(sent, ["$queryRaw", "$executeRaw"]);
});

test("the call past the allowance throws before it reaches the client", () => {
  const { tx, sent } = fakeTx();
  const { client } = countingClient(tx, 1);
  client.$executeRaw(...tag`UPDATE x SET y = ${1}`);
  assert.throws(() => client.$queryRaw(...tag`SELECT 1`), refusedWith("statement_ceiling_exceeded"));
  assert.deepEqual(sent, ["$executeRaw"]);
});

test("a raw call that is not one tagged statement is refused, uncounted", () => {
  const { tx, sent } = fakeTx();
  const { client, used } = countingClient(tx, 10);
  for (const args of [["SELECT 1"], tag`SELECT 1; SELECT 2`, tag`SELECT ${sqlFragment}`]) {
    assert.equal(rawCallIsSingleStatement(args), false);
    assert.throws(() => client.$queryRaw(...args), refusedWith("statement_ceiling_not_single_statement"));
  }
  assert.equal(used(), 0);
  assert.deepEqual(sent, []);
});

test("model delegates, unsafe and internal entry points, and nested functions all refuse", () => {
  const { tx, sent } = fakeTx();
  const { client, used } = countingClient(tx, 10);
  for (const call of [
    () => client.opsObserverState.findUnique({ where: { genesisId: "g" }, select: { genesis: true } }),
    () => client.opsObserverState.update({ where: {}, data: {} }),
    () => client.opsObserverState.nested.run(),
    () => client.$executeRawUnsafe("DELETE FROM x"),
    () => client.$queryRawUnsafe("SELECT 1"),
    () => client.$transaction(),
    () => client._request({}),
    () => client._executeRequest({}),
  ]) {
    assert.throws(call, refusedWith("statement_ceiling_unknown_method"));
  }
  assert.equal(used(), 0);
  assert.deepEqual(sent, []);
});

test("nothing on the result hands out the real client", () => {
  const { tx } = fakeTx();
  const result = countingClient(tx, 5);
  assert.deepEqual(Object.keys(result).sort(), ["client", "used"]);
});

test("an invalid allowance is a programming error", () => {
  assert.throws(() => countingClient({}, -1), /allowance_invalid/);
  assert.throws(() => countingClient({}, 1.5), /allowance_invalid/);
});
