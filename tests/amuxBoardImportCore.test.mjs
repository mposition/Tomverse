import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { computeAdminAuditEntryHash } from "../lib/adminAuditIntegrityCore.ts";
import { ADMIN_SEARCHABLE_PAGES, resolveAdminPageMeta } from "../lib/adminNavigation.ts";
import {
  BOARD_IMPORT_APPLY_CODE_LATCH,
  BOARD_IMPORT_MAX_ITEMS,
  BOARD_IMPORT_APPROVAL_STATUSES,
  BOARD_IMPORT_PREVIEW_LIMIT,
  BOARD_IMPORT_PREVIEW_WINDOW_MS,
  BOARD_IMPORT_RAW_BODY_MAX_BYTES,
  BOARD_IMPORT_SCANNER_RULESET,
  BOARD_IMPORT_SCANNER_RULESET_DIGEST,
  BOARD_IMPORT_SNAPSHOT_KEYS,
  admitBoardImportPreview,
  boardImportApplyPermitted,
  boardImportAuditEntryHashMatches,
  boardImportCardData,
  boardImportCardWrites,
  BOARD_IMPORT_CONFLICT_REASON_CODES,
  boardImportConflictLedger,
  boardImportConflictReasons,
  boardImportContentTypeAccepted,
  boardImportFailureIsAmbiguous,
  boardImportItemBindingsDigest,
  boardImportItemBindings,
  boardImportItemsFromBindings,
  boardImportSameOperatorApproval,
  boardImportSourceMissing,
  boardImportSourcePresenceFromRows,
  boardImportSourcePresenceQuery,
  boardImportSourceSnapshot,
  boardImportSubmissionRefusal,
  boardImportTransitionAllowed,
  classifyBoardImport,
  digestAmuxManifest,
  parseBoardImportItemBindings,
  parseBoardImportManifest,
  pruneBoardImportPreviewHits,
} from "../lib/amux/boardImportCore.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const COMMIT = "a".repeat(40);
const BOARD = "b".repeat(64);

const item = (sourceKey, extras = {}) => ({
  sourceSystem: "example_board",
  sourceKey,
  sourceVersion: COMMIT,
  sourceDigest: createHash("sha256").update(sourceKey, "utf8").digest("hex"),
  sectionCode: "investment",
  executionBrief: null,
  mode: "catalog_only",
  exclude: false,
  ...extras,
});

const signed = (items, sourceExtras = {}) => {
  const body = {
    canonicalizationVersion: "amux-json-v1",
    manifestDigest: "",
    policyVersion: 2,
    scannerVersion: "amux-board-content-scan-v1",
    scannerRulesetDigest: BOARD_IMPORT_SCANNER_RULESET_DIGEST,
    plannerVersion: "amux-board-planner-v2",
    validatorVersion: "amux-board-validator-v1",
    source: {
      commit: COMMIT,
      boardDigest: BOARD,
      verificationMode: "operator_attested",
      activeItemCount: items.filter((entry) => !entry.exclude).length,
      sectionCount: new Set(items.map((entry) => entry.sectionCode)).size,
      recommendationReferenceCount: 6,
      ...sourceExtras,
    },
    items,
  };
  body.manifestDigest = digestAmuxManifest(body);
  return JSON.stringify(body);
};

const parsed = (items, sourceExtras) => {
  const result = parseBoardImportManifest(signed(items, sourceExtras));
  assert.equal(result.ok, true, result.ok ? "" : result.code);
  return result;
};

test("the scanner ruleset digest is the hash of the frozen ruleset text", () => {
  assert.equal(
    BOARD_IMPORT_SCANNER_RULESET_DIGEST,
    createHash("sha256").update(BOARD_IMPORT_SCANNER_RULESET, "utf8").digest("hex"),
  );
});

test("a catalog manifest parses and does not keep a free-text title", () => {
  const result = parsed([item("CHAT-01"), item("SEC-02", { sectionCode: "security_operations", sourceSystem: "second_board" })]);
  assert.equal(result.manifest.items.length, 2);
  assert.equal(result.manifest.source.sectionCount, 2);
  assert.equal(result.manifest.source.recommendationReferenceCount, 6);
  assert.equal(result.rawBodyDigest.length, 64);
});

test("titles, paths, urls, private paths and undesignated digests are refused without an echo", () => {
  const raw = signed([item("CHAT-01")]);
  const titled = raw.replace('"mode":"catalog_only"', '"mode":"catalog_only","title":"secret plan"');
  // The replacement changes the digest and adds a forbidden key. Content wins.
  const titledResult = parseBoardImportManifest(titled);
  assert.equal(titledResult.ok, false);
  assert.equal(titledResult.code, "content_refused");
  assert.equal(JSON.stringify(titledResult).includes("secret plan"), false);

  const withUrl = signed([item("CHAT-01")]).replace(
    "amux-board-planner-v2",
    "https://example.test/secret",
  );
  assert.equal(parseBoardImportManifest(withUrl).code, "content_refused");

  const withPath = signed([item("CHAT-01")]).replace("amux-board-validator-v1", "C:\\\\secret\\\\plan");
  assert.equal(parseBoardImportManifest(withPath).code, "content_refused");
});

test("server verification and a rank label are not accepted", () => {
  const raw = signed([item("CHAT-01")]).replace("operator_attested", "server_verified");
  assert.equal(parseBoardImportManifest(raw).code, "source_verification_refused");
  const ranked = signed([{ ...item("CHAT-01"), sourcePriorityLabel: "p0" }]);
  assert.equal(parseBoardImportManifest(ranked).code, "content_refused");
});

test("product source keys are tighter than the database pattern", () => {
  for (const sourceKey of ["CHAT.01", "CHAT_01", "CHAT:01", "chat-01"]) {
    const result = parseBoardImportManifest(signed([item(sourceKey)]));
    assert.equal(result.ok, false, sourceKey);
    assert.equal(result.code, "schema_rejected");
  }
});

test("digest mismatch, empty, overflow and a bad ruleset are refused", () => {
  const raw = signed([item("CHAT-01")]);
  const body = JSON.parse(raw);
  body.manifestDigest = `${"d".repeat(63)}e`;
  assert.equal(parseBoardImportManifest(JSON.stringify(body)).code, "digest_mismatch");
  assert.equal(parseBoardImportManifest(signed([])).code, "empty_manifest");
  assert.equal(parseBoardImportManifest("x".repeat(BOARD_IMPORT_RAW_BODY_MAX_BYTES + 1)).code, "too_large");
  body.manifestDigest = digestAmuxManifest({ ...body, scannerRulesetDigest: "e".repeat(64) });
  body.scannerRulesetDigest = "e".repeat(64);
  assert.equal(parseBoardImportManifest(JSON.stringify(body)).code, "scanner_mismatch");
});

test("classification separates create, no-op, conflict and exclude, and a refusal writes no cards", () => {
  const manifest = parsed([
    item("CHAT-01"),
    item("CHAT-02"),
    item("CHAT-03"),
    item("CHAT-04", { exclude: true }),
  ]).manifest;
  const digest = manifest.items[0].sourceDigest;
  const classification = classifyBoardImport(manifest, [
    {
      sourceSystem: "example_board",
      sourceKey: "CHAT-02",
      sourceVersion: COMMIT,
      sourceDigest: manifest.items[1].sourceDigest,
      sourceSnapshot: boardImportSourceSnapshot(manifest.items[1], manifest),
      status: "backlog",
      owner: null,
      claimedAt: null,
      attemptCount: 0,
      deliveryCount: 0,
      routeDecisionCount: 0,
    },
    {
      sourceSystem: "example_board",
      sourceKey: "CHAT-03",
      sourceVersion: COMMIT,
      sourceDigest: digest,
      sourceSnapshot: null,
      status: "todo",
      owner: "someone",
      claimedAt: "2026-09-22T00:00:00.000Z",
      attemptCount: 1,
      deliveryCount: 1,
      routeDecisionCount: 1,
    },
  ]);
  assert.deepEqual(classification.create, ["example_board:CHAT-01"]);
  assert.deepEqual(classification.noOp, ["example_board:CHAT-02"]);
  assert.deepEqual(classification.conflict, ["example_board:CHAT-03"]);
  assert.deepEqual(classification.exclude, ["example_board:CHAT-04"]);
  assert.equal(boardImportSubmissionRefusal(classification), "excluded_item");
  assert.deepEqual(boardImportCardWrites(manifest, classification), []);
});

test("drift and an active execution are counted apart and do not change the refusal", () => {
  const manifest = parsed([item("CHAT-01"), item("CHAT-02"), item("CHAT-03"), item("CHAT-04")]).manifest;
  const matched = (sourceKey, itemIndex, patch) => ({
    sourceSystem: "example_board",
    sourceKey,
    sourceVersion: COMMIT,
    sourceDigest: manifest.items[itemIndex].sourceDigest,
    sourceSnapshot: boardImportSourceSnapshot(manifest.items[itemIndex], manifest),
    status: "backlog",
    owner: null,
    claimedAt: null,
    attemptCount: 0,
    deliveryCount: 0,
    routeDecisionCount: 0,
    ...patch,
  });
  const existing = [
    matched("CHAT-01", 0, { sourceDigest: "a".repeat(64), sourceSnapshot: null }),
    matched("CHAT-02", 1, { claimedAt: "2026-09-22T00:00:00.000Z", attemptCount: 1 }),
    matched("CHAT-03", 2, { status: "todo", owner: "someone" }),
    matched("CHAT-04", 3, {
      sourceDigest: "b".repeat(64),
      sourceSnapshot: null,
      claimedAt: "2026-09-22T00:00:00.000Z",
      attemptCount: 1,
    }),
  ];
  assert.deepEqual(boardImportConflictReasons(manifest, existing), {
    sourceDrift: 2,
    activeExecution: 2,
    otherConflict: 1,
  });
  assert.deepEqual(boardImportConflictLedger(manifest, existing), [
    { key: "example_board:CHAT-01", reasons: ["source_drift"] },
    { key: "example_board:CHAT-02", reasons: ["active_execution"] },
    { key: "example_board:CHAT-03", reasons: ["other_conflict"] },
    { key: "example_board:CHAT-04", reasons: ["active_execution", "source_drift"] },
  ]);
  const omitted = boardImportConflictLedger(manifest, [
    ...existing,
    {
      sourceSystem: "example_board",
      sourceKey: "CHAT-99",
      sourceVersion: COMMIT,
      sourceDigest: "c".repeat(64),
      sourceSnapshot: null,
      status: "todo",
      owner: "someone",
      claimedAt: "2026-09-22T00:00:00.000Z",
      attemptCount: 1,
      deliveryCount: 0,
      routeDecisionCount: 0,
    },
  ]);
  assert.equal(omitted.some((entry) => entry.key.endsWith("CHAT-99")), false);
  const ledger = boardImportConflictLedger(manifest, existing);
  assert.ok(
    ledger.every((entry) =>
      entry.reasons.every((reason) => BOARD_IMPORT_CONFLICT_REASON_CODES.includes(reason)),
    ),
  );
  const classification = classifyBoardImport(manifest, existing);
  assert.equal(classification.conflict.length, 4);
  assert.equal(boardImportSubmissionRefusal(classification), "conflict");
  assert.deepEqual(boardImportCardWrites(manifest, classification), []);
});

test("a clean create is a backlog card with a placeholder title and a closed snapshot", () => {
  const manifest = parsed([item("CHAT-01")]).manifest;
  const classification = classifyBoardImport(manifest, []);
  const [card] = boardImportCardWrites(manifest, classification);
  assert.equal(card.status, "backlog");
  assert.equal(card.kind, "unknown");
  assert.equal(card.priority, "p3");
  assert.equal(card.description, null);
  assert.equal(card.owner, null);
  assert.equal(card.claimedAt, null);
  assert.equal(card.title.startsWith("card "), true);
  assert.equal(card.title.includes("CHAT-01"), false);
  assert.ok(Buffer.byteLength(card.title, "utf8") <= 64);
  assert.deepEqual(Object.keys(card.sourceSnapshot).sort(), [...BOARD_IMPORT_SNAPSHOT_KEYS].sort());
  assert.equal("executionAttempts" in card, false);
  assert.equal("routeDecisions" in card, false);
  const again = boardImportCardData(manifest.items[0], manifest);
  assert.equal(again.title, card.title);
});

test("the presence read stops one past the cap, and a full page is not a stopped scan", async () => {
  const cap = BOARD_IMPORT_MAX_ITEMS;
  const query = boardImportSourcePresenceQuery([{ sourceSystem: "example_board" }], cap);
  assert.ok(query);
  assert.equal(query.take, cap + 1);
  const stored = (count) =>
    Array.from({ length: count }, (_, index) => ({
      sourceSystem: "example_board",
      sourceKey: `K${String(index).padStart(4, "0")}`,
    }));
  const read = async (count) => {
    const rows = await Promise.resolve(stored(count).slice(0, query.take));
    return boardImportSourcePresenceFromRows(rows, cap);
  };
  const over = await read(cap + 1);
  assert.equal(over.truncated, true);
  assert.equal(over.rows.length, cap);
  const exact = await read(cap);
  assert.equal(exact.truncated, false);
  assert.equal(exact.rows.length, cap);
  assert.equal(boardImportSourcePresenceQuery([], cap), null);
});

test("a stored row the catalog omits is reported and is not a refusal or a delete", () => {
  const manifest = parsed([item("CHAT-01")]).manifest;
  const missing = boardImportSourceMissing(manifest, [
    { sourceSystem: "example_board", sourceKey: "CHAT-01" },
    { sourceSystem: "example_board", sourceKey: "CHAT-09" },
    { sourceSystem: "example_board", sourceKey: "CHAT-09" },
    { sourceSystem: "other_board", sourceKey: "CHAT-08" },
  ]);
  assert.deepEqual(missing, ["example_board:CHAT-09"]);
  const classification = classifyBoardImport(manifest, []);
  assert.equal(boardImportSubmissionRefusal(classification), null);
  assert.deepEqual(boardImportCardWrites(manifest, classification).map((card) => card.sourceKey), ["CHAT-01"]);
});

test("item bindings round-trip into the same items without a title", () => {
  const manifest = parsed([item("CHAT-01")]).manifest;
  const bindings = boardImportItemBindings(manifest);
  assert.equal(bindings[0].executionBriefDigest, null);
  assert.equal("title" in bindings[0], false);
  assert.deepEqual(boardImportItemsFromBindings(bindings), manifest.items);
  assert.deepEqual(parseBoardImportItemBindings(bindings), bindings);
  assert.equal(parseBoardImportItemBindings([{ ...bindings[0], title: "nope" }]), null);
});

test("apply stays off unless both latches are on, and the code latch is armed", () => {
  assert.equal(BOARD_IMPORT_APPLY_CODE_LATCH, true);
  assert.equal(boardImportApplyPermitted({ envValue: "enabled", codeLatch: false }), false);
  assert.equal(boardImportApplyPermitted({ envValue: "disabled", codeLatch: true }), false);
  assert.equal(boardImportApplyPermitted({ envValue: undefined, codeLatch: true }), false);
  assert.equal(boardImportApplyPermitted({ envValue: "enabled", codeLatch: true }), true);
});

test("approval transitions and same-operator approval stay inside the v2 exception", () => {
  assert.equal(boardImportTransitionAllowed("prepared", "approved"), true);
  assert.equal(boardImportTransitionAllowed("approved", "consumed"), true);
  assert.equal(boardImportTransitionAllowed("prepared", "consumed"), false);
  assert.equal(boardImportTransitionAllowed("consumed", "approved"), false);
  assert.equal(boardImportTransitionAllowed("rejected", "approved"), false);
  assert.equal(boardImportSameOperatorApproval("operator-1", "operator-1"), true);
  assert.equal(boardImportSameOperatorApproval("operator-1", "operator-2"), false);
  assert.equal(boardImportSameOperatorApproval("", ""), false);
});

test("preview admission is ten a minute and an unknown database failure is not a retry", () => {
  const start = 1_000_000;
  let retained = [];
  for (let index = 0; index < BOARD_IMPORT_PREVIEW_LIMIT; index += 1) {
    const decision = admitBoardImportPreview(retained, start + index);
    assert.equal(decision.allowed, true);
    retained = decision.retained;
  }
  assert.equal(admitBoardImportPreview(retained, start + 10).allowed, false);
  assert.equal(
    admitBoardImportPreview(retained, start + BOARD_IMPORT_PREVIEW_WINDOW_MS).allowed,
    true,
  );
  assert.equal(boardImportFailureIsAmbiguous("P2028"), true);
  assert.equal(boardImportFailureIsAmbiguous("P2002"), false);
  const stale = start - BOARD_IMPORT_PREVIEW_WINDOW_MS - 1;
  const pruned = pruneBoardImportPreviewHits(
    [
      ["gone", [stale]],
      ["kept", [start]],
    ],
    start + 1,
  );
  assert.deepEqual(pruned, [["kept", [start]]]);
});

test("a matching digest with a different snapshot is a conflict, and a forged audit hash does not bind", () => {
  const manifest = parsed([item("CHAT-01")]).manifest;
  const snapshot = boardImportSourceSnapshot(manifest.items[0], manifest);
  const classification = classifyBoardImport(manifest, [
    {
      sourceSystem: "example_board",
      sourceKey: "CHAT-01",
      sourceVersion: COMMIT,
      sourceDigest: manifest.items[0].sourceDigest,
      sourceSnapshot: { ...snapshot, manifestDigest: "c".repeat(64) },
      status: "backlog",
      owner: null,
      claimedAt: null,
      attemptCount: 0,
      deliveryCount: 0,
      routeDecisionCount: 0,
    },
  ]);
  assert.deepEqual(classification.noOp, []);
  assert.deepEqual(classification.conflict, ["example_board:CHAT-01"]);
  const input = {
    previousHash: null,
    actorUserId: "operator-1",
    actorEmail: null,
    action: "amux.board_import.prepared",
    targetType: "AmuxBoardImportApproval",
    targetId: "approval-1",
    summary: "Prepared an AMUX catalog import.",
    metadata: { policyVersion: 2 },
    ipAddress: null,
    userAgent: null,
    createdAt: "2026-09-22T00:00:00.000Z",
  };
  const entryHash = computeAdminAuditEntryHash(input, "test-key");
  assert.equal(boardImportAuditEntryHashMatches(input, entryHash, ["test-key"]), true);
  assert.equal(boardImportAuditEntryHashMatches(input, "0".repeat(64), ["test-key"]), false);
  assert.equal(boardImportAuditEntryHashMatches(input, entryHash, []), false);
});

test("the approval table is registered, inserts no cards, and is not a user relation", () => {
  const sql = read("prisma/migrations/20260922120000_amux_board_import_approval/migration.sql");
  for (const status of BOARD_IMPORT_APPROVAL_STATUSES) assert.match(sql, new RegExp(`'${status}'`));
  assert.equal(sql.includes('INSERT INTO "AmuxWorkItem"'), false);
  assert.equal(sql.includes("REFERENCES"), false);
  const schema = read("prisma/schema.prisma");
  const start = schema.indexOf("model AmuxBoardImportApproval");
  const model = schema.slice(start, schema.indexOf("\n}", start));
  assert.equal(model.includes("@relation"), false);
  assert.equal(model.includes("itemBindingsDigest"), true);
  assert.match(sql, /"itemBindingsDigest"/);
});

test("preview does not write, apply has no caller latch, and the worker boundary is not reused", () => {
  const preview = read("lib/amux/boardImportPreview.ts");
  assert.equal(preview.includes("writeAdminAuditLog"), false);
  assert.equal(preview.includes("amuxBoardImportApproval"), false);
  assert.equal(preview.includes("$transaction"), false);
  assert.equal(preview.includes("loadBoardImportSourcePresence"), true);
  assert.equal(preview.includes("boardImportSourcePresenceQuery"), true);
  assert.equal(preview.includes("boardImportSourcePresenceFromRows"), true);
  assert.equal(preview.includes("rows.length >"), false);
  const messages = read("lib/adminMessages/amuxBoardImport.ts");
  const panel = read("components/admin/AmuxBoardImportPanel.tsx");
  assert.equal(messages.includes("sourceMissingScanStopped"), true);
  assert.equal(messages.includes("sourceMissingAllPresent"), true);
  assert.equal(panel.includes("sourceMissingAllPresent"), true);
  assert.equal(panel.includes("sourceMissingCount === 0"), true);
  assert.equal(preview.includes("deleteMany"), false);
  assert.equal(preview.includes(".delete("), false);
  const service = read("lib/amux/boardImportService.ts");
  assert.equal(service.includes("dbBoundary"), false);
  assert.equal(service.includes("withAmuxDbBoundary"), false);
  assert.equal(service.includes("adminAuditLog.create"), false);
  assert.equal(service.includes("writeAdminAuditLog"), true);
  assert.equal(service.includes("boardImportAuditEntryHashMatches"), true);
  assert.equal(service.includes("systemActor"), false);
  assert.equal(service.includes("writeBoardImportExpiryAudit"), false);
  assert.equal(service.includes("expected.marker"), false);
  assert.match(service, /sourceMissingCount: sourceMissing.length/);
  const applyBody = service.slice(service.indexOf("export async function applyBoardImport"));
  assert.equal(applyBody.includes("boardImportSourceMissing"), false);
  assert.equal(applyBody.includes("boardImportConflictReasons"), false);
  assert.equal(applyBody.includes("boardImportConflictLedger"), false);
  assert.match(service, /conflictLedger,/);
  assert.match(service, /sourceDriftCount: conflictReasons.sourceDrift/);
  assert.equal(applyBody.includes("findUnique"), false);
  assert.match(service, /boardImportItemBindingsDigest\(bindings\)/);
  assert.match(service, /digestAmuxManifest\(manifest\)/);
  assert.match(service, /signedManifest !== row\.manifestDigest/);
  assert.equal(service.includes("applyLatch"), false);
  assert.equal(service.includes("boardImportTransitionAllowed"), true);
  const core = read("lib/amux/boardImportCore.ts");
  const commentAt = core.indexOf("Ten requests a minute");
  const admitAt = core.indexOf("export const admitBoardImportPreview");
  const contentAt = core.indexOf("export const boardImportContentTypeAccepted");
  assert.ok(contentAt >= 0 && contentAt < commentAt && commentAt < admitAt);
  assert.match(service, /expireDueBoardImports[\s\S]*writeHumanAudit/);
  assert.match(service, /markBoardImportOutcomeUnknown[\s\S]*boardImportSameOperatorApproval/);
  assert.match(service, /outcomeUnknownAt: now, status: "expired", expiredAt: now/);
  assert.equal(read("lib/adminAuditSystemActors.ts").includes("amux-board-import-expiry"), false);
  assert.equal(service.includes('set_config(\'statement_timeout\''), true);
  const route = read("app/api/admin/amux/board-import/route.ts");
  assert.equal(route.includes("applyLatch"), false);
  assert.equal(route.includes("outcome_unknown"), true);
  assert.equal(route.includes("retry: false"), true);
  assert.equal(route.includes("previewHits.delete"), true);
  assert.match(route, /expireDueBoardImports\(\{[\s\S]*session:/);
  const previewBranch = route.slice(route.indexOf('if (action === "preview")'), route.indexOf('if (action === "prepare")'));
  assert.equal(previewBranch.includes("consumeApiRateLimit"), false);
  assert.ok(previewBranch.indexOf("admitBoardImportPreview") < previewBranch.indexOf("readLimitedText"));
  assert.ok(route.indexOf("boardImportContentTypeAccepted(") < route.indexOf("readLimitedText("));
  assert.equal(boardImportContentTypeAccepted("application/json"), true);
  assert.equal(boardImportContentTypeAccepted("application/json; charset=utf-8"), true);
  assert.equal(boardImportContentTypeAccepted("text/plain"), false);
  assert.equal(boardImportContentTypeAccepted(null), false);
  const manifestForDigest = parsed([item("CHAT-01")]).manifest;
  const bindings = boardImportItemBindings(manifestForDigest);
  const digest = boardImportItemBindingsDigest(bindings);
  const altered = [{ ...bindings[0], sourceDigest: "d".repeat(64) }];
  assert.equal(digest, boardImportItemBindingsDigest(bindings));
  assert.notEqual(digest, boardImportItemBindingsDigest(altered));
  assert.equal(panel.includes("adminRecentAuthenticationHref"), true);
  assert.equal(panel.includes("ADMIN_REAUTHENTICATION_REQUIRED"), true);
  assert.match(panel, /const applyReady = result\?\.applyPermitted === true && approvalId\.trim\(\)\.length > 0/);
  assert.match(panel, /disabled=\{pending \|\| !applyReady\}/);
  assert.match(panel, /applyReady \? messages\.applyPermitted\("true"\) : messages\.applyDisabled/);
  assert.match(panel, /send\("apply"/);
  const page = resolveAdminPageMeta("/admin/amux-board-import");
  assert.equal(page.label, "AMUX catalog import");
  assert.equal(page.isKnown, true);
  assert.equal(
    ADMIN_SEARCHABLE_PAGES.some((entry) => entry.href === "/admin/amux-board-import"),
    false,
  );
});
