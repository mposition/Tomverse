import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// A refusal that leaves no record is diagnosed by screenshot.
//
// `WEB_SEARCH_COST_UNBOUNDED` used to write nothing: its code is not a
// cost-safety code, so the routes' `chat_cost_safety_rejected` log skipped it,
// and the chat route raises it before `acquireChatAccess`, which is what
// writes `ChatLimitDecisionEvent`. A user reported it with the Trace ID the UI
// showed them and that trace resolved to nothing.
//
// This drives the real preflight handler into the refusal and asserts a
// decision row is written for it, carrying the reason. The trigger is the one
// path that is genuinely reachable now that OpenAI's ceiling exists: the
// per-process latch a breached ceiling sets.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "server-contract-test-secret";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

type DecisionCall = {
  traceId: string;
  phase: string;
  decision: string;
  errorCode: string | null;
  limitScope: string | null;
  modelIds: string[];
  enabledTools: string[];
  subjectKey: string;
  plan: string;
};

const decisions: DecisionCall[] = [];

const original = (relativePath: string) =>
  require(resolve(ROOT, relativePath)) as Record<string, unknown>;

const realApiSecurity = original("lib/apiSecurity.ts");
const realLimitDecisions = original("lib/chatLimitDecisions.ts");

// The seam under test. Spied rather than stubbed away: what is asserted is
// that the route reaches it at all, and with what.
mock.module(mod("lib/chatLimitDecisions.ts"), {
  namedExports: {
    ...realLimitDecisions,
    recordChatLimitDecision: async (input: {
      traceId: string;
      phase: string;
      decision: string;
      errorCode?: string | null;
      limitScope?: string | null;
      models: { modelId: string }[];
      enabledTools: string[];
      subjectKey: string;
      plan: string;
    }) => {
      decisions.push({
        traceId: input.traceId,
        phase: input.phase,
        decision: input.decision,
        errorCode: input.errorCode ?? null,
        limitScope: input.limitScope ?? null,
        modelIds: input.models.map((model) => model.modelId),
        enabledTools: input.enabledTools,
        subjectKey: input.subjectKey,
        plan: input.plan,
      });
      return {} as never;
    },
  },
});

// A database write, and this suite runs without one.
mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => undefined },
});

// Guest: the refusal under test is not plan-dependent, and all three models
// below are guest-selectable.
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => null },
});

const LUNA = "gpt-5-6-luna";
const HAIKU = "claude-haiku-4-5";

const preflightRoute = async () =>
  (await import(
    `${mod("app/api/chat/preflight/route.ts")}?refusal=cached`
  )) as { POST: (request: Request) => Promise<Response> };

const TRACE = "5c1d9f22-3a4e-4c77-9b10-6f0e2d8a4b31";

const preflightRequest = (webSearchMode?: string) =>
  new Request("http://127.0.0.1:3100/api/chat/preflight", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-Request-ID": TRACE,
    },
    body: JSON.stringify({
      comparisonId: "1754000000009",
      conversationId: "private-chat",
      modelIds: [LUNA, HAIKU],
      prompt: "what happened today?",
      attachments: [],
      ...(webSearchMode ? { webSearchMode } : {}),
    }),
  });

const reservation = async () =>
  (await import(
    mod("lib/webSearchNativeCostReservation.ts")
  )) as typeof import("../../lib/webSearchNativeCostReservation");

test("a breached ceiling refuses the turn and the refusal is recorded", async () => {
  const { recordSearchQueryCeilingBreach, resetSearchQueryCeilingBreaches } =
    await reservation();
  const { POST } = await preflightRoute();
  decisions.length = 0;
  resetSearchQueryCeilingBreaches();
  // What a provider billing more searches than it was authorized leaves
  // behind. Nothing else in normal operation reaches this refusal now that
  // OpenAI declares a ceiling.
  recordSearchQueryCeilingBreach("openai");

  try {
    const response = await POST(preflightRequest("always"));
    const body = (await response.json()) as { code?: string; traceId?: string };

    assert.equal(response.status, 503);
    assert.equal(body.code, "WEB_SEARCH_COST_UNBOUNDED");

    assert.equal(decisions.length, 1, "the refusal must be recorded exactly once");
    const [row] = decisions;
    assert.equal(row.traceId, TRACE, "recorded under the trace the user is shown");
    assert.equal(row.phase, "comparison_preflight");
    assert.equal(row.decision, "rejected");
    assert.equal(row.errorCode, "WEB_SEARCH_COST_UNBOUNDED");
    // The whole reason the row exists: three refusals look identical on screen
    // and this is what tells them apart afterwards.
    assert.equal(row.limitScope, "search_query_ceiling_breached");
    assert.deepEqual(row.modelIds, [LUNA, HAIKU], "an all-or-nothing preflight blocked both");
    assert.deepEqual(row.enabledTools, ["web_search"]);
    assert.ok(row.subjectKey.length > 0, "recorded against a subject");
  } finally {
    resetSearchQueryCeilingBreaches();
  }
});

test("a turn that is not searching is neither refused nor recorded", async () => {
  const { recordSearchQueryCeilingBreach, resetSearchQueryCeilingBreaches } =
    await reservation();
  const { POST } = await preflightRoute();
  decisions.length = 0;
  resetSearchQueryCeilingBreaches();
  // The latch is about searching, not about the model: web search off attaches
  // no tool, so there is nothing to bound and nothing to refuse.
  recordSearchQueryCeilingBreach("openai");

  try {
    const response = await POST(preflightRequest());
    const body = (await response.json()) as { code?: string };
    assert.notEqual(body.code, "WEB_SEARCH_COST_UNBOUNDED");
    assert.equal(
      decisions.some((row) => row.errorCode === "WEB_SEARCH_COST_UNBOUNDED"),
      false,
      "no refusal, so no refusal row"
    );
  } finally {
    resetSearchQueryCeilingBreaches();
  }
});
