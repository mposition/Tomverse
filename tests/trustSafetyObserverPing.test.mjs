import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MONOTONIC_PRECHECK_MS, PING_ABORT_MS } from "../lib/trustSafetyBoundsCore.ts";
import { sendTrustSafetyPing } from "../lib/trustSafetyObserverPing.ts";

/**
 * The dead-man ping (docs/policy/trust-safety-compliance-agent.md §8, §13-9).
 *
 * The call is replaced here rather than mocked through a module boundary,
 * because §5.6 allows this agent exactly one `fetch` and it is a bare global
 * call inside that one module -- which is also what makes it replaceable from
 * a test without changing the module's shape.
 */

const MODULE = "lib/trustSafetyObserverPing.ts";
const URL_VALUE = "https://monitor.example/ping/abc123";

const withFetch = async (impl, run) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return impl(...args);
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
};

const ok = () => new Response(null, { status: 204 });

test("a fresh round sends exactly one request, to the URL as given", async () => {
  const { result, calls } = await withFetch(ok, () =>
    sendTrustSafetyPing({
      url: URL_VALUE,
      committedAtMonotonicMs: 1_000,
      now: () => 1_050,
    }),
  );
  assert.equal(result, "sent");
  assert.equal(calls.length, 1, "one request, never two");
  const [url, init] = calls[0];
  // §8 item 4: the URL only. No query appended, no body, no custom header.
  assert.equal(url, URL_VALUE);
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.headers, undefined);
  assert.equal(init.cache, "no-store");
  assert.equal(init.redirect, "error", "a redirect would reach a host the variable does not name");
  assert.ok(init.signal instanceof AbortSignal, "the third freshness device");
});

test("a stale round sends nothing", async () => {
  // The monotonic pre-check is the second device (§8). Over the budget, the
  // request is not attempted at all -- a late ping is a false negative in the
  // monitor, and sending one anyway would hide the stall it exists to report.
  for (const elapsed of [MONOTONIC_PRECHECK_MS + 1, 60_000]) {
    const { result, calls } = await withFetch(ok, () =>
      sendTrustSafetyPing({
        url: URL_VALUE,
        committedAtMonotonicMs: 0,
        now: () => elapsed,
      }),
    );
    assert.equal(result, "stale", `elapsed ${elapsed}`);
    assert.equal(calls.length, 0);
  }
});

test("the boundary itself still sends", async () => {
  const { result, calls } = await withFetch(ok, () =>
    sendTrustSafetyPing({
      url: URL_VALUE,
      committedAtMonotonicMs: 0,
      now: () => MONOTONIC_PRECHECK_MS,
    }),
  );
  assert.equal(result, "sent");
  assert.equal(calls.length, 1);
});

test("a clock that went backwards or unreadable is stale, not sent", async () => {
  // A monotonic clock should not do either; if it does, the elapsed time is
  // not evidence of freshness and the only safe answer is to send nothing.
  for (const now of [() => -5, () => Number.NaN]) {
    const { result, calls } = await withFetch(ok, () =>
      sendTrustSafetyPing({ url: URL_VALUE, committedAtMonotonicMs: 0, now }),
    );
    assert.equal(result, "stale");
    assert.equal(calls.length, 0);
  }
});

test("a refusing monitor and a thrown request are both `failed`, never `sent`", async () => {
  const refused = await withFetch(
    () => new Response(null, { status: 500 }),
    () => sendTrustSafetyPing({ url: URL_VALUE, committedAtMonotonicMs: 0, now: () => 10 }),
  );
  assert.equal(refused.result, "failed");

  const threw = await withFetch(
    () => {
      throw new Error("aborted");
    },
    () => sendTrustSafetyPing({ url: URL_VALUE, committedAtMonotonicMs: 0, now: () => 10 }),
  );
  assert.equal(threw.result, "failed");
});

test("the abort signal is the approved budget and the body is never read", () => {
  const source = readFileSync(MODULE, "utf8");
  assert.match(source, /AbortSignal\.timeout\(PING_ABORT_MS\)/);
  assert.equal(PING_ABORT_MS, 3_000);
  // Reading the response would make the monitor's answer an input to this
  // agent. Only `ok` is consulted.
  assert.doesNotMatch(source, /\.json\(\)|\.text\(\)|response\.body/);
});

test("the module makes one outgoing call and names no other way out", () => {
  // §5.6 item 4: E1's closure has exactly one outgoing request, in one
  // module. A second one here would be a failure even if it went to the same
  // host. Counted on non-comment lines, since the prose above explains why the
  // call is here.
  const code = readFileSync(MODULE, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  const calls = code.match(/\bfetch\s*\(/g) ?? [];
  assert.equal(calls.length, 1, `one fetch call, found ${calls.length}`);
  for (const banned of [
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /\bsendBeacon\b/,
    /\bgetBuiltinModule\b/,
    /\bglobalThis\b/,
    /\bglobal\b/,
    /\bObject\b/,
    /\bReflect\b/,
    /\bProxy\b/,
    /\brequire\b/,
  ]) {
    assert.doesNotMatch(code, banned, `banned in a self file: ${banned}`);
  }
  // The URL is a secret: it may not appear in a log line or be built here.
  assert.doesNotMatch(code, /console\./);
});
