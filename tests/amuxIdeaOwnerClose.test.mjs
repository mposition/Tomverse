import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AMUX_IDEA_OWNER_CLOSABLE_STATE, AMUX_IDEA_OWNER_CLOSE_LIMIT,
  inspectAmuxIdeaOwnerClose } from "../lib/amux/ideaOwnerCloseCore.ts";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const id = (n) => `idea-${String(n).padStart(8, "0")}`;

test("an owner close names 1 to 20 distinct ideas and a 3 to 500 character reason", () => {
  assert.equal(AMUX_IDEA_OWNER_CLOSABLE_STATE, "awaiting_owner");
  assert.equal(AMUX_IDEA_OWNER_CLOSE_LIMIT, 20);
  assert.deepEqual(inspectAmuxIdeaOwnerClose({ ideaIds: [id(1), id(2)], reason: "Not needed" }),
    { ok: true, ideaIds: [id(1), id(2)], reason: "Not needed" });
  const full = Array.from({ length: 20 }, (_, n) => id(n));
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: full, reason: "abc" }).ok, true);
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: [...full, id(20)], reason: "abc" }).ok, false,
    "over the bound");
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: [], reason: "abc" }).ok, false);
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: [id(1), id(1)], reason: "abc" }).ok, false,
    "a duplicate is refused, not merged");
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: ["short"], reason: "abc" }).ok, false);
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: ["../idea-0001"], reason: "abc" }).ok, false);
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: id(1), reason: "abc" }).ok, false);
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: [id(1)], reason: "ab" }).ok, false);
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: [id(1)], reason: "x".repeat(501) }).ok, false);
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: [id(1)], reason: " padded " }).ok, false);
  assert.equal(inspectAmuxIdeaOwnerClose({ ideaIds: [id(1)], reason: 42 }).ok, false);
});

test("the close route is owner-only, same-origin, recently re-authenticated, JSON and rate limited", () => {
  const route = read("app/api/admin/amux/ideas/close/route.ts");
  assert.equal(/export async function (GET|PUT|PATCH|DELETE)/.test(route), false, "POST only");
  assert.match(route, /getAdminRole\(session\) !== "owner" \|\| !hasValidMutationOrigin\(request\)/);
  assert.ok(route.includes("await assertRecentAdminAuthentication(session);"));
  assert.ok(route.includes(`"application/json"`));
  assert.ok(route.includes("consumeApiRateLimit("));
  assert.ok(route.includes("ownerConfirmed: z.literal(true)"));
  assert.ok(route.includes(".max(AMUX_IDEA_OWNER_CLOSE_LIMIT)"));
  assert.ok(route.includes("status: 428"), "a stale sign-in is told to sign in again");
});

test("a close writes through the audit writer only, and leaves retention clocks alone", () => {
  const service = read("lib/amux/ideaOwnerCloseService.ts");
  assert.ok(service.includes("writeAdminAuditLog({"), "the hash-chained writer, in the caller's transaction");
  assert.equal(/adminAuditLog\.(create|update|upsert|delete)/.test(service), false,
    "never the audit table directly");
  assert.ok(service.indexOf("takeAuditChainLock(tx)") < service.indexOf("FOR UPDATE"),
    "the audit lock is taken before the row lock, as every other writer does");
  assert.equal((service.match(/\.update(Many)?\(/g) ?? []).length, 1, "one write besides the audit");
  assert.ok(service.includes(`data: { state: "cancelled", cancelledAt: now },`),
    "the raw purge clock and unit expiry are not moved");
  assert.equal(/\.delete(Many)?\(/.test(service), false, "nothing deleted");
  // A unit decision re-checks the idea under the same lock (see the DB suite).
  const store = read("lib/amux/ideaUnitDecisionStore.ts");
  const guard = store.slice(store.indexOf("async function assertCurrentProposalSource"),
    store.indexOf("/** One owner preparation."));
  assert.match(guard, /chunk\.idea\.state === "cancelled" \|\| chunk\.idea\.cancelledAt !== null/);
});
