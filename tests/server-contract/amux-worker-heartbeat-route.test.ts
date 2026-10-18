import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let recordedCapabilities: string[] | null = null;

mock.module(mod("lib/amux/guard.ts"), { namedExports: {
  isAmuxSyncAuthorized: () => true,
} });
mock.module(mod("lib/amux/executionGate.ts"), { namedExports: {
  isAmuxExecutionApiEnabled: () => true,
} });
// The derived catalog check runs inside the heartbeat's own transaction
// (orchestration policy version 35, section 3), through `listed`.
mock.module(mod("lib/amux/workerAssignmentCatalog.ts"), { namedExports: {
  amuxWorkerCatalogRefusal: async () => null,
} });
mock.module(mod("lib/amux/workerRuntime.ts"), { namedExports: {
  heartbeatAmuxWorkerRuntime: async (input: { protocolCapabilities: string[]; listed?: unknown }) => {
    assert.equal(typeof input.listed, "function");
    recordedCapabilities = input.protocolCapabilities;
    return { accepted: true,
      leaseExpiresAt: new Date("2026-10-13T12:01:30.000Z") };
  },
} });
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS: 12_000,
  withAmuxRouteBudget: (work: () => Promise<Response>) => work(),
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  readLimitedJson: async (request: Request, _limit: number,
    schema: { parse: (value: unknown) => unknown }) =>
    schema.parse(JSON.parse(await request.text())),
} });
mock.module(mod("lib/amux/internalRoute.ts"), { namedExports: {
  amuxJsonNoStore: (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } }),
  amuxInternalErrorResponse: () => Response.json({ error: "internal" }, { status: 500 }),
  isAmuxInputError: () => true,
} });

const route = import(mod("app/api/internal/amux/workers/heartbeat/route.ts"));

const request = (protocolCapabilities: unknown) => new Request(
  "https://tomverse.test/api/internal/amux/workers/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      worker_name: "worker-one",
      instance_id: "00000000-0000-4000-8000-000000000001",
      generation: 1,
      status: "idle",
      dispatch_ready: true,
      protocol_capabilities: protocolCapabilities,
    }),
  });

test("worker heartbeat preserves one exact CLI or API capability and rejects every other shape",
  async () => {
    const { POST } = await route;
    for (const capability of ["read_only_retry_v1", "read_only_api_retry_v1"]) {
      recordedCapabilities = null;
      const response = await POST(request([capability]));
      assert.equal(response.status, 200, capability);
      assert.deepEqual(recordedCapabilities, [capability]);
    }
    for (const invalid of [
      ["unknown"],
      ["read_only_retry_v1", "read_only_api_retry_v1"],
    ]) {
      recordedCapabilities = null;
      const response = await POST(request(invalid));
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.equal(recordedCapabilities, null);
    }
  });
