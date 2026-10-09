import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  IDLE_IN_TRANSACTION_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  checkBounds,
  checkDerivations,
  checkOrderings,
  checkTaTrSeparate,
  parsePolicyNumbers,
} from "../scripts/trust-safety-numbers-core.mjs";

/**
 * The test §14's stage 1 entry conditions require: one that reads §12 (1)'s
 * tables of `docs/policy/trust-safety-compliance-agent.md` as its source.
 *
 * The operator signs those numbers. This checks the arithmetic the document
 * claims for them, so the signature lands on something verified. §12 itself
 * records why: an earlier revision had the table and the test carrying
 * different formulas for the same deadline -- 24s and 9s against 21s and 6s --
 * and nothing caught it, because nothing read the table.
 */

const POLICY = join(
  process.cwd(),
  "docs",
  "policy",
  "trust-safety-compliance-agent.md",
);

const policyText = () => readFileSync(POLICY, "utf8");

test("all three tables of §12 (1) are found", () => {
  // A table that cannot be read is reported as missing, not as an empty set of
  // numbers: an empty set passes every check below.
  const parsed = parsePolicyNumbers(policyText());
  assert.ok(parsed.tableA, "table A (periods, windows, retention) was not found");
  assert.ok(parsed.tableB, "table B (the four transaction kinds) was not found");
  assert.ok(parsed.tableC, "table C (deadlines, windows, budgets) was not found");
  assert.equal(parsed.tableB.length, 4, "table B must hold exactly the four kinds");
  for (const [name, value] of Object.entries(parsed.tableA)) {
    assert.equal(typeof value, "number", `table A's ${name} did not parse`);
  }
  for (const [name, value] of Object.entries(parsed.tableC)) {
    assert.equal(typeof value, "number", `table C's ${name} did not parse`);
  }
  for (const row of parsed.tableB) {
    for (const key of ["a", "r", "guardedSeconds", "transactionTimeoutSeconds", "prismaTimeoutMs"]) {
      assert.equal(typeof row[key], "number", `table B's ${row.kind} ${key} did not parse`);
    }
  }
});

test("every derivation §12 states holds against its own numbers", () => {
  const findings = checkDerivations(parsePolicyNumbers(policyText()));
  // The count is asserted so a parser that silently stops finding rows cannot
  // report success by checking nothing.
  assert.ok(findings.length >= 20, `expected at least 20 derivations, checked ${findings.length}`);
  const broken = findings.filter((finding) => !finding.ok);
  assert.deepEqual(
    broken.map((finding) => `${finding.name}: states ${finding.stated}, ${finding.from} gives ${finding.derived}`),
    [],
  );
});

test("the bounds §12 states as ranges hold", () => {
  const bounds = checkBounds(parsePolicyNumbers(policyText()));
  assert.ok(bounds.length >= 6, `expected at least 6 bounds, checked ${bounds.length}`);
  assert.deepEqual(
    bounds.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.because}`),
    [],
  );
});

test("Ta and Tr stay two rows even while they carry the same numbers", () => {
  // §12's reason: a statement added to Tr must not drag Ta along. Equal values
  // are expected; one row standing for both is what this refuses.
  const result = checkTaTrSeparate(parsePolicyNumbers(policyText()));
  assert.equal(result.separate, true, "Ta and Tr must each be exactly one row");
  assert.equal(result.sameNumbers, true, "today they carry the same numbers, by coincidence of A");
});

test("the per-statement guards are the two the document fixes", () => {
  // These two are the only values §12 table B says the database enforces, and
  // every C_guarded is derived from them.
  assert.equal(STATEMENT_TIMEOUT_MS, 2_000);
  assert.equal(IDLE_IN_TRANSACTION_TIMEOUT_MS, 1_000);
  const text = policyText();
  assert.match(text, /`statement_timeout`\s*\*\*2,000ms\*\*/);
  assert.match(text, /`idle_in_transaction_session_timeout`\s*\*\*1,000ms\*\*/);
});

test("a broken derivation is reported, not rounded away", () => {
  // The guard on this guard: feed it the mistake §12 records and check it says
  // so. An earlier revision's deadline formula gave 21s where the table said
  // 24s.
  const text = policyText().replace(
    /\| \*\*사람의 activation 쓰기\*\* \| 8 \| 10 \| \*\*24초\*\*/,
    "| **사람의 activation 쓰기** | 8 | 10 | **21초**",
  );
  const parsed = parsePolicyNumbers(text);
  assert.equal(parsed.tableB.find((row) => /activation 쓰기/.test(row.kind)).guardedSeconds, 21);
  const broken = checkDerivations(parsed).filter((finding) => !finding.ok);
  assert.ok(broken.length > 0, "a wrong C_guarded must be reported");
  assert.ok(
    broken.some((finding) => /activation 쓰기: C_guarded/.test(finding.name)),
    "the C_guarded row itself must be named",
  );
});

test("a missing table is missing, never an empty pass", () => {
  const parsed = parsePolicyNumbers("# a document with no tables\n");
  assert.equal(parsed.tableA, undefined);
  assert.equal(parsed.tableB, undefined);
  assert.equal(parsed.tableC, undefined);
  // And then there is nothing to check, which the count assertions above are
  // what turn into a failure.
  assert.deepEqual(checkDerivations(parsed), []);
  assert.deepEqual(checkBounds(parsed), []);
  assert.equal(checkTaTrSeparate(parsed).separate, false);
});

test("this test changes nothing: it only reads the document", () => {
  // §12's tables are the only source and the signature is the operator's. A
  // check that edited them would be approving its own policy.
  const before = policyText();
  parsePolicyNumbers(before);
  checkDerivations(parsePolicyNumbers(before));
  checkBounds(parsePolicyNumbers(before));
  assert.equal(policyText(), before);
});

test("every ordering §12 states as a contract holds", () => {
  const orderings = checkOrderings(parsePolicyNumbers(policyText()));
  assert.ok(orderings.length >= 11, `expected at least 11 orderings, checked ${orderings.length}`);
  assert.deepEqual(
    orderings.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.because}`),
    [],
  );
});

test("a consistent table whose supervisor outlives P is still refused", () => {
  // The counterexample a review supplied. Scale P to 5 minutes and the round
  // window, B, the child timeout and the supervisor kill with it, and every
  // derivation and bound still holds -- nothing was made unequal. Two runs then
  // overlap, and §8's dead-man reasoning rests on them not doing so.
  const text = policyText()
    .replace(/\| 선언 주기 `P` \| \*\*30분\*\*/, "| 선언 주기 `P` | **5분**")
    .replace(/\(`\*\/30 \* \* \* \*`\)/, "(`*/5 * * * *`)")
    .replace(/= \*\*120분\*\*/, "= **20분**")
    .replace(/\| 회차 창\(`pingPermitted`\) \| \*\*47초\*\*/, "| 회차 창(`pingPermitted`) | **300초**")
    .replace(/\| route 예산 `B` \| \*\*59초\*\*/, "| route 예산 `B` | **312초**")
    .replace(/\| ping 신선도 예산 \| \*\*51초\*\*/, "| ping 신선도 예산 | **304초**")
    .replace(/\| child 요청 timeout \| \*\*69초\*\*/, "| child 요청 timeout | **322초**")
    .replace(/\| supervisor 강제 종료 \| \*\*99초\*\*/, "| supervisor 강제 종료 | **352초**");

  const parsed = parsePolicyNumbers(text);
  assert.equal(parsed.tableA.declarationPeriodMinutes, 5, "the counterexample must parse");
  assert.equal(parsed.tableC.supervisorKillSeconds, 352);

  // Every equality and range still holds, which is the point.
  assert.deepEqual(checkDerivations(parsed).filter((entry) => !entry.ok), []);
  assert.deepEqual(checkBounds(parsed).filter((entry) => !entry.ok), []);

  // The ordering is what catches it.
  const broken = checkOrderings(parsed).filter((entry) => !entry.ok);
  assert.ok(broken.length > 0, "the supervisor outliving P must be reported");
  assert.ok(
    broken.some((entry) => /outer budgets in order/.test(entry.name)),
    "the outer chain must be the finding",
  );
});

test("a transaction_timeout at the statement guard is refused on its own", () => {
  // §12 asks for this assertion separately: at or below the statement guard,
  // PostgreSQL 17 ends the transaction before any statement can be cut off.
  const text = policyText().replace(
    /\| \*\*Ta\*\* DSR count 읽기 \| 3 \| 5 \| \*\*9초\*\* \| \*\*12초\*\*/,
    "| **Ta** DSR count 읽기 | 3 | 5 | **9초** | **2초**",
  );
  const parsed = parsePolicyNumbers(text);
  assert.equal(parsed.tableB.find((row) => /^Ta/.test(row.kind)).transactionTimeoutSeconds, 2);
  const broken = checkOrderings(parsed).filter((entry) => !entry.ok);
  assert.ok(
    broken.some((entry) => /transaction_timeout above statement_timeout/.test(entry.name)),
    "the separate assertion must name itself",
  );
});
