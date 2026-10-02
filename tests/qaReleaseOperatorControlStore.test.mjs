import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// lib/qaReleaseOperatorControlStore.ts is server-only; its limits and lock are
// read from source here, and its behaviour is covered by
// tests/integration/qa-release-operator-control.db.test.ts.

const STORE = readFileSync(new URL("../lib/qaReleaseOperatorControlStore.ts", import.meta.url), "utf8");
const AUDIT = readFileSync(new URL("../lib/adminAudit.ts", import.meta.url), "utf8");

test("the write takes the audit chain's own lock key in its first statement", () => {
  const key = /pg_advisory_xact_lock\(hashtext\('([^']+)'\)\)/;
  assert.equal(STORE.match(key)?.[1], AUDIT.match(key)?.[1]);
});

test("the limits follow 3A + 5 for seven statements, with Prisma five seconds longer", () => {
  const block = STORE.slice(STORE.indexOf("QA_RELEASE_CONTROL_WRITE_LIMITS = Object.freeze({"));
  assert.match(block, /statements: 7,/);
  assert.match(block, /transactionMs: \(3 \* 7 \+ 5\) \* 1_000,/);
  assert.match(block, /prismaMs: \(3 \* 7 \+ 5\) \* 1_000 \+ 5_000,/);
  assert.match(STORE, /set_config\('transaction_timeout'/);
});
