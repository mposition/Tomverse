import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ADMIN_SEARCHABLE_PAGES, resolveAdminPageMeta } from "../lib/adminNavigation.ts";
import {
  BACKLOG_METADATA_APPLY_ENV,
  BACKLOG_METADATA_AUDIT_ACTION,
  BACKLOG_METADATA_AUDIT_KEYS,
  BACKLOG_METADATA_CODE_LATCH,
  BACKLOG_METADATA_COST_MAX_MICROUSD,
  BACKLOG_METADATA_RAW_BODY_MAX_BYTES,
  BacklogMetadataConflict,
  backlogMetadataApplyPermitted,
  backlogMetadataAuditMetadata,
  backlogMetadataCardWrite,
  backlogMetadataRefusal,
  parseBacklogMetadataRequest,
} from "../lib/amux/backlogMetadataCore.ts";
import { BoardImportError } from "../lib/amux/boardImportCore.ts";
import { BOARD_PROMOTION_KINDS } from "../lib/amux/boardPromotionCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const cardId = `c${"a".repeat(24)}`;

const body = (overrides = {}) => ({
  canonicalizationVersion: "amux-json-v1",
  policyVersion: 15,
  cardId,
  expectedRevision: 2,
  kind: "code",
  priority: "p1",
  estimatedCostMicrousd: 250_000,
  ...overrides,
});

const raw = (overrides = {}) => JSON.stringify(body(overrides));

const fact = (overrides = {}) => ({
  id: cardId,
  revision: 2,
  status: "backlog",
  owner: null,
  claimedAt: null,
  archivedAt: null,
  executionBriefDigest: null,
  kind: "unknown",
  priority: "p3",
  ...overrides,
});

test("the latch is on and apply still needs the environment value exactly enabled", () => {
  assert.equal(BACKLOG_METADATA_CODE_LATCH, true);
  assert.equal(BACKLOG_METADATA_APPLY_ENV, "TOMVERSE_AMUX_BACKLOG_METADATA");
  assert.equal(backlogMetadataApplyPermitted({ envValue: "enabled", codeLatch: true }), true);
  assert.equal(
    backlogMetadataApplyPermitted({ envValue: "enabled", codeLatch: BACKLOG_METADATA_CODE_LATCH }),
    true,
  );
  assert.equal(backlogMetadataApplyPermitted({ envValue: "enabled", codeLatch: false }), false);
  assert.equal(backlogMetadataApplyPermitted({ envValue: undefined, codeLatch: true }), false);
  assert.equal(backlogMetadataApplyPermitted({ envValue: undefined, codeLatch: false }), false);
  for (const envValue of ["", "1", "true", "ENABLED", "Enabled", " enabled", "enabled ", "on"]) {
    assert.equal(backlogMetadataApplyPermitted({ envValue, codeLatch: true }), false, envValue);
  }
});

test("an exact body parses, in any key order, with a null or bounded cost", () => {
  const parsed = parseBacklogMetadataRequest(raw());
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.request, body());
  const reordered = JSON.stringify({
    estimatedCostMicrousd: 250_000,
    priority: "p1",
    kind: "code",
    expectedRevision: 2,
    cardId,
    policyVersion: 15,
    canonicalizationVersion: "amux-json-v1",
  });
  assert.deepEqual(parseBacklogMetadataRequest(reordered).request, parsed.request);
  assert.equal(parseBacklogMetadataRequest(raw({ estimatedCostMicrousd: null })).request.estimatedCostMicrousd, null);
  assert.equal(parseBacklogMetadataRequest(raw({ estimatedCostMicrousd: 0 })).ok, true);
  assert.equal(
    parseBacklogMetadataRequest(raw({ estimatedCostMicrousd: BACKLOG_METADATA_COST_MAX_MICROUSD })).ok,
    true,
  );
  assert.equal(BACKLOG_METADATA_COST_MAX_MICROUSD, 5_000_000);
  assert.equal(parseBacklogMetadataRequest(raw({ expectedRevision: 0 })).ok, true);
  for (const kind of BOARD_PROMOTION_KINDS) {
    assert.equal(parseBacklogMetadataRequest(raw({ kind })).ok, true, kind);
  }
  for (const priority of ["p0", "p1", "p2", "p3"]) {
    assert.equal(parseBacklogMetadataRequest(raw({ priority })).ok, true, priority);
  }
});

test("unknown or unlisted kinds are refused", () => {
  assert.equal(parseBacklogMetadataRequest(raw({ kind: "unknown" })).code, "kind_not_explicit");
  for (const kind of ["feature", "Code", "", 3, null]) {
    assert.equal(parseBacklogMetadataRequest(raw({ kind })).code, "schema_rejected", String(kind));
  }
});

test("priorities outside p0 to p3 are refused", () => {
  for (const priority of ["p4", "P1", "high", "", 1, null]) {
    assert.equal(parseBacklogMetadataRequest(raw({ priority })).code, "schema_rejected", String(priority));
  }
});

test("a cost outside the integer range 0 to 5,000,000 is refused", () => {
  for (const estimatedCostMicrousd of [-1, 5_000_001, 1.5, 0.1, "100", true, [], {}, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      parseBacklogMetadataRequest(raw({ estimatedCostMicrousd })).code,
      "schema_rejected",
      JSON.stringify(estimatedCostMicrousd),
    );
  }
  // Numbers that JSON cannot carry exactly never reach the integer check as integers.
  assert.equal(
    parseBacklogMetadataRequest(raw().replace('"estimatedCostMicrousd":250000', '"estimatedCostMicrousd":1e400')).code,
    "schema_rejected",
  );
});

test("an extra, missing or renamed key is refused", () => {
  assert.equal(parseBacklogMetadataRequest(raw({ status: "todo" })).code, "schema_rejected");
  assert.equal(parseBacklogMetadataRequest(raw({ owner: "worker" })).code, "schema_rejected");
  assert.equal(parseBacklogMetadataRequest(raw({ extra: 1 })).code, "schema_rejected");
  const missing = body();
  delete missing.estimatedCostMicrousd;
  assert.equal(parseBacklogMetadataRequest(JSON.stringify(missing)).code, "schema_rejected");
  const noCard = body();
  delete noCard.cardId;
  assert.equal(parseBacklogMetadataRequest(JSON.stringify(noCard)).code, "schema_rejected");
  assert.equal(parseBacklogMetadataRequest(JSON.stringify([body()])).code, "schema_rejected");
  assert.equal(parseBacklogMetadataRequest("null").code, "schema_rejected");
});

test("the header must name amux-json-v1 and policy version 15", () => {
  for (const policyVersion of [3, 7, 11, 14, 16, "15", null]) {
    assert.equal(parseBacklogMetadataRequest(raw({ policyVersion })).code, "schema_rejected", String(policyVersion));
  }
  assert.equal(parseBacklogMetadataRequest(raw({ canonicalizationVersion: "amux-json-v2" })).code, "schema_rejected");
});

test("card id and expected revision are bounded", () => {
  for (const id of ["card", `c${"A".repeat(24)}`, `c${"a".repeat(23)}`, `x${"a".repeat(24)}`, 1]) {
    assert.equal(parseBacklogMetadataRequest(raw({ cardId: id })).code, "schema_rejected", String(id));
  }
  for (const expectedRevision of [-1, 1.5, "2", 2_147_483_648, null]) {
    assert.equal(
      parseBacklogMetadataRequest(raw({ expectedRevision })).code,
      "schema_rejected",
      String(expectedRevision),
    );
  }
});

test("a path separator in any string is content_refused before the schema is read", () => {
  assert.equal(parseBacklogMetadataRequest(raw({ cardId: `c${"a".repeat(12)}/${"a".repeat(11)}` })).code, "content_refused");
  assert.equal(parseBacklogMetadataRequest(raw({ kind: "code/ops" })).code, "content_refused");
  assert.equal(parseBacklogMetadataRequest(raw({ priority: "p1/p2" })).code, "content_refused");
  assert.equal(parseBacklogMetadataRequest(raw({ canonicalizationVersion: "amux/json-v1" })).code, "content_refused");
  assert.equal(parseBacklogMetadataRequest(raw({ note: "lib/amux" })).code, "content_refused");
  assert.equal(parseBacklogMetadataRequest(raw({ kind: "see https://example.com" })).code, "content_refused");
  assert.equal(parseBacklogMetadataRequest(raw({ description: "plain" })).code, "content_refused");
  assert.equal(parseBacklogMetadataRequest(`${raw().slice(0, -1)},"x":"\u0000"}`).code, "content_refused");
  assert.equal(parseBacklogMetadataRequest("{").code, "invalid_json");
  assert.equal(
    parseBacklogMetadataRequest(" ".repeat(BACKLOG_METADATA_RAW_BODY_MAX_BYTES + 1)).code,
    "too_large",
  );
});

test("only an unowned, unarchived backlog card without a brief at the expected revision is writable", () => {
  const request = parseBacklogMetadataRequest(raw()).request;
  assert.equal(backlogMetadataRefusal(request, fact()), null);
  assert.equal(backlogMetadataRefusal(request, null), "not_found");
  assert.equal(backlogMetadataRefusal(request, fact({ id: `c${"b".repeat(24)}` })), "not_found");
  assert.equal(backlogMetadataRefusal(request, fact({ archivedAt: new Date() })), "archived");
  for (const status of ["todo", "doing", "review", "done", "blocked", "cancelled"]) {
    assert.equal(backlogMetadataRefusal(request, fact({ status })), "not_backlog", status);
  }
  assert.equal(backlogMetadataRefusal(request, fact({ owner: "worker" })), "owned");
  assert.equal(backlogMetadataRefusal(request, fact({ claimedAt: new Date() })), "owned");
  assert.equal(backlogMetadataRefusal(request, fact({ executionBriefDigest: "a".repeat(64) })), "brief_present");
  assert.equal(backlogMetadataRefusal(request, fact({ revision: 3 })), "revision_mismatch");
  const conflict = new BacklogMetadataConflict("brief_present");
  // Same class chain as every other AMUX writer error. instanceof across the
  // .mjs/.ts boundary compares two loader copies, so compare the prototype name.
  assert.equal(Object.getPrototypeOf(BacklogMetadataConflict).name, BoardImportError.name);
  assert.equal(conflict.code, "conflict");
  assert.equal(conflict.httpStatus, 409);
  assert.equal(conflict.refusal, "brief_present");
});

test("the card write is conditional and names only kind, priority, cost and revision", () => {
  const request = parseBacklogMetadataRequest(raw()).request;
  const write = backlogMetadataCardWrite(request);
  assert.deepEqual(write.where, {
    id: cardId,
    revision: 2,
    status: "backlog",
    owner: null,
    claimedAt: null,
    archivedAt: null,
    executionBriefDigest: null,
  });
  assert.deepEqual(Object.keys(write.data).sort(), ["estimatedCostMicrousd", "kind", "priority", "revision"]);
  assert.equal(write.data.kind, "code");
  assert.equal(write.data.priority, "p1");
  assert.equal(write.data.estimatedCostMicrousd, 250_000n);
  assert.deepEqual(write.data.revision, { increment: 1 });
  const cleared = backlogMetadataCardWrite(parseBacklogMetadataRequest(raw({ estimatedCostMicrousd: null })).request);
  assert.equal(cleared.data.estimatedCostMicrousd, null);
});

test("the audit metadata carries only ids, closed-list values, a cost flag and revisions", () => {
  assert.equal(BACKLOG_METADATA_AUDIT_ACTION, "amux.backlog_metadata.updated");
  const request = parseBacklogMetadataRequest(raw()).request;
  const metadata = backlogMetadataAuditMetadata(fact({ kind: "unknown", priority: "p3" }), request);
  assert.deepEqual(metadata, {
    cardId,
    previousKind: "unknown",
    kind: "code",
    previousPriority: "p3",
    priority: "p1",
    costPresent: true,
    previousRevision: 2,
    revision: 3,
  });
  assert.deepEqual(Object.keys(metadata).sort(), [...BACKLOG_METADATA_AUDIT_KEYS].sort());
  for (const key of ["title", "sourceKey", "executionBrief", "description", "estimatedCostMicrousd", "status", "owner"]) {
    assert.equal(Object.hasOwn(metadata, key), false, key);
  }
  const noCost = backlogMetadataAuditMetadata(fact(), parseBacklogMetadataRequest(raw({ estimatedCostMicrousd: null })).request);
  assert.equal(noCost.costPresent, false);
});

const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the route refuses apply before any transaction and cannot supply the latch", () => {
  const route = withoutComments(read("app/api/admin/amux/backlog-metadata/route.ts"));
  assert.equal(route.includes("CODE_LATCH"), false);
  assert.equal(route.includes("codeLatch"), false);
  assert.equal(route.includes("$transaction"), false);
  assert.equal(route.includes("@/lib/prisma"), false);
  // The exported transaction body skips the gate; only the gated apply is reachable over HTTP.
  assert.equal(route.includes("commitBacklogMetadata"), false);
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /status: 428/);
  assert.match(route, /boardImportContentTypeAccepted/);
  assert.match(route, /consumeApiRateLimit\(request, auth\.session\.user\.id, "admin-amux-backlog-metadata-apply", \{\s*minute: 10,\s*day: 100,/);
  const gate = route.indexOf("if (!backlogMetadataApplyOpen())");
  const disabled = route.indexOf('{ error: "apply_disabled" }, { status: 409');
  const apply = route.indexOf("applyBacklogMetadata({");
  const read_ = route.indexOf("readLimitedText(request, BACKLOG_METADATA_RAW_BODY_MAX_BYTES)", gate);
  assert.ok(gate > 0 && disabled > gate && apply > disabled && read_ > disabled && apply > read_);
  assert.equal(route.lastIndexOf("applyBacklogMetadata({"), apply);

  const service = withoutComments(read("lib/amux/backlogMetadataService.ts"));
  assert.match(service, /^import "server-only";/);
  assert.match(service, /codeLatch: BACKLOG_METADATA_CODE_LATCH/);
  assert.equal(service.includes("codeLatch: true"), false);
  const start = service.indexOf("export async function applyBacklogMetadata");
  const applyBody = service.slice(start);
  const refused = applyBody.indexOf('throw new BoardImportError("apply_disabled", 409)');
  const transaction = applyBody.indexOf("withBacklogMetadataTransaction(");
  assert.ok(start > 0 && refused > 0 && transaction > refused);
  const core = withoutComments(read("lib/amux/backlogMetadataCore.ts"));
  assert.match(core, /export const BACKLOG_METADATA_CODE_LATCH = true;/);
  assert.equal(core.includes("process.env"), false);
});

test("the service writes one card row and never status, owner or execution rows", () => {
  const service = withoutComments(read("lib/amux/backlogMetadataService.ts"));
  const cardCalls = [...service.matchAll(/\b\w+\.amuxWorkItem\.(\w+)\(/g)].map((match) => match[1]);
  assert.deepEqual(cardCalls.filter((method) => method !== "findUnique"), ["updateMany"]);
  // Reads select owner and status; no object literal assigns them. The one
  // other `status:` is the response body's `"updated"`, which is not a column.
  assert.equal(/\b(?:owner|claimedAt|executionBrief|executionBriefDigest):(?!\s*true\b)/.test(service), false);
  const statusFields = [...service.matchAll(/\bstatus:\s*([^,\n}]+)/g)].map((match) => match[1].trim());
  assert.deepEqual([...new Set(statusFields)].sort(), ['"updated" as const', "true"]);
  assert.match(service, /tx\.amuxWorkItem\.updateMany\(\{ where: write\.where, data: write\.data \}\)/);
  assert.match(service, /const write = backlogMetadataCardWrite\(update\);/);
  for (const forbidden of [
    "amuxExecutionAttempt",
    "amuxWorkDelivery",
    "amuxRouteDecision",
    "amuxHumanEscalation",
    "TOMVERSE_AMUX_EXECUTE",
    "lib/amux/execution",
    "$executeRawUnsafe",
    "$queryRawUnsafe",
  ]) {
    assert.equal(service.includes(forbidden), false, forbidden);
  }
  const core = withoutComments(read("lib/amux/backlogMetadataCore.ts"));
  const data = core.slice(core.indexOf("  data: {"), core.indexOf("});", core.indexOf("  data: {")));
  assert.equal(/\bstatus\b|\bowner\b|\bclaimedAt\b|\bexecutionBrief/.test(data), false);
});

test("the page is owner-only, unlisted, and offers the step-up link", () => {
  const page = read("app/(site)/(application)/admin/amux-backlog-metadata/page.tsx");
  assert.match(page, /getAdminRole\(session\) !== "owner"\) notFound\(\)/);
  const panel = read("components/admin/AmuxBacklogMetadataPanel.tsx");
  assert.match(panel, /\/api\/admin\/amux\/backlog-metadata\?action=/);
  assert.match(panel, /ADMIN_REAUTHENTICATION_REQUIRED/);
  assert.match(panel, /adminRecentAuthenticationHref\("\/admin\/amux-backlog-metadata"\)/);
  // Apply needs a preview of the exact text on screen that reported valid and permitted.
  assert.match(
    panel,
    /previewed !== null &&\s*previewed\.valid === true &&\s*previewed\.applyPermitted === true &&\s*previewed\.text === requestText/,
  );
  assert.match(panel, /disabled=\{pending \|\| !applyReady\}/);
  const meta = resolveAdminPageMeta("/admin/amux-backlog-metadata");
  assert.equal(meta.label, "AMUX backlog metadata");
  assert.equal(meta.isKnown, true);
  assert.equal(
    ADMIN_SEARCHABLE_PAGES.some((entry) => entry.href === "/admin/amux-backlog-metadata"),
    false,
  );
});
