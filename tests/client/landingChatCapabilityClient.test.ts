import assert from "node:assert/strict";
import test from "node:test";

import { startLandingChatCapabilityRead } from "@/lib/landingChatCapabilityClient";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("guests and unresolved account IDs perform no capability request", async () => {
  let reads = 0;
  const results: boolean[] = [];
  const stop = startLandingChatCapabilityRead({
    accountUserId: null,
    onResolved: (offered) => results.push(offered),
    fetcher: async () => { reads += 1; return response({ offered: true }); },
  });
  stop();
  await settle();
  assert.equal(reads, 0);
  assert.deepEqual(results, []);
});

test("a resolved account reads the existing private endpoint with GET and no-store", async () => {
  const results: boolean[] = [];
  const stop = startLandingChatCapabilityRead({
    accountUserId: "account-a",
    onResolved: (offered) => results.push(offered),
    fetcher: async (url, options) => {
      assert.equal(url, "/api/marketing/chat-entry");
      assert.equal(options?.method, "GET");
      assert.equal(options?.cache, "no-store");
      assert.ok(options?.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return response({ offered: true, ignoredClientFlag: false });
    },
  });
  await settle();
  assert.deepEqual(results, [true]);
  stop();
});

test("only a strict server offered boolean admits the account link", async () => {
  for (const body of [null, {}, { autoSelection: { offered: true } }, { flagEnabled: true },
    { offered: false }, { offered: "true" },
    { offered: 1 }, { autoSelection: [] }]) {
    const results: boolean[] = [];
    const stop = startLandingChatCapabilityRead({
      accountUserId: "account-a",
      onResolved: (offered) => results.push(offered),
      fetcher: async () => response(body),
    });
    await settle();
    assert.deepEqual(results, [false]);
    stop();
  }
});

test("HTTP, transport and malformed body failures retain an unavailable account link", async () => {
  const fetchers: Array<typeof fetch> = [
    async () => response({ offered: true }, 401),
    async () => response({ offered: true }, 500),
    async () => { throw new Error("NETWORK_UNAVAILABLE"); },
    async () => new Response("{invalid"),
  ];
  for (const fetcher of fetchers) {
    const results: boolean[] = [];
    const stop = startLandingChatCapabilityRead({
      accountUserId: "account-a",
      onResolved: (offered) => results.push(offered),
      fetcher,
    });
    await settle();
    assert.deepEqual(results, [false]);
    stop();
  }
});

test("an A-to-B-to-A transition discards both earlier identity responses", async () => {
  const pending = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
  const results: Array<{ identity: string; offered: boolean }> = [];
  const signals: AbortSignal[] = [];
  const start = (index: number, identity: string) => startLandingChatCapabilityRead({
    accountUserId: identity,
    onResolved: (offered) => results.push({ identity: `${identity}-${index}`, offered }),
    fetcher: async (_url, options) => {
      signals.push(options!.signal as AbortSignal);
      return pending[index]!.promise;
    },
  });
  const stopA = start(0, "account-a");
  stopA();
  const stopB = start(1, "account-b");
  stopB();
  const stopReturningA = start(2, "account-a");
  pending[0]!.resolve(response({ offered: true }));
  pending[1]!.resolve(response({ offered: true }));
  await settle();
  assert.deepEqual(results, []);
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[1]!.aborted, true);
  pending[2]!.resolve(response({ offered: false }));
  await settle();
  assert.deepEqual(results, [{ identity: "account-a-2", offered: false }]);
  stopReturningA();
});

test("cancellation while the response body is pending cannot restore the old offer", async () => {
  const body = deferred<unknown>();
  const results: boolean[] = [];
  const stop = startLandingChatCapabilityRead({
    accountUserId: "account-a",
    onResolved: (offered) => results.push(offered),
    fetcher: async () => ({ ok: true, json: () => body.promise }) as Response,
  });
  await settle();
  stop();
  body.resolve({ offered: true });
  await settle();
  assert.deepEqual(results, []);
});
