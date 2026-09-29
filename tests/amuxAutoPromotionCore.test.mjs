import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ADMIN_LEGACY_ROUTES,
  ADMIN_SEARCHABLE_PAGES,
  adminNavItemTabs,
  adminSearchablePagesFor,
  resolveAdminPageMeta,
} from "../lib/adminNavigation.ts";
import { SYSTEM_AUDIT_ACTORS } from "../lib/adminAuditSystemActors.ts";
import { boardPromotionItemBindingsDigest } from "../lib/amux/boardPromotionCore.ts";
import { RECOMMENDATION_CODE_LATCH } from "../lib/amux/recommendationPoolCore.ts";
import {
  AUTO_COST_24H_CENTS,
  AUTO_COST_30D_CENTS,
  AUTO_COST_EVENT_CENTS,
  AUTO_EXPIRE_BATCH,
  AUTO_GRADUATION_DECISIONS,
  AUTO_GRADUATION_SPAN_MS,
  AUTO_PROMOTION_CANONICALIZATION_VERSION,
  AUTO_PROMOTION_CODE_LATCH as AUTO_LATCH,
  AUTO_PROMOTION_POLICY_VERSION,
  AUTO_PROMOTION_V8_CONSUME_POLICY_VERSION,
  AUTO_SYSTEM_ACTOR_ROW_ID,
  autoBoundItem,
  autoConsumeBindingAccepted,
  autoConsumeRequestIsBound,
  autoCostAccepted,
  autoGlobalWipAccepted,
  autoGraduationAccepted,
  autoGrantExpiresAt,
  autoGrantUsable,
  autoHaltRequired,
  autoPromotionApplyPermitted,
  autoReadbackCritical,
  autoSystemConsumeDigest,
  autoTickHttpStatus,
  autoUnknownEvents,
  autoWorkerAdmitted,
  parseAutoConsumeRequest,
  parseAutoGrantRequest,
  parseAutoResumeRequest,
} from "../lib/amux/autoPromotionCore.ts";

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-25T00:00:00.000Z");
const at = (ms) => new Date(now.getTime() + ms);

test("version 10 keeps the auto latch open and ships the recommendation latch open", () => {
  assert.equal(AUTO_LATCH, true);
  assert.equal(RECOMMENDATION_CODE_LATCH, true);
  assert.equal(autoPromotionApplyPermitted({ envValue: "enabled", codeLatch: true }), true);
  assert.equal(autoPromotionApplyPermitted({ envValue: "enabled", codeLatch: false }), false);
  assert.equal(autoPromotionApplyPermitted({ envValue: "true", codeLatch: true }), false);
  assert.equal(AUTO_GRADUATION_DECISIONS, 20);
  assert.equal(AUTO_GRADUATION_SPAN_MS, 14 * day);
  assert.equal(AUTO_COST_EVENT_CENTS, 500);
  assert.equal(AUTO_COST_24H_CENTS, 1500);
  assert.equal(AUTO_COST_30D_CENTS, 10000);
});

test("graduation needs 20 human decisions spanning 14 days", () => {
  const nineteen = Array.from({ length: 19 }, (_, index) => ({ createdAt: at(index * day) }));
  assert.equal(autoGraduationAccepted(nineteen).ok, false);
  const burst = Array.from({ length: 20 }, () => ({ createdAt: now }));
  assert.equal(autoGraduationAccepted(burst).ok, false);
  const spanned = [
    { createdAt: now },
    ...Array.from({ length: 18 }, () => ({ createdAt: at(day) })),
    { createdAt: at(14 * day) },
  ];
  assert.equal(autoGraduationAccepted(spanned).ok, true);
  const exact = [{ createdAt: now }, { createdAt: at(14 * day) }];
  while (exact.length < 20) exact.push({ createdAt: at(14 * day) });
  assert.equal(autoGraduationAccepted(exact).ok, true);
});

test("cost caps are USD cents and ordinary overages refuse before a card write", () => {
  assert.equal(autoCostAccepted({ proposedCents: 501, entries: [], now }).ok, false);
  assert.equal(autoCostAccepted({ proposedCents: 500, entries: [], now }).ok, true);
  const dayEntries = [{ amountCents: 1000, recordedAt: now }];
  assert.equal(autoCostAccepted({ proposedCents: 500, entries: dayEntries, now }).ok, true);
  assert.equal(autoCostAccepted({ proposedCents: 500, entries: [{ amountCents: 1001, recordedAt: now }], now }).ok, false);
  const old = [{ amountCents: 10000, recordedAt: at(-31 * day) }];
  assert.equal(autoCostAccepted({ proposedCents: 500, entries: old, now }).ok, true);
  const month = [{ amountCents: 9600, recordedAt: at(-day) }];
  assert.equal(autoCostAccepted({ proposedCents: 500, entries: month, now }).ok, false);
});

test("worker isolation refuses a worker id and a fourth active card without calling either a critical violation", () => {
  assert.equal(autoWorkerAdmitted(null).ok, true);
  assert.equal(autoWorkerAdmitted("worker-a").code, "worker_not_admitted");
  assert.equal(autoGlobalWipAccepted(3).code, "auto_wip_full");
  assert.equal(autoGlobalWipAccepted(2).ok, true);
  assert.deepEqual(autoReadbackCritical({
    activeCount: 4,
    ownerCounts: [2],
    costCents24h: 0,
    costCents30d: 0,
    unapprovedTodo: 0,
    lifecycleWrites: 0,
  }), ["global_wip_exceeded", "worker_cap_exceeded"]);
});

test("a grant lasts seven days and an expired grant is missing", () => {
  const expires = autoGrantExpiresAt(now);
  assert.equal(expires.getTime() - now.getTime(), 7 * day);
  assert.equal(autoGrantUsable({ status: "active", expiresAt: expires, now: at(7 * day - 1) }).ok, true);
  assert.equal(autoGrantUsable({ status: "active", expiresAt: expires, now: at(7 * day) }).code, "grant_missing");
  assert.equal(autoGrantUsable({ status: "consumed", expiresAt: expires, now }).code, "grant_missing");
});

test("one critical violation or two unknown outcomes inside 15 minutes halts", () => {
  assert.equal(autoHaltRequired({ criticalCodes: [], unknownAt: [now], now }).halt, false);
  assert.equal(autoHaltRequired({ criticalCodes: ["cost_exceeded"], unknownAt: [], now }).halt, true);
  const burst = autoHaltRequired({ criticalCodes: [], unknownAt: [at(-15 * 60 * 1000), now], now });
  assert.equal(burst.halt, true);
  assert.equal(burst.reason, "outcome_unknown_burst");
  const apart = autoHaltRequired({ criticalCodes: [], unknownAt: [at(-15 * 60 * 1000 - 1), now], now });
  assert.equal(apart.halt, false);
});

const item = {
  cardId: `c${"a".padEnd(24, "0")}`,
  classification: { complexity: 3, files_expected: 2, risk: 1, task_kind: "bugfix" },
  executionBrief: "Keep the daily job window from treating frequent jobs as delayed.",
  expectedRevision: 0,
  kind: "bug",
  priority: "p2",
  sourceDigest: "ab".repeat(32),
};
const grantId = "11111111-1111-4111-8111-111111111111";
const consumptionId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "33333333-3333-4333-8333-333333333333";
const haltId = "44444444-4444-4444-8444-444444444444";
const grantBody = (overrides = {}) => ({
  canonicalizationVersion: "amux-json-v1",
  policyVersion: 15,
  grantId,
  cardId: item.cardId,
  amountCents: 125,
  item,
  ...overrides,
});

test("a version 8 consume request is one card and a worker id is refused", () => {
  const base = {
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 8,
    grantId,
    consumptionId,
    snapshotId,
    workerId: null,
    amountCents: 0,
    item,
  };
  const parsed = parseAutoConsumeRequest(JSON.stringify(base));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.code);
  assert.equal(parsed.request.policyVersion, AUTO_PROMOTION_V8_CONSUME_POLICY_VERSION);
  assert.equal(autoConsumeRequestIsBound(parsed.request), false);
  assert.equal(parseAutoConsumeRequest(JSON.stringify({ ...base, workerId: "worker-a" })).code, "worker_not_admitted");
  assert.equal(parseAutoConsumeRequest(JSON.stringify({ ...base, items: [item, item] })).code, "one_card");
  // The version 8 grant shape (no item, no amount) is gone.
  const legacyGrant = parseAutoGrantRequest(JSON.stringify({
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 8,
    grantId,
    cardId: item.cardId,
  }));
  assert.equal(legacyGrant.ok, false);
  assert.equal(legacyGrant.code, "schema_rejected");
});

test("version 15 grant binds the item and a cent amount between 1 and 500", () => {
  assert.equal(AUTO_PROMOTION_POLICY_VERSION, 15);
  const parsed = parseAutoGrantRequest(JSON.stringify(grantBody()));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.code);
  assert.equal(parsed.request.amountCents, 125);
  assert.deepEqual(parsed.request.item, item);
  assert.equal(parsed.itemBindingsDigest, boardPromotionItemBindingsDigest([item]));
  assert.match(parsed.requestDigest, /^[a-f0-9]{64}$/);
  assert.equal(parseAutoGrantRequest(JSON.stringify(grantBody({ amountCents: 1 }))).ok, true);
  assert.equal(parseAutoGrantRequest(JSON.stringify(grantBody({ amountCents: 500 }))).ok, true);
  for (const amountCents of [0, 501, 1.5, "125", null, -1]) {
    assert.equal(parseAutoGrantRequest(JSON.stringify(grantBody({ amountCents }))).code, "schema_rejected", String(amountCents));
  }
  const withoutAmount = grantBody();
  delete withoutAmount.amountCents;
  assert.equal(parseAutoGrantRequest(JSON.stringify(withoutAmount)).code, "schema_rejected");
  assert.equal(parseAutoGrantRequest(JSON.stringify(grantBody({ cardId: `c${"b".repeat(24)}` }))).code, "schema_rejected");
  assert.equal(parseAutoGrantRequest(JSON.stringify(grantBody({ policyVersion: 8 }))).code, "schema_rejected");
  assert.equal(parseAutoGrantRequest(JSON.stringify(grantBody({ items: [item] }))).code, "one_card");
});

test("a grant item passes the same checks as a promotion item, and the whole body is scanned", () => {
  const withItem = (overrides) => parseAutoGrantRequest(JSON.stringify(grantBody({ item: { ...item, ...overrides } })));
  assert.equal(withItem({ kind: "unknown" }).code, "kind_not_explicit");
  // Words, not one long run: a 32-character run is refused as a token first.
  const words = (bytes) => "ab cd ".repeat(Math.ceil(bytes / 6)).slice(0, bytes);
  assert.equal(withItem({ executionBrief: words(8_193) }).code, "brief_too_large");
  assert.equal(withItem({ executionBrief: words(8_192) }).ok, true);
  assert.equal(withItem({ executionBrief: "See https://example.test for details." }).code, "content_refused");
  assert.equal(withItem({ executionBrief: "Edit lib/amux/core.ts." }).code, "content_refused");
  // The scanner reads the whole request, not only the brief.
  assert.equal(
    parseAutoGrantRequest(JSON.stringify(grantBody({ cardId: "https://example.test" }))).code,
    "content_refused",
  );
  assert.equal(
    parseAutoGrantRequest(JSON.stringify({ ...grantBody(), note: "ghp_abcdefghijklmnop" })).code,
    "content_refused",
  );
});

test("a version 15 consume names the grant and takes nothing the grant bound", () => {
  const base = {
    canonicalizationVersion: "amux-json-v1",
    policyVersion: 15,
    grantId,
    consumptionId,
    snapshotId,
    workerId: null,
  };
  const parsed = parseAutoConsumeRequest(JSON.stringify(base));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.code);
  assert.equal(autoConsumeRequestIsBound(parsed.request), true);
  assert.equal(parseAutoConsumeRequest(JSON.stringify({ ...base, item, amountCents: 125 })).code, "schema_rejected");
  assert.equal(parseAutoConsumeRequest(JSON.stringify({ ...base, workerId: "worker-a" })).code, "worker_not_admitted");
  assert.equal(parseAutoConsumeRequest(JSON.stringify({ ...base, grantId: "not-a-uuid" })).code, "schema_rejected");
});

test("resume names exactly one halt at policy version 15", () => {
  const body = { canonicalizationVersion: "amux-json-v1", policyVersion: 15, haltId };
  const parsed = parseAutoResumeRequest(JSON.stringify(body));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.code);
  assert.equal(parsed.request.haltId, haltId);
  assert.equal(parseAutoResumeRequest(JSON.stringify({ ...body, policyVersion: 8 })).code, "schema_rejected");
  assert.equal(parseAutoResumeRequest(JSON.stringify({ ...body, haltId: "halt-1" })).code, "schema_rejected");
  assert.equal(parseAutoResumeRequest(JSON.stringify({ ...body, reason: "ok" })).code, "schema_rejected");
});

test("a stored binding is read back fail-closed", () => {
  const binding = {
    workItemId: item.cardId,
    itemBindings: [item],
    itemBindingsDigest: boardPromotionItemBindingsDigest([item]),
    amountCents: 125,
  };
  const bound = autoBoundItem(binding);
  assert.equal(bound.ok, true);
  assert.deepEqual(bound.item, item);
  assert.equal(bound.amountCents, 125);
  assert.equal(
    autoBoundItem({ workItemId: item.cardId, itemBindings: null, itemBindingsDigest: null, amountCents: null }).code,
    "grant_unbound",
  );
  assert.equal(autoBoundItem({ ...binding, itemBindingsDigest: "0".repeat(64) }).code, "grant_binding_invalid");
  assert.equal(autoBoundItem({ ...binding, workItemId: `c${"b".repeat(24)}` }).code, "grant_binding_invalid");
  assert.equal(autoBoundItem({ ...binding, amountCents: 0 }).code, "grant_binding_invalid");
  assert.equal(autoBoundItem({ ...binding, itemBindings: [item, item] }).code, "grant_binding_invalid");
  assert.equal(
    autoBoundItem({ ...binding, itemBindings: [{ ...item, executionBrief: "changed" }] }).code,
    "grant_binding_invalid",
  );
});

test("a consume must use the bound item and amount, and the system path needs a binding", () => {
  const binding = {
    workItemId: item.cardId,
    itemBindings: [item],
    itemBindingsDigest: boardPromotionItemBindingsDigest([item]),
    amountCents: 125,
  };
  const legacy = { workItemId: item.cardId, itemBindings: null, itemBindingsDigest: null, amountCents: null };
  assert.deepEqual(
    autoConsumeBindingAccepted({ binding, item, amountCents: 125, requireBound: true }),
    { ok: true, bound: true },
  );
  assert.equal(
    autoConsumeBindingAccepted({ binding, item, amountCents: 124, requireBound: false }).code,
    "grant_amount_mismatch",
  );
  assert.equal(
    autoConsumeBindingAccepted({ binding, item: { ...item, priority: "p0" }, amountCents: 125, requireBound: false }).code,
    "grant_item_mismatch",
  );
  assert.deepEqual(
    autoConsumeBindingAccepted({ binding: legacy, item, amountCents: 0, requireBound: false }),
    { ok: true, bound: false },
  );
  assert.equal(
    autoConsumeBindingAccepted({ binding: legacy, item, amountCents: 0, requireBound: true }).code,
    "grant_unbound",
  );
});

test("one lost outcome is one event, so it cannot open a halt alone", () => {
  const events = autoUnknownEvents({
    consumptions: [{ id: consumptionId, outcomeUnknownAt: now }],
    unknowns: [{ id: consumptionId, recordedAt: now }],
  });
  assert.equal(events.length, 1);
  assert.equal(autoHaltRequired({ criticalCodes: [], unknownAt: events, now }).halt, false);
  const two = autoUnknownEvents({
    consumptions: [{ id: consumptionId, outcomeUnknownAt: at(-60_000) }, { id: snapshotId, outcomeUnknownAt: null }],
    unknowns: [{ id: grantId, recordedAt: now }],
  });
  assert.equal(two.length, 2);
  assert.equal(autoHaltRequired({ criticalCodes: [], unknownAt: two, now }).halt, true);
});

test("the tick answers 200 for a finished decision and 409 only for the switch and a lost outcome", () => {
  assert.equal(autoTickHttpStatus(undefined), 200);
  assert.equal(autoTickHttpStatus("no_grant"), 200);
  assert.equal(autoTickHttpStatus("graduation_unmet"), 200);
  assert.equal(autoTickHttpStatus("auto_halted"), 200);
  assert.equal(autoTickHttpStatus("capacity_full"), 200);
  assert.equal(autoTickHttpStatus("apply_disabled"), 409);
  assert.equal(autoTickHttpStatus("outcome_unknown"), 409);
  assert.equal(autoTickHttpStatus("expiry_outcome_unknown"), 409);
  assert.equal(autoTickHttpStatus("audit_key_missing"), 503);
  assert.equal(autoTickHttpStatus("audit_unbound"), 500);
  assert.equal(autoTickHttpStatus("auto_promotion_failed"), 500);
  assert.equal(AUTO_EXPIRE_BATCH, 50);
});

test("the system actor is listed, and its column marker is not a user id", () => {
  assert.ok(SYSTEM_AUDIT_ACTORS.includes("amux-auto-promoter"));
  assert.equal(AUTO_SYSTEM_ACTOR_ROW_ID, "system:amux-auto-promoter");
  const digest = autoSystemConsumeDigest({
    grantId,
    consumptionId,
    snapshotId,
    itemBindingsDigest: boardPromotionItemBindingsDigest([item]),
    amountCents: 125,
  });
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(
    digest,
    autoSystemConsumeDigest({
      grantId,
      consumptionId,
      snapshotId,
      itemBindingsDigest: boardPromotionItemBindingsDigest([item]),
      amountCents: 124,
    }),
  );
  // The auto-promotion tables have no User foreign key, which is what lets the
  // marker live in an actor column.
  const migration = readFileSync(
    new URL("../prisma/migrations/20260925053000_amux_auto_promotion_gate/migration.sql", import.meta.url),
    "utf8",
  );
  const pool = readFileSync(
    new URL("../prisma/migrations/20260924230000_amux_recommendation_pool/migration.sql", import.meta.url),
    "utf8",
  );
  assert.equal(/REFERENCES "User"/.test(migration), false);
  assert.equal(/REFERENCES "User"/.test(pool), false);
});

test("the version 15 migration is additive", () => {
  const sql = readFileSync(
    new URL("../prisma/migrations/20260929120000_amux_auto_promotion_item_binding/migration.sql", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.equal(/\bDROP\b/i.test(sql), false);
  // No statement writes rows. "ON UPDATE CASCADE" is a foreign-key clause, not a statement.
  assert.equal(/^\s*(?:UPDATE|DELETE|INSERT|TRUNCATE)\b/im.test(sql), false);
  assert.equal(/SET NOT NULL/i.test(sql), false);
  assert.match(sql, /ADD COLUMN "itemBindings" JSONB,/);
  assert.match(sql, /ADD COLUMN "itemBindingsDigest" TEXT,/);
  assert.match(sql, /ADD COLUMN "amountCents" INTEGER;/);
  assert.match(sql, /"amountCents" IS NULL OR "amountCents" BETWEEN 1 AND 500/);
  assert.match(sql, /CREATE TABLE "AmuxRecommendationAutoUnknown"/);
  assert.equal(/"actorUserId"|"userId"/.test(sql), false);
});

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the public auto route checks the latch before the service", () => {
  const route = read("app/api/admin/amux/board-auto-promotion/route.ts");
  const service = read("lib/amux/autoPromotionService.ts");
  const core = read("lib/amux/autoPromotionCore.ts");
  assert.match(route, /if \(!AUTO_PROMOTION_CODE_LATCH\)/);
  assert.match(route, /apply_disabled/);
  assert.match(core, /AUTO_PROMOTION_CODE_LATCH = true/);
  assert.equal(service.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.equal(core.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.equal(service.includes("TOMVERSE_AMUX_EXECUTION_API_ENABLED"), false);
  assert.match(service, /from "@\/lib\/amux\/recommendationPoolCore"/);
  assert.match(service, /pg_advisory_xact_lock\(hashtext\(\$\{RECOMMENDATION_LOCK_NAME\}\)\)/);
  assert.equal(service.includes("unapprovedTodo: 0"), false);
});

test("expire-due and resume run before the latch, grant and consume after it", () => {
  const route = withoutComments(read("app/api/admin/amux/board-auto-promotion/route.ts"));
  const narrow = route.indexOf('action === "expire-due" || action === "resume"');
  const latch = route.indexOf("if (!AUTO_PROMOTION_CODE_LATCH)");
  const grant = route.indexOf("grantAutoPromotion({");
  const consume = route.indexOf("consumeAutoPromotion({");
  assert.ok(narrow > 0 && latch > narrow && grant > latch && consume > latch);
  assert.match(route, /const ACTIONS = new Set\(\["preview", "grant", "consume", "expire-due", "resume"\]\)/);
  assert.match(route, /retry: false/);
  // The service refuses grant and consume before a transaction when the switch is off.
  const service = withoutComments(read("lib/amux/autoPromotionService.ts"));
  const grantBodyText = service.slice(service.indexOf("export async function grantAutoPromotion"));
  assert.ok(grantBodyText.indexOf("refuseClosed();") < grantBodyText.indexOf("commitAutoGrant("));
  const consumeBodyText = service.slice(service.indexOf("export async function consumeAutoPromotion"));
  assert.ok(consumeBodyText.indexOf("refuseClosed();") < consumeBodyText.indexOf("commitAutoPromotion("));
});

test("the tick route authenticates, reads an empty body, checks the switch, and only then opens a transaction", () => {
  const route = withoutComments(read("app/api/internal/amux/auto-promotion/tick/route.ts"));
  assert.match(route, /^export const dynamic = "force-dynamic";/m);
  assert.match(route, /z\.object\(\{\}\)\.strict\(\)/);
  assert.match(route, /"Cache-Control": "no-store"/);
  const auth = route.indexOf("isAmuxSyncAuthorized(request)");
  const body = route.indexOf("readLimitedJson(request");
  const gate = route.indexOf("autoPromotionApplyPermitted({");
  const tick = route.indexOf("tickAutoPromotion()");
  assert.ok(auth > 0 && body > auth && gate > body && tick > gate, "auth, body, gate, tick");
  assert.match(route, /status: 401/);
  assert.match(route, /reason: "apply_disabled"/);
  assert.match(route, /envValue: process\.env\[AUTO_PROMOTION_APPLY_ENV\]/);
  assert.match(route, /codeLatch: AUTO_PROMOTION_CODE_LATCH/);
  assert.equal(route.includes("TOMVERSE_AMUX_EXECUTE"), false);
  assert.equal(route.includes("prisma"), false);
  const service = withoutComments(read("lib/amux/autoPromotionService.ts"));
  const tickBody = service.slice(service.indexOf("export async function tickAutoPromotion"));
  assert.ok(tickBody.indexOf("applyOpen()") < tickBody.indexOf("runAutoPromotionTick()"));
});

test("the system actor writes only through its own audit module", () => {
  const service = read("lib/amux/autoPromotionService.ts");
  const systemAudit = read("lib/amux/autoPromotionSystemAudit.ts");
  assert.equal(service.includes("writeSystemAuditLog"), false);
  assert.match(systemAudit, /systemActor: AMUX_AUTO_PROMOTER_AUDIT_ACTOR/);
  assert.equal(systemAudit.includes("writeAdminAuditLog"), false);
  // A lost consume outcome is recorded on both paths, and the tick's grant
  // choice skips a grant that has one.
  const code = withoutComments(service);
  const humanConsume = code.slice(code.indexOf("export async function consumeAutoPromotion"));
  assert.ok(humanConsume.indexOf("recordAutoOutcomeUnknownSafely(") > 0);
  const tick = code.slice(code.indexOf("export async function runAutoPromotionTick"));
  assert.ok(tick.indexOf("recordAutoOutcomeUnknownSafely(") > 0);
  assert.match(code, /unknowns: \{ none: \{\} \}/);
});

test("the screen is owner-only, listed to the owner alone, and offers the step-up link", () => {
  const page = read("app/(site)/(application)/admin/amux-promotion/page.tsx");
  const panel = read("components/admin/AmuxBoardAutoPromotionPanel.tsx");
  assert.match(page, /getAdminRole\(session\) !== "owner"\) notFound\(\)/);
  assert.match(panel, /ADMIN_REAUTHENTICATION_REQUIRED/);
  assert.match(
    panel,
    /adminRecentAuthenticationHref\("\/admin\/amux-promotion\?tab=auto-promotion"\)/,
  );
  assert.match(panel, /adminFetch\(/);
  // The resume header the screen sends is the one the core parser accepts.
  assert.match(panel, new RegExp(`RESUME_CANONICALIZATION_VERSION = "${AUTO_PROMOTION_CANONICALIZATION_VERSION}"`));
  assert.match(panel, new RegExp(`RESUME_POLICY_VERSION = ${AUTO_PROMOTION_POLICY_VERSION};`));
  // The screen moved into Promotion's Auto-promotion section; its old address
  // still resolves there.
  assert.equal(ADMIN_LEGACY_ROUTES["/admin/amux-board-auto-promotion"], "/admin/amux-promotion?tab=auto-promotion");
  const movedTo = resolveAdminPageMeta("/admin/amux-promotion");
  assert.equal(movedTo.label, "Promotion");
  assert.equal(movedTo.isKnown, true);
  assert.equal(
    adminNavItemTabs("amux-promotion").find((tab) => tab.id === "auto-promotion")?.label,
    "Auto-promotion",
  );
  // Listed to the owner only: every other role would receive a 404.
  for (const role of ["billing", "support", "ops", "readonly"]) {
    assert.equal(
      adminSearchablePagesFor(role).some((entry) => entry.href === "/admin/amux-promotion"),
      false,
      role,
    );
  }
  assert.equal(
    ADMIN_SEARCHABLE_PAGES.some((entry) => entry.href === "/admin/amux-board-auto-promotion"),
    false,
  );
});

test("a tick skips a grant refused for its own card and stops on a refusal about the whole path", async () => {
  const { AUTO_TICK_GRANT_ATTEMPTS, autoTickCardSpecificRefusal } = await import("../lib/amux/autoPromotionCore.ts");
  for (const code of ["not_backlog", "conflict", "dependency_open", "not_included", "capacity_full", "cost_exceeded"]) {
    assert.equal(autoTickCardSpecificRefusal(code), true, code);
  }
  for (const code of ["auto_halted", "graduation_unmet", "capacity_unconfigured", "auto_wip_full", "incident_blocked", "outcome_unknown", "audit_key_missing"]) {
    assert.equal(autoTickCardSpecificRefusal(code), false, code);
  }
  assert.ok(AUTO_TICK_GRANT_ATTEMPTS >= 2 && AUTO_TICK_GRANT_ATTEMPTS <= 20);
});

test("the halt read-back counts only lifecycle rows the consume itself could write", async () => {
  const { readFile } = await import("node:fs/promises");
  const service = await readFile(new URL("../lib/amux/autoPromotionService.ts", import.meta.url), "utf8");
  for (const table of ["AmuxExecutionAttempt", "AmuxWorkDelivery", "AmuxRouteDecision"]) {
    assert.ok(service.includes(`FROM "${table}" `), table);
  }
  assert.equal((service.match(/"createdAt" <= c\."createdAt"/g) ?? []).length, 3);
  assert.match(service, /autoConsumptions: \{ some: \{\}, none: \{ status: "consumed" \} \}/);
  assert.doesNotMatch(service, /autoGrants: \{ some: \{\} \},\s*autoConsumptions/);
});
