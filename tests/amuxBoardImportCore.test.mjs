import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { computeAdminAuditEntryHash } from "../lib/adminAuditIntegrityCore.ts";
import {
  ADMIN_LEGACY_ROUTES,
  ADMIN_SEARCHABLE_PAGES,
  adminHrefIsVisibleTo,
  adminNavItemTabs,
  resolveAdminPageMeta,
} from "../lib/adminNavigation.ts";
import {
  BOARD_IMPORT_APPROVAL_STATUSES,
  BOARD_IMPORT_SCANNER_RULESET,
  BOARD_IMPORT_SCANNER_RULESET_DIGEST,
  BOARD_IMPORT_SECTION_CODES,
  BOARD_IMPORT_SNAPSHOT_KEYS,
  amuxCanonicalJson,
  amuxCatalogTextRefused,
  boardImportApplyPermitted,
  boardImportAuditEntryHashMatches,
  boardImportContentTypeAccepted,
  boardImportFailureIsAmbiguous,
  boardImportSameOperatorApproval,
  boardImportStoredSnapshot,
  boardImportTransitionAllowed,
} from "../lib/amux/boardImportCore.ts";

// The one-time catalog import was removed on 2026-11-18; this module keeps only
// what the board services still share (scanner, canonical JSON, snapshot reader,
// approval status list and the small guards).

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

test("the scanner ruleset digest is the hash of the frozen ruleset text", () => {
  assert.equal(
    BOARD_IMPORT_SCANNER_RULESET_DIGEST,
    createHash("sha256").update(BOARD_IMPORT_SCANNER_RULESET, "utf8").digest("hex"),
  );
});

test("the catalog text scanner refuses paths, urls, forbidden keys and undesignated digests", () => {
  assert.equal(amuxCatalogTextRefused({ note: "plain words" }), false);
  assert.equal(amuxCatalogTextRefused({ note: "see https://example.com/a" }), true);
  assert.equal(amuxCatalogTextRefused({ note: "C:\\Users\\someone" }), true);
  assert.equal(amuxCatalogTextRefused({ title: "a title" }), true);
  assert.equal(amuxCatalogTextRefused({ note: "a".repeat(40) }), true);
  assert.equal(amuxCatalogTextRefused({ detailDigest: "a".repeat(64) }), false);
  assert.equal(amuxCatalogTextRefused({ detailDigest: "not a digest" }), true);
});

test("canonical JSON sorts object keys and keeps array order", () => {
  assert.equal(
    amuxCanonicalJson({ b: 1, a: [2, 1], c: { z: null, y: "x" } }),
    '{"a":[2,1],"b":1,"c":{"y":"x","z":null}}',
  );
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

test("an apply permit needs both the code latch and the exact environment value", () => {
  assert.equal(boardImportApplyPermitted({ envValue: "enabled", codeLatch: false }), false);
  assert.equal(boardImportApplyPermitted({ envValue: "disabled", codeLatch: true }), false);
  assert.equal(boardImportApplyPermitted({ envValue: undefined, codeLatch: true }), false);
  assert.equal(boardImportApplyPermitted({ envValue: "enabled", codeLatch: true }), true);
});

test("an unknown database failure is ambiguous and a unique violation is not", () => {
  assert.equal(boardImportFailureIsAmbiguous("P2028"), true);
  assert.equal(boardImportFailureIsAmbiguous("P2002"), false);
});

test("only application/json with an optional utf-8 charset is accepted", () => {
  assert.equal(boardImportContentTypeAccepted("application/json"), true);
  assert.equal(boardImportContentTypeAccepted("application/json; charset=utf-8"), true);
  assert.equal(boardImportContentTypeAccepted("text/plain"), false);
  assert.equal(boardImportContentTypeAccepted(null), false);
});

test("a stored card snapshot is read only when it is closed and well formed", () => {
  const snapshot = {
    sourceKey: "CHAT-01",
    sectionCode: BOARD_IMPORT_SECTION_CODES[0],
    detailDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    policyVersion: 2,
  };
  assert.deepEqual(Object.keys(snapshot).sort(), [...BOARD_IMPORT_SNAPSHOT_KEYS].sort());
  assert.deepEqual(boardImportStoredSnapshot(snapshot), snapshot);
  assert.equal(boardImportStoredSnapshot({ ...snapshot, extra: 1 }), null);
  assert.equal(boardImportStoredSnapshot({ ...snapshot, sectionCode: "other" }), null);
  assert.equal(boardImportStoredSnapshot({ ...snapshot, policyVersion: "2" }), null);
  assert.equal(boardImportStoredSnapshot(null), null);
  assert.equal(boardImportStoredSnapshot([]), null);
});

test("a forged audit hash does not bind", () => {
  const input = {
    previousHash: null,
    actorUserId: "operator-1",
    actorEmail: null,
    action: "amux.board_promotion.prepared",
    targetType: "AmuxBoardImportApproval",
    targetId: "approval-1",
    summary: "Prepared an AMUX card promotion.",
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

test("the approval table stays registered, inserts no cards, and is not a user relation", () => {
  const sql = read("prisma/migrations/20260922120000_amux_board_import_approval/migration.sql");
  for (const status of BOARD_IMPORT_APPROVAL_STATUSES) assert.match(sql, new RegExp(`'${status}'`));
  assert.equal(sql.includes('INSERT INTO "AmuxWorkItem"'), false);
  assert.equal(sql.includes("REFERENCES"), false);
  const schema = read("prisma/schema.prisma");
  const start = schema.indexOf("model AmuxBoardImportApproval");
  const model = schema.slice(start, schema.indexOf("\n}", start));
  assert.equal(model.includes("@relation"), false);
});

test("the catalog import has no route, service, panel or switch left, and its old address still redirects", () => {
  for (const path of [
    "app/api/admin/amux/board-import/route.ts",
    "lib/amux/boardImportService.ts",
    "lib/amux/boardImportPreview.ts",
    "components/admin/AmuxBoardImportPanel.tsx",
    "lib/adminMessages/amuxBoardImport.ts",
  ]) {
    assert.equal(existsSync(join(root, path)), false, path);
  }
  const core = read("lib/amux/boardImportCore.ts");
  assert.equal(core.includes("TOMVERSE_AMUX_BOARD_IMPORT_APPLY"), false);
  assert.equal(core.includes("BOARD_IMPORT_APPLY_CODE_LATCH"), false);
  // The retired address stays a redirect (bookmarks and audit links keep working).
  assert.equal(ADMIN_LEGACY_ROUTES["/admin/amux-board-import"], "/admin/amux-recovery?tab=legacy");
  const movedTo = resolveAdminPageMeta("/admin/amux-recovery");
  assert.equal(movedTo.label, "Safety & recovery");
  assert.equal(movedTo.isKnown, true);
  assert.equal(
    adminNavItemTabs("amux-recovery").find((tab) => tab.id === "legacy")?.label,
    "Legacy tools",
  );
  // The tab is listed to the owner only: every other role would receive a 404.
  for (const role of ["billing", "support", "ops", "readonly"]) {
    assert.equal(adminHrefIsVisibleTo(role, "/admin/amux-recovery?tab=legacy"), false, role);
  }
  assert.equal(
    ADMIN_SEARCHABLE_PAGES.some((entry) => entry.href === "/admin/amux-board-import"),
    false,
  );
});
