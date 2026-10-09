import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

import { ENGINEERING_AGENT_SYSTEM_AUDIT_ACTORS, SYSTEM_AUDIT_ACTORS } from "../lib/adminAuditSystemActors.ts";
import {
  ENGINEERING_AGENT_FREEZE_SETTING_KEY,
  ENGINEERING_AGENT_KILL_SWITCH_ENV,
  ENGINEERING_AGENT_MODE_SETTING_KEY,
  ENGINEERING_AGENT_POLICY_VERSION,
} from "../lib/engineeringAgentCore.ts";
import {
  engineeringAgentApprovalObservationSchema,
  engineeringAgentBindingSnapshotSchema,
  engineeringAgentMergeObservationSchema,
  readEngineeringAgentSwitches,
} from "../lib/engineeringAgentStore.ts";

// The engineering agent's single writer (docs/policy/engineering-agent.md §11).
// The database rules are proven in tests/integration/engineering-agent-*.db.test.ts;
// this file fixes the module's shape: one transaction brand, an audit entry for
// every change, strict JSON with no person identifiers, and the switches read
// fail-closed.

const STORE = "lib/engineeringAgentStore.ts";
const source = readFileSync(STORE, "utf8");
const tree = ts.createSourceFile(STORE, source, ts.ScriptTarget.Latest, true);

const exportedFunctions = () =>
  tree.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );

test("the code implements the policy version the policy header states", () => {
  const policy = readFileSync("docs/policy/engineering-agent.md", "utf8");
  const header = /정책 버전: ([0-9]+)/.exec(policy);
  assert.ok(header, "the policy states its version");
  assert.equal(ENGINEERING_AGENT_POLICY_VERSION, Number(header[1]));
});

test("the engineering actors are listed system actors, and none is a person", () => {
  for (const actor of ENGINEERING_AGENT_SYSTEM_AUDIT_ACTORS) {
    assert.ok(SYSTEM_AUDIT_ACTORS.includes(actor), actor);
    assert.match(actor, /^engineering-agent-[a-z]+$/);
  }
});

test("the engineering transaction brand has exactly two casts, both in the store, and nothing casts past a type", () => {
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const next = join(at, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(next);
    }
  };
  for (const root of ["lib", "app", "components"]) walk(root);
  const casts = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("EngineeringAgentTransaction")) continue;
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        node.type.getText(sourceFile).includes("EngineeringAgentTransaction")
      ) {
        casts.push(`${file}: ${node.getText(sourceFile).slice(0, 60)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  // One in runEngineeringAgentTransaction, one renaming an AMUX writer's lent transaction.
  assert.equal(casts.length, 2, casts.join(" | "));
  for (const cast of casts) assert.ok(cast.includes("engineeringAgentStore.ts"), cast);
  assert.doesNotMatch(source, /\bas (?:never|any)\b/);
});

// Functions that write without an audit entry, and why. Everything else that
// writes records its actor in the same transaction.
const UNAUDITED = new Map([
  ["runEngineeringAgentTransaction", "opens the transaction; writes nothing itself"],
  ["engineeringAgentTransactionInAmux", "renames a lent transaction; writes nothing itself"],
  ["readEngineeringAgentSwitches", "reads only"],
  ["readEngineeringAgentHaltState", "reads only"],
  ["readEngineeringAgentOwnerQueues", "reads only"],
  ["readEngineeringAgentRegistrationCounts", "reads only"],
  ["readEngineeringAgentKnownPublishes", "reads only"],
  ["lockEngineeringAgentMismatchAmuxRows", "takes AMUX row locks before the audit chain; writes nothing"],
  ["lockEngineeringAgentV22Run", "takes a run row lock after AMUX locks; writes nothing"],
  ["requireEngineeringAgentRunAdmission", "reads only; the run it admits is audited"],
  ["acceptEngineeringAgentRequest", "idempotency bookkeeping for a request whose own change is audited"],
  ["moveEngineeringAgentRequest", "idempotency bookkeeping for a request whose own change is audited"],
  ["heartbeatEngineeringAgentRun", "a lease extension; the run's start and end are audited"],
]);

test("every exported write takes the engineering transaction and records its audit entry in it", () => {
  const names = [];
  for (const fn of exportedFunctions()) {
    const name = fn.name.getText(tree);
    names.push(name);
    const body = fn.body.getText(tree);
    if (UNAUDITED.has(name)) continue;
    const first = fn.parameters[0];
    assert.ok(first, `${name} takes a client`);
    assert.equal(first.type.getText(tree), "EngineeringAgentTransaction", `${name} takes the engineering transaction`);
    // A function that delegates its one write to another export inherits that audit entry.
    assert.match(
      body,
      /\b(?:systemAudit|writeAdminAuditLog|claimEngineeringAgentWorkItem|openEngineeringAgentWorkItem|settleEngineeringAgentWorkItem)\(/,
      `${name} writes its audit entry`,
    );
  }
  for (const name of UNAUDITED.keys()) assert.ok(names.includes(name), `${name} is still exported`);
  assert.ok(names.length > UNAUDITED.size + 10, "the writer's functions were found");
});

// Every export sits in exactly one of these: it reads the switches before it
// writes, or it records something that already happened and is never refused
// by a switch. A new export that is in neither fails here until it is placed.
const SWITCHED = [
  "recordEngineeringAgentRunStart",
  "recordEngineeringAgentRegistration",
  "requireEngineeringAgentRunAdmission",
  "claimNextEngineeringAgentPublishWork",
  "openEngineeringAgentWorkItem",
  "claimEngineeringAgentWorkItem",
  "markEngineeringAgentWorkItemLeaseExpired",
  "expireEngineeringAgentWorkItem",
  "issueEngineeringAgentCapability",
  "moveEngineeringAgentBinding",
  "recordEngineeringAgentBindingObservation",
  "removeEngineeringAgentReviewer",
];
const RECORDS_WHAT_HAPPENED = [
  "runEngineeringAgentTransaction",
  "engineeringAgentTransactionInAmux",
  "readEngineeringAgentSwitches",
  "readEngineeringAgentHaltState",
  "readEngineeringAgentOwnerQueues",
  "readEngineeringAgentRegistrationCounts",
  "readEngineeringAgentKnownPublishes",
  "lockEngineeringAgentMismatchAmuxRows",
  "lockEngineeringAgentV22Run",
  "resolveEngineeringAgentStateMismatch",
  "recordEngineeringAgentObservedHalt",
  "openEngineeringAgentRunMismatches",
  "recordEngineeringAgentPublishResult",
  "recordEngineeringAgentRegistrationReadBack",
  "acknowledgeEngineeringAgentHalt",
  "recordEngineeringAgentMonitorsConfirmed",
  "recordEngineeringAgentServiceFinish",
  "acceptEngineeringAgentRequest",
  "moveEngineeringAgentRequest",
  "heartbeatEngineeringAgentRun",
  "endEngineeringAgentRun",
  "settleEngineeringAgentWorkItem",
  "decideEngineeringAgentT2Draft",
  "acknowledgeEngineeringAgentDecision",
  "setEngineeringAgentSwitch",
  "recordEngineeringAgentBinding",
  "replaceEngineeringAgentBinding",
];

test("every claim, capability, publish and maintenance write reads the switches first", () => {
  const names = exportedFunctions().map((fn) => fn.name.getText(tree));
  assert.deepEqual([...names].sort(), [...SWITCHED, ...RECORDS_WHAT_HAPPENED].sort());
  for (const fn of exportedFunctions()) {
    const name = fn.name.getText(tree);
    const body = fn.body.getText(tree);
    if (SWITCHED.includes(name)) {
      assert.match(body, /await requireSwitch\(tx, /, `${name} reads the switches`);
    } else {
      assert.doesNotMatch(body, /requireSwitch\(/, `${name} records what happened and is not refused by a switch`);
    }
  }
});

test("the store names no target state for a result; the core decides it", () => {
  const settle = exportedFunctions().find((fn) => fn.name.getText(tree) === "settleEngineeringAgentWorkItem");
  assert.ok(settle);
  const parameters = settle.parameters.map((parameter) => parameter.type.getText(tree)).join(" ");
  assert.doesNotMatch(parameters, /\bto\b|\bstate\b/);
  assert.match(settle.body.getText(tree), /resultTarget\(/);
});

test("a binding snapshot is strict and names no person", () => {
  const snapshot = {
    baseSha: "a".repeat(40),
    diffDigest: "b".repeat(64),
    treeId: "c".repeat(40),
    invalidatedReviewIds: [12, 13],
  };
  assert.equal(engineeringAgentBindingSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(engineeringAgentBindingSnapshotSchema.safeParse({ ...snapshot, reviewerLogin: "someone" }).success, false);
  assert.equal(engineeringAgentBindingSnapshotSchema.safeParse({ ...snapshot, baseSha: "main" }).success, false);
});

test("an approval observation is a verdict with its review, and never the reviewer's identity", () => {
  const approved = {
    verdict: "approved",
    reviewId: 7,
    reviewCommitId: "d".repeat(40),
    submittedAt: "2026-09-28T01:02:03.000Z",
    observedAt: "2026-09-28T01:03:03.000Z",
  };
  assert.equal(engineeringAgentApprovalObservationSchema.safeParse(approved).success, true);
  for (const identity of [{ reviewerGithubId: 60078951 }, { reviewerLogin: "mposition" }]) {
    assert.equal(engineeringAgentApprovalObservationSchema.safeParse({ ...approved, ...identity }).success, false);
  }
  assert.equal(
    engineeringAgentApprovalObservationSchema.safeParse({
      verdict: "not_approved",
      reason: "snapshot_changed",
      observedAt: "2026-09-28T01:03:03.000Z",
    }).success,
    true,
  );
  assert.equal(
    engineeringAgentApprovalObservationSchema.safeParse({
      verdict: "not_approved",
      reason: "looked fine to me",
      observedAt: "2026-09-28T01:03:03.000Z",
    }).success,
    false,
    "a reason is an enum, never free text",
  );
  assert.equal(
    engineeringAgentApprovalObservationSchema.safeParse({ verdict: "undetermined", observedAt: "2026-09-28T01:03:03.000Z" })
      .success,
    false,
    "an undetermined reading is not recorded",
  );
});

test("a merge observation names the kind of merger, never who, and a merge has a commit and a time", () => {
  const merged = {
    merged: true,
    mergeCommitSha: "e".repeat(40),
    mergedAt: "2026-09-28T02:00:00.000Z",
    mergedByKind: "user",
    observedAt: "2026-09-28T02:01:00.000Z",
  };
  assert.equal(engineeringAgentMergeObservationSchema.safeParse(merged).success, true);
  assert.equal(engineeringAgentMergeObservationSchema.safeParse({ ...merged, mergedBy: "mposition" }).success, false);
  assert.equal(engineeringAgentMergeObservationSchema.safeParse({ ...merged, mergeCommitSha: null }).success, false);
  assert.equal(
    engineeringAgentMergeObservationSchema.safeParse({
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      mergedByKind: "unknown",
      observedAt: "2026-09-28T02:01:00.000Z",
    }).success,
    true,
  );
});

const settingsDb = (rows) => ({
  appSetting: {
    findMany: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  },
});

test("the switches are read from AppSetting, and an unreadable read is off and frozen", async () => {
  const on = await readEngineeringAgentSwitches(
    settingsDb([
      { key: ENGINEERING_AGENT_MODE_SETTING_KEY, value: "t1" },
      { key: ENGINEERING_AGENT_FREEZE_SETTING_KEY, value: "false" },
    ]),
    {},
  );
  assert.equal(on.mode, "t1");
  assert.equal(on.frozen, false);
  assert.equal(on.publishAllowed, true);

  const unreadable = await readEngineeringAgentSwitches(settingsDb(new Error("connection refused")), {});
  assert.equal(unreadable.mode, "off");
  assert.equal(unreadable.frozen, true);
  assert.equal(unreadable.claimAllowed, false);

  const killed = await readEngineeringAgentSwitches(
    settingsDb([{ key: ENGINEERING_AGENT_MODE_SETTING_KEY, value: "t1" }]),
    { [ENGINEERING_AGENT_KILL_SWITCH_ENV]: "1" },
  );
  assert.equal(killed.mode, "off");
  assert.equal(killed.claimAllowed, false);

  const unset = await readEngineeringAgentSwitches(settingsDb([]), {});
  assert.equal(unset.mode, "off");
});
