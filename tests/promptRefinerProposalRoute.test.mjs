import assert from "node:assert/strict";
import test from "node:test";

import * as route from "../app/api/chat/prompt-refiner/proposal/route.ts";

test("product proposal API stays closed without an approved product adapter", async () => {
  const request = {
    get body() {
      throw new Error("proposal body must not be read while unavailable");
    },
    async json() {
      throw new Error("proposal JSON must not be parsed while unavailable");
    },
    async text() {
      throw new Error("proposal text must not be read while unavailable");
    },
  };

  const response = await route.POST(request);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    code: "PROMPT_REFINER_UNAVAILABLE",
  });
  assert.equal(route.GET, undefined);
});

test("a supplied prompt or claimed approval cannot cause an offer", async () => {
  const request = new Request("http://localhost/api/chat/prompt-refiner/proposal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: "request_1",
      prompt: "private synthetic draft",
      approved: true,
      adapterReady: true,
    }),
  });

  const response = await route.POST(request);
  const body = JSON.stringify(await response.json());
  assert.equal(response.status, 503);
  assert.equal(body.includes("private synthetic draft"), false);
  assert.equal(body.includes("refinedPrompt"), false);
});
