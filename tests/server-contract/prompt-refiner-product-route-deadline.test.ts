import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const cjsRequire = createRequire(import.meta.url);
const authStarts: number[] = [];
const observations: Array<{ requestedAt: number; remainingMs: number }> = [];
const admissionEvents: string[] = [];
const caughtErrors: unknown[] = [];
let authenticated = true;
let validOrigin = true;
let releaseReads = 0;

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => {
    authStarts.push(Date.now());
    admissionEvents.push("auth");
    await new Promise(resolve => setTimeout(resolve, 30));
    return authenticated ? { user: { id: "owner" } } : null;
  },
} });
const authExports = { authOptions: {} };
const requestOriginExports = {
  hasValidMutationOrigin: () => {
    admissionEvents.push("origin");
    return validOrigin;
  },
};
mock.module(mod("lib/e2eTestMode.ts"), { namedExports: {
  isE2EFixtureMode: () => false,
} });
mock.module(mod("lib/promptRefinerChatExecutionRelease.ts"), { namedExports: {
  promptRefinerChatExecutionRelease: async () => {
    releaseReads += 1;
    return { explicitEnabled: true, autoEnabled: true };
  },
} });
const productApiExports = {
  handlePromptRefinerProductPrepare: async (_request: Request, _userId: string,
    deadline: { requestedAt: Date; deadlineAtMonotonicMs: number }) => {
    admissionEvents.push("prepare-handler");
    observations.push({ requestedAt: deadline.requestedAt.getTime(),
      remainingMs: deadline.deadlineAtMonotonicMs - performance.now() });
    return Response.json({ ok: true });
  },
  handlePromptRefinerProductProposal: async (_request: Request, _userId: string,
    deadline: { requestedAt: Date; deadlineAtMonotonicMs: number }) => {
    admissionEvents.push("proposal-handler");
    observations.push({ requestedAt: deadline.requestedAt.getTime(),
      remainingMs: deadline.deadlineAtMonotonicMs - performance.now() });
    return Response.json({ ok: true });
  },
  promptRefinerProductApiErrorResponse: (error: unknown) => {
    caughtErrors.push(error);
    return null;
  },
};
// tsx loads .ts files as CommonJS in this package. Install an ES-module-shaped
// CommonJS fixture so both static and dynamic imports receive the same exports.
const installCommonJsFixture = (specifier: string, exports: object) => {
  const filename = cjsRequire.resolve(specifier);
  const fixture = new Module(filename);
  fixture.filename = filename;
  fixture.loaded = true;
  fixture.exports = { __esModule: true, ...exports };
  cjsRequire.cache[filename] = fixture;
};
installCommonJsFixture("@/lib/auth", authExports);
installCommonJsFixture("@/lib/requestOrigin", requestOriginExports);
installCommonJsFixture("@/lib/promptRefinerProductApi", productApiExports);

const prepareRoute = import(mod("app/api/chat/prompt-refiner/prepare/route.ts"));
const proposalRoute = import(mod("app/api/chat/prompt-refiner/proposal/route.ts"));
const request = (path: string) => new Request(`https://tomverse.test${path}`, {
  method: "POST", headers: { origin: "https://tomverse.test",
    "content-type": "application/json" }, body: "{}",
});
const failureSummary = () => JSON.stringify({ admissionEvents,
  observationCount: observations.length,
  caughtErrors: caughtErrors.map((error) =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
});

test("product route deadline starts before authentication", async () => {
  const prepare = await prepareRoute;
  const proposal = await proposalRoute;
  admissionEvents.length = 0;
  assert.equal((await prepare.POST(request(
    "/api/chat/prompt-refiner/prepare"))).status, 200,
  failureSummary());
  assert.equal((await proposal.POST(request(
    "/api/chat/prompt-refiner/proposal"))).status, 200,
  failureSummary());
  assert.equal(observations.length, 2);
  assert.deepEqual(admissionEvents, [
    "auth", "origin", "prepare-handler",
    "auth", "origin", "proposal-handler",
  ]);
  for (const [index, observation] of observations.entries()) {
    assert.ok(observation.requestedAt <= authStarts[index]!);
    assert.ok(observation.remainingMs < 12_990,
      `authentication did not consume the product deadline: ${observation.remainingMs}`);
    assert.ok(observation.remainingMs > 12_000);
  }
});

test("unauthenticated requests do not enter product admission or read release evidence", async () => {
  const prepare = await prepareRoute;
  const proposal = await proposalRoute;
  const authCount = authStarts.length;
  const handlerCount = observations.length;
  const releaseCount = releaseReads;
  authenticated = false;
  assert.equal((await proposal.POST(request(
    "/api/chat/prompt-refiner/proposal"))).status, 401);
  assert.equal((await prepare.POST(request(
    "/api/chat/prompt-refiner/prepare"))).status, 401);
  authenticated = true;
  assert.equal(authStarts.length, authCount + 2);
  assert.equal(observations.length, handlerCount);
  assert.equal(releaseReads, releaseCount);
});

test("invalid mutation origins do not enter product admission or read release evidence", async () => {
  const prepare = await prepareRoute;
  const proposal = await proposalRoute;
  const handlerCount = observations.length;
  const releaseCount = releaseReads;
  validOrigin = false;
  assert.equal((await proposal.POST(request(
    "/api/chat/prompt-refiner/proposal"))).status, 403,
  failureSummary());
  assert.equal((await prepare.POST(request(
    "/api/chat/prompt-refiner/prepare"))).status, 403);
  validOrigin = true;
  assert.equal(observations.length, handlerCount);
  assert.equal(releaseReads, releaseCount);
});
