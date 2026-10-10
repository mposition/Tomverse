import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let authenticated = true;
let administrator = true;
let owner = true;
let statusReads = 0;
let rateReads = 0;
let roleReads = 0;

mock.module("next-auth/next", { namedExports: {
  getServerSession: async () => authenticated
    ? { user: { id: "owner-id", email: "owner@example.test" } }
    : null,
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => administrator,
  getAdminRole: () => {
    roleReads += 1;
    return owner ? "owner" : "ops";
  },
} });
mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
  apiSecurityResponse: () => null,
  consumeApiRateLimit: async () => { rateReads += 1; },
} });
mock.module(mod("lib/promptRefinerProductStatus.ts"), { namedExports: {
  readPromptRefinerProductStatus: async () => {
    statusReads += 1;
    return { version: "prompt-refiner-product-status-v1" };
  },
} });

const route = import(mod(
  "app/api/admin/prompt-refiner/product-status/route.ts"
));
const request = () => new Request(
  "https://tomverse.test/api/admin/prompt-refiner/product-status"
);

test("product status authenticates an owner before heavy reads", async () => {
  const handler = await route;
  authenticated = false;
  assert.equal((await handler.GET(request())).status, 404);
  authenticated = true;
  administrator = false;
  owner = true;
  assert.equal((await handler.GET(request())).status, 404);
  assert.equal(roleReads, 0);
  administrator = true;
  owner = false;
  assert.equal((await handler.GET(request())).status, 404);
  owner = true;
  assert.equal(roleReads, 1);
  assert.equal(statusReads, 0);
  assert.equal(rateReads, 0);
});

test("an owner receives one no-store serving snapshot", async () => {
  const handler = await route;
  const response = await handler.GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"),
    "private, no-store, max-age=0");
  assert.deepEqual(await response.json(), {
    version: "prompt-refiner-product-status-v1",
  });
  assert.equal(rateReads, 1);
  assert.equal(statusReads, 1);
});
