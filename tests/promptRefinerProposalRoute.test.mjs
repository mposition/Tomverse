import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => null,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/e2eTestMode.ts"), { namedExports: {
  isE2EFixtureMode: () => false,
} });
mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
  hasValidMutationOrigin: () => true,
} });
mock.module(mod("lib/promptRefinerProductApi.ts"), { namedExports: {
  handlePromptRefinerProductProposal: async () => {
    throw new Error("unauthenticated request entered product admission");
  },
  promptRefinerProductApiErrorResponse: () => null,
} });

const routePromise = import(mod("app/api/chat/prompt-refiner/proposal/route.ts"));
const endpoint = "http://localhost/api/chat/prompt-refiner/proposal";

test("unauthenticated product proposal refuses before product admission", async () => {
  const route = await routePromise;
  const response = await route.POST(new Request(endpoint, { method: "POST" }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    code: "UNAUTHORIZED",
  });
  assert.equal(route.GET, undefined);
});

test("a supplied prompt or claimed approval cannot cause an offer", async () => {
  const route = await routePromise;
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
  assert.equal(response.status, 401);
  assert.equal(body.includes("private synthetic draft"), false);
  assert.equal(body.includes("refinedPrompt"), false);
});
