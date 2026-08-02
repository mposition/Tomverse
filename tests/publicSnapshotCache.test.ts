import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  invalidatePublicSnapshot,
  readPublicSnapshot,
  resetPublicSnapshotCacheForTests,
} from "../lib/publicSnapshotCache.ts";
import {
  consumePublicReadBudget,
  PUBLIC_READ_RATE_LIMIT,
  resetPublicReadRateLimitForTests,
} from "../lib/publicReadRateLimit.ts";

/**
 * SEC-012. `/api/app-settings` and `/api/models/catalog` are unauthenticated
 * and used to run a database query per request, with the catalogue additionally
 * fetched on every page load. A loop against either turned one attacker
 * connection into one query.
 *
 * What has to hold: a burst costs one load, a burst that arrives *during* a
 * load costs no extra loads, a failure is not cached as an answer, and the
 * cache keys are a closed set rather than anything a caller supplies.
 */

beforeEach(() => {
  resetPublicSnapshotCacheForTests();
  resetPublicReadRateLimitForTests();
});

test("repeated reads inside the TTL cost one load", async () => {
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { guestDefaultModelId: "model-a" };
  };

  for (let index = 0; index < 50; index += 1) {
    const result = await readPublicSnapshot("app-settings", load);
    assert.equal(result.value.guestDefaultModelId, "model-a");
  }
  assert.equal(loads, 1, "50 requests must not be 50 queries");
});

test("a burst arriving during a load waits on it instead of starting more", async () => {
  let loads = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = async () => {
    loads += 1;
    await gate;
    return { models: [] };
  };

  // Every one of these starts before the first load resolves.
  const pending = Array.from({ length: 25 }, () =>
    readPublicSnapshot("model-catalog", load)
  );
  release!();
  const results = await Promise.all(pending);

  assert.equal(loads, 1, "a cold start must not be amplified either");
  const etags = new Set(results.map((result) => result.etag));
  assert.equal(etags.size, 1, "every waiter must get the same snapshot");
});

test("the ETag changes with the payload and is stable when it is not", async () => {
  let value = { aiChatEnabled: true };
  const load = async () => value;

  const first = await readPublicSnapshot("app-settings", load);
  invalidatePublicSnapshot("app-settings");
  const unchanged = await readPublicSnapshot("app-settings", load);
  assert.equal(unchanged.etag, first.etag);

  value = { aiChatEnabled: false };
  invalidatePublicSnapshot("app-settings");
  const changed = await readPublicSnapshot("app-settings", load);
  assert.notEqual(changed.etag, first.etag);
  assert.match(changed.etag, /^W\/"[A-Za-z0-9_-]+"$/);
});

test("a failed load is not cached as an answer", async () => {
  let attempts = 0;
  const load = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("database unreachable");
    return { aiChatEnabled: true };
  };

  await assert.rejects(() => readPublicSnapshot("app-settings", load));
  // The next request must retry rather than inherit the failure -- these
  // snapshots decide whether chat is available at all.
  const recovered = await readPublicSnapshot("app-settings", load);
  assert.equal(recovered.value.aiChatEnabled, true);
  assert.equal(attempts, 2);
});

test("a failure is delivered to every waiter and leaves nothing in flight", async () => {
  let attempts = 0;
  const load = async () => {
    attempts += 1;
    throw new Error("database unreachable");
  };

  const results = await Promise.allSettled([
    readPublicSnapshot("model-catalog", load),
    readPublicSnapshot("model-catalog", load),
    readPublicSnapshot("model-catalog", load),
  ]);
  assert.equal(attempts, 1);
  assert.ok(results.every((result) => result.status === "rejected"));

  // A stuck in-flight entry would wedge the endpoint permanently.
  const recovered = await readPublicSnapshot("model-catalog", async () => ({
    models: [],
  }));
  assert.deepEqual(recovered.value, { models: [] });
});

test("invalidation makes the next read observe the write", async () => {
  let stored = "before";
  const load = async () => ({ value: stored });

  assert.equal((await readPublicSnapshot("app-settings", load)).value.value, "before");
  stored = "after";
  assert.equal(
    (await readPublicSnapshot("app-settings", load)).value.value,
    "before",
    "still cached"
  );
  invalidatePublicSnapshot("app-settings");
  assert.equal((await readPublicSnapshot("app-settings", load)).value.value, "after");
});

test("the two snapshots do not share a cache slot", async () => {
  const settings = await readPublicSnapshot("app-settings", async () => ({
    kind: "settings",
  }));
  const catalog = await readPublicSnapshot("model-catalog", async () => ({
    kind: "catalog",
  }));
  assert.equal(settings.value.kind, "settings");
  assert.equal(catalog.value.kind, "catalog");
});

// ---------------------------------------------------------------------------
// The per-process request ceiling. Deliberately not backed by the database:
// a limiter that wrote a row per request would reintroduce the amplification
// it exists to remove.
// ---------------------------------------------------------------------------

const requestFrom = (ip: string) =>
  new Request("https://tomverse.app/api/models/catalog", {
    headers: { "x-real-ip": ip, "user-agent": `agent-${ip}` },
  });

test("a caller is allowed up to the ceiling and refused past it", () => {
  const request = requestFrom("203.0.113.7");
  for (let index = 0; index < PUBLIC_READ_RATE_LIMIT.requestsPerWindow; index += 1) {
    assert.equal(
      consumePublicReadBudget(request, "model-catalog").allowed,
      true,
      `request ${index + 1} must be allowed`
    );
  }
  const refused = consumePublicReadBudget(request, "model-catalog");
  assert.equal(refused.allowed, false);
  assert.ok(
    refused.retryAfter >= 1 &&
      refused.retryAfter <= PUBLIC_READ_RATE_LIMIT.windowMs / 1000,
    "a refusal must carry a usable Retry-After"
  );
});

test("one caller exhausting its budget does not refuse another", () => {
  const noisy = requestFrom("203.0.113.8");
  for (let index = 0; index <= PUBLIC_READ_RATE_LIMIT.requestsPerWindow; index += 1) {
    consumePublicReadBudget(noisy, "model-catalog");
  }
  assert.equal(consumePublicReadBudget(noisy, "model-catalog").allowed, false);
  assert.equal(
    consumePublicReadBudget(requestFrom("203.0.113.9"), "model-catalog").allowed,
    true
  );
});

test("the two endpoints keep separate budgets", () => {
  const request = requestFrom("203.0.113.10");
  for (let index = 0; index <= PUBLIC_READ_RATE_LIMIT.requestsPerWindow; index += 1) {
    consumePublicReadBudget(request, "model-catalog");
  }
  assert.equal(consumePublicReadBudget(request, "model-catalog").allowed, false);
  assert.equal(consumePublicReadBudget(request, "app-settings").allowed, true);
});

test("tracking is bounded, and overflow fails open rather than refusing everyone", () => {
  for (let index = 0; index < PUBLIC_READ_RATE_LIMIT.maxTrackedClients + 500; index += 1) {
    const result = consumePublicReadBudget(
      requestFrom(`198.51.100.${index % 256}`),
      `scope-${index}`
    );
    assert.equal(
      result.allowed,
      true,
      "a distinct caller must never be refused on its first request"
    );
  }
});
