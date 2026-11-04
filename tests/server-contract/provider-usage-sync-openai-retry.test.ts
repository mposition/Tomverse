import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * The OpenAI Costs adapter on a rate limit. On 2026-11-04 all three attempts got
 * a 429 within 2.8 seconds, because the sub-second backoff cannot outlast a
 * per-minute limit. Only the adapter's collaborators are replaced.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

const recorded: Array<{ provider: string; costMicroUsd: number }> = [];

mock.module(mod("lib/providerUsageAccounting.ts"), {
  namedExports: {
    getInternalProviderUsageSummary: async () => ({}),
    recordProviderReportedUsage: async (row: {
      provider: string;
      costMicroUsd: number;
    }) => {
      recorded.push(row);
    },
  },
});
mock.module(mod("lib/providerMonitoring.ts"), {
  namedExports: {
    MONITORED_PROVIDERS: ["openai"],
    PROVIDER_API_KEY_ENV: { openai: [] },
    PROVIDER_DISPLAY_NAMES: { openai: "OpenAI" },
  },
});

const rateLimited = () =>
  new Response(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "rate_limit_exceeded",
        message: "You've exceeded the rate limit.",
      },
    }),
    { status: 429, headers: { "x-request-id": "req-429" } }
  );
const costs = () =>
  new Response(
    JSON.stringify({
      data: [{ results: [{ amount: { value: 1.25, currency: "usd" } }] }],
      has_more: false,
      next_page: null,
    }),
    { status: 200 }
  );

const withStubs = async (responses: Array<() => Response>) => {
  const { syncProviderUsageForDate } = await import(
    mod("lib/providerUsageSync.ts")
  );
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const realWarn = console.warn;
  const delays: number[] = [];
  const warnings: unknown[][] = [];
  let calls = 0;
  process.env.OPENAI_ADMIN_API_KEY = "test-admin-key";
  recorded.length = 0;
  globalThis.fetch = (async () => responses[calls++]()) as typeof fetch;
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return realSetTimeout(callback, 0);
  }) as typeof setTimeout;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const results = await syncProviderUsageForDate(new Date("2026-11-03"));
    return { result: results[0], delays, warnings, calls };
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    console.warn = realWarn;
    delete process.env.OPENAI_ADMIN_API_KEY;
  }
};

test("a 429 waits out the rate limit window and the day still syncs", async () => {
  const { result, delays, calls } = await withStubs([
    rateLimited,
    rateLimited,
    costs,
  ]);
  assert.equal(result.status, "synced");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [30_000, 30_000]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].costMicroUsd, 1_250_000);
});

test("an exhausted 429 fails with its provider and code on one log line", async () => {
  const { result, warnings, calls } = await withStubs([
    rateLimited,
    rateLimited,
    rateLimited,
  ]);
  assert.equal(result.status, "failed");
  assert.equal(calls, 3);
  assert.equal(result.diagnostic?.errorCode, "rate_limit_exceeded");
  assert.equal(recorded.length, 0);

  assert.equal(warnings.length, 1);
  const [label, line] = warnings[0];
  assert.equal(label, "Provider usage sync failed");
  assert.equal(typeof line, "string");
  assert.ok(!String(line).includes("\n"));
  const logged = JSON.parse(String(line));
  assert.equal(logged.provider, "openai");
  assert.equal(logged.errorCode, "rate_limit_exceeded");
  assert.equal(logged.httpStatus, 429);
  assert.ok(!String(line).includes("test-admin-key"));
});
