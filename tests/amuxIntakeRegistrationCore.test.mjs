import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ADMIN_SEARCHABLE_PAGES, resolveAdminPageMeta } from "../lib/adminNavigation.ts";
import { amuxIntakeDraftDigest, parseAmuxIntakeDraft } from "../lib/amux/intakeCore.ts";
import {
  AMUX_INTAKE_DRIFT_OWNERS,
  AMUX_INTAKE_UNTOUCHED_TABLES,
  classifyAmuxIntakeReadBack,
  planAmuxIntakeRegistration,
  previewAmuxIntake,
  reportAmuxIntakeDrift,
} from "../lib/amux/intakeRegistrationCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const secret = "intake-hmac-secret-at-least-32-bytes";
const taskId = "codex-turn-explicit-1";
const workDigest = "ab".repeat(32);

const draft = (overrides = {}) => ({
  canonicalizationVersion: "amux-json-v1",
  policyVersion: 1,
  explicitRegistration: true,
  sourceTaskId: taskId,
  workItem: { id: "AMUX-INTAKE-01", version: "v1", digest: workDigest },
  proposal: {
    title: "Register one intake unit",
    scope: "Owner confirms a single backlog card",
    completion: "The card stays backlog",
    priority: "p2",
  },
  ...overrides,
});

const body = (value) => JSON.stringify(value);

const confirmed = (value) => {
  const parsed = parseAmuxIntakeDraft(body(value));
  if (!parsed.ok) throw new Error(parsed.code);
  return body({ ...value, confirmationDigest: amuxIntakeDraftDigest(parsed.draft) });
};

test("a conversation that is not an explicit registration writes nothing", () => {
  const preview = previewAmuxIntake(body(draft({ explicitRegistration: false })), secret, "enabled");
  assert.equal(preview.outcome, "reject");
  assert.equal(preview.code, "implicit_registration");
  assert.equal(preview.unitCount, 0);
  assert.equal(preview.writes, 0);
  assert.equal(preview.title, null);
  assert.equal(JSON.stringify(preview).includes(taskId), false);
  const planned = planAmuxIntakeRegistration(body(draft({ explicitRegistration: false })), secret);
  assert.equal(planned.ok, false);
  assert.equal(planned.writes, 0);
});

test("preview shows one unit and asks again after the payload changes", () => {
  const waiting = previewAmuxIntake(body(draft()), secret, "enabled");
  assert.equal(waiting.outcome, "approval_required");
  assert.equal(waiting.unitCount, 1);
  assert.equal(waiting.inactive, false);
  assert.equal(waiting.applyPermitted, false);
  assert.equal(waiting.writes, 0);
  assert.equal(waiting.reconfirmRequired, true);
  assert.equal(waiting.title, "Register one intake unit");
  assert.equal(waiting.scope, "Owner confirms a single backlog card");
  assert.equal(waiting.completion, "The card stays backlog");
  assert.equal(waiting.priority, "p2");
  assert.equal(waiting.sourceVersion, "v1");
  assert.match(waiting.sourceDigest, /^[a-f0-9]{64}$/);
  assert.match(waiting.sourceKey, /^[A-Z0-9][A-Z0-9._:-]*$/);
  assert.equal(JSON.stringify(waiting).includes(taskId), false);

  const parsed = parseAmuxIntakeDraft(body(draft()));
  const stale = confirmed(draft());
  const changed = JSON.parse(stale);
  changed.proposal = { ...changed.proposal, title: "A different unit" };
  const again = previewAmuxIntake(JSON.stringify(changed), secret, undefined);
  assert.equal(again.outcome, "reject");
  assert.equal(again.code, "digest_mismatch");
  assert.equal(again.reconfirmRequired, true);
  assert.equal(again.writes, 0);
  assert.equal(again.title, "A different unit");
  assert.notEqual(again.draftDigest, parsed.ok ? amuxIntakeDraftDigest(parsed.draft) : null);

  const ready = previewAmuxIntake(confirmed(draft()), secret, "enabled");
  assert.equal(ready.outcome, "allow");
  assert.equal(ready.applyPermitted, true);
  assert.equal(ready.inactive, false);
  assert.equal(ready.writes, 0);
  assert.equal(ready.reconfirmRequired, false);
  const closed = previewAmuxIntake(confirmed(draft()), secret, undefined);
  assert.equal(closed.outcome, "allow");
  assert.equal(closed.applyPermitted, false);
  assert.equal(closed.inactive, true);
  assert.equal(closed.writes, 0);
});

test("the registration plan is one backlog card and does not touch execution or credit", () => {
  const planned = planAmuxIntakeRegistration(confirmed(draft()), secret);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.plan.card.status, "backlog");
  assert.equal(planned.plan.card.kind, "unknown");
  assert.equal(planned.plan.card.owner, null);
  assert.equal(planned.plan.card.claimedAt, null);
  assert.equal(planned.plan.card.executionBrief, null);
  assert.equal(planned.plan.draftStatus, "consumed");
  assert.equal(planned.plan.approvalStatus, "consumed");
  assert.deepEqual(Object.keys(planned.plan.audit).sort(), [
    "cardCount",
    "draftDigest",
    "policyVersion",
    "scannerVersion",
    "sourceDigest",
  ]);
  assert.equal(JSON.stringify(planned.plan.audit).includes("Register one intake unit"), false);
  assert.equal(JSON.stringify(planned.plan.card.sourceSnapshot).includes(taskId), false);
  assert.equal(planned.plan.untouched.includes("AmuxExecutionAttempt"), true);
  assert.equal(planned.plan.untouched.includes("CreditLot"), true);
  assert.deepEqual(planned.plan.untouched, AMUX_INTAKE_UNTOUCHED_TABLES);
});

test("drift keeps both digests and names the four owners", () => {
  const same = reportAmuxIntakeDrift("a".repeat(64), "a".repeat(64));
  assert.equal(same.kind, "same");
  assert.equal(same.dropped, false);
  const conflict = reportAmuxIntakeDrift("a".repeat(64), "b".repeat(64));
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.storedDigest, "a".repeat(64));
  assert.equal(conflict.observedDigest, "b".repeat(64));
  assert.equal(conflict.dropped, false);
  assert.deepEqual(conflict.owners, AMUX_INTAKE_DRIFT_OWNERS);
  assert.deepEqual(Object.keys(AMUX_INTAKE_DRIFT_OWNERS).sort(), [
    "cardRevision",
    "detailDocument",
    "governanceCutover",
    "reconciliation",
  ]);
});

test("an unclear registration is classified without writing", () => {
  const digest = "c".repeat(64);
  const empty = {
    cardDigest: null,
    matchingConsumedDrafts: 0,
    matchingConsumedApprovals: 0,
    matchingAudits: 0,
    otherIntakeRows: 0,
  };
  assert.equal(classifyAmuxIntakeReadBack(empty, digest), "absent");
  assert.equal(
    classifyAmuxIntakeReadBack(
      { ...empty, cardDigest: digest, matchingConsumedDrafts: 1, matchingConsumedApprovals: 1, matchingAudits: 1 },
      digest,
    ),
    "committed",
  );
  assert.equal(classifyAmuxIntakeReadBack({ ...empty, cardDigest: digest }, digest), "partial");
  assert.equal(classifyAmuxIntakeReadBack({ ...empty, matchingAudits: 1 }, digest), "partial");
  assert.equal(
    classifyAmuxIntakeReadBack(
      { cardDigest: digest, matchingConsumedDrafts: 1, matchingConsumedApprovals: 1, matchingAudits: 2, otherIntakeRows: 0 },
      digest,
    ),
    "partial",
  );
});

test("the public apply path checks the shipped latch before the commit", () => {
  const service = read("lib/amux/intakeRegistration.ts");
  const route = read("app/api/admin/amux/intake/route.ts");
  const panel = read("components/admin/AmuxIntakePanel.tsx");
  const readBack = service.slice(
    service.indexOf("export async function readAmuxIntakeRegistration"),
    service.indexOf("export async function applyAmuxIntakeRegistration"),
  );
  const apply = service.slice(service.indexOf("export async function applyAmuxIntakeRegistration"));
  const permit = apply.indexOf("amuxIntakeApplyPermitted");
  const commit = apply.indexOf("commitAmuxIntakeRegistration");
  const ambiguous = apply.indexOf("boardImportFailureIsAmbiguous");
  const unclear = apply.slice(ambiguous);
  assert.equal(permit >= 0 && commit > permit, true);
  assert.equal(ambiguous > commit, true);
  assert.equal(readBack.includes("$transaction"), false);
  assert.equal(readBack.includes("INSERT"), false);
  assert.equal(readBack.includes(".create("), false);
  assert.equal(readBack.includes(".update("), false);
  assert.equal(readBack.includes(".delete("), false);
  assert.equal(unclear.includes("commitAmuxIntakeRegistration"), false);
  assert.equal(unclear.includes("$transaction"), false);
  assert.equal(unclear.indexOf("readAmuxIntakeRegistration") < unclear.indexOf("AmuxIntakeOutcomeUnknownError"), true);
  assert.equal(apply.includes('code === "P2002"'), true);
  assert.equal(apply.includes('new BoardImportError("conflict", 409, approvalId)'), true);
  assert.equal(service.includes('super("outcome_unknown", 409, approvalId)'), true);
  assert.equal(unclear.includes("new AmuxIntakeOutcomeUnknownError"), true);
  assert.equal(service.includes("codeLatch: true"), false);
  assert.equal(service.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.equal(route.includes("commitAmuxIntakeRegistration"), false);
  assert.equal(route.includes("retry: false"), true);
  assert.equal(route.includes("codeLatch: true"), false);
  assert.match(panel, /registerReady = result\?\.applyPermitted === true/);
  assert.match(panel, /registerReady \? messages\.registerPermitted : messages\.registerDisabled/);
  assert.match(panel, /disabled=\{pending \|\| !registerReady\}/);
  assert.match(panel, /result\.error === "outcome_unknown"/);
  assert.match(panel, /messages\.outcomeUnknown/);
  assert.equal(panel.slice(panel.indexOf("outcome_unknown")).includes('send("register")'), false);
  assert.match(panel, /ADMIN_REAUTHENTICATION_REQUIRED/);
  assert.match(panel, /adminRecentAuthenticationHref/);
  const page = resolveAdminPageMeta("/admin/amux-intake");
  assert.equal(page.label, "AMUX intake");
  assert.equal(page.isKnown, true);
  assert.equal(ADMIN_SEARCHABLE_PAGES.some((entry) => entry.href === "/admin/amux-intake"), false);
});
