import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let session = { user: { id: "owner-a", email: "owner@example.invalid", authenticatedAt: new Date().toISOString() } };
let scheduled = 0; let issued = 0; let redeemed = 0;
let rateLimited = false;
mock.module("next/server", { namedExports: { NextResponse, after: () => undefined } });
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => ({ session }), resolveAccountRouteSession: async () => ({ session }) } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => { if (rateLimited) throw { status: 429 }; },
  apiSecurityResponse: (error) => error?.status === 429 ? Response.json({}, { status: 429 }) : error?.name === "ZodError" ? Response.json({}, { status: 400 }) : null,
  readLimitedJson: async (request, _limit, schema) => schema.parse(await request.json()),
} });
mock.module(mod("lib/securityAudit.ts"), { namedExports: { logSecurityAuditEvent: () => undefined } });
mock.module(mod("lib/accountDeletion.ts"), { namedExports: { scheduleTomverseAccountDeletion: async (id) => { assert.equal(id, "owner-a"); scheduled++; return { scheduled: true, scheduledFor: new Date(), email: "owner@example.invalid", language: "en" }; } } });
mock.module(mod("lib/standardEmailLane.ts"), { namedExports: { enqueueStandardEmail: async () => undefined } });
mock.module(mod("lib/operationalMonitoring.ts"), { namedExports: { reportOperationalIncident: async () => undefined } });
mock.module(mod("lib/accountDataExportTickets.ts"), { namedExports: {
  issueAccountDataExportTicket: async ({ userId }) => { assert.equal(userId, "owner-a"); issued++; return { token: "x".repeat(43), expiresAt: new Date(Date.now() + 300000) }; },
  listAccountDataExportHistory: async () => [],
  redeemAccountDataExportTicket: async ({ userId }) => { assert.equal(userId, "owner-a"); redeemed++; return { ok: redeemed === 1, ticketId: "ticket-a" }; },
  recordAccountDataExportDelivery: async () => undefined,
} });
mock.module(mod("lib/accountDataExport.ts"), { namedExports: { buildAccountDataExport: async () => ({ manifest: { schemaVersion: 1, includedDomains: ["conversations"], filteredDomains: [] }, conversations: [] }) } });
const account = await import("../../app/api/user/account/route.ts");
const ticket = await import("../../app/api/user/account/export/route.ts");
const download = await import("../../app/api/user/account/export/[token]/route.ts");
const request = (path, method = "GET", body) => new Request(`https://tomverse.app${path}`, { method, headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("expired sign-in cannot issue an export or schedule deletion", async () => {
  session.user.authenticatedAt = new Date(Date.now() - 86400000).toISOString();
  assert.equal((await ticket.GET(request("/api/user/account/export"))).status, 200);
  assert.equal((await ticket.POST(request("/api/user/account/export", "POST", {}))).status, 428);
  assert.equal((await account.DELETE(request("/api/user/account", "DELETE", { confirm: true, confirmationText: "DELETE MY ACCOUNT" }))).status, 428);
  assert.equal(issued, 0); assert.equal(scheduled, 0);
  session.user.authenticatedAt = new Date().toISOString();
});
test("deletion preserves exact confirmation and schedules only the authenticated owner", async () => {
  assert.equal((await account.DELETE(request("/api/user/account", "DELETE", { confirm: true, confirmationText: "delete" }))).status, 400);
  assert.equal(scheduled, 0);
  const response = await account.DELETE(request("/api/user/account", "DELETE", { confirm: true, confirmationText: "DELETE MY ACCOUNT" }));
  assert.equal(response.status, 200); assert.equal(scheduled, 1); assert.equal((await response.json()).success, true);
});
test("native export preserves the existing scoped, single-use download contract", async () => {
  const result = await ticket.POST(request("/api/user/account/export", "POST", {}));
  assert.equal(result.status, 201); const body = await result.json(); assert.equal(body.singleUse, true);
  const response = await download.GET(request(body.downloadPath), { params: Promise.resolve({ token: "x".repeat(43) }) });
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/); assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.equal((await download.GET(request(body.downloadPath), { params: Promise.resolve({ token: "x".repeat(43) }) })).status, 410);
});
test("account profile is private and preserves rate-limit responses", async () => {
  const response = await account.GET(request("/api/user/account"));
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/); assert.equal((await response.json()).id, "owner-a");
  rateLimited = true; assert.equal((await account.GET(request("/api/user/account"))).status, 429); rateLimited = false;
});
test("missing identity cannot read account data, issue tickets or delete", async () => {
  session = null;
  const before = { issued, redeemed, scheduled };
  assert.equal((await account.GET(request("/api/user/account"))).status, 401);
  assert.equal((await ticket.GET(request("/api/user/account/export"))).status, 401);
  assert.equal((await account.DELETE(request("/api/user/account", "DELETE", {}))).status, 401);
  assert.equal((await ticket.POST(request("/api/user/account/export", "POST", {}))).status, 401);
  assert.equal((await download.GET(request("/api/user/account/export/synthetic"), { params: Promise.resolve({ token: "x".repeat(43) }) })).status, 401);
  assert.deepEqual({ issued, redeemed, scheduled }, before);
});
