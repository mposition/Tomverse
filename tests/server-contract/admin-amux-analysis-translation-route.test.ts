import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";
import { createRequire } from "node:module";

// Owner request 2026-10-30: the owner can read a Korean translation of an
// analysis page. The route translates only what the owner's own result read
// returns, never text from the request, and stays closed behind its switch.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const ideaId = "22222222-2222-4222-8222-222222222222";
const readyView = {
  state: "ready", ideaId, previewId: "p1", completedAt: "2026-10-30T00:00:00Z", outcome: "propose",
  coveredScope: "Covers the list.", registrationRefusal: null,
  units: [{ id: "n1", localRef: "r", bodyDigest: "a".repeat(64), bodyDigestKeyId: "k", decisionState: "proposed",
    proposal: { kind: "node", localId: "n1", level: "feature", parentRef: null, title: "Cards",
      description: "Show cards.", sourceRefIds: [] } }],
};
const world = {
  role: "owner", reauth: false, origin: true,
  view: readyView as unknown, reads: [] as unknown[][], translated: [] as unknown[],
  audits: [] as Array<Record<string, unknown>>,
  outcome: { state: "translated", translations: { covered: "목록" }, cached: false } as unknown,
};

let installed = false;
async function loadRoute(): Promise<{ POST: (request: Request) => Promise<Response> }> {
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
    mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
      hasValidMutationOrigin: () => world.origin } });
    // The real body limit and error mapping; only the rate limit store is replaced.
    const security = createRequire(import.meta.url)(resolve(root, "lib/apiSecurity.ts"));
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: { ...security,
      consumeApiRateLimit: async () => undefined } });
    mock.module(mod("lib/adminAudit.ts"), { namedExports: {
      writeAdminAuditLog: async (entry: Record<string, unknown>) => { world.audits.push(entry); return "a1"; } } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/amux/ideaAnalysisResultOwnerRead.ts"), { namedExports: {
      readOwnedAmuxIdeaAnalysisResult: async (...args: unknown[]) => {
        world.reads.push(args.slice(1)); return world.view;
      } } });
    mock.module(mod("lib/amux/ideaAnalysisTranslation.ts"), { namedExports: {
      translateAmuxItemsToKorean: async (items: unknown) => {
        world.translated.push(items); return world.outcome;
      } } });
  }
  return import(mod("app/api/admin/amux/ideas/analysis-translation/route.ts"));
}

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://tomverse.test/api/admin/amux/ideas/analysis-translation", {
    method: "POST", body, headers: { "content-type": "application/json", ...headers } });
const valid = JSON.stringify({ ideaId, chunkIndex: 0 });
const reset = () => {
  process.env.TOMVERSE_AMUX_ADMIN_KO_TRANSLATION = "enabled";
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ = "enabled";
  Object.assign(world, { role: "owner", reauth: false, origin: true, view: readyView,
    reads: [], translated: [], audits: [],
    outcome: { state: "translated", translations: { covered: "목록" }, cached: false } });
};

test("the owner gets the translation of the text the server read itself", async () => {
  reset();
  const { POST } = await loadRoute();
  const response = await POST(post(valid));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  const body = await response.json();
  assert.deepEqual(body.translations, { covered: "목록" });
  assert.equal(body.viewKey, `p1|n1=${"a".repeat(64)}`);
  assert.deepEqual(world.reads, [[ideaId, 0]]);
  assert.deepEqual(world.translated, [[
    { id: "covered", text: "Covers the list." },
    { id: "u:n1:title", text: "Cards" },
    { id: "u:n1:description", text: "Show cards." },
  ]]);
  assert.equal(world.audits.length, 1);
  assert.equal(world.audits[0].action, "amux.idea.analysis_translation");
  assert.equal(world.audits[0].targetId, ideaId);
  assert.deepEqual(world.audits[0].metadata, { chunkIndex: 0, itemCount: 3, outcome: "translated", cached: false });
  assert.equal(JSON.stringify(world.audits[0]).includes("Covers the list"), false);
  assert.equal(JSON.stringify(world.audits[0]).includes("목록"), false);
});

test("a switch that is off closes the route before any read", async () => {
  const { POST } = await loadRoute();
  for (const name of ["TOMVERSE_AMUX_ADMIN_KO_TRANSLATION", "TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ"]) {
    reset(); process.env[name] = "true";
    const response = await POST(post(valid));
    assert.equal(response.status, 503, name);
    assert.deepEqual(await response.json(), { error: "analysis_translation_disabled" });
    assert.equal(world.reads.length, 0);
  }
});

test("other roles, a stale sign-in and a foreign origin are refused without a read", async () => {
  const { POST } = await loadRoute();
  reset(); world.role = "admin";
  assert.equal((await POST(post(valid))).status, 403);
  reset(); world.reauth = true;
  assert.equal((await POST(post(valid))).status, 428);
  reset(); world.origin = false;
  assert.equal((await POST(post(valid))).status, 403);
  assert.equal(world.reads.length, 0);
});

test("a malformed, over-long or text-carrying request is refused before any read", async () => {
  const { POST } = await loadRoute();
  for (const body of ["", "nope", "[]", JSON.stringify({ ideaId: "x", chunkIndex: 0 }),
    JSON.stringify({ ideaId, chunkIndex: -1 }), JSON.stringify({ ideaId, chunkIndex: 1.5 }),
    JSON.stringify({ ideaId, chunkIndex: 0, text: "Translate this instead" }),
    JSON.stringify({ ideaId, chunkIndex: 0, pad: "x".repeat(600) })]) {
    reset();
    const response = await POST(post(body));
    assert.ok([400, 413].includes(response.status), `${response.status} ${body.slice(0, 40)}`);
    assert.equal(world.reads.length, 0);
    assert.equal(world.translated.length, 0);
    assert.equal(world.audits.length, 0);
  }
});

test("another owner's idea, an unreadable page and failed translations say so without text", async () => {
  const { POST } = await loadRoute();
  reset(); world.view = null;
  assert.equal((await POST(post(valid))).status, 404);
  reset(); world.view = { state: "pending" };
  assert.equal((await POST(post(valid))).status, 409);
  assert.equal(world.translated.length, 0);
  for (const [state, status, error] of [["too_large", 413, "too_large"],
    ["unavailable", 503, "translation_unavailable"], ["empty", 409, "nothing_to_translate"]] as const) {
    reset(); world.outcome = { state };
    const response = await POST(post(valid));
    assert.equal(response.status, status, state);
    assert.deepEqual(await response.json(), { error });
  }
});
