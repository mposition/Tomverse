import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, beforeEach, mock, test } from "node:test";

// Admin › Routing's "send to AMUX": while session intake is on a recommendation
// enters as a session idea, so it is analysed and reaches the workers; with it
// off it stays a v4 idea; and however often it is sent there is one idea.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;

class SessionError extends Error {
  constructor(readonly code: string, readonly readBack?: string, readonly ideaId?: string) { super(code); }
}
class V4Error extends Error {
  status = 409;
  ideaId?: string;
  constructor(readonly code: string) { super(code); }
}

type ReadBack = { status: "absent" } | { status: "partial" | "committed"; ideaId: string };
const world = {
  status: "open",
  amuxIdeaId: null as string | null,
  reservations: 0,
  closes: [] as string[],
  sessionCalls: [] as { inspected: { requestId: string; input: { idea: string; repositories: string[] };
    source: Record<string, string> } }[],
  v4Calls: [] as { inspected: { input: { idea: string; repositories: string[] } } }[],
  sessionError: null as SessionError | null,
  sessionSeen: { status: "absent" } as ReadBack,
  sessionSeenNext: [] as ReadBack[],
  v4Seen: { status: "absent" } as ReadBack,
};

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
  readLimitedJson: async (request: Request, _limit: number, schema: { parse: (value: unknown) => unknown }) =>
    schema.parse(await request.json()) } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/autoRouterRecommendations.ts"), { namedExports: {
  readRecommendationForSend: async () => ({
    recommendation: { kind: "code", text: "Retry failed answers on a same-credit model.",
      status: world.status, amuxIdeaId: world.amuxIdeaId },
    findings: ["answer calls failed for two models"],
    createdAt: "2026-11-04T00:00:00.000Z",
  }),
  reserveRecommendationForAmux: async () => {
    world.reservations += 1;
    if (world.status !== "open" && world.status !== "sending_to_amux") return false;
    world.status = "sending_to_amux";
    return true;
  },
  markRecommendationSentToAmux: async (_actor: unknown, input: { ideaId: string }) => {
    world.closes.push(input.ideaId);
    if (world.status !== "sending_to_amux") return false;
    world.status = "sent_to_amux";
    world.amuxIdeaId = input.ideaId;
    return true;
  },
} });
mock.module(mod("lib/amux/ideaSubmissionService.ts"), { namedExports: {
  IdeaSubmissionError: V4Error,
  submitIdea: async (input: (typeof world.v4Calls)[number]) => {
    world.v4Calls.push(input);
    world.v4Seen = { status: "committed", ideaId: "v4-idea" };
    return { ideaId: "v4-idea" };
  },
  readIdeaSubmissionByDerivedRequestId: async () => world.v4Seen } });
mock.module(mod("lib/amux/ideaSessionSubmissionService.ts"), { namedExports: {
  AmuxIdeaSessionSubmissionError: SessionError,
  submitAmuxIdeaFromSession: async (input: (typeof world.sessionCalls)[number]) => {
    world.sessionCalls.push(input);
    if (world.sessionError) throw world.sessionError;
    world.sessionSeen = { status: "committed", ideaId: "session-idea" };
    return { ideaId: "session-idea" };
  },
  readAmuxIdeaSessionSubmissionRequest: async () => world.sessionSeenNext.shift() ?? world.sessionSeen } });

let POST: (request: Request) => Promise<Response>;
before(async () => {
  ({ POST } = await import(mod("app/api/admin/auto-llm-router/optimizer/recommendations/send/route.ts")));
});

const SWITCHES = ["TOMVERSE_AMUX_SESSION_INTAKE", "TOMVERSE_AMUX_SESSION_INTAKE_READBACK",
  "TOMVERSE_AMUX_V4_IDEA_SUBMIT", "TOMVERSE_AMUX_V4_IDEA_READBACK"];
const setSwitches = (sessionIntake: "enabled" | "disabled") => {
  for (const name of SWITCHES) process.env[name] = "enabled";
  process.env.TOMVERSE_AMUX_SESSION_INTAKE = sessionIntake;
};
const send = () => POST(new Request("https://tomverse.test/api/admin/auto-llm-router/optimizer/recommendations/send", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ cycleId: "cycle-1", index: 1 }),
}));

beforeEach(() => {
  Object.assign(world, { status: "open", amuxIdeaId: null, reservations: 0, closes: [], sessionCalls: [],
    v4Calls: [], sessionError: null, sessionSeen: { status: "absent" }, sessionSeenNext: [], v4Seen: { status: "absent" } });
  setSwitches("enabled");
});

test("with session intake on, a recommendation enters as a session idea naming this repository", async () => {
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "sent", amuxIdeaId: "session-idea" });
  assert.equal(world.v4Calls.length, 0);
  const { inspected } = world.sessionCalls[0];
  assert.deepEqual(inspected.input.repositories, ["mposition/Tomverse"]);
  assert.deepEqual(inspected.source, { toolName: "tomverse-admin", modelProvider: "operator",
    sessionDisplay: "Auto router recommendation" });
  assert.ok(inspected.input.idea.includes("Retry failed answers on a same-credit model."));
  assert.ok(inspected.input.idea.includes("/admin/routing#optimizer-cycle-cycle-1"));
  assert.deepEqual(world.closes, ["session-idea"]);
});

test("with session intake off, a recommendation stays a v4 idea", async () => {
  setSwitches("disabled");
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "sent", amuxIdeaId: "v4-idea" });
  assert.equal(world.sessionCalls.length, 0);
  assert.deepEqual(world.v4Calls[0].inspected.input.repositories, []);
  assert.deepEqual(world.closes, ["v4-idea"]);
});

test("sending again makes no second idea, whichever way the first one went", async () => {
  assert.equal((await send()).status, 200);
  const again = await send();
  assert.deepEqual(await again.json(), { status: "sent", amuxIdeaId: "session-idea" });
  assert.equal(world.sessionCalls.length, 1);
  assert.equal(world.closes.length, 1);

  // The idea was made but the process stopped before the recommendation closed.
  Object.assign(world, { status: "sending_to_amux", amuxIdeaId: null, closes: [] });
  assert.deepEqual(await (await send()).json(), { status: "sent", amuxIdeaId: "session-idea" });
  assert.equal(world.sessionCalls.length, 1);
  assert.deepEqual(world.closes, ["session-idea"]);

  // A session idea is still found once session intake has been turned off.
  Object.assign(world, { status: "sending_to_amux", amuxIdeaId: null, closes: [] });
  setSwitches("disabled");
  assert.deepEqual(await (await send()).json(), { status: "sent", amuxIdeaId: "session-idea" });
  assert.equal(world.v4Calls.length, 0);
});

test("a send that loses the request-id race reads the winner's idea back", async () => {
  world.sessionError = new SessionError("request_already_seen", "committed", "winner-idea");
  world.sessionSeenNext = [{ status: "absent" }, { status: "committed", ideaId: "winner-idea" }];
  assert.deepEqual(await (await send()).json(), { status: "sent", amuxIdeaId: "winner-idea" });
  assert.deepEqual(world.closes, ["winner-idea"]);
});

test("a refusal before the write says why with a code the panel reads, and the send can be retried", async () => {
  for (const [code, status] of [["outside_scope", 409], ["scope_unavailable", 409],
    ["model_not_approved", 409], ["reference_snapshot_unavailable", 503]] as const) {
    world.sessionError = new SessionError(code);
    const response = await send();
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: code, code });
    assert.equal(world.status, "sending_to_amux");
    assert.deepEqual(world.closes, []);
  }
  world.sessionError = null;
  assert.deepEqual(await (await send()).json(), { status: "sent", amuxIdeaId: "session-idea" });
});

test("an uncertain write answers outcome_unknown and leaves the recommendation unsent", async () => {
  world.sessionError = new SessionError("key_store_unavailable");
  const response = await send();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "outcome_unknown", code: "outcome_unknown" });
  assert.equal(world.status, "sending_to_amux");
  assert.deepEqual(world.closes, []);
});

test("a recommendation AMUX would refuse is not reserved", async () => {
  const previous = process.env.NEXT_PUBLIC_SHARE_BASE_URL;
  process.env.NEXT_PUBLIC_SHARE_BASE_URL = "http://localhost:3000";
  try {
    const response = await send();
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "content_refused" });
    assert.equal(world.reservations, 0);
    assert.equal(world.sessionCalls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SHARE_BASE_URL;
    else process.env.NEXT_PUBLIC_SHARE_BASE_URL = previous;
  }
});

test("with idea submission off nothing is reserved or sent", async () => {
  process.env.TOMVERSE_AMUX_V4_IDEA_SUBMIT = "disabled";
  const response = await send();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "amux_submission_disabled" });
  assert.equal(world.reservations, 0);
});
