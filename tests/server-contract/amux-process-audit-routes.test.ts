import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, mock, test } from "node:test";

// The AMUX process analysis routes (owner request 2026-11-14): the box's two
// internal routes exist only with their own secret, and the owner's settings
// change is a recent owner's, rate limited and audited in its transaction.

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const SECRET = "p".repeat(40);

class Refused extends Error {
  constructor(readonly code: string) { super(code); }
}
class ReauthenticationError extends Error {}

let claims = 0;
let recorded: Record<string, unknown>[] = [];
let recordFailure: Error | null = null;
let changes: Record<string, unknown>[] = [];
let audits: Record<string, unknown>[] = [];
let role: string | null = "owner";
let recent = true;
let rateLimits = 0;

mock.module(mod("lib/amuxProcessAuditStore.ts"), { namedExports: {
  claimProcessAuditRun: async () => { claims += 1; return { due: false, reason: "disabled" }; },
  recordProcessAuditReport: async (input: Record<string, unknown>) => {
    if (recordFailure) throw recordFailure;
    recorded.push(input);
    return { id: "r1", removed: 0 };
  },
  ProcessAuditReportRefused: Refused,
  changeProcessAuditSettings: async (_tx: unknown, change: Record<string, unknown>) => {
    changes.push(change);
    return {
      before: { enabled: false, cadenceDays: 7, runRequestedAt: null, claim: null },
      after: { enabled: change.enabled, cadenceDays: change.cadenceDays, runRequestedAt: change.runNow ? "2026-11-14T00:00:00.000Z" : null, claim: null },
    };
  },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { $transaction: async (work: (tx: unknown) => unknown) => work({ tx: true }) } } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: { writeAdminAuditLog: async (entry: Record<string, unknown>) => { audits.push(entry); return "audit-1"; } } });
mock.module("next-auth/next", { namedExports: { getServerSession: async () => role ? { user: { id: "owner-1" } } : null } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { getAdminRole: () => role, isAdminSession: () => role !== null } });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => { if (!recent) throw new ReauthenticationError(); },
  isAdminReauthenticationError: (error: unknown) => error instanceof ReauthenticationError,
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  consumeApiRateLimit: async () => { rateLimits += 1; },
  apiSecurityResponse: (error: unknown) => (error as { status?: number })?.status
    ? new Response(JSON.stringify({ error: "invalid" }), { status: (error as { status: number }).status }) : null,
  readLimitedJson: async (request: Request, _max: number, schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } }) => {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) throw Object.assign(new Error("invalid"), { status: 400 });
    return parsed.data;
  },
} });

type Handler = (request: Request) => Promise<Response>;
let context: Handler;
let report: Handler;
let settings: Handler;
before(async () => {
  ({ POST: context } = await import(mod("app/api/internal/amux-process-audit/context/route.ts")));
  ({ POST: report } = await import(mod("app/api/internal/amux-process-audit/report/route.ts")));
  ({ POST: settings } = await import(mod("app/api/admin/amux/process-audit/settings/route.ts")));
});

beforeEach(() => {
  claims = 0; recorded = []; recordFailure = null; changes = []; audits = []; role = "owner"; recent = true; rateLimits = 0;
  process.env.AMUX_PROCESS_AUDIT_SECRET = SECRET;
});

const internal = (path: string, body: unknown, secret: string | null = SECRET) => new Request(`https://app.test${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const reportBody = { token: ["0b6c3b1e", "9d1e", "4a3f", "8a59", "2e1c0d6f7a11"].join("-"), developSha: "a".repeat(40), model: null, analysis: { headline: "x" } };

test("the internal routes do not exist without their own secret", async () => {
  delete process.env.AMUX_PROCESS_AUDIT_SECRET;
  assert.equal((await context(internal("/api/internal/amux-process-audit/context", {}))).status, 404);
  process.env.AMUX_PROCESS_AUDIT_SECRET = "short";
  assert.equal((await report(internal("/api/internal/amux-process-audit/report", reportBody))).status, 404);
  assert.equal(claims, 0);
  assert.equal(recorded.length, 0);
});

test("a wrong or missing bearer is refused before anything is read", async () => {
  assert.equal((await context(internal("/api/internal/amux-process-audit/context", {}, "q".repeat(40)))).status, 401);
  assert.equal((await context(internal("/api/internal/amux-process-audit/context", {}, null))).status, 401);
  assert.equal((await report(internal("/api/internal/amux-process-audit/report", reportBody, "q".repeat(40)))).status, 401);
  assert.equal(claims, 0);
});

test("the poll answers the store's claim", async () => {
  const response = await context(internal("/api/internal/amux-process-audit/context", {}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { due: false, reason: "disabled" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(claims, 1);
});

test("a report is stored only in its strict shape, and a refused claim says why", async () => {
  const stored = await report(internal("/api/internal/amux-process-audit/report", reportBody));
  assert.equal(stored.status, 201);
  assert.deepEqual(recorded, [reportBody]);
  assert.equal((await report(internal("/api/internal/amux-process-audit/report", { ...reportBody, metrics: {} }))).status, 400);
  assert.equal((await report(internal("/api/internal/amux-process-audit/report", { ...reportBody, developSha: "main" }))).status, 400);
  recordFailure = new Refused("no_claim");
  assert.equal((await report(internal("/api/internal/amux-process-audit/report", reportBody))).status, 409);
  recordFailure = new Refused("invalid_analysis");
  assert.equal((await report(internal("/api/internal/amux-process-audit/report", reportBody))).status, 422);
  recordFailure = new Error("database");
  assert.equal((await report(internal("/api/internal/amux-process-audit/report", reportBody))).status, 503);
});

const ownerRequest = (body: unknown) => new Request("https://app.test/api/admin/amux/process-audit/settings", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const change = { enabled: true, cadenceDays: 7, runNow: true, ownerConfirmed: true };

test("only a recently signed-in owner changes the schedule, with one audit entry in the same transaction", async () => {
  const response = await settings(ownerRequest(change));
  assert.equal(response.status, 200);
  assert.deepEqual(changes, [{ enabled: true, cadenceDays: 7, runNow: true, ownerConfirmed: true }]);
  assert.equal(rateLimits, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "amux.process_audit.settings_changed");
  assert.deepEqual(audits[0].tx, { tx: true });

  role = "ops";
  assert.equal((await settings(ownerRequest(change))).status, 404);
  role = "owner";
  recent = false;
  assert.equal((await settings(ownerRequest(change))).status, 428);
  recent = true;
  assert.equal((await settings(ownerRequest({ ...change, cadenceDays: 31 }))).status, 400);
  assert.equal((await settings(ownerRequest({ ...change, ownerConfirmed: false }))).status, 400);
  assert.equal(audits.length, 1);
});
