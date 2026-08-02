import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * SEC-012. Server-side contract for the two unauthenticated read endpoints.
 *
 * `/api/app-settings` and `/api/models/catalog` answered a database query per
 * request, and the catalogue is fetched by `ModelCatalogProvider` on every page
 * load, so an unauthenticated loop against either turned one connection into
 * one query. They now answer from a short-lived shared snapshot with an ETag,
 * behind a per-process request ceiling.
 *
 * The real handlers run here. The database is not reachable and does not need
 * to be: `E2E_DISABLE_DATABASE` makes both loaders answer from the static
 * bootstrap catalogue, which is enough to assert the response contract --
 * conditional requests, the refusal, and that the private provider fields never
 * appear in the body.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.NEXTAUTH_SECRET ||= "public-read-routes-contract-secret";
process.env.DATABASE_URL ||=
  "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

// Loaded lazily: tsx compiles this file to CJS, so there is no top-level
// await, and the environment above has to be in place before any of these
// modules evaluate.
type Handler = (request: Request) => Promise<Response>;
type Harness = {
  resetPublicSnapshotCacheForTests: () => void;
  resetPublicReadRateLimitForTests: () => void;
  requestsPerWindow: number;
  handlers: Record<"app-settings" | "model-catalog", Handler>;
};

let harness: Promise<Harness> | null = null;

const load = (): Promise<Harness> => {
  harness ??= (async () => {
    const snapshotCache = await import(mod("lib/publicSnapshotCache.ts"));
    const rateLimit = await import(mod("lib/publicReadRateLimit.ts"));
    const appSettingsRoute = await import(mod("app/api/app-settings/route.ts"));
    const catalogRoute = await import(mod("app/api/models/catalog/route.ts"));
    return {
      resetPublicSnapshotCacheForTests:
        snapshotCache.resetPublicSnapshotCacheForTests,
      resetPublicReadRateLimitForTests:
        rateLimit.resetPublicReadRateLimitForTests,
      requestsPerWindow: rateLimit.PUBLIC_READ_RATE_LIMIT.requestsPerWindow,
      handlers: {
        "app-settings": appSettingsRoute.GET as Handler,
        "model-catalog": catalogRoute.GET as Handler,
      },
    };
  })();
  return harness;
};

const ENDPOINTS = [
  { name: "app-settings" as const, path: "/api/app-settings" },
  { name: "model-catalog" as const, path: "/api/models/catalog" },
];

let clientCounter = 0;
const freshClient = () => `203.0.113.${(clientCounter += 1) % 250}`;

const request = (path: string, ip: string, headers: HeadersInit = {}) =>
  new Request(`https://tomverse.app${path}`, {
    headers: { "x-real-ip": ip, "user-agent": `contract-${ip}`, ...headers },
  });

const reset = async () => {
  const harnessed = await load();
  harnessed.resetPublicSnapshotCacheForTests();
  harnessed.resetPublicReadRateLimitForTests();
  return harnessed;
};

for (const endpoint of ENDPOINTS) {
  test(`${endpoint.path} answers with a validator and honours it`, async () => {
    const { handlers } = await reset();
    const handler = handlers[endpoint.name];
    const ip = freshClient();
    const first = await handler(request(endpoint.path, ip));
    assert.equal(first.status, 200);

    const etag = first.headers.get("etag");
    assert.ok(etag, "the response must carry an ETag");
    assert.match(etag!, /^W\/"[A-Za-z0-9_-]+"$/);
    assert.equal(first.headers.get("cache-control"), "private, no-cache");

    const conditional = await handler(
      request(endpoint.path, ip, { "if-none-match": etag! })
    );
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "", "a 304 must have no body");
    assert.equal(conditional.headers.get("etag"), etag);

    // A stale validator must not be honoured.
    const stale = await handler(
      request(endpoint.path, freshClient(), { "if-none-match": 'W/"stale"' })
    );
    assert.equal(stale.status, 200);
  });

  test(`${endpoint.path} is stable across repeated reads`, async () => {
    const { handlers } = await reset();
    const handler = handlers[endpoint.name];
    const ip = freshClient();
    const etags = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const response = await handler(request(endpoint.path, ip));
      assert.equal(response.status, 200);
      etags.add(response.headers.get("etag")!);
    }
    assert.equal(
      etags.size,
      1,
      "an unchanged snapshot must not produce a new validator per request"
    );
  });

  test(`${endpoint.path} refuses a caller past the ceiling`, async () => {
    const { handlers, requestsPerWindow } = await reset();
    const handler = handlers[endpoint.name];
    const ip = freshClient();
    for (let index = 0; index < requestsPerWindow; index += 1) {
      const response = await handler(request(endpoint.path, ip));
      assert.equal(response.status, 200);
    }
    const refused = await handler(request(endpoint.path, ip));
    assert.equal(refused.status, 429);
    assert.ok(
      Number(refused.headers.get("retry-after")) >= 1,
      "a refusal must carry Retry-After"
    );
    assert.equal(refused.headers.get("cache-control"), "no-store");

    // Another caller is unaffected.
    const other = await handler(request(endpoint.path, freshClient()));
    assert.equal(other.status, 200);
  });
}

test("the public catalogue never carries the provider connection fields", async () => {
  const { handlers } = await reset();
  const catalogHandler = handlers["model-catalog"];
  const response = await catalogHandler(
    request("/api/models/catalog", freshClient())
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  for (const field of ["apiBaseUrl", "apiKeyEnvName", "operationalReason"]) {
    assert.ok(
      !body.includes(field),
      `${field} must not reach an unauthenticated caller`
    );
  }

  const payload = JSON.parse(body) as { models: Array<Record<string, unknown>> };
  assert.ok(payload.models.length > 0, "the catalogue must not be empty");
  // Caching the redacted shape, rather than redacting on the way out, is what
  // stops a future reader of the snapshot from reaching the private fields.
  for (const model of payload.models) {
    assert.ok(!("apiKeyEnvName" in model));
    assert.equal(typeof model.id, "string");
  }
});

test("a 304 carries no snapshot content of its own", async () => {
  const { handlers } = await reset();
  const catalogHandler = handlers["model-catalog"];
  const ip = freshClient();
  const seed = await catalogHandler(request("/api/models/catalog", ip));
  const etag = seed.headers.get("etag")!;
  const conditional = await catalogHandler(
    request("/api/models/catalog", ip, { "if-none-match": etag })
  );
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get("content-type"), null);
  assert.equal((await conditional.arrayBuffer()).byteLength, 0);
});
