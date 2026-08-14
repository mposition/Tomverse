import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { readResponseToBuffer } from "../lib/boundedBuffer.ts";

/**
 * A size guard must release the body it refuses.
 *
 * Three readers in this repository refuse an oversized response, and each has
 * two ceilings: the declared `content-length`, checked before a byte is read,
 * and a running total, checked while streaming. The streaming ceiling always
 * cancelled. The declared-length one threw with the body untouched in two of
 * the three, which is the worst place to leave one: that branch fires
 * *because* the response is large, and an unread body past roughly 16-64 KiB
 * pins its connection on Node 22 / undici 6 -- measured, and recorded in
 * .github/audits/unconsumed-response-bodies-2026-08-13.md §8.
 *
 * `providerUsageSync` runs on a schedule and retries, so a pinned connection
 * there is not a one-off.
 *
 * No static analysis found this. The call sites all read the body through the
 * helper, so they classify as consumed; only the helper's own early exit did
 * not. Hence a test rather than a gate.
 */

/** A response whose declared length exceeds any of the ceilings below. */
const oversizedResponse = (declaredBytes) => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { "content-length": String(declaredBytes) },
  });
  return { response, wasCancelled: () => cancelled };
};

test("readResponseToBuffer cancels the body it refuses for declared size", async () => {
  const { response, wasCancelled } = oversizedResponse(10 * 1024 * 1024);
  await assert.rejects(() => readResponseToBuffer(response, 1024));
  assert.equal(
    wasCancelled(),
    true,
    "the refused body must be cancelled, not left open"
  );
});

test("readResponseToBuffer cancels when the stream passes the ceiling mid-read", async () => {
  // No content-length, so the declared-length branch cannot fire and the
  // running total is what refuses it.
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4096));
      controller.enqueue(new Uint8Array(4096));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(() => readResponseToBuffer(new Response(body), 1024));
  assert.equal(cancelled, true);
});

test("readResponseToBuffer returns the body when it fits", async () => {
  const response = new Response("ok", {
    headers: { "content-length": "2" },
  });
  const buffer = await readResponseToBuffer(response, 1024);
  assert.equal(buffer.toString("utf8"), "ok");
});

/**
 * The other two are module-private, so this asserts their shape rather than
 * their behaviour. Stated plainly because it is the weaker check: it proves
 * the release is written, not that it runs.
 */
for (const [file, limitText] of [
  ["lib/providerUsageSync.ts", "512 KB"],
  ["lib/infrastructureMonitoring.ts", "1 MB"],
]) {
  test(`${file} releases the body before throwing on declared size`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const guard = source.slice(
      source.indexOf("const readBoundedJson"),
      source.indexOf("const readBoundedJson") + 2_000
    );
    assert.ok(guard, `${file} no longer defines readBoundedJson`);

    const declaredBranch = guard.slice(
      guard.indexOf("declaredLength !== null"),
      guard.indexOf(`safety limit.");`)
    );
    assert.match(
      declaredBranch,
      /response\.body\?\.cancel\(\)/,
      `${file} refuses a response over ${limitText} without releasing its body`
    );
  });
}
