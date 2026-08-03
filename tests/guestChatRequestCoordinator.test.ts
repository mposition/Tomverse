import assert from "node:assert/strict";
import test from "node:test";

import {
  createGuestChatCoordinatorState,
  runCoordinatedGuestChatRequest,
} from "../components/chat/guestChatRequestCoordinator.ts";
import { isGuestVerificationError } from "../components/chat/guestVerificationFailure.ts";

// The regression these guard (trace e81bb83c-…): three panels hit
// TURNSTILE_REQUIRED, one ran the challenge, its verified retry then failed on
// a later gate (CHAT_RATE_LIMITED) -- and the two waiting panels, which used
// to swallow that rejection, each fired a tokenless retry that could only
// harvest another TURNSTILE_REQUIRED. The waiting panels must inherit the
// verifier's outcome: retry only after a SUCCESSFUL verified retry, fail with
// it otherwise, and never send an extra request on failure.

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

type PanelLog = {
  tokenSends: (string | undefined)[];
  grantSends: number;
};

const panel = (
  state: ReturnType<typeof createGuestChatCoordinatorState>,
  options: {
    isEnabled?: boolean;
    requestToken?: () => Promise<string | undefined>;
    sendWithToken?: (token: string | undefined) => Promise<string>;
    sendAfterGrant?: () => Promise<string>;
  } = {}
) => {
  const log: PanelLog = { tokenSends: [], grantSends: 0 };
  const run = runCoordinatedGuestChatRequest(state, {
    isEnabled: options.isEnabled ?? true,
    requestToken: options.requestToken ?? (() => Promise.resolve("token-1")),
    sendWithToken:
      options.sendWithToken ??
      ((token) => {
        log.tokenSends.push(token);
        return Promise.resolve("ok");
      }),
    sendAfterGrant:
      options.sendAfterGrant ??
      (() => {
        log.grantSends += 1;
        return Promise.resolve("ok-after-grant");
      }),
  });
  return { run, log };
};

test("waiting panels retry (tokenless) only after the verifier's retry succeeded", async () => {
  const state = createGuestChatCoordinatorState();
  const verifiedRetry = deferred<string>();

  const winner = panel(state, {
    sendWithToken: (token) => {
      assert.equal(token, "token-1");
      return verifiedRetry.promise;
    },
  });
  await flushMicrotasks();

  const waiterA = panel(state);
  const waiterB = panel(state);
  await flushMicrotasks();

  // Nobody moves while the verified retry is still in flight.
  assert.equal(waiterA.log.grantSends, 0);
  assert.equal(waiterB.log.grantSends, 0);

  verifiedRetry.resolve("winner-answer");
  assert.equal(await winner.run, "winner-answer");
  assert.equal(await waiterA.run, "ok-after-grant");
  assert.equal(await waiterB.run, "ok-after-grant");
  assert.equal(waiterA.log.grantSends, 1);
  assert.equal(waiterB.log.grantSends, 1);
  // The waiters never spent a token of their own.
  assert.deepEqual(waiterA.log.tokenSends, []);
  assert.deepEqual(waiterB.log.tokenSends, []);
});

test("a failed verified retry fails every waiting panel with zero extra requests", async () => {
  const state = createGuestChatCoordinatorState();
  const verifiedRetry = deferred<string>();

  const rateLimited = Object.assign(new Error("Chat request failed: 429"), {
    code: "CHAT_RATE_LIMITED",
  });

  const winner = panel(state, { sendWithToken: () => verifiedRetry.promise });
  await flushMicrotasks();
  const waiterA = panel(state);
  const waiterB = panel(state);

  verifiedRetry.reject(rateLimited);

  await assert.rejects(winner.run, rateLimited);
  // The verifier's failure propagates as-is: the waiting panels report the
  // real reason (a rate limit), not a fabricated verification error.
  await assert.rejects(waiterA.run, rateLimited);
  await assert.rejects(waiterB.run, rateLimited);
  await flushMicrotasks();
  assert.equal(waiterA.log.grantSends, 0, "waiter A sent a tokenless retry");
  assert.equal(waiterB.log.grantSends, 0, "waiter B sent a tokenless retry");
  assert.deepEqual(waiterA.log.tokenSends, []);
  assert.deepEqual(waiterB.log.tokenSends, []);
});

for (const kind of ["failed", "unavailable", "cancelled", "timeout", "expired"] as const) {
  test(`a challenge that ends "${kind}" sends nothing from any panel`, async () => {
    const state = createGuestChatCoordinatorState();
    const { GuestVerificationError } = await import(
      "../components/chat/guestVerificationFailure.ts"
    );
    const challenge = deferred<string | undefined>();

    const winner = panel(state, { requestToken: () => challenge.promise });
    await flushMicrotasks();
    const waiter = panel(state);

    challenge.reject(new GuestVerificationError(kind));

    await assert.rejects(winner.run, (error: unknown) => {
      assert.ok(isGuestVerificationError(error));
      assert.equal(error.kind, kind);
      return true;
    });
    await assert.rejects(waiter.run, (error: unknown) => {
      assert.ok(isGuestVerificationError(error));
      assert.equal(error.kind, kind);
      return true;
    });
    await flushMicrotasks();
    assert.deepEqual(winner.log.tokenSends, [], "the winner sent without a token");
    assert.equal(waiter.log.grantSends, 0, "the waiter retried after a dead challenge");
    assert.deepEqual(waiter.log.tokenSends, []);
  });
}

test("a network failure in the verified retry does not strand the next attempt", async () => {
  const state = createGuestChatCoordinatorState();
  const networkError = new TypeError("Failed to fetch");

  const first = panel(state, {
    sendWithToken: () => Promise.reject(networkError),
  });
  await assert.rejects(first.run, networkError);

  // The lock was released: a later user-initiated send verifies afresh
  // instead of being chained to the dead attempt.
  const second = panel(state);
  assert.equal(await second.run, "ok");
  assert.deepEqual(second.log.tokenSends, ["token-1"]);
});

test("a disabled coordinator fails typed instead of repeating the tokenless request", async () => {
  // Scenario B: the server's secret is configured (it answered
  // TURNSTILE_REQUIRED) but this page has no site key, so no challenge can
  // ever produce a token. The old behaviour re-sent the same tokenless
  // request once more and surfaced the server's raw English sentence.
  const state = createGuestChatCoordinatorState();
  const disabled = panel(state, { isEnabled: false });

  await assert.rejects(disabled.run, (error: unknown) => {
    assert.ok(isGuestVerificationError(error));
    assert.equal(error.kind, "unavailable");
    return true;
  });
  assert.deepEqual(disabled.log.tokenSends, [], "a tokenless request was repeated");
  assert.equal(disabled.log.grantSends, 0);
});

test("the winner's success is required, not merely its settlement", async () => {
  // The exact line this replaces was `await inFlight.catch(() => {})` -- a
  // settled-but-rejected verification let every waiter march on. Assert the
  // waiter's sendAfterGrant is never called even after inFlight has fully
  // settled (rejected) and the coordinator lock has been released.
  const state = createGuestChatCoordinatorState();
  const failure = new Error("verified retry refused");
  const verifiedRetry = deferred<string>();

  const winner = panel(state, { sendWithToken: () => verifiedRetry.promise });
  await flushMicrotasks();
  const waiter = panel(state);
  await flushMicrotasks();

  verifiedRetry.reject(failure);
  await assert.rejects(winner.run, failure);
  await assert.rejects(waiter.run, failure);
  // Everything has settled; give any stray retry the chance to fire.
  await flushMicrotasks();
  assert.equal(waiter.log.grantSends, 0);
  assert.equal(state.inFlight, null, "the lock must be released for the next manual send");
});
