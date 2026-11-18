import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let authorized = false;
let startReachedService = false;
let permitStart = false;
let readbackCalls = 0;
let heartbeatCalls = 0;
let settleCalls = 0;
let settleInput: unknown = null;
let startInput: { publicationBaseSha?: string | null } | null = null;
let developHead: () => Promise<string> = async () => "a".repeat(40);
const noStore = (body: unknown, status = 200) => new Response(
  JSON.stringify(body), { status, headers: { "Cache-Control": "no-store" } });
const unexpected = () => { startReachedService = true;
  throw new Error("dark v22 execution reached a service"); };

mock.module(mod("lib/amux/guard.ts"), { namedExports: {
  isAmuxSyncAuthorized: () => authorized,
} });
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS: 12_000,
  withAmuxRouteBudget: (work: () => Promise<Response>) => work(),
} });
mock.module(mod("lib/amux/v22ChangedPathsStore.ts"), { namedExports: {
  // The settle route's size allowance and named list read the database: no
  // patch or list recorded here, and a body that names none.
  amuxV22NamedChangedPathsSchema: {
    changed_paths_digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    changed_paths_count: z.number().int().min(0).optional(),
  },
  amuxV22SettlementAllowanceMs: async () => 0,
  resolveAmuxV22NamedChangedPaths: async () => ({ kind: "absent" }),
} });
mock.module(mod("lib/amux/execution.ts"), { namedExports: {
  AMUX_V22_CHANGED_PATHS_UNRECORDED: "changed_paths_unrecorded",
  startAmuxV22TaskExecution: async (input: { publicationBaseSha?: string | null }) => {
    startReachedService = true;
    startInput = input;
    assert.equal(permitStart, true, "an unpermitted start reached a service");
    return { started: true,
      attemptId: "00000000-0000-4000-8000-000000000003",
      taskRevision: 2,
      leaseExpiresAt: new Date("2026-10-10T12:00:00Z") };
  },
  readAmuxV22TaskExecution: async () => { readbackCalls += 1;
    return { found: true, state: "not_started" }; },
  heartbeatAmuxV22TaskExecution: async () => { heartbeatCalls += 1;
    return false; },
  settleAmuxV22TaskExecution: async (input: unknown) => { settleCalls += 1;
    settleInput = input;
    return { settled: false, reason: "fenced_out" }; },
} });
class EngineeringAgentGitHubReadError extends Error {
  constructor(readonly code: string) { super(code); }
}
mock.module(mod("lib/engineeringAgentGitHubRead.ts"), { namedExports: {
  EngineeringAgentGitHubReadError,
  readEngineeringAgentDevelopHead: () => developHead(),
} });
mock.module(mod("lib/engineeringAgentStore.ts"), { namedExports: {
  readEngineeringAgentSwitches: async () => ({ publishAllowed: true }),
} });
mock.module(mod("lib/amux/v22PublicPrConsent.ts"), { namedExports: {
  readAmuxV22PublicPrConsent: async () => true,
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  readLimitedJson: async (request: Request, _limit: number,
    schema: { parse: (value: unknown) => unknown }) =>
    schema.parse(JSON.parse(await request.text())),
} });
mock.module(mod("lib/amux/internalRoute.ts"), { namedExports: {
  amuxJsonNoStore: noStore,
  amuxInternalErrorResponse: unexpected,
  isAmuxInputError: () => false,
} });

const routes = Promise.all([
  "start", "heartbeat", "settle", "attempt",
].map(async (name) => {
  const loaded = await import(mod(`app/api/internal/amux/v22/execution/${name}/route.ts`));
  return { name, call: name === "attempt" ? loaded.GET : loaded.POST };
}));

test("v22 routes refuse an unauthenticated call; read-back and fenced attempts answer", async () => {
  {
    startReachedService = false;
    permitStart = false;
    readbackCalls = 0;
    heartbeatCalls = 0;
    settleCalls = 0;
    for (const { name, call } of await routes) {
      authorized = false;
      const body = name === "start" ? {
        task_id: "task-one", assignment_id: "00000000-0000-4000-8000-000000000001",
        worker: "worker-one", instance_id: "00000000-0000-4000-8000-000000000002",
        generation: 1, expected_revision: 1,
      } : {
        attempt_id: "00000000-0000-4000-8000-000000000003",
        worker: "worker-one", instance_id: "00000000-0000-4000-8000-000000000002",
        generation: 1, task_revision: 2,
        ...(name === "settle" ? { outcome: "blocked", invocation_ids: [] } : {}),
      };
      const request = () => new Request(
        `https://tomverse.test/api/internal/amux/v22/execution/${name}` +
          (name === "attempt" ?
            "?assignment_id=00000000-0000-4000-8000-000000000001" +
            "&worker=worker-one&instance_id=00000000-0000-4000-8000-000000000002" +
            "&generation=1" : ""),
        name === "attempt" ? undefined : { method: "POST",
          body: JSON.stringify(body) });
      const unauthorized = await call(request());
      assert.equal(unauthorized.status, 401, name);
      assert.equal(unauthorized.headers.get("cache-control"), "no-store");
      if (name === "start") continue; // the authenticated start is covered below
      authorized = true;
      const answered = await call(request());
      assert.equal(answered.status, name === "attempt" ? 200 : 409, name);
      assert.equal(answered.headers.get("cache-control"), "no-store");
      const result = await answered.json();
      if (name === "heartbeat" || name === "settle")
        assert.equal(result.reason, "fenced_out");
    }
    assert.equal(startReachedService, false);
    assert.equal(readbackCalls, 1);
    assert.equal(heartbeatCalls, 1);
    assert.equal(settleCalls, 1);
  }
});

test("v22 admission reaches start only after authentication", async () => {
  {
    const { call } = (await routes).find(({ name }) => name === "start")!;
    const request = () => new Request(
      "https://tomverse.test/api/internal/amux/v22/execution/start", {
        method: "POST", body: JSON.stringify({
          task_id: "task-one",
          assignment_id: "00000000-0000-4000-8000-000000000001",
          worker: "worker-one",
          instance_id: "00000000-0000-4000-8000-000000000002",
          generation: 1, expected_revision: 1,
        }),
      });
    startReachedService = false;
    permitStart = true;
    authorized = false;
    assert.equal((await call(request())).status, 401);
    assert.equal(startReachedService, false);
    authorized = true;
    const response = await call(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).started, true);
    assert.equal(startReachedService, true);
  }
});

test("v22 start logs why publication was skipped and still starts the Task", async () => {
  const saved = { publication: process.env.TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION };
  process.env.TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION = "enabled";
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (line: string) => { warnings.push(line); });
  try {
    const { call } = (await routes).find(({ name }) => name === "start")!;
    const start = () => call(new Request(
      "https://tomverse.test/api/internal/amux/v22/execution/start", {
        method: "POST", body: JSON.stringify({
          task_id: "task-one",
          assignment_id: "00000000-0000-4000-8000-000000000001",
          worker: "worker-one",
          instance_id: "00000000-0000-4000-8000-000000000002",
          generation: 1, expected_revision: 1,
        }),
      }));
    authorized = true;
    permitStart = true;
    developHead = async () => { throw new EngineeringAgentGitHubReadError("http_error"); };
    assert.equal((await start()).status, 200);
    assert.equal(startInput?.publicationBaseSha, null);
    assert.deepEqual(warnings.map((line) => JSON.parse(line)), [{
      subsystem: "amux", event: "v22_publication_skipped",
      taskId: "task-one", reason: "develop_head_http_error" }]);
    warnings.length = 0;
    developHead = async () => "b".repeat(40);
    assert.equal((await start()).status, 200);
    assert.equal(startInput?.publicationBaseSha, "b".repeat(40));
    assert.deepEqual(warnings, []);
  } finally {
    warn.mock.restore();
    permitStart = false;
    developHead = async () => "a".repeat(40);
    if (saved.publication === undefined) delete process.env.TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION;
    else process.env.TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION = saved.publication;
  }
});

test("v22 settlement maps the strict read-only API receipt echo", async () => {
  const { call } = (await routes).find(({ name }) => name === "settle")!;
  authorized = true;
  settleInput = null;
  const digest = "a".repeat(64);
  const apiExecutionReceipt = { version: 1,
    executorKind: "read_only_api_retry_v1", digest: "b".repeat(64) };
  const response = await call(new Request(
    "https://tomverse.test/api/internal/amux/v22/execution/settle", {
      method: "POST", body: JSON.stringify({
        attempt_id: "00000000-0000-4000-8000-000000000003",
        worker: "worker-one",
        instance_id: "00000000-0000-4000-8000-000000000002",
        generation: 1, task_revision: 2, outcome: "succeeded",
        invocation_ids: ["00000000-0000-4000-8000-000000000003"],
        read_only_retry: { version: 1,
          launch_binding_id: "00000000-0000-4000-8000-000000000004",
          launch_proof_digest: digest, launch_scope_digest: digest,
          executor_kind: "read_only_api_retry_v1",
          launcher_config_digest: digest,
          api_execution_frame_digest: digest,
          api_execution_receipt: apiExecutionReceipt },
      }),
    }));
  assert.equal(response.status, 409);
  assert.deepEqual(settleInput, {
    attemptId: "00000000-0000-4000-8000-000000000003",
    worker: "worker-one",
    instanceId: "00000000-0000-4000-8000-000000000002",
    generation: 1, taskRevision: 2, outcome: "succeeded",
    invocationIds: ["00000000-0000-4000-8000-000000000003"],
    readOnlyRetry: { version: 1,
      launchBindingId: "00000000-0000-4000-8000-000000000004",
      launchProofDigest: digest, launchScopeDigest: digest,
      executorKind: "read_only_api_retry_v1",
      launcherConfigDigest: digest, apiExecutionFrameDigest: digest,
      apiExecutionReceipt },
  });
});

test("an unverified v22 settlement carries what the sidecar said; codes only, never on a verified one", async () => {
  // Owner decision 2026-11-15: the app keeps an infrastructure failure off the card's attempts.
  const { call } = (await routes).find(({ name }) => name === "settle")!;
  authorized = true;
  const body = (over: Record<string, unknown>) => JSON.stringify({
    attempt_id: "00000000-0000-4000-8000-000000000003", worker: "worker-one",
    instance_id: "00000000-0000-4000-8000-000000000002", generation: 1, task_revision: 2,
    outcome: "blocked", invocation_ids: [], ...over });
  const post = (over: Record<string, unknown>) => call(new Request(
    "https://tomverse.test/api/internal/amux/v22/execution/settle", { method: "POST", body: body(over) }));
  settleInput = null;
  assert.equal((await post({ failure: { code: "invalid_result", cli_started: true, exit_code: 1,
    elapsed_ms: 4200 } })).status, 409);
  assert.deepEqual((settleInput as { failure?: unknown }).failure,
    { code: "invalid_result", cliStarted: true, exitCode: 1, elapsedMs: 4200 });
  settleInput = null;
  await post({ outcome: "failed", invocation_ids: ["00000000-0000-4000-8000-000000000003"],
    failure: { code: "invalid_result" } });
  assert.equal("failure" in (settleInput as object), false, "a verified settlement is judged on its receipt");
  // A malformed report never reaches the service (this suite's input-error
  // mock turns the schema refusal into a thrown error).
  for (const failure of [{ code: "Invalid Result" }, { code: "x".repeat(65) },
    { code: "invalid_result", text: "worker output" }]) {
    settleInput = null;
    await assert.rejects(post({ failure }), JSON.stringify(failure));
    assert.equal(settleInput, null);
  }
});
