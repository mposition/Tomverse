import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// Owner decision 2026-11-15: one card's events hold that card only, a
// successful result is never thrown away, and nothing runs a reviewed result
// again for want of a pull request. (The ENGINEERING_AGENT_LEGACY_HALTS kill switch was removed, 2026-11-16.)

const read = (path) => readFileSync(path, "utf8");

test("card-scoped halts are the only behaviour", async () => {
  const core = await import("../lib/engineeringAgentCore.ts");
  assert.equal("ENGINEERING_AGENT_LEGACY_HALTS_ENV" in core, false);
  assert.equal("engineeringAgentLegacyHalts" in core, false);
  assert.equal("engineeringAgentMismatchCardScoped" in core, false);
  // A review_pr: mismatch (no run of its own) holds the card of the publish item it names, everywhere a card is held.
  const store = read("lib/engineeringAgentStore.ts");
  assert.equal(store.split('JOIN "EngineeringAgentWorkItem" m ON m."causeKey" = ${REVIEW_PR_MISMATCH_PREFIX} || p."id"').length, 2,
    "the card-held test");
  assert.equal(store.split('JOIN "EngineeringAgentWorkItem" mm ON mm."causeKey" = ${REVIEW_PR_MISMATCH_PREFIX} || pp."id"').length, 2,
    "the publish claim's pick");
  assert.match(store, /WHERE p\."id" = substr\(m\."causeKey", \$\{REVIEW_PR_MISMATCH_PREFIX\.length \+ 1\}\)/,
    "the unscoped count looks the item up by its key");
  // The old opt-in switch is gone: nothing reads it.
  assert.equal("ENGINEERING_AGENT_MISMATCH_CARD_SCOPED_ENV" in core, false);
  for (const path of ["lib/engineeringAgentStore.ts", "lib/engineeringAgentCore.ts"])
    assert.doesNotMatch(read(path), /ENGINEERING_AGENT_MISMATCH_CARD_SCOPED\b/, path);
});

test("the global halts are named, and each is a security boundary or has no card to hold", async () => {
  const { ENGINEERING_AGENT_GLOBAL_HALTS, HALT_VALUES } = await import("../lib/engineeringAgentCore.ts");
  assert.deepEqual(Object.keys(ENGINEERING_AGENT_GLOBAL_HALTS).sort(),
    HALT_VALUES.filter((h) => h !== "none" && h !== "circuit_open").sort(), "the circuit halts only with the kill switch");
  assert.match(ENGINEERING_AGENT_GLOBAL_HALTS.state_mismatch, /no card/);
  assert.match(ENGINEERING_AGENT_GLOBAL_HALTS.unbound_app_pr, /clears once a later reading explains it/);
});

test("an observed halt names its pull request or branch, and nothing else", async () => {
  const { parseObservedHaltSubject } = await import("../lib/engineeringAgentCore.ts");
  assert.deepEqual(parseObservedHaltSubject({ prNumber: 3942 }), { prNumber: 3942 });
  assert.deepEqual(parseObservedHaltSubject({ ref: "refs/heads/agent/engineering/123" }),
    { ref: "refs/heads/agent/engineering/123" });
  for (const bad of [null, [], { prNumber: 0 }, { prNumber: 1.5 }, { prNumber: 1, ref: "refs/heads/x" },
    { ref: "heads/x" }, { ref: "refs/heads/a/../b" }, { ref: "refs/heads/a b" }, { other: 1 }])
    assert.equal(parseObservedHaltSubject(bad), null, JSON.stringify(bad));
});

test("a card's review is its newest accepted result; a later failure does not hide it", async () => {
  const { amuxV22ReviewAttempt } = await import("../lib/amux/v22KeptResultCore.ts");
  const at = new Date("2026-11-15T00:00:00Z");
  const ok = (id) => ({ id, endedAt: at, outcome: "succeeded", toStatus: "review" });
  const failed = (id) => ({ id, endedAt: at, outcome: "failed", toStatus: "todo" });
  // AMUX-IMGOUT-003: attempts 2 and 3 passed review, 4 and 5 failed.
  const imgout = [failed("a5"), failed("a4"), ok("a3"), ok("a2"), failed("a1")];
  assert.equal(amuxV22ReviewAttempt(imgout)?.id, "a3");
  assert.equal(amuxV22ReviewAttempt(imgout, true), null, "a card that is not a v4 card: only the newest counts");
  assert.equal(amuxV22ReviewAttempt([ok("a2"), failed("a1")])?.id, "a2");
  assert.equal(amuxV22ReviewAttempt([ok("a2")], true)?.id, "a2");
  // A result rejected back to todo holds no review; anything still open holds every review.
  assert.equal(amuxV22ReviewAttempt([{ ...ok("a3"), toStatus: "todo" }, ok("a2")])?.id, "a2");
  assert.equal(amuxV22ReviewAttempt([{ ...ok("a3"), endedAt: null }, ok("a2")]), null);
  assert.equal(amuxV22ReviewAttempt([]), null);
});

test("a kept result is published once publication could open, the way settlement would have", async () => {
  const { decideAmuxV22KeptResult, amuxV22KeptResultPublicationEnabled } = await import("../lib/amux/v22KeptResultCore.ts");
  const open = { publicationEnabled: true, orchestratorHalted: false, claimAllowed: true,
    publishAllowed: true, mode: "t1", consent: true, taskStatus: "review" };
  assert.deepEqual(decideAmuxV22KeptResult(open), { publish: true, moveToReview: false, tierPending: true });
  assert.deepEqual(decideAmuxV22KeptResult({ ...open, taskStatus: "blocked" }),
    { publish: true, moveToReview: true, tierPending: true }, "a card whose budget ran out goes back to review");
  // No public pull request consent under t1: the owner's T2 draft, rejudged once the consent is there.
  assert.deepEqual(decideAmuxV22KeptResult({ ...open, consent: false }), { publish: true, moveToReview: false, tierPending: false });
  // Review r-20261115-115151-9e04dc: under shadow it waits, since a shadow run's product can never become a PR.
  for (const [change, reason] of [
    [{ publicationEnabled: false }, "disabled"],
    [{ orchestratorHalted: true }, "orchestrator_halted"], [{ taskStatus: "todo" }, "task_moved"],
    [{ mode: "shadow", publishAllowed: false }, "shadow_mode"],
    [{ mode: "off", claimAllowed: false, publishAllowed: false }, "engineering_off"],
    [{ claimAllowed: false, publishAllowed: false }, "engineering_off"]])
    assert.deepEqual(decideAmuxV22KeptResult({ ...open, ...change }), { publish: false, reason }, JSON.stringify(change));
  // Whether kept results are published at all, which also decides whether the DM leaves them out.
  assert.equal(amuxV22KeptResultPublicationEnabled({ TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION: "enabled" }), true);
  assert.equal(amuxV22KeptResultPublicationEnabled({}), false);
});

test("the Decision Maker is never asked to run a kept result again, and the reads only read", () => {
  const scan = read("lib/amux/dmOwnerSettlementRead.ts");
  assert.match(scan, /AND \(\$\{keepsNoResult\} OR NOT \$\{amuxV22KeptResultExistsSql\}\)/);
  const kept = read("lib/amux/v22KeptResultRead.ts");
  const sql = [...kept.matchAll(/(?:Prisma\.sql|\$queryRaw<[\s\S]*?>)`([\s\S]*?)`/g)].map((m) => m[1]).join("\n");
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "EngineeringAgentRun" kr WHERE kr\."amuxAttemptId" = ra\."id"\)/);
  assert.match(sql, /kp\."bodyPurgedAt" IS NULL/);
  assert.match(sql, /ke\."resolutionOutcome" IN \('retry', 'block'\)/, "a person's rejection is honoured");
  assert.doesNotMatch(sql.toLowerCase(), /\b(insert|update|delete|merge|upsert|truncate|alter|drop)\b/,
    "the engineering reads only read (scripts/check-protected-table-writers-core.mjs)");
});

test("a review pull request's DM settlement follows the card's review attempt, not its newest one", async () => {
  // Review r-20261115-120115-261135: attempt 3's kept result published after attempts 4 and 5 failed.
  const { amuxDmOwnerSettlementMoved } = await import("../lib/amux/dmOwnerSettlementCore.ts");
  const facts = { taskStatus: "review", attemptId: "a3", status: "review", sourceSystem: "admin-idea-v4",
    archivedAt: null, lastAttempt: { id: "a5" }, activeDelivery: false, liveAttempt: false, escalationOpen: true };
  assert.equal(amuxDmOwnerSettlementMoved({ ...facts, kind: "t2_pr", reviewAttempt: { id: "a3" } }), null);
  assert.equal(amuxDmOwnerSettlementMoved({ ...facts, kind: "t2_pr", reviewAttempt: { id: "a6" } }), "task_moved",
    "a newer accepted result is a new review");
  assert.equal(amuxDmOwnerSettlementMoved({ ...facts, kind: "stopped", reviewAttempt: { id: "a3" } }), "task_moved",
    "a stopped card is still judged by its newest attempt");
  const scan = read("lib/amux/dmOwnerSettlementRead.ts");
  assert.match(scan, /WHERE r\."amuxAttemptId" = ra\."id" AND r\."cardId" = w\."id"/);
  // Review r-20261115-121651-2c22aa: the scan itself names the attempt to file, so the
  // owner's manual request (ownerQueueDmRequestService.ts) files the review attempt too.
  assert.match(scan, /CASE WHEN b\."id" IS NOT NULL THEN ra\."id" ELSE a\."id" END AS "attemptId"/);
  for (const caller of ["lib/amux/dmOwnerSettlementService.ts", "lib/amux/ownerQueueDmRequestService.ts"])
    assert.match(read(caller), /attemptId/, caller);
  const lane = read("lib/amux/dmT2MergeRead.ts");
  assert.match(lane, /AND x\."outcome" = 'succeeded' AND x\."toStatus" = 'review'\n\s+ORDER BY x\."attemptNumber" DESC NULLS LAST, x\."startedAt" DESC, x\."id" DESC LIMIT 1\) = s\."attemptId"/);
});

test("the runner's round carries the kept results after the bindings are released", () => {
  const route = read("app/api/internal/engineering-agent/observe/pull-requests/route.ts");
  const released = route.indexOf("await releaseEngineeringAgentBindings();");
  const kept = route.indexOf("await publishAmuxV22KeptResults();");
  assert.ok(released > 0 && kept > released);
  const halt = read("app/api/internal/engineering-agent/observe/halt/route.ts");
  // A clean reading names the halt it saw (review r-20261115-120115-261135).
  assert.match(halt, /z\.object\(\{ halt: z\.literal\("none"\), observedAt: z\.string\(\)\.datetime\(\) \}\)\.strict\(\)/);
  assert.match(halt, /clearEngineeringAgentObservedHalt\(tx, \{ observedAt \}\)/);
});

test("the kept result publication writes in one transaction, through the stores, and runs nothing", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server", "--no-warnings=ExperimentalWarning",
    "--import", "tsx",
    resolve("tests/support/amuxV22KeptResultPublicationHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
