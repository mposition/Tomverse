import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const authStarts: number[] = [];
const observations: Array<{ requestedAt: number; remainingMs: number }> = [];
let release = { explicitEnabled: true, autoEnabled: true };

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => {
    authStarts.push(Date.now());
    await new Promise(resolve => setTimeout(resolve, 30));
    return { user: { id: "owner" } };
  },
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
  hasValidMutationOrigin: () => true,
} });
mock.module(mod("lib/e2eTestMode.ts"), { namedExports: {
  isE2EFixtureMode: () => false,
} });
mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), { namedExports: {
  promptRefinerChatExecutionRelease: async () => release,
} });
mock.module(mod("lib/promptRefinerProductApi.ts"), { namedExports: {
  handlePromptRefinerProductPrepare: async (_request: Request, _userId: string,
    deadline: { requestedAt: Date; deadlineAtMonotonicMs: number }) => {
    observations.push({ requestedAt: deadline.requestedAt.getTime(),
      remainingMs: deadline.deadlineAtMonotonicMs - performance.now() });
    return Response.json({ ok: true });
  },
  handlePromptRefinerProductProposal: async (_request: Request, _userId: string,
    deadline: { requestedAt: Date; deadlineAtMonotonicMs: number }) => {
    observations.push({ requestedAt: deadline.requestedAt.getTime(),
      remainingMs: deadline.deadlineAtMonotonicMs - performance.now() });
    return Response.json({ ok: true });
  },
  promptRefinerProductApiErrorResponse: () => null,
} });

const prepareRoute = import(mod("app/api/chat/prompt-refiner/prepare/route.ts"));
const proposalRoute = import(mod("app/api/chat/prompt-refiner/proposal/route.ts"));
const request = (path: string) => new Request(`https://tomverse.test${path}`, {
  method: "POST", headers: { origin: "https://tomverse.test",
    "content-type": "application/json" }, body: "{}",
});

test("product route deadline starts before authentication", async () => {
  const prepare = await prepareRoute; const proposal = await proposalRoute;
  assert.equal((await prepare.POST(request(
    "/api/chat/prompt-refiner/prepare"))).status, 200);
  assert.equal((await proposal.POST(request(
    "/api/chat/prompt-refiner/proposal"))).status, 200);
  assert.equal(observations.length, 2);
  for (const [index, observation] of observations.entries()) {
    assert.ok(observation.requestedAt <= authStarts[index]!);
    assert.ok(observation.remainingMs < 12_990,
      `authentication did not consume the product deadline: ${observation.remainingMs}`);
    assert.ok(observation.remainingMs > 12_000);
  }
});

test("closed mode authority refuses before authentication and body access", async () => {
  const prepare = await prepareRoute; const proposal = await proposalRoute;
  const authCount = authStarts.length;
  const handlerCount = observations.length;
  const unreadable = {
    get body() { throw new Error("closed route read request body"); },
    json: async () => { throw new Error("closed route parsed JSON"); },
    text: async () => { throw new Error("closed route parsed text"); },
  } as unknown as Request;
  release = { explicitEnabled: false, autoEnabled: false };
  const proposalResponse = await proposal.POST(unreadable);
  const prepareResponse = await prepare.POST(unreadable);
  assert.equal(proposalResponse.status, 503);
  assert.deepEqual(await proposalResponse.json(), {
    code: "PROMPT_REFINER_UNAVAILABLE",
  });
  assert.deepEqual(await prepareResponse.json(), {
    outcome: "original_fallback", reason: "unavailable",
  });
  assert.equal(authStarts.length, authCount);
  assert.equal(observations.length, handlerCount);
});

test("release pre-admission checks explicit and Auto authority separately", async () => {
  const prepare = await prepareRoute; const proposal = await proposalRoute;
  const unreadable = {
    get body() { throw new Error("closed mode read request body"); },
    json: async () => { throw new Error("closed mode parsed JSON"); },
    text: async () => { throw new Error("closed mode parsed text"); },
  } as unknown as Request;

  release = { explicitEnabled: true, autoEnabled: false };
  assert.equal((await proposal.POST(request(
    "/api/chat/prompt-refiner/proposal"))).status, 200);
  const afterExplicit = { auth: authStarts.length, handler: observations.length };
  assert.deepEqual(await (await prepare.POST(unreadable)).json(), {
    outcome: "original_fallback", reason: "unavailable",
  });
  assert.deepEqual({ auth: authStarts.length, handler: observations.length },
    afterExplicit);

  release = { explicitEnabled: false, autoEnabled: true };
  assert.equal((await proposal.POST(unreadable)).status, 503);
  assert.deepEqual({ auth: authStarts.length, handler: observations.length },
    afterExplicit);
  assert.equal((await prepare.POST(request(
    "/api/chat/prompt-refiner/prepare"))).status, 200);
  assert.deepEqual({ auth: authStarts.length, handler: observations.length }, {
    auth: afterExplicit.auth + 1, handler: afterExplicit.handler + 1,
  });
});
