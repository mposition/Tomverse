import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const id = "a".repeat(64);
let role, recent, item, calls, rates, reserved, ambiguous;
const submissions = new Map();
class ReauthenticationError extends Error {}
mock.module("next-auth/next", { namedExports: { getServerSession: async () => role ? { user: { id: "operator" } } : null } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { getAdminRole: () => role, isAdminSession: () => role !== null } });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => { if (!recent) throw new ReauthenticationError(); },
  isAdminReauthenticationError: (error) => error instanceof ReauthenticationError,
} });
mock.module(mod("lib/adminApproval.ts"), { namedExports: { adminApprovalErrorResponse: () => null } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  readLimitedJson: async (request, _limit, schema) => schema.parse(await request.json()),
  consumeApiRateLimit: async (_request, _user, key, limit) => { rates.push({ key, limit }); }, apiSecurityResponse: (error) => error.name === "ZodError" ? Response.json({ error: "invalid_request" }, { status: 400 }) : null,
} });
mock.module(mod("lib/publicUrl.ts"), { namedExports: { getPublicAppOrigin: () => "https://app.example.test" } });
mock.module(mod("lib/qaReleaseCiAdviceStore.ts"), { namedExports: {
  readCiAdviceItem: async (value) => value === id ? item : null,
  changeCiAdviceStatus: async ({ status, ideaId }) => { calls.push(status); item = { ...item, status, amuxIdeaId: ideaId ?? null }; return item; },
  reserveCiAdviceSend: async () => { if (!reserved) return null; item = { ...item, status: "sending_to_amux" }; return item; },
} });
mock.module(mod("lib/amux/ideaSendPath.ts"), { namedExports: { ideaSendPath: async ({ requestId, idea }) => ({
  ok: true,
  readBack: async () => submissions.has(requestId) ? { status: "committed", ideaId: submissions.get(requestId) } : { status: "absent" },
  submit: async () => { calls.push("submit"); assert.match(idea, /preserve security, billing and audit coverage/i); submissions.set(requestId, "idea-one"); if (ambiguous) throw new Error("simulated lost reply"); return { ideaId: "idea-one" }; },
  isAlreadySeen: () => false,
}) } });
const { POST } = await import(mod("app/api/admin/qa-release/ci-advice/[suggestionId]/route.ts"));
const { AMUX_V4_IDEA_SUBMISSION_ENV: writeKey, AMUX_V4_IDEA_READBACK_ENV: readKey } = await import(mod("lib/amux/ideaSubmissionCore.ts"));
const oldWrite = process.env[writeKey], oldRead = process.env[readKey];
test.beforeEach(() => {
  role = "owner"; recent = true; calls = []; rates = []; reserved = true; ambiguous = false; submissions.clear();
  item = { id, title: "Reuse CI fixtures", why: "Measured six-minute check", change: "Reuse the existing fixtures", savesMinutes: 2,
    status: "open", createdAt: "2026-11-13T00:00:00.000Z", at: null, amuxIdeaId: null };
  process.env[writeKey] = "enabled"; process.env[readKey] = "enabled";
});
test.after(() => {
  for (const [key, value] of [[writeKey, oldWrite], [readKey, oldRead]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const act = (action, extra = {}, suggestionId = id) => POST(new Request("https://app.example.test/api/admin/qa-release/ci-advice/item", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }),
}), { params: Promise.resolve({ suggestionId }) });

test("only recent owner or ops can complete or dismiss, while sending remains owner-only", async () => {
  role = null; assert.equal((await act("complete")).status, 404);
  role = "support"; assert.equal((await act("complete")).status, 403);
  role = "ops"; assert.equal((await act("send")).status, 403);
  recent = false; assert.equal((await act("complete")).status, 428);
  assert.deepEqual(calls, []);
  recent = true;
  const response = await act("complete");
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(calls, ["completed"]);
  assert.deepEqual(rates, [{ key: "admin-ci-advice-close", limit: { minute: 60, day: 500 } }]);
  role = "owner"; assert.equal((await act("dismiss")).status, 200);
  assert.deepEqual(calls, ["completed", "dismissed"]);
});

test("caller-supplied request IDs, unsupported actions and unknown suggestions cannot mutate or submit", async () => {
  assert.equal((await act("send", { requestId: "chosen-by-browser" })).status, 400);
  assert.equal((await act("merge")).status, 400);
  assert.equal((await act("complete", {}, "../item")).status, 400);
  assert.equal((await act("complete", {}, "b".repeat(64))).status, 404);
  assert.deepEqual(calls, []);
});

test("AMUX switches and the item reservation stop submissions", async () => {
  delete process.env[writeKey]; assert.equal((await act("send")).status, 503);
  process.env[writeKey] = "enabled"; reserved = false; assert.equal((await act("send")).status, 409);
  assert.deepEqual(calls, []);
});

test("an unknown send is finished by deterministic read-back without a second external submission", async () => {
  ambiguous = true;
  assert.equal((await act("send")).status, 500); assert.equal(item.status, "sending_to_amux");
  ambiguous = false;
  assert.equal((await act("send")).status, 200); assert.equal(item.amuxIdeaId, "idea-one");
  assert.equal((await act("send")).status, 200); assert.deepEqual(calls, ["submit", "sent"]);
  assert.ok(rates.every((entry) => entry.key === "admin-ci-advice-send" && entry.limit.minute === 5 && entry.limit.day === 50));
});
