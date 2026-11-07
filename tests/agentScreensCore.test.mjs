import assert from "node:assert/strict";
import test from "node:test";

import { financeFigures, financeHeadStatus } from "../lib/billingFinanceAgentCore.ts";
import { sreHeadStatus, summarizeSreDigest } from "../lib/adminSreDailyCore.ts";
import {
  classifyEngineeringPr,
  engineeringHeadStatus,
  minutesToFirstPullRequest,
} from "../lib/engineeringAgentOverviewCore.ts";

// --- Engineering -----------------------------------------------------------

test("a pull request is ready only when it is open, approved and not merged", () => {
  assert.equal(classifyEngineeringPr({ state: "open", approved: true, merged: null }), "ready");
  assert.equal(classifyEngineeringPr({ state: "open", approved: false, merged: null }), "waiting");
  assert.equal(classifyEngineeringPr({ state: "open", approved: true, merged: true }), "merged");
  assert.equal(classifyEngineeringPr({ state: "closed", approved: true, merged: false }), "closed");
  assert.equal(classifyEngineeringPr({ state: "closed", approved: false, merged: true }), "merged");
});

test("time to the first pull request counts one run once, drops bad rows and keeps the newest", () => {
  const at = (iso) => new Date(iso);
  const rows = [
    // run a: two bindings, the earlier one counts (12 minutes)
    { runId: "a", createdAt: at("2026-11-01T01:12:00Z"), runStartedAt: at("2026-11-01T01:00:00Z") },
    { runId: "a", createdAt: at("2026-11-01T02:00:00Z"), runStartedAt: at("2026-11-01T01:00:00Z") },
    // run b: 30 minutes
    { runId: "b", createdAt: at("2026-11-02T01:30:00Z"), runStartedAt: at("2026-11-02T01:00:00Z") },
    // run c: opened before it started, and an unreadable time: both dropped
    { runId: "c", createdAt: at("2026-11-03T00:00:00Z"), runStartedAt: at("2026-11-03T01:00:00Z") },
    { runId: "d", createdAt: "not a date", runStartedAt: at("2026-11-03T01:00:00Z") },
  ];
  assert.deepEqual(minutesToFirstPullRequest(rows), [12, 30]);
  assert.deepEqual(minutesToFirstPullRequest(rows, 1), [30]);
  assert.deepEqual(minutesToFirstPullRequest([]), []);
});

test("the engineering head names the agent from its own switch and halt, and unread is not off", () => {
  const observed = (patch) => ({
    kind: "observed",
    mode: "t1",
    frozen: false,
    killSwitch: false,
    halt: "none",
    pending: { t2Draft: 0, decision: 0, stateMismatch: 0 },
    activeRuns: 0,
    activeSince: null,
    lastRun: null,
    runnerLastFinishAt: null,
    publisherLastFinishAt: null,
    ...patch,
  });
  assert.deepEqual(engineeringHeadStatus({ kind: "unread" }), { status: "unknown", tone: "unknown", autoRun: "unknown" });
  assert.equal(engineeringHeadStatus(observed({ mode: "off" })).autoRun, "off");
  assert.equal(engineeringHeadStatus(observed({ killSwitch: true })).status, "off");
  assert.equal(engineeringHeadStatus(observed({ halt: "circuit_open" })).status, "stopped");
  assert.equal(engineeringHeadStatus(observed({ frozen: true })).status, "frozen");
  assert.equal(engineeringHeadStatus(observed({ mode: "shadow" })).status, "observing");
  assert.equal(engineeringHeadStatus(observed({ activeRuns: 2 })).status, "working");
  assert.equal(engineeringHeadStatus(observed({})).status, "watching");
});

// --- SRE -------------------------------------------------------------------

const digest = (payload, id = "d1") => ({
  id,
  createdAt: "2026-11-07T21:00:00.000Z",
  countsComplete: true,
  payload,
});

test("an SRE day is quiet only with no message and every check passing", () => {
  const quiet = summarizeSreDigest(
    digest({ ownerDate: "2026-11-07", mode: "shadow", readiness: { db: true }, items: [], counts: [], channelCheckTaken: true }),
  );
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.tone, "ok");
  assert.equal(quiet.total, 0);

  const busy = summarizeSreDigest(
    digest({
      ownerDate: "2026-11-06",
      mode: "live",
      readiness: { db: false, queue: true },
      items: [],
      counts: [{ mode: "live", status: "reserved", kind: "new_open", count: 2 }],
      channelCheckTaken: false,
    }),
  );
  assert.equal(busy.quiet, false);
  assert.equal(busy.total, 2);
  assert.deepEqual(busy.failingChecks, ["db"]);

  // Checks that were not read are not "passing".
  const unknown = summarizeSreDigest(
    digest({ ownerDate: "2026-11-05", mode: "shadow", readiness: "unknown", items: [], counts: [], channelCheckTaken: true }),
  );
  assert.equal(unknown.quiet, false);
  assert.equal(unknown.readinessUnknown, true);
  assert.equal(unknown.failingChecks, null);
});

test("an SRE report with no body is unknown, never a quiet day", () => {
  const gone = summarizeSreDigest(digest(null));
  assert.equal(gone.bodyGone, true);
  assert.equal(gone.quiet, false);
  assert.equal(gone.tone, "unknown");
  assert.equal(gone.total, null);
});

test("the SRE head follows the chain verdict, and an unread chain is unknown", () => {
  const head = (mode) => ({ genesisId: "g", generation: 0, mode, createdAt: "2026-11-01T00:00:00.000Z" });
  const view = (patch) => ({ head: head("live"), trustReason: "trusted", nextGenesisAt: null, genesisAllowedNow: true, ...patch });
  assert.equal(sreHeadStatus(null).status, "unknown");
  assert.equal(sreHeadStatus(view({ head: null })).status, "preparing");
  assert.equal(sreHeadStatus(view({ trustReason: "state_missing" })).status, "needsLook");
  assert.equal(sreHeadStatus(view({ head: head("shadow") })).status, "observing");
  assert.equal(sreHeadStatus(view({})).status, "watching");
});

// --- Billing and finance ----------------------------------------------------

const row = (id, createdAt, digest) => ({
  id,
  createdAt,
  sizeBytes: 100,
  body: digest ? "present" : "expired",
  digest,
});
const item = (modelId, remainingDays, mark) => ({ modelId, registeredAt: "2026-10-01", expiresAt: "2026-12-01", remainingDays, mark });

test("finance figures come from the newest readable digest and say nothing without one", () => {
  const rows = [
    row("3", "2026-11-07T01:00:00.000Z", null),
    row(
      "2",
      "2026-11-06T01:00:00.000Z",
      { environment: "production", computedAtDate: "2026-11-06", verdict: "notice", items: [item("m-a", 20, "none"), item("m-b", 5, "7"), item("m-c", null, "none")], rejectedFields: [] },
    ),
    row(
      "1",
      "2026-11-05T01:00:00.000Z",
      { environment: "production", computedAtDate: "2026-11-05", verdict: "quiet", items: [], rejectedFields: [] },
    ),
  ];
  const figures = financeFigures(rows);
  assert.equal(figures.latest.id, "2");
  assert.equal(figures.waiting, 3);
  assert.deepEqual(figures.nearest, { days: 5, modelId: "m-b" });
  assert.equal(figures.soon, 1);
  // Oldest first, and the day with no body is unknown rather than quiet.
  assert.deepEqual(figures.calendar.map((day) => day.tone), ["ok", "warn", "unknown"]);
  assert.deepEqual(figures.calendar.map((day) => day.label), ["11-05", "11-06", "11-07"]);

  const none = financeFigures([row("9", "2026-11-07T01:00:00.000Z", null)]);
  assert.equal(none.latest, null);
  assert.equal(none.waiting, null);
  assert.equal(none.soon, null);
  assert.equal(none.nearest, null);
});

test("an already expired price counts as due soon", () => {
  const figures = financeFigures([
    row("1", "2026-11-06T01:00:00.000Z", {
      environment: "staging",
      computedAtDate: "2026-11-06",
      verdict: "notice",
      items: [item("m-a", -3, "expired"), item("m-b", 40, "none")],
      rejectedFields: [],
    }),
  ]);
  assert.equal(figures.soon, 1);
  assert.deepEqual(figures.nearest, { days: -3, modelId: "m-a" });
});

test("an unreadable finance switch is never off", () => {
  const control = (state) => ({ state, revision: 1, enabledAt: null });
  assert.equal(financeHeadStatus(null).autoRun, "unknown");
  assert.equal(financeHeadStatus(control("unreadable")).autoRun, "unknown");
  assert.equal(financeHeadStatus(control("disabled")).autoRun, "off");
  assert.equal(financeHeadStatus(control("enabled")).autoRun, "on");
});
