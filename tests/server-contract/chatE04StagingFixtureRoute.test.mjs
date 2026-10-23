import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "..", "..", path)).href;
let authenticated = true; let administrator = true;
mock.module(mod("node_modules/next-auth/next/index.js"), { namedExports: { getServerSession: async () => authenticated ? { user: { id: "e04-test-admin" } } : null } });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: { isAdminSession: () => administrator } });
const unavailable = new Error("NEXT_NOT_FOUND");
const Workspace = () => null;
mock.module(mod("node_modules/next/navigation.js"), { namedExports: { notFound: () => { throw unavailable; } } });
mock.module(mod("app/(site)/(application)/admin/chat-e2e/ChatE04FixtureWorkspace.tsx"), { namedExports: { ChatE04FixtureWorkspace: Workspace } });
const route = await import(mod("app/api/admin/chat-e2e-fixture/route.ts"));
const { GET } = route;
const { default: QaPage } = await import(mod("app/(site)/(application)/admin/chat-e2e/page.tsx"));
const request = (query = "action=accepted", origin = "https://staging.example.invalid") => new Request(`https://staging.example.invalid/api/admin/chat-e2e-fixture?${query}`, {
  method: "GET", headers: origin === null ? {} : { Origin: origin },
});

test("the server route rejects anonymous, nonadmin, production, development and cross-origin before running Auto", async () => {
  process.env.APP_ENV = "staging";
  authenticated = false; assert.equal((await GET(request())).status, 404);
  authenticated = true; administrator = false; assert.equal((await GET(request())).status, 404);
  administrator = true; process.env.APP_ENV = "production"; assert.equal((await GET(request())).status, 404);
  process.env.APP_ENV = "development"; assert.equal((await GET(request())).status, 404);
  process.env.APP_ENV = "staging"; assert.equal((await GET(request(undefined, "https://hostile.example.invalid"))).status, 403);
  assert.equal((await GET(request(undefined, null))).status, 403);
});

test("the actual page rejects production, development, anonymous and nonadmin before rendering the QA workspace", async () => {
  for (const environment of ["production", "development"]) {
    process.env.APP_ENV = environment; authenticated = true; administrator = true;
    await assert.rejects(QaPage(), (error) => error === unavailable);
  }
  process.env.APP_ENV = "staging";
  authenticated = false; administrator = true;
  await assert.rejects(QaPage(), (error) => error === unavailable);
  authenticated = true; administrator = false;
  await assert.rejects(QaPage(), (error) => error === unavailable);
  administrator = true;
  assert.equal((await QaPage()).type, Workspace);
});

test("the read-only API accepts one fixed action only, refuses body/method and returns no-store results", async () => {
  process.env.APP_ENV = "staging"; authenticated = true; administrator = true;
  for (const query of ["", "action=other", "action=accepted&action=accepted", "action=accepted&prompt=arbitrary", "action=accepted&", `action=${"%61".repeat(171)}`]) {
    assert.equal((await GET(request(query))).status, 400);
  }
  const bodyRequest = request();
  Object.defineProperty(bodyRequest, "body", { value: new ReadableStream({ start: (controller) => controller.close() }) });
  assert.equal((await GET(bodyRequest)).status, 400);
  assert.equal("POST" in route, false);
  assert.equal((await GET(new Request(request().url, { method: "POST" }))).status, 405);
  for (const action of ["default_off", "accepted", "kept_original", "stale", "replay", "unknown"]) {
    const response = await GET(request(`action=${action}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const result = await response.json();
    assert.equal(result.action, action);
    assert.equal(result.dispatchAuthorized, false);
    for (const key of ["providerCalls", "costMicroUsd", "productDatabaseWrites", "auditWrites"]) assert.equal(result[key], 0);
    assert.deepEqual(await (await GET(request(`action=${action}`))).json(), result);
  }
});
