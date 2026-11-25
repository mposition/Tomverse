import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { desktopChatApi } from "../src/host/chat-api";
import type { ImageRequest } from "../src/images-contract";

const imageRequest: ImageRequest = {
  prompt: "Draw a blue circle",
  idempotencyKey: randomUUID(),
  size: "1024x1024",
  quality: "medium",
  models: ["fixture-image"],
  pricing: { "fixture-image": "v1" },
};
const receipt = { conversationId: "image-fixture", groupId: "image-group-fixture" };

test("Image pricing conflicts reconcile an existing request before asking the user to review a new quote", async (context) => {
  const events: string[] = [];
  let conflictCode = "IMAGE_PRICE_CHANGED";
  let receiptStatus = 404;
  const server = createServer((request, response) => {
    events.push(`${request.method} ${request.url}`);
    const posting = request.method === "POST";
    request.resume();
    response.writeHead(posting ? 409 : receiptStatus, { "Content-Type": "application/json" });
    response.end(JSON.stringify(posting ? { code: conflictCode } : receiptStatus === 200 ? receipt : {}));
  });
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const api = desktopChatApi("fixture-account", new AbortController().signal, `http://127.0.0.1:${address.port}`);
  const post = "POST /api/images/generations";
  const lookup = "GET /api/images/generations?requestKey=" + imageRequest.idempotencyKey;

  assert.deepEqual(await api.generateImages(imageRequest), { status: "price-changed" });
  assert.deepEqual(events.splice(0), [post, lookup]);

  receiptStatus = 200;
  assert.deepEqual(await api.generateImages(imageRequest), { status: "accepted", receipt });
  assert.deepEqual(events.splice(0), [post, lookup]);

  receiptStatus = 503;
  await assert.rejects(api.generateImages(imageRequest));
  assert.deepEqual(events.splice(0), [post, lookup]);

  conflictCode = "OTHER_CONFLICT";
  await assert.rejects(api.generateImages(imageRequest));
  assert.deepEqual(events, [post]);
});
