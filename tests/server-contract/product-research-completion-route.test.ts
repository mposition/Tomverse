import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, mock, test } from "node:test";

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let role: string | null;
let recent: boolean;
let storedStatus: string;
let closeResult: boolean;
let closes: Record<string, unknown>[];
let sends: number;
let rateLimits: number;
class ReauthenticationError extends Error {}

mock.module("next-auth/next", { namedExports: { getServerSession: async () => role ? { user: { id: "operator" } } : null } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { getAdminRole: () => role, isAdminSession: () => role !== null } });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => { if (!recent) throw new ReauthenticationError(); },
  isAdminReauthenticationError: (error: unknown) => error instanceof ReauthenticationError,
} });
mock.module(mod("lib/adminApproval.ts"), { namedExports: { adminApprovalErrorResponse: () => null } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  readLimitedText: (request: Request) => request.text(),
  consumeApiRateLimit: async () => { rateLimits += 1; },
  apiSecurityResponse: () => null,
} });
mock.module(mod("lib/amux/ideaSendPath.ts"), { namedExports: { ideaSendPath: async () => { sends += 1; throw new Error("unexpected send"); } } });
mock.module(mod("lib/amux/ideaSessionSubmissionService.ts"), { namedExports: { AmuxIdeaSessionSubmissionError: class extends Error {} } });
mock.module(mod("lib/amux/ideaSubmissionService.ts"), { namedExports: { IdeaSubmissionError: class extends Error {} } });
mock.module(mod("lib/productResearchScoutStore.ts"), { namedExports: {
  readSuggestion: async () => ({ id: "one", status: storedStatus, amuxIdeaId: null }),
  closeSuggestion: async (input: Record<string, unknown>) => { closes.push(input); return closeResult; },
} });
let POST: typeof import("../../app/api/admin/product-research/suggestions/[suggestionId]/route").POST;
before(async () => { ({ POST } = await import(mod("app/api/admin/product-research/suggestions/[suggestionId]/route.ts"))); });
const complete = () => POST(new Request("https://example.test/api/admin/product-research/suggestions/one", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "complete" }),
}), { params: Promise.resolve({ suggestionId: "one" }) });

beforeEach(() => { role = "owner"; recent = true; storedStatus = "open"; closeResult = true; closes = []; sends = 0; rateLimits = 0; });

test("owner and ops complete through the audited store without sending an AMUX idea", async () => {
  for (const allowed of ["owner", "ops"]) {
    role = allowed;
    const response = await complete();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "completed" });
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  assert.equal(closes.length, 2);
  assert.deepEqual(closes[0].next, { status: "completed" });
  assert.equal(sends, 0);
  assert.equal(rateLimits, 2);
});

test("completion preserves administrator role and recent-authentication gates", async () => {
  role = null;
  assert.equal((await complete()).status, 404);
  role = "reader";
  assert.equal((await complete()).status, 403);
  role = "owner";
  recent = false;
  assert.equal((await complete()).status, 428);
  assert.equal(closes.length, 0);
});

test("an already completed suggestion is read back without another write", async () => {
  storedStatus = "completed";
  const response = await complete();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "completed");
  assert.equal(closes.length, 0);
});

test("a concurrent decision is reported as conflict instead of completion", async () => {
  closeResult = false;
  const response = await complete();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "suggestion_changed");
});
