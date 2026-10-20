import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { dmAdminAttentionKind } from "../lib/amux/decisionMakerAdminCore.ts";
import { dmAdminRequestDetailHref, DM_ADMIN_REQUEST_LIST_HREF } from "../lib/amux/decisionMakerAdminHrefs.ts";

/**
 * AMUX Decision Maker requests that wait on a person are judged in
 * AMUX › Execution: pinned to the top of the Cards board's attention lane,
 * counted in the Execution badge, and opened as a side panel (?dmRequest=)
 * on any Execution tab. Operations settings › Decision Maker keeps the
 * switches, the report and the history, and its old request address
 * redirects to the panel.
 */

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const NOW = Date.UTC(2026, 9, 19, 6, 0, 0);

const row = (overrides = {}) => ({
  requestId: "0b6f2a3e-5d1c-4e8f-9a7b-2c3d4e5f6a7b",
  cardId: "CR-7",
  questionRevision: 2,
  askingWorkerId: "claude-impl",
  askingProvider: "claude",
  route: "dm_proposal",
  instance: "decision-maker-openai",
  refusalCodes: [],
  createdAtMs: NOW - 12 * 60_000,
  assignmentDeadlineAtMs: NOW - 10 * 60_000,
  assigned: true,
  snapshotState: "worker_head",
  transmitOutcome: "receipt",
  resultKind: null,
  resultUnknown: false,
  closingKind: null,
  outputKind: null,
  irreversible: null,
  declarationAccuracy: null,
  delivered: false,
  deliveryOutcome: null,
  deliveryNotSentReason: null,
  deliveryResolution: null,
  cleanupUnknownAtMs: null,
  ...overrides,
});

const proposal = { resultKind: "proposal", outputKind: "select", irreversible: true };
const confirmed = { ...proposal, closingKind: "confirm", declarationAccuracy: "not_judged", delivered: true };

test("an open proposal and an unknown delivery wait on a person; nothing else does", () => {
  assert.equal(dmAdminAttentionKind(row(proposal), NOW), "proposal");
  assert.equal(dmAdminAttentionKind(row({ ...confirmed, deliveryOutcome: "unknown" }), NOW), "delivery_unknown");
  // Running, closed, delivered, resolved, or kept with the operator: not here.
  for (const overrides of [
    {},
    { resultKind: "escalate", outputKind: "escalate" },
    { resultKind: "timeout" },
    { ...confirmed },
    { ...confirmed, deliveryOutcome: "receipt" },
    { ...confirmed, deliveryOutcome: "unknown", deliveryResolution: "delivered" },
    { ...confirmed, deliveryOutcome: "not_sent", deliveryNotSentReason: "question_changed" },
    { ...proposal, closingKind: "reject", declarationAccuracy: "not_judged" },
    { route: "operator", instance: null, assigned: false, snapshotState: null, transmitOutcome: null },
  ]) {
    assert.equal(dmAdminAttentionKind(row(overrides), NOW), null, JSON.stringify(overrides));
  }
});

test("one request opens as a side panel over Execution; the history stays in settings", () => {
  assert.equal(dmAdminRequestDetailHref("a b"), "/admin/amux-execution?dmRequest=a%20b");
  assert.equal(DM_ADMIN_REQUEST_LIST_HREF, "/admin/amux-settings?tab=decision-maker");
  const settings = read("app/(site)/(application)/admin/amux-settings/page.tsx");
  // The old address keeps working.
  assert.match(settings, /if \(typeof query\.request === "string"\) redirect\(dmAdminRequestDetailHref\(query\.request\)\);/);
  assert.doesNotMatch(settings, /AmuxDecisionMakerRequestDetailPanel|readDecisionMakerRequestDetailForAdmin/);
  assert.match(settings, /<AmuxDecisionMakerWorkPointer /);
});

test("Execution reads the waiting requests for its board and opens the panel on every tab", () => {
  const page = read("app/(site)/(application)/admin/amux-execution/page.tsx");
  // Bodies only for a reader who may judge; a failed read is null, never an empty lane.
  assert.match(page, /readDecisionMakerAttentionForAdmin\(\{ withBodies: canJudge \}\)\.catch\(\(\) => null\)/);
  assert.match(page, /const canJudge = hasAdminPermission\(session, "ops:write"\);/);
  assert.match(page, /if \(!canJudge\) return \{ kind: "restricted" \};/);
  assert.match(page, /decisionMaker=\{decisionMaker\}/);
  assert.equal(page.match(/\{drawer\}/g)?.length, 2, "cards and assignment each render the panel");
  assert.match(page, /countDecisionMakerAttention\(\)\.catch\(\(\) => null\)/);

  const workspace = read("components/admin/AmuxExecutionWorkspace.tsx");
  // The lane's count includes the requests, and a failed read says so.
  assert.match(workspace, /const laneCount = board\.counts\[lane\] \+ \(attention \? dmTotal : 0\);/);
  assert.match(workspace, /attention && decisionMaker === null && <p role="alert"/);
  assert.match(workspace, /\/admin\/amux-execution\?tab=cards&dmRequest=/);
  // The board is the console palette, so the Admin theme remaps it too.
  const css = read("components/admin/AmuxExecutionWorkspace.module.css");
  assert.doesNotMatch(css.slice(0, css.indexOf("color: var(--amux-text);")), /#[0-9a-f]{3,8}\b/i);
});

test("the panel is modal while open and closes by navigating", () => {
  const drawer = read("components/admin/AmuxDecisionMakerRequestDrawer.tsx");
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /event\.key === "Escape"/);
  assert.match(drawer, /router\.push\(closeHref/);
  assert.match(drawer, /close=\{\{ href: closeHref, label: d\.close \}\}/);
});
