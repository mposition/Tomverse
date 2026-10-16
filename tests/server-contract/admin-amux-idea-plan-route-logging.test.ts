import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// POST /api/admin/amux/ideas/plan: every answer that is not a 201 leaves one structured log line with a
// code and a status, so a refusal that reaches a browser that already gave up is visible in production.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;
class FakePlanError extends Error {
  draftUnitIds = ["unit-1"];
  constructor(readonly code: string) { super(code); }
}
class FakeCodeError extends Error {
  constructor(readonly code: string) { super(code); }
}
class FakeDuplicateReason extends Error {
  candidateIds = ["candidate-1"];
  constructor(readonly code = "duplicate_reason_required") { super(code); }
}
class ReauthError extends Error {}

const world = {
  session: { user: { id: "owner-1" } } as { user: { id: string } } | null,
  role: "owner", origin: true, writeOn: true, text: "{}",
  approve: async (): Promise<unknown> => ({ ideaId: "i" }),
  security: null as Response | null,
  recentError: null as Error | null,
};
let installed = false;

async function route(): Promise<{ POST: (request: Request) => Promise<Response> }> {
  if (!installed) {
    installed = true;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => world.session } });
    mock.module(mod("lib/adminAuth.ts"), { namedExports: {
      isAdminSession: () => world.session !== null, getAdminRole: () => world.role,
    } });
    mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
      assertRecentAdminAuthentication: async () => { if (world.recentError) throw world.recentError; },
      isAdminReauthenticationError: (error: unknown) => error instanceof ReauthError,
    } });
    mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
      apiSecurityResponse: (error: unknown) => (error instanceof Error && error.message === "security" ? world.security : null),
      consumeApiRateLimit: async () => undefined,
      readLimitedText: async () => world.text,
    } });
    mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
    mock.module(mod("lib/requestOrigin.ts"), { namedExports: { hasValidMutationOrigin: () => world.origin } });
    mock.module(mod("lib/amux/ideaCardPlanApprovalService.ts"), { namedExports: { AmuxV4CardPlanError: FakePlanError } });
    mock.module(mod("lib/amux/ideaNodePlanApprovalService.ts"), { namedExports: { AmuxV4NodePlanError: class extends Error {} } });
    mock.module(mod("lib/amux/ideaPlanApprovalService.ts"), { namedExports: {
      AmuxV4PlanError: class extends Error {},
      approveAmuxV4Plan: async () => world.approve(),
    } });
    mock.module(mod("lib/amux/ideaUnitDecisionStore.ts"), { namedExports: {
      AMUX_V4_UNIT_WRITE_ENV: "UNIT_WRITE_TEST",
      AmuxV4DuplicateReasonRequired: FakeDuplicateReason,
      AmuxV4UnitDecisionError: FakeCodeError,
      amuxV4UnitWriteEnabled: () => world.writeOn,
    } });
    mock.module(mod("lib/amux/portfolioAssessmentService.ts"), { namedExports: { AmuxPortfolioError: class PortfolioError extends Error {
      constructor(readonly code: string) { super(code); }
    } } });
  }
  return import(mod("app/api/admin/amux/ideas/plan/route.ts"));
}

const validBody = JSON.stringify({
  ideaId: "idea-0001", planRequestId: "123e4567-e89b-42d3-a456-426614174000",
  expectedUnitIds: ["unit-0001"],
});
const post = (contentType = "application/json") => new Request("https://tomverse.test/api/admin/amux/ideas/plan", {
  method: "POST", headers: { "content-type": contentType }, body: world.text,
});
const reset = () => {
  world.session = { user: { id: "owner-1" } }; world.role = "owner"; world.origin = true; world.writeOn = true;
  world.text = validBody; world.approve = async () => ({ ideaId: "i" }); world.security = null; world.recentError = null;
};

async function answer(contentType?: string) {
  const { POST } = await route();
  const lines: Array<Record<string, unknown>> = [];
  const warn = mock.method(console, "warn", (line: unknown) => { lines.push(JSON.parse(String(line))); });
  try {
    const response = await POST(post(contentType));
    return { status: response.status, body: await response.json().catch(() => null), lines };
  } finally { warn.mock.restore(); }
}

test("a 201 logs nothing, and every other answer logs one refusal line with its code and status", async () => {
  reset();
  const ok = await answer();
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.lines, []);

  const cases: Array<[string, () => void, number, string]> = [
    ["no session", () => { world.session = null; }, 404, "not_found"],
    ["not the owner", () => { world.role = "ops"; }, 403, "forbidden"],
    ["bad origin", () => { world.origin = false; }, 403, "forbidden"],
    ["write switch off", () => { world.writeOn = false; }, 503, "unit_write_disabled"],
    ["step-up needed", () => { world.recentError = new ReauthError("stale"); }, 428, "ADMIN_REAUTHENTICATION_REQUIRED"],
    ["not JSON", () => { world.text = "not json"; }, 400, "schema_rejected"],
    ["wrong schema", () => { world.text = "{}"; }, 400, "schema_rejected"],
    ["plan refusal", () => { world.approve = async () => { throw new FakePlanError("plan_stale"); }; }, 409, "plan_stale"],
    ["duplicate reason", () => { world.approve = async () => { throw new FakeDuplicateReason(); }; }, 409, "duplicate_reason_required"],
    ["unit not found", () => { world.approve = async () => { throw new FakeCodeError("not_found"); }; }, 404, "not_found"],
    ["unit forbidden", () => { world.approve = async () => { throw new FakeCodeError("forbidden"); }; }, 403, "forbidden"],
    ["unit not ready", () => { world.approve = async () => { throw new FakeCodeError("not_ready"); }; }, 409, "not_ready"],
    ["v20 task split refusal", () => { world.approve = async () => {
      throw new FakeCodeError("task_expected_paths_mixed");
    }; }, 409, "task_expected_paths_mixed"],
    ["unit unavailable", () => { world.approve = async () => { throw new FakeCodeError("integrity_unavailable"); }; }, 503, "integrity_unavailable"],
  ];
  for (const [label, arrange, status, code] of cases) {
    reset(); arrange();
    const result = await answer();
    assert.equal(result.status, status, label);
    assert.equal(result.body.error, code, label);
    assert.deepEqual(result.lines, [{ subsystem: "amux", event: "idea_plan_approval_refused", code, status }], label);
  }

  reset();
  const wrongType = await answer("text/plain");
  assert.deepEqual([wrongType.status, wrongType.lines], [415,
    [{ subsystem: "amux", event: "idea_plan_approval_refused", code: "content_type_refused", status: 415 }]]);

  reset();
  world.security = new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 });
  world.approve = async () => { throw new Error("security"); };
  const limited = await answer();
  assert.deepEqual([limited.status, limited.lines], [429,
    [{ subsystem: "amux", event: "idea_plan_approval_refused", code: "api_security", status: 429 }]]);
});

test("an unknown outcome logs its class and SQLSTATE, never the message", async () => {
  reset();
  world.approve = async () => {
    throw Object.assign(new Error("password=hunter2 SELECT secret"), { name: "PrismaClientKnownRequestError", code: "P2028",
      cause: { code: "25P03" } });
  };
  const result = await answer();
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: "outcome_unknown", retryWrite: false });
  assert.deepEqual(result.lines, [{ subsystem: "amux", event: "idea_plan_approval_unknown", code: "outcome_unknown",
    status: 503, name: "PrismaClientKnownRequestError", sqlState: "25P03" }]);
  assert.equal(JSON.stringify(result.lines).includes("hunter2"), false);
});
