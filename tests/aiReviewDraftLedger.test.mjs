import assert from "node:assert/strict";
import test from "node:test";

import { admitDraftCall, ledgerBalance } from "../lib/aiReviewDraftLedger.ts";

const reserve = (id, cost) =>
  JSON.stringify({ op: "reserve", id, at: "2026-09-01", costCeilingUsd: cost });
const settle = (id, cost, outcome = "drafted_10") =>
  JSON.stringify({
    op: "settle",
    reservationId: id,
    at: "2026-09-01",
    costCeilingUsd: cost,
    outcome,
  });

test("a reservation that never settled keeps holding the budget", () => {
  // The whole point. A call that was billed and produced nothing usable, a
  // reply that would not parse, and a process that died after the response all
  // leave exactly this: a reservation with no settlement. A settle-only ledger
  // lost every one of them.
  const balance = ledgerBalance([reserve("a", 1.5)]);
  assert.equal(balance.settledUsd, 0);
  assert.equal(balance.outstandingUsd, 1.5);
  assert.equal(balance.committedUsd, 1.5);
  assert.equal(balance.outstandingCount, 1);
  assert.deepEqual(balance.problems, []);
});

test("a billed failure is committed at its reserved cost", () => {
  const balance = ledgerBalance([
    reserve("a", 0.02),
    settle("a", 0.02, "no_usable_cases"),
  ]);
  assert.equal(balance.committedUsd, 0.02);
  assert.equal(balance.settledCount, 1);
  assert.equal(balance.outstandingCount, 0);
});

test("settling releases only the difference, never more than was reserved", () => {
  const balance = ledgerBalance([reserve("a", 1), settle("a", 5)]);
  assert.equal(balance.committedUsd, 1);
  assert.ok(
    balance.problems.some((problem) => problem.includes("above its reservation"))
  );
});

test("an unreadable line, a stray settlement and a double settlement all stop the loop", () => {
  for (const lines of [
    ["not json"],
    [settle("never-reserved", 1)],
    [reserve("a", 1), settle("a", 1), settle("a", 1)],
    [reserve("a", 1), reserve("a", 1)],
  ]) {
    const balance = ledgerBalance(lines);
    assert.ok(balance.problems.length > 0, JSON.stringify(lines));
    assert.equal(
      admitDraftCall({
        balance,
        callCostCeilingUsd: 0.01,
        maxTotalCostUsd: 100,
      }).allowed,
      false
    );
  }
});

test("a call is refused when its ceiling would pass the approved total", () => {
  // Settled, not outstanding: an outstanding reservation is refused before the
  // arithmetic is reached, and this test is about the arithmetic.
  const balance = ledgerBalance([reserve("a", 5.99), settle("a", 5.99)]);
  const decision = admitDraftCall({
    balance,
    callCostCeilingUsd: 0.0145,
    maxTotalCostUsd: 6,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /1 settled/);
  assert.match(decision.reason, /approved \$6\.00/);
});

test("an outstanding reservation refuses the next call outright", () => {
  // Not "there is no room" -- there is plenty. The refusal is that another run
  // may still be going, and two runs write the same decision set back whole,
  // so the second to finish erases the first one's cases. Budget arithmetic
  // cannot see that, so the rule cannot live in the arithmetic.
  const balance = ledgerBalance([reserve("a", 0.0145)]);
  const decision = admitDraftCall({
    balance,
    callCostCeilingUsd: 0.0145,
    maxTotalCostUsd: 100,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /have not settled/);
  assert.match(decision.reason, /overwrite/);
});

test("no approved total and no known price are both refusals", () => {
  const balance = ledgerBalance([]);
  assert.equal(
    admitDraftCall({ balance, callCostCeilingUsd: 1, maxTotalCostUsd: null }).allowed,
    false
  );
  const unpriced = admitDraftCall({
    balance,
    callCostCeilingUsd: null,
    maxTotalCostUsd: 10,
  });
  assert.equal(unpriced.allowed, false);
  assert.match(unpriced.reason, /unknown price is not a budget/);
});

test("two callers reading the same balance cannot both fit", () => {
  // What the lock exists for, stated as arithmetic: if the second caller sees
  // the first caller's reservation it is refused, and if it does not -- which
  // is what an unlocked read gives -- both proceed and the total is passed.
  const empty = ledgerBalance([]);
  assert.equal(
    admitDraftCall({ balance: empty, callCostCeilingUsd: 4, maxTotalCostUsd: 6 }).allowed,
    true
  );
  const afterFirst = ledgerBalance([reserve("a", 4)]);
  assert.equal(
    admitDraftCall({ balance: afterFirst, callCostCeilingUsd: 4, maxTotalCostUsd: 6 })
      .allowed,
    false
  );
});
