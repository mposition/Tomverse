import assert from "node:assert/strict";
import test from "node:test";

import {
  admitDraftCall,
  DOWNWARD_CORRECTION_GROUNDS,
  ledgerBalance,
  transportBlockedBeforeProvider,
} from "../lib/aiReviewDraftLedger.ts";

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

const correct = (
  id,
  from,
  to,
  reason = "the input bound was replaced",
  // `null` omits the field; leaving the argument off takes the default a
  // real downward correction carries. `undefined` would take the default
  // too, which is why the omission case has to say null out loud.
  grounds = to < from ? "transport_blocked_before_provider" : null
) =>
  JSON.stringify({
    op: "correct",
    reservationId: id,
    at: "2026-09-02",
    previousCostCeilingUsd: from,
    costCeilingUsd: to,
    reason,
    ...(grounds == null ? {} : { grounds }),
  });

/** The proxy's refusal, as it actually arrived on 2026-09-03. */
const egressRefusal = (host) =>
  `Host not in allowlist: ${host}. Add this host to your network egress ` +
  `settings to allow access.`;

test("a correction reaches the total without editing the line it corrects", () => {
  // The first paid batch reserved against an input bound that was later
  // replaced. Rewriting that line would make the ledger's history change under
  // an approval; the correction restates it instead, and the difference lands
  // in the running total.
  const balance = ledgerBalance([
    reserve("pilot", 0.0145338),
    settle("pilot", 0.0145338, "drafted_7"),
    correct("pilot", 0.0145338, 0.014948),
  ]);
  assert.deepEqual(balance.problems, []);
  assert.equal(balance.settledCount, 1);
  assert.equal(balance.outstandingCount, 0);
  assert.equal(Number(balance.committedUsd.toFixed(7)), 0.014948);
});

test("a correction that restates the wrong starting figure is refused", () => {
  // Two corrections written against the same reservation from the same
  // starting figure, or one aimed at a line its author misread. Either way the
  // running total is not what anybody computed.
  const balance = ledgerBalance([
    reserve("pilot", 0.0145338),
    correct("pilot", 0.0145338, 0.014948),
    correct("pilot", 0.0145338, 0.02),
  ]);
  assert.equal(balance.problems.length, 1);
  assert.match(balance.problems[0], /but 0.014948 is what stands/);
});

test("a correction needs a reservation and a reason", () => {
  const orphan = ledgerBalance([correct("nobody", 1, 2)]);
  assert.match(orphan.problems[0], /never reserved/);
  const unexplained = ledgerBalance([reserve("a", 1), correct("a", 1, 2, "")]);
  assert.match(unexplained.problems[0], /gives no reason/);
});

test("a settlement written before its correction still totals at the corrected ceiling", () => {
  // The settlement carries the old figure, because it was written when that
  // was the ceiling. What the total must reflect is what the reservation now
  // stands at, not what the settlement happens to say.
  const balance = ledgerBalance([
    reserve("a", 1),
    settle("a", 1),
    correct("a", 1, 3),
  ]);
  assert.deepEqual(balance.problems, []);
  assert.equal(balance.committedUsd, 3);
});


// ---------------------------------------------------------------------------
// Corrections that lower a ceiling
//
// 2026-09-03: an approved call was refused by this session's egress proxy.
// The request never reached OpenAI, nothing was generated, nothing was billed
// -- and it settled at the full ceiling, leaving $0.0086 of an approved $0.18,
// which would have refused the very batch that $0.18 was approved for.
// ---------------------------------------------------------------------------

test("lowering a ceiling under a settlement that already stands is not an overrun", () => {
  // The shape the live ledger is in: reserve, settle at the full ceiling, and
  // only afterwards the correction saying the call reached nothing. Read
  // naively the settlement now closes for more than its reservation holds; it
  // does not, because it closed against the ceiling standing at the time.
  const balance = ledgerBalance([
    reserve("blocked", 0.0233574),
    settle("blocked", 0.0233574, "http_403"),
    correct(
      "blocked",
      0.0233574,
      0,
      `refused before the provider: ${egressRefusal("api.openai.com")}`
    ),
  ]);
  assert.deepEqual(balance.problems, []);
  assert.equal(balance.committedUsd, 0);
  assert.equal(balance.settledCount, 1);
  assert.equal(balance.outstandingCount, 0);
});

test("a correction that lowers a ceiling states grounds, not just a sentence", () => {
  // A prose reason can say anything. Giving an approval its money back is a
  // decision about what counts as money never at stake, so it names one of the
  // codes this file lists and a reader can count them.
  const unexplained = ledgerBalance([
    reserve("a", 1),
    settle("a", 1),
    correct("a", 1, 0, "it felt wrong", null),
  ]);
  assert.equal(unexplained.problems.length, 1);
  assert.match(unexplained.problems[0], /without one of transport_blocked_before_provider/);
  // The ceiling that stands is still the one it was reserved at: a refused
  // correction changes nothing.
  assert.equal(unexplained.committedUsd, 1);

  const invented = ledgerBalance([
    reserve("a", 1),
    settle("a", 1),
    correct("a", 1, 0, "it felt wrong", "seemed_expensive"),
  ]);
  assert.equal(invented.problems.length, 1);
  assert.equal(invented.committedUsd, 1);

  // Raising one needs no code: it commits more, so the worst a wrong one does
  // is refuse a later call.
  const raised = ledgerBalance([reserve("a", 1), settle("a", 1), correct("a", 1, 3, "r", null)]);
  assert.deepEqual(raised.problems, []);
  assert.equal(raised.committedUsd, 3);
});

test("a settlement above every ceiling the reservation ever had is still refused", () => {
  // The check this loosening must not have dissolved. `highest` is the most
  // the reservation ever stood at, so a settlement that closed for more than
  // any of them means the reservation was never a bound.
  const overrun = ledgerBalance([reserve("a", 1), settle("a", 5)]);
  assert.equal(overrun.problems.length, 1);
  assert.match(overrun.problems[0], /settled at 5 above its reservation of 1/);

  // And a downward correction does not become a way to hide one: 5 is above
  // both 1 and 0.
  const hidden = ledgerBalance([
    reserve("a", 1),
    settle("a", 5),
    correct("a", 1, 0, "refused before the provider"),
  ]);
  assert.equal(hidden.problems.length, 1);
  assert.match(hidden.problems[0], /above its reservation of 1/);
});

test("a run that stops after correcting still blocks the next call", () => {
  // Why the drafter writes the correction BEFORE the settlement. Dying between
  // the two leaves a reservation with no settlement, and an outstanding
  // reservation refuses the next call whatever the arithmetic says -- which is
  // what has to happen, because nobody has accounted for that run yet.
  const balance = ledgerBalance([
    reserve("blocked", 0.0233574),
    correct("blocked", 0.0233574, 0, "refused before the provider"),
  ]);
  assert.deepEqual(balance.problems, []);
  assert.equal(balance.committedUsd, 0);
  assert.equal(balance.outstandingCount, 1);
  const decision = admitDraftCall({
    balance,
    callCostCeilingUsd: 0.0234,
    maxTotalCostUsd: 0.18,
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /have not settled/);
});

test("only the proxy's own refusal, about this host, reaches zero", () => {
  const host = "api.openai.com";
  assert.equal(
    transportBlockedBeforeProvider({ status: 403, body: egressRefusal(host), host }),
    true
  );
  // Trailing whitespace is not a difference; a transport is allowed to add a
  // newline.
  assert.equal(
    transportBlockedBeforeProvider({
      status: 403,
      body: `${egressRefusal(host)}\n`,
      host,
    }),
    true
  );

  // A provider's own 403. This is the one that must keep its ceiling: it can
  // follow a request the provider accepted, and this tool never learns whether
  // it did.
  assert.equal(
    transportBlockedBeforeProvider({
      status: 403,
      body: JSON.stringify({ error: { message: "You do not have access to this model" } }),
      host,
    }),
    false
  );

  // The proxy's sentence about a DIFFERENT host says nothing about this call.
  assert.equal(
    transportBlockedBeforeProvider({
      status: 403,
      body: egressRefusal("example.invalid"),
      host,
    }),
    false
  );

  // Near misses. Matched in full rather than searched for, so a provider that
  // happens to mention an allowlist cannot buy a refund by phrasing an error a
  // certain way.
  for (const body of [
    `Warning: ${egressRefusal(host)}`,
    `${egressRefusal(host)} Contact your administrator.`,
    `Host not in allowlist: ${host}.`,
    egressRefusal(host).replace("allowlist", "allow list"),
  ]) {
    assert.equal(
      transportBlockedBeforeProvider({ status: 403, body, host }),
      false,
      body
    );
  }

  // Everything that is not a 403 keeps its ceiling, including the statuses a
  // billed call can end on.
  for (const status of [200, 400, 401, 429, 500, 502, 503, 504]) {
    assert.equal(
      transportBlockedBeforeProvider({ status, body: egressRefusal(host), host }),
      false,
      String(status)
    );
  }
  assert.equal(
    transportBlockedBeforeProvider({ status: 403, body: egressRefusal(""), host: "" }),
    false
  );
});

test("the grounds vocabulary is a list, not a free field", () => {
  assert.deepEqual(
    [...DOWNWARD_CORRECTION_GROUNDS],
    ["transport_blocked_before_provider"]
  );
});
