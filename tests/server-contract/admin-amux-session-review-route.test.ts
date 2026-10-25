import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Owner decision 2026-10-23: a session idea's detail shows why its answer made
// no plan, read from the answer kept for seven days after intake.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const ideaId = "22222222-2222-4222-8222-222222222222";
const world = {
  role: "owner", reauth: false, calls: [] as unknown[][],
  review: { reason: "owner_question", question: "Which page?" } as unknown,
  error: null as Error | null,
};

let installed = false;
async function loadRoute(): Promise<{ GET: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: {
      getServerSession: async () => ({ user: { id: "owner-1" } }) } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => true, getAdminRole: () => world.role } });
    class Reauth extends Error {}
    mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
      assertRecentAdminAuthentication: async () => { if (world.reauth) throw new Reauth(); },
      isAdminReauthenticationError: (error: unknown) => error instanceof Reauth } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      consumeApiRateLimit: async () => undefined, apiSecurityResponse: () => null } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/amux/ideaSessionReviewRead.ts"), { namedExports: {
      readAmuxSessionReviewForOwner: async (...args: unknown[]) => {
        world.calls.push(args);
        if (world.error) throw world.error;
        return world.review;
      } } });
  }
  return import(mod("app/api/admin/amux/ideas/session-review/route.ts"));
}

const get = (query: string) =>
  new Request(`https://tomverse.test/api/admin/amux/ideas/session-review?${query}`);

test("the owner reads one idea's review, scoped to their own id", async () => {
  world.calls = []; world.review = { reason: "owner_question", question: "Which page?" };
  const { GET } = await loadRoute();
  const response = await GET(get(`ideaId=${ideaId}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), { review: { reason: "owner_question", question: "Which page?" } });
  assert.deepEqual(world.calls, [["owner-1", ideaId]]);
});

test("a malformed query is refused before any read", async () => {
  const { GET } = await loadRoute();
  for (const query of ["", "ideaId=nope", `ideaId=${ideaId}&ideaId=${ideaId}`, `ideaId=${ideaId}&x=1`]) {
    world.calls = [];
    const response = await GET(get(query));
    assert.equal(response.status, 400, query);
    assert.equal(world.calls.length, 0);
  }
});

test("no review, other roles, stale sign-in and failures answer without content", async () => {
  const { GET } = await loadRoute();
  world.review = null;
  assert.equal((await GET(get(`ideaId=${ideaId}`))).status, 404);
  world.review = { reason: "not_a_plan" };
  world.role = "admin";
  assert.equal((await GET(get(`ideaId=${ideaId}`))).status, 403);
  world.role = "owner"; world.reauth = true;
  const reauth = await GET(get(`ideaId=${ideaId}`));
  assert.equal(reauth.status, 428);
  world.reauth = false; world.error = new Error("key store down");
  const failed = await GET(get(`ideaId=${ideaId}`));
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "session_review_unavailable" });
  world.error = null;
});
