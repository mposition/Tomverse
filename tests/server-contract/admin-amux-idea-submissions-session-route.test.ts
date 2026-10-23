import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// amux-intake v19 item 1: while session intake is on, the Admin idea input
// enters the same session intake writer as a coding session, under the saved
// operating scope; with it off the v4 owner path is unchanged.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const requestId = "11111111-1111-4111-8111-111111111111";
const world = {
  sessionCalls: [] as unknown[], v4Calls: 0,
  sessionError: null as null | { code: string; readBack?: string },
  seen: { status: "absent" } as Record<string, unknown>,
  owned: { requestId, status: "absent" } as Record<string, unknown>,
};

class SessionError extends Error {
  constructor(readonly code: string, readonly readBack?: string) { super(code); }
}

let installed = false;
async function loadRoute(): Promise<{
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
}> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: {
      getServerSession: async () => ({ user: { id: "owner-1" } }) } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => true, getAdminRole: () => "owner" } });
    mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
      assertRecentAdminAuthentication: async () => undefined,
      isAdminReauthenticationError: () => false } });
    mock.module(mod("lib/adminApproval.ts"), { namedExports: {
      adminApprovalErrorResponse: () => null } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      consumeApiRateLimit: async () => undefined,
      apiSecurityResponse: () => null,
      readLimitedText: async (request: Request) => request.text() } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/amux/ideaSubmissionService.ts"), { namedExports: {
      IdeaSubmissionError: class extends Error {},
      submitIdea: async () => { world.v4Calls += 1;
        return { ideaId: "v4-idea", requestId, auditId: "a" }; },
      readIdeaSubmissionRequest: async () => world.owned } });
    mock.module(mod("lib/amux/ideaSessionSubmissionService.ts"), { namedExports: {
      AmuxIdeaSessionSubmissionError: SessionError,
      submitAmuxIdeaFromSession: async (input: unknown) => {
        world.sessionCalls.push(input);
        if (world.sessionError) {
          throw new SessionError(world.sessionError.code, world.sessionError.readBack);
        }
        return { ideaId: "session-idea", requestId, reservationId: "r", auditId: "a",
          reservationAuditId: "b" };
      },
      readAmuxIdeaSessionSubmissionRequest: async () => world.seen } });
  }
  return import(mod("app/api/admin/amux/ideas/submissions/route.ts"));
}

const SWITCHES = { TOMVERSE_AMUX_SESSION_INTAKE: "enabled", TOMVERSE_AMUX_V4_IDEA_SUBMIT: "enabled",
  TOMVERSE_AMUX_SESSION_INTAKE_READBACK: "enabled", TOMVERSE_AMUX_V4_IDEA_READBACK: "enabled" };

async function withSwitches<T>(values: Record<string, string>, fn: () => Promise<T>) {
  const old = Object.fromEntries(Object.keys(SWITCHES).map((name) => [name, process.env[name]]));
  for (const name of Object.keys(SWITCHES)) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  try { return await fn(); }
  finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const post = (input: unknown) => new Request("https://tomverse.test/api/admin/amux/ideas/submissions", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ version: 1, requestId, input }) });
const idea = (repositories: string[]) => ({ version: 1,
  idea: "Show why a session analysis made no plan.", repositories, pullRequests: [] });

test("with session intake on, an Admin idea enters the session writer as an Admin source", () =>
  withSwitches(SWITCHES, async () => {
    world.sessionCalls = []; world.v4Calls = 0; world.sessionError = null;
    const { POST } = await loadRoute();
    const response = await POST(post(idea(["mposition/Tomverse"])));
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ideaId: "session-idea", requestId,
      state: "submitted", origin: "session", hasExternalSources: true, transferReady: false });
    assert.equal(world.v4Calls, 0);
    const call = world.sessionCalls[0] as { inspected: { requestId: string;
      source: Record<string, string> } };
    assert.equal(call.inspected.requestId, requestId);
    assert.deepEqual(call.inspected.source, { toolName: "tomverse-admin",
      modelProvider: "operator", sessionDisplay: "Admin idea input" });
  }));

test("a session idea without any reference is refused before anything is written", () =>
  withSwitches(SWITCHES, async () => {
    world.sessionCalls = [];
    const { POST } = await loadRoute();
    const response = await POST(post(idea([])));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "references_required" });
    assert.equal(world.sessionCalls.length, 0);
  }));

test("pre-write refusals keep their code; an uncertain write is read back", () =>
  withSwitches(SWITCHES, async () => {
    const { POST } = await loadRoute();
    for (const [code, status] of [["outside_scope", 409], ["model_not_approved", 409],
      ["scope_unavailable", 409], ["reference_snapshot_unavailable", 503]] as const) {
      world.sessionError = { code };
      const response = await POST(post(idea(["mposition/Tomverse"])));
      assert.equal(response.status, status, code);
      assert.deepEqual(await response.json(), { error: code });
    }
    world.sessionError = { code: "key_store_unavailable" };
    const keyStore = await POST(post(idea(["mposition/Tomverse"])));
    assert.equal(keyStore.status, 503);
    assert.equal((await keyStore.json()).error, "outcome_unknown",
      "a key store failure is read back, as on the v4 path");
    world.sessionError = { code: "outcome_unknown", readBack: "unavailable" };
    const unknown = await POST(post(idea(["mposition/Tomverse"])));
    assert.equal(unknown.status, 503);
    assert.deepEqual(await unknown.json(), { error: "outcome_unknown", readBack: "unavailable" });
    world.sessionError = null;
  }));

test("the read-back finds a session idea the owner path does not know", () =>
  withSwitches(SWITCHES, async () => {
    world.seen = { requestId, status: "committed", ideaId: "session-idea",
      reservationId: "r", hasExternalSources: true };
    const { GET } = await loadRoute();
    const response = await GET(new Request(
      `https://tomverse.test/api/admin/amux/ideas/submissions?requestId=${requestId}`));
    assert.deepEqual(await response.json(), { requestId, status: "committed",
      ideaId: "session-idea", origin: "session", hasExternalSources: true });
    world.seen = { status: "absent" };
  }));

test("a session idea reads back as committed even when the v4 owner read sees its row as partial", () =>
  withSwitches(SWITCHES, async () => {
    world.owned = { requestId, status: "partial", ideaId: "session-idea" };
    world.seen = { requestId, status: "committed", ideaId: "session-idea",
      reservationId: "r", hasExternalSources: true };
    try {
      const { GET } = await loadRoute();
      const response = await GET(new Request(
        `https://tomverse.test/api/admin/amux/ideas/submissions?requestId=${requestId}`));
      assert.deepEqual(await response.json(), { requestId, status: "committed",
        ideaId: "session-idea", origin: "session", hasExternalSources: true });
    } finally {
      world.owned = { requestId, status: "absent" };
      world.seen = { status: "absent" };
    }
  }));

test("a row that is not a session idea still reads back through the v4 owner path", () =>
  withSwitches(SWITCHES, async () => {
    world.owned = { requestId, status: "committed", ideaId: "v4-idea" };
    try {
      const { GET } = await loadRoute();
      const response = await GET(new Request(
        `https://tomverse.test/api/admin/amux/ideas/submissions?requestId=${requestId}`));
      assert.deepEqual(await response.json(), { requestId, status: "committed", ideaId: "v4-idea" });
    } finally { world.owned = { requestId, status: "absent" }; }
  }));

test("with session intake off, the Admin input keeps the v4 owner path", () =>
  withSwitches({ TOMVERSE_AMUX_V4_IDEA_SUBMIT: "enabled",
    TOMVERSE_AMUX_V4_IDEA_READBACK: "enabled" }, async () => {
    world.sessionCalls = []; world.v4Calls = 0;
    const { POST } = await loadRoute();
    const response = await POST(post(idea(["mposition/Tomverse"])));
    assert.equal(response.status, 201);
    assert.equal((await response.json()).origin, undefined);
    assert.equal(world.v4Calls, 1);
    assert.equal(world.sessionCalls.length, 0);
  }));
