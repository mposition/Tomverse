import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const moduleUrl = (relative: string) =>
  pathToFileURL(resolve(ROOT, relative)).href;

let authorized = false;
let serviceCalls = 0;
const noStore = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Cache-Control": "no-store" },
  });

mock.module(moduleUrl("lib/amux/guard.ts"), {
  namedExports: { isAmuxSyncAuthorized: () => authorized },
});
mock.module(moduleUrl("lib/amux/executionGate.ts"), {
  namedExports: { isAmuxExecutionApiEnabled: () => false },
});
mock.module(moduleUrl("lib/amux/dbBoundary.ts"), {
  namedExports: {
    withAmuxRouteBudget: () => {
      serviceCalls += 1;
      throw new Error("execution-off request entered the DB boundary");
    },
  },
});
mock.module(moduleUrl("lib/apiSecurity.ts"), {
  namedExports: {
    readLimitedJson: () => {
      serviceCalls += 1;
      throw new Error("execution-off request parsed an unneeded body");
    },
  },
});
mock.module(moduleUrl("lib/amux/internalRoute.ts"), {
  namedExports: {
    amuxJsonNoStore: noStore,
    amuxBoundedJsonNoStore: () => {
      serviceCalls += 1;
      throw new Error("execution-off request serialized future data");
    },
    amuxInternalErrorResponse: () => noStore({ error: "unexpected" }, 500),
    isAmuxInputError: () => false,
    AmuxResponseCapacityError: class extends Error {},
  },
});
mock.module(moduleUrl("lib/amux/routing.ts"), {
  namedExports: {
    getConfiguredAmuxWorkerCatalog: () => {
      serviceCalls += 1;
      return [];
    },
  },
});
mock.module(moduleUrl("lib/amux/workerRuntime.ts"), {
  namedExports: {
    registerAmuxWorkerRuntime: () => {
      serviceCalls += 1;
      throw new Error("unexpected runtime registration");
    },
    heartbeatAmuxWorkerRuntime: () => {
      serviceCalls += 1;
      throw new Error("unexpected runtime heartbeat");
    },
  },
});
mock.module(moduleUrl("lib/amux/store.ts"), {
  namedExports: {
    AmuxQueueCapacityError: class extends Error {},
    listOwnedTodos: () => {
      serviceCalls += 1;
      throw new Error("unexpected owned queue read");
    },
  },
});
mock.module(moduleUrl("lib/amux/wireContract.ts"), {
  namedExports: { amuxOwnedQueueResponseSchema: {} },
});

const routesPromise = Promise.all(
  [
    "workers/register",
    "workers/heartbeat",
    "owned-queue",
  ].map(async (path) => ({
    path,
    POST: (await import(moduleUrl(`app/api/internal/amux/${path}/route.ts`)))
      .POST as (request: Request) => Promise<Response>,
  })),
);

test("future-only routes reject unauthenticated requests without work", async () => {
  const routes = await routesPromise;
  authorized = false;
  serviceCalls = 0;
  for (const { path, POST } of routes) {
    const response = await POST(
      new Request(`https://tomverse.app/api/internal/amux/${path}`, {
        method: "POST",
        body: "{}",
      }),
    );
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(serviceCalls, 0);
});

test("execution-off worker and owned routes return 409 before DB mutation", async () => {
  const routes = await routesPromise;
  authorized = true;
  serviceCalls = 0;
  const expected = [
    { registered: false, reason: "execution_api_disabled" },
    { accepted: false, reason: "execution_api_disabled" },
    { available: false, reason: "execution_api_disabled" },
  ];
  for (let index = 0; index < routes.length; index += 1) {
    const { path, POST } = routes[index];
    const response = await POST(
      new Request(`https://tomverse.app/api/internal/amux/${path}`, {
        method: "POST",
        body: "{ deliberately malformed future body",
      }),
    );
    assert.equal(response.status, 409, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), expected[index]);
  }
  assert.equal(serviceCalls, 0);
});
