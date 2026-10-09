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
const { POST } = await import(mod("app/api/admin/chat-e2e-fixture/route.ts"));
const { default: QaPage } = await import(mod("app/(site)/(application)/admin/chat-e2e/page.tsx"));
const request = (body = { action: "accepted" }, origin = "https://staging.example.invalid") => new Request("https://staging.example.invalid/api/admin/chat-e2e-fixture", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: typeof body === "string" ? body : JSON.stringify(body),
});

test("the server route rejects anonymous, nonadmin, production, development and cross-origin before running Auto", async () => {
  process.env.APP_ENV = "staging";
  authenticated = false; assert.equal((await POST(request())).status, 404);
  authenticated = true; administrator = false; assert.equal((await POST(request())).status, 404);
  administrator = true; process.env.APP_ENV = "production"; assert.equal((await POST(request())).status, 404);
  process.env.APP_ENV = "development"; assert.equal((await POST(request())).status, 404);
  process.env.APP_ENV = "staging"; assert.equal((await POST(request(undefined, "https://hostile.example.invalid"))).status, 403);
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

test("the API accepts fixed actions only, caps bytes and returns no-store synthetic results", async () => {
  process.env.APP_ENV = "staging"; authenticated = true; administrator = true;
  for (const body of ["broken-json", " ".repeat(513), { action: "accepted", prompt: "client cannot supply this" }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json();
  assert.equal(result.inputSource, "accepted_proposal");
  assert.equal(result.dispatchAuthorized, false);
  assert.equal(result.providerCalls, 0); assert.equal(result.productDatabaseWrites, 0); assert.equal(result.auditWrites, 0);
});
