import assert from "node:assert/strict";
import test from "node:test";
import { prepareChatContextBundle } from "../lib/chatContextBundleClient.ts";
import { createSharedPendingRequest } from "../lib/sharedPendingRequest.ts";

const input = { conversationId: "conversation", modelIds: ["model-a", "model-b"], prompt: "그 프로젝트 마감은?" };

test("initial preparation sends the authored question without inventing a previous snapshot", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return Response.json({ contextBundle: "initial-signed-context" });
  });
  assert.equal(await prepareChatContextBundle(input), "initial-signed-context");
  assert.deepEqual(requests, [{ url: "/api/chat/context", body: input }]);
});

test("comparison recovery shares one preparation carrying the original signed snapshot", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ contextBundle: "refreshed-same-sources" });
  });
  const shared = createSharedPendingRequest();
  const recover = () => shared.run("saved-question", () => prepareChatContextBundle({
    ...input, previousContextBundle: "original-signed-context",
  }));
  assert.deepEqual(await Promise.all([recover(), recover(), recover()]), [
    "refreshed-same-sources", "refreshed-same-sources", "refreshed-same-sources",
  ]);
  assert.equal(await recover(), "refreshed-same-sources");
  assert.deepEqual(requests, [{ ...input, previousContextBundle: "original-signed-context" }]);
});

test("a refused recovery does not silently retry without its previous snapshot", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ code: "INVALID_CONTEXT_BUNDLE" }, { status: 400 });
  });
  assert.equal(await prepareChatContextBundle({ ...input, previousContextBundle: "rejected-context" }), null);
  assert.deepEqual(requests, [{ ...input, previousContextBundle: "rejected-context" }]);
});
