import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ADMIN_SEARCHABLE_PAGES, resolveAdminPageMeta } from "../lib/adminNavigation.ts";
import {
  BOARD_IMPORT_SCANNER_RULESET_DIGEST,
  BOARD_IMPORT_SCANNER_VERSION,
} from "../lib/amux/boardImportCore.ts";
import {
  AMUX_RECONCILIATION_APPLY_CODE_LATCH,
  AMUX_RECONCILIATION_PRESERVED_CARD,
  amuxReconciliationApplyPermitted,
  classifySourceReconciliation,
  planAmuxReconciliation,
  previewAmuxReconciliation,
} from "../lib/amux/boardReconciliationCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const digest = (seed) => seed.padEnd(64, "a").slice(0, 64);
const item = (sourceKey, sectionCode = "investment", detail = sourceKey) => ({
  sourceKey,
  sectionCode,
  detailDigest: digest(detail),
});

const stored = [
  item("AMUX-BOARD-01"),
  item("AMUX-INTAKE-01"),
  ...Array.from({ length: 63 }, (_, index) => item(`ITEM-${index}`)),
];

test("a new board digest is one global drift and does not mark unchanged items", () => {
  const observed = stored.map((entry) => ({ ...entry }));
  const classified = classifySourceReconciliation({
    storedBoardDigest: digest("stored-board"),
    observedBoardDigest: digest("later-board"),
    storedItems: stored,
    observedItems: observed,
  });
  assert.equal(classified.globalSnapshotDrift, 1);
  assert.deepEqual(classified.itemDrift, []);
  assert.equal(classified.itemNoOp.length, 65);
  assert.deepEqual(classified.missing, []);
  assert.deepEqual(classified.extra, []);
});

test("only the two changed detail digests are item drift", () => {
  const observed = stored.map((entry) =>
    entry.sourceKey === "AMUX-BOARD-01" || entry.sourceKey === "AMUX-INTAKE-01"
      ? { ...entry, detailDigest: digest(`${entry.sourceKey}-later`) }
      : { ...entry },
  );
  const classified = classifySourceReconciliation({
    storedBoardDigest: digest("stored-board"),
    observedBoardDigest: digest("later-board"),
    storedItems: stored,
    observedItems: observed,
  });
  assert.equal(classified.globalSnapshotDrift, 1);
  assert.deepEqual(classified.itemDrift, ["AMUX-BOARD-01", "AMUX-INTAKE-01"]);
  assert.equal(classified.itemNoOp.length, 63);
  assert.equal(classified.itemNoOp.includes("AMUX-BOARD-01"), false);
  assert.equal(classified.itemNoOp.includes("AMUX-INTAKE-01"), false);
});

test("a missing key and an extra key stay out of the no-op list", () => {
  const observed = stored.filter((entry) => entry.sourceKey !== "ITEM-0");
  observed.push(item("NEW-ITEM"));
  const classified = classifySourceReconciliation({
    storedBoardDigest: digest("same"),
    observedBoardDigest: digest("same"),
    storedItems: stored,
    observedItems: observed,
  });
  assert.equal(classified.globalSnapshotDrift, 0);
  assert.deepEqual(classified.missing, ["ITEM-0"]);
  assert.deepEqual(classified.extra, ["NEW-ITEM"]);
  assert.equal(classified.itemNoOp.length, 64);
});

test("an accepted revision preserves the backlog card and the latch still needs the environment", () => {
  assert.equal(AMUX_RECONCILIATION_APPLY_CODE_LATCH, true);
  assert.equal(amuxReconciliationApplyPermitted("enabled"), true);
  assert.equal(amuxReconciliationApplyPermitted("true"), false);
  assert.equal(amuxReconciliationApplyPermitted(undefined), false);
  assert.deepEqual(AMUX_RECONCILIATION_PRESERVED_CARD, {
    status: "backlog",
    kind: "unknown",
    priority: "p3",
    owner: null,
    claimedAt: null,
  });
});

const version = (char) => char.repeat(40);
const hex = (char) => char.repeat(64);
const fullItem = (sourceKey, detailChar, sectionCode = "investment", versionChar = "a") => ({
  sourceKey,
  sectionCode,
  detailDigest: hex(detailChar),
  sourceVersion: version(versionChar),
});

const reconciliationBody = ({ storedItems, observedItems, decisions, boardStored = "1", boardObserved = "2" }) =>
  JSON.stringify({
    canonicalizationVersion: "amux-json-v1",
    sourceCommit: version("c"),
    manifestDigest: hex("d"),
    scannerRulesetDigest: BOARD_IMPORT_SCANNER_RULESET_DIGEST,
    scannerVersion: BOARD_IMPORT_SCANNER_VERSION,
    plannerVersion: "amux-board-planner-v2",
    validatorVersion: "amux-board-validator-v1",
    sectionCount: 4,
    stored: { boardDigest: hex(boardStored), items: storedItems },
    observed: { boardDigest: hex(boardObserved), items: observedItems },
    decisions,
  });

const driftedPair = () => {
  const storedItems = [
    fullItem("AMUX-BOARD-01", "a"),
    fullItem("AMUX-INTAKE-01", "b"),
    fullItem("ITEM-0", "e"),
  ];
  const observedItems = [
    fullItem("AMUX-BOARD-01", "f", "investment", "b"),
    fullItem("AMUX-INTAKE-01", "c", "investment", "b"),
    fullItem("ITEM-0", "e"),
  ];
  const decisions = [
    { sourceKey: "AMUX-BOARD-01", decision: "accept_new_source_revision" },
    { sourceKey: "AMUX-INTAKE-01", decision: "reject" },
  ];
  return { storedItems, observedItems, decisions };
};

test("each drifted key needs its own decision and preview writes nothing", () => {
  const body = reconciliationBody(driftedPair());
  const planned = planAmuxReconciliation(body);
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.globalSnapshotDrift, 1);
  assert.equal(planned.itemDriftCount, 2);
  assert.equal(planned.noOpCount, 1);
  assert.equal(planned.audit.acceptCount, 1);
  assert.equal(planned.audit.rejectCount, 1);
  assert.equal(JSON.stringify(planned.audit).includes("AMUX-BOARD-01"), false);
  assert.equal(JSON.stringify(planned.revisions).includes("todo"), false);
  assert.deepEqual(
    planned.revisions.map((entry) => entry.decision),
    ["accept_new_source_revision", "reject"],
  );
  const preview = previewAmuxReconciliation(body, "enabled");
  assert.equal(preview.outcome, "preview");
  assert.equal(preview.writes, 0);
  assert.equal(preview.applyPermitted, true);
  assert.equal(preview.inactive, false);
  assert.deepEqual(preview.acceptKeys, ["AMUX-BOARD-01"]);
  assert.deepEqual(preview.rejectKeys, ["AMUX-INTAKE-01"]);
  assert.equal(previewAmuxReconciliation(body, undefined).applyPermitted, false);
  assert.equal(previewAmuxReconciliation(body, undefined).inactive, true);
  assert.equal(previewAmuxReconciliation(body, "true").applyPermitted, false);
});

test("a missing decision and a decision on a no-op both refuse without a write", () => {
  const pair = driftedPair();
  const missing = planAmuxReconciliation(
    reconciliationBody({ ...pair, decisions: [pair.decisions[0]] }),
  );
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.code, "decision_required");
  assert.equal(missing.writes, 0);
  const notDrift = planAmuxReconciliation(
    reconciliationBody({
      ...pair,
      decisions: [...pair.decisions, { sourceKey: "ITEM-0", decision: "reject" }],
    }),
  );
  assert.equal(notDrift.ok, false);
  if (notDrift.ok) return;
  assert.equal(notDrift.code, "decision_not_drift");
  assert.equal(notDrift.writes, 0);
});

test("a title in the reconciliation body is refused by the catalog scanner", () => {
  const parsed = JSON.parse(reconciliationBody(driftedPair()));
  parsed.title = "card";
  const planned = planAmuxReconciliation(JSON.stringify(parsed));
  assert.equal(planned.ok, false);
  if (planned.ok) return;
  assert.equal(planned.code, "content_refused");
  assert.equal(planned.writes, 0);
});

test("global digest drift with no item drift is a run with zero revisions", () => {
  const storedItems = [fullItem("ITEM-0", "e")];
  const planned = planAmuxReconciliation(
    reconciliationBody({ storedItems, observedItems: storedItems, decisions: [] }),
  );
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.equal(planned.globalSnapshotDrift, 1);
  assert.equal(planned.itemDriftCount, 0);
  assert.equal(planned.revisions.length, 0);
  assert.equal(planned.noOpCount, 1);
});

test("the public apply path checks the shipped latch before the commit", () => {
  const core = read("lib/amux/boardReconciliationCore.ts");
  const service = read("lib/amux/boardReconciliation.ts");
  const route = read("app/api/admin/amux/reconciliation/route.ts");
  const panel = read("components/admin/AmuxReconciliationPanel.tsx");
  const apply = service.slice(service.indexOf("export async function applyAmuxReconciliation"));
  const permit = apply.indexOf("amuxReconciliationApplyPermitted");
  const opened = apply.indexOf("prisma.$transaction");
  assert.equal(permit >= 0 && opened > permit, true);
  assert.equal(core.includes("AMUX_RECONCILIATION_APPLY_CODE_LATCH = true"), true);
  assert.equal(core.includes("codeLatch: true"), false);
  assert.equal(service.includes("codeLatch: true"), false);
  assert.equal(service.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.match(service, /SET "acceptedSourceRevisionId"/);
  assert.equal(service.includes('"sourceDigest" ='), false);
  assert.equal(route.includes("commitAmuxReconciliation"), false);
  assert.equal(route.includes("codeLatch: true"), false);
  assert.match(panel, /applyReady = result\?\.applyPermitted === true/);
  assert.match(panel, /disabled=\{pending \|\| !applyReady\}/);
  assert.match(panel, /applyReady \? messages\.applyPermitted : messages\.applyDisabled/);
  assert.match(panel, /ADMIN_REAUTHENTICATION_REQUIRED/);
  assert.match(panel, /adminRecentAuthenticationHref/);
  const page = resolveAdminPageMeta("/admin/amux-reconciliation");
  assert.equal(page.label, "AMUX source reconciliation");
  assert.equal(page.isKnown, true);
  assert.equal(ADMIN_SEARCHABLE_PAGES.some((entry) => entry.href === "/admin/amux-reconciliation"), false);
});
