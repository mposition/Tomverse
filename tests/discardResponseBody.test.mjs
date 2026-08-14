import assert from "node:assert/strict";
import test from "node:test";

import { discardResponseBody } from "../lib/discardResponseBody.ts";

/**
 * The helper every `/api/*` caller uses on the paths it does not parse.
 *
 * What is worth pinning here is not that it returns a promise -- it is the
 * three properties call sites rely on without saying so. It really consumes
 * (an unconsumed body is the whole defect). It answers the same way whatever
 * the status, because the browser behaviour that motivates it did not depend on
 * the status either. And it never rejects, because every call site uses it on a
 * path that was about to ignore the response and would now have to grow a
 * `catch` it does not otherwise need.
 *
 * The browser-level half -- that consuming the body is what lets the request
 * complete -- is tests/e2e/api-response-body-completion.spec.ts. This half runs
 * without a browser and covers the shapes a page cannot conveniently produce.
 */

test("a successful response is consumed, not merely returned", async () => {
  const response = new Response("hello", { status: 200 });
  assert.equal(response.bodyUsed, false);
  assert.equal(await discardResponseBody(response), undefined);
  assert.equal(response.bodyUsed, true);
});

test("an error response is consumed the same way", async () => {
  const response = new Response(JSON.stringify({ error: "nope" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
  await discardResponseBody(response);
  assert.equal(response.bodyUsed, true);
});

test("a response with no body at all resolves rather than throwing", async () => {
  // 204 and a HEAD answer both arrive with `body === null`, which is why this
  // reads with `text()` instead of cancelling the stream.
  const response = new Response(null, { status: 204 });
  assert.equal(response.body, null);
  assert.equal(await discardResponseBody(response), undefined);
});

test("a body that fails mid-read is swallowed, not raised", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      controller.error(new Error("connection reset"));
    },
  });
  const response = new Response(stream, { status: 200 });
  assert.equal(await discardResponseBody(response), undefined);
});

test("an already-consumed response does not become an unhandled rejection", async () => {
  // The shape a careless edit produces: a body parsed on the success path and
  // then handed here as well. It must stay quiet rather than turn a working
  // page into a crash.
  const response = new Response("{}", { status: 200 });
  await response.json();
  assert.equal(await discardResponseBody(response), undefined);
});

test("the caller can chain a value onto it, which is how the ok/not-ok shape reads", async () => {
  const response = new Response("ignored", { status: 403 });
  const result = await discardResponseBody(response).then(() => null);
  assert.equal(result, null);
  assert.equal(response.bodyUsed, true);
});
