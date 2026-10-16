import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

import { AMUX_V20_TASK_REGISTRATION_REFUSAL_CODES } from
  "../../lib/amux/ideaUnitRegistrationCore.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

class FakeCodeError extends Error {
  constructor(readonly code: string) { super(code); }
}
class FakePlanError extends Error {
  readonly draftUnitIds: string[] = [];
  constructor(readonly code: string) { super(code); }
}

let refusalCode = "task_expected_paths_missing";

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => ({ user: { id: "owner-1" } }),
} });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => true,
  getAdminRole: () => "owner",
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => undefined,
  isAdminReauthenticationError: () => false,
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  apiSecurityResponse: () => null,
  consumeApiRateLimit: async () => undefined,
  readLimitedText: async (request: Request) => request.text(),
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
  hasValidMutationOrigin: () => true,
} });
mock.module(mod("lib/amux/ideaUnitDecisionStore.ts"), { namedExports: {
  AMUX_V4_UNIT_WRITE_ENV: "UNIT_WRITE_TEST",
  AmuxV4DuplicateReasonRequired: class extends FakeCodeError {},
  AmuxV4UnitDecisionError: FakeCodeError,
  amuxV4UnitWriteEnabled: () => true,
} });
mock.module(mod("lib/amux/ideaUnitBrowserCore.ts"), { namedExports: {
  readAmuxV4UnitBrowserNonce: () => "browser-nonce",
  amuxV4UnitBrowserCookieName: () => "amux-browser-nonce",
  newAmuxV4UnitBrowserNonce: () => "browser-nonce",
} });
mock.module(mod("lib/amux/ideaStoryRegistrationService.ts"), { namedExports: {
  consumeAmuxV4StoryRegistration: async () => { throw new FakeCodeError(refusalCode); },
  prepareAmuxV4StoryRegistration: async () => { throw new FakeCodeError(refusalCode); },
} });
mock.module(mod("lib/amux/ideaCardPlanApprovalService.ts"), { namedExports: {
  AmuxV4CardPlanError: FakePlanError,
  approveAmuxV4CardPlan: async () => { throw new FakeCodeError(refusalCode); },
} });

const loadRoutes = async () => Promise.all([
  import(mod("app/api/admin/amux/ideas/unit-decisions/prepare/route.ts")) as
    Promise<{ POST(request: Request): Promise<Response> }>,
  import(mod("app/api/admin/amux/ideas/unit-decisions/consume/route.ts")) as
    Promise<{ POST(request: Request): Promise<Response> }>,
  import(mod("app/api/admin/amux/ideas/unit-decisions/cards/plan/route.ts")) as
    Promise<{ POST(request: Request): Promise<Response> }>,
]);

const prepareRequest = () => new Request("https://tomverse.test/api/admin/amux/ideas/unit-decisions/prepare", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ideaId: "idea-0001",
    draftUnitId: "draft-0001",
    featureNodeId: "feature-0001",
    prepareRequestId: "123e4567-e89b-42d3-a456-426614174000",
    cardType: "task",
    publicPrDisclosureApproved: false,
    decisionReason: null,
  }),
});

const unitRequest = () => new Request("https://tomverse.test/api/admin/amux/ideas/unit-decisions/consume", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: "nonce=opaque" },
  body: JSON.stringify({
    decisionId: "decision-0001",
    consumeRequestId: "123e4567-e89b-42d3-a456-426614174000",
    confirmationDigest: "a".repeat(64),
  }),
});

const planRequest = () => new Request("https://tomverse.test/api/admin/amux/ideas/unit-decisions/cards/plan", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ideaId: "idea-0001", reasons: {}, publicPrConsentOff: [] }),
});

test("prepare, consume and plan routes return every stable v20 refusal without proposal data", async () => {
  const [prepareRoute, unitRoute, planRoute] = await loadRoutes();
  for (const code of AMUX_V20_TASK_REGISTRATION_REFUSAL_CODES) {
    refusalCode = code;
    for (const [label, response] of [
      ["prepare", await prepareRoute.POST(prepareRequest())],
      ["single", await unitRoute.POST(unitRequest())],
      ["plan", await planRoute.POST(planRequest())],
    ] as const) {
      const body = await response.json();
      assert.equal(response.status, 409, `${label}:${code}`);
      assert.deepEqual(body, { error: code, retryWrite: false }, `${label}:${code}`);
    }
  }
});
