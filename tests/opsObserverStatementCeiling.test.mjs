// The statement ceiling (docs/policy/sre-ops.md §6): calls are counted before
// they run, the (A)+1th throws without reaching the client, a call that could
// send more than one statement is refused, and a method not known to be one
// statement -- directly or through a nested object -- is refused rather than
// guessed at.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ONE_STATEMENT_DELEGATE_METHODS,
  StatementCeilingError,
  countingClient,
  delegateArgsFanOut,
  rawCallIsSingleStatement,
} from "../scripts/ops-observer/statement-ceiling-core.mjs";

const tag = (strings, ...values) => [strings, ...values];
const sqlFragment = { strings: ["SELECT 1; DROP TABLE x"], values: [] };

function fakeTx() {
  const sent = [];
  const delegateMethods = Object.fromEntries(
    [...ONE_STATEMENT_DELEGATE_METHODS, "upsert", "createManyAndReturn"].map((m) => [m, (...args) => (sent.push(`model.${m}`), args)]),
  );
  delegateMethods.nested = { run: () => sent.push("model.nested.run") };
  return {
    sent,
    tx: {
      opsObserverState: delegateMethods,
      $queryRaw: (...args) => (sent.push("$queryRaw"), args),
      $executeRaw: (...args) => (sent.push("$executeRaw"), args),
      $executeRawUnsafe: (...args) => (sent.push("$executeRawUnsafe"), args),
      $transaction: () => sent.push("$transaction"),
    },
  };
}

const refusedWith = (code) => (e) => e instanceof StatementCeilingError && e.code === code;

test("calls up to the allowance pass through and are counted", () => {
  const { tx, sent } = fakeTx();
  const { client, used } = countingClient(tx, 3);
  client.opsObserverState.findUnique({ where: { genesisId: "g" } });
  client.$queryRaw(...tag`SELECT ${1}`);
  client.opsObserverState.update({ where: { genesisId: "g" }, data: { generation: 2, keys: { "P3#x": { status: "open" } } } });
  assert.equal(used(), 3);
  assert.deepEqual(sent, ["model.findUnique", "$queryRaw", "model.update"]);
});

test("the call past the allowance throws before it reaches the client", () => {
  const { tx, sent } = fakeTx();
  const { client } = countingClient(tx, 1);
  client.$executeRaw(...tag`UPDATE x SET y = ${1}`);
  assert.throws(() => client.opsObserverState.findMany({}), refusedWith("statement_ceiling_exceeded"));
  assert.deepEqual(sent, ["$executeRaw"]);
});

test("a delegate call that could fan out into several queries is refused, uncounted", () => {
  const { tx, sent } = fakeTx();
  const { client, used } = countingClient(tx, 10);
  for (const args of [
    { where: {}, include: { genesis: true } },
    { where: {}, select: { genesis: { select: { id: true } } } },
    { data: { genesis: { connect: { id: "g" } } } },
    { data: [{ items: { create: [{ kind: "new_open" }] } }] },
    { where: {}, create: {}, update: {} },
  ]) {
    assert.ok(delegateArgsFanOut(args), JSON.stringify(args));
    assert.throws(() => client.opsObserverState.findMany(args), refusedWith("statement_ceiling_fan_out"));
  }
  assert.equal(delegateArgsFanOut({ where: { id: "x" }, select: { id: true, mode: false } }), false);
  assert.equal(delegateArgsFanOut({ data: { keys: { "P1a#database": { status: "open" } } } }), false);
  assert.equal(used(), 0);
  assert.deepEqual(sent, []);
});

test("a raw call that is not one tagged statement is refused, uncounted", () => {
  const { tx, sent } = fakeTx();
  const { client, used } = countingClient(tx, 10);
  for (const args of [
    ["SELECT 1"],
    tag`SELECT 1; SELECT 2`,
    tag`SELECT ${sqlFragment}`,
  ]) {
    assert.equal(rawCallIsSingleStatement(args), false);
    assert.throws(() => client.$queryRaw(...args), refusedWith("statement_ceiling_not_single_statement"));
  }
  assert.equal(rawCallIsSingleStatement(tag`SELECT ${"a;b"}`), true, "a ; inside a bound value is data, not SQL");
  assert.equal(used(), 0);
  assert.deepEqual(sent, []);
});

test("unknown methods are refused, whether direct, raw-unsafe or nested", () => {
  const { tx, sent } = fakeTx();
  const { client, used } = countingClient(tx, 10);
  for (const call of [
    () => client.opsObserverState.upsert({}),
    () => client.opsObserverState.createManyAndReturn({}),
    () => client.opsObserverState.nested.run(),
    () => client.$transaction(),
    () => client.$executeRawUnsafe("DELETE FROM x"),
  ]) {
    assert.throws(call, refusedWith("statement_ceiling_unknown_method"));
  }
  assert.equal(used(), 0);
  assert.deepEqual(sent, []);
});

test("an invalid allowance is a programming error", () => {
  assert.throws(() => countingClient({}, -1), /allowance_invalid/);
  assert.throws(() => countingClient({}, 1.5), /allowance_invalid/);
});
