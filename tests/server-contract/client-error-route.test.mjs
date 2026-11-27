import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const captured = [];
let currentScope = null;

mock.module("@sentry/nextjs", {
  namedExports: {
    withScope: (callback) => {
      currentScope = {
        tags: {},
        contexts: {},
        fingerprint: null,
        level: null,
        setLevel(level) { this.level = level; },
        setTags(tags) { Object.assign(this.tags, tags); },
        setContext(name, value) { this.contexts[name] = value; },
        setFingerprint(value) { this.fingerprint = value; },
      };
      return callback(currentScope);
    },
    captureException: (error) => {
      captured.push({ error, scope: currentScope });
      return "event-id";
    },
  },
});

const { POST } = await import(mod("app/api/diagnostics/client-error/route.ts"));
const { resetClientErrorLimitersForTests } = await import(
  mod("lib/clientErrorReport.ts")
);

const validBody = (overrides = {}) => ({
  name: "TypeError",
  message: "x is not a function",
  stack: "TypeError: x is not a function\n    at f (https://tomverse.test/_next/a.js:1:2)",
  source: "window-error",
  path: "/chat/:id",
  build: "abc123def456",
  language: "ko",
  sessionId: "11111111-2222-4333-8444-555555555555",
  ...overrides,
});

const post = (body, { origin = "https://tomverse.test", headers = {} } = {}) =>
  POST(
    new Request("https://tomverse.test/api/diagnostics/client-error", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 test",
        ...(origin ? { origin } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );

test.beforeEach(() => {
  captured.length = 0;
  resetClientErrorLimitersForTests();
  delete process.env.CLIENT_ERROR_REPORTING_ENABLED;
});

test("a valid browser report reaches Sentry with source, page and build tags", async () => {
  const response = await post(validBody());
  assert.equal(response.status, 204);
  assert.equal(captured.length, 1);
  const { error, scope } = captured[0];
  assert.equal(error.name, "TypeError");
  assert.equal(error.message, "x is not a function");
  assert.equal(scope.tags["client.path"], "/chat/:id");
  assert.equal(scope.tags["client.build"], "abc123def456");
  assert.equal(scope.tags["client.source"], "window-error");
  assert.equal(scope.tags.errorCode, "BROWSER_ERROR");
  assert.match(scope.contexts.browser_error.stack, /at f /);
  assert.equal(scope.contexts.browser_error.userAgent, "Mozilla/5.0 test");
  assert.ok(Array.isArray(scope.fingerprint));
});

test("the server cleans what a browser sent again", async () => {
  const response = await post(
    validBody({
      message: `bad jane@example.com at https://tomverse.test/x?token=SECRET and "typed private words"`,
      path: "/share/c0123456789abcdefghijklmn?x=1",
      stack: "x".repeat(0) + "a ".repeat(6_000),
    })
  );
  assert.equal(response.status, 204);
  const { error, scope } = captured[0];
  assert.ok(!error.message.includes("jane@"), error.message);
  assert.ok(!error.message.includes("SECRET"), error.message);
  assert.ok(!error.message.includes("private"), error.message);
  assert.equal(scope.tags["client.path"], "/share/:id");
  assert.ok(scope.contexts.browser_error.stack.length <= 4_000);
});

test("fields a browser has no business sending are dropped", async () => {
  const response = await post(
    validBody({ userId: "u1", conversationId: "c1", email: "a@b.co", prompt: "hello" })
  );
  assert.equal(response.status, 204);
  const serialised = JSON.stringify([
    captured[0].error.message,
    captured[0].scope.tags,
    captured[0].scope.contexts,
  ]);
  for (const leaked of ["u1", "c1", "a@b.co", "hello"]) {
    assert.ok(!serialised.includes(`"${leaked}"`), leaked);
  }
});

test("an invalid report is refused and nothing is sent", async () => {
  assert.equal((await post({ nope: true })).status, 400);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post(validBody({ source: "other" }))).status, 400);
  assert.equal((await post(validBody({ sessionId: "short" }))).status, 400);
  assert.equal(captured.length, 0);
});

test("an oversized body is refused", async () => {
  const response = await post(validBody({ stack: "a ".repeat(20_000) }));
  assert.equal(response.status, 413);
  assert.equal(captured.length, 0);
});

test("a request without a same-origin Origin header is refused", async () => {
  assert.equal((await post(validBody(), { origin: null })).status, 403);
  assert.equal((await post(validBody(), { origin: "https://evil.example" })).status, 403);
  assert.equal(captured.length, 0);
});

test("one page load, one error and one address are each bounded", async () => {
  for (let index = 0; index < 30; index += 1) {
    await post(validBody({ name: `Name${String.fromCharCode(97 + (index % 26))}`, message: `m ${index}` }));
  }
  // 12 per page load.
  assert.equal(captured.length, 12);

  captured.length = 0;
  resetClientErrorLimitersForTests();
  for (let index = 0; index < 15; index += 1) {
    await post(validBody({ sessionId: `session-number-${index}-aaaa` }));
  }
  // The same error from 15 different pages: 10 per error.
  assert.equal(captured.length, 10);

  captured.length = 0;
  resetClientErrorLimitersForTests();
  const statuses = [];
  for (let index = 0; index < 40; index += 1) {
    statuses.push(
      (await post(validBody({ sessionId: `other-session-${index}-bbbb`, name: `N${String.fromCharCode(97 + (index % 26))}`, message: `m${index}` }))).status
    );
  }
  // Limited requests are answered like accepted ones; only 30 reach Sentry.
  assert.ok(statuses.every((status) => status === 204));
  assert.equal(captured.length, 30);
});

test("the switch turns collection off and tells the page to stop", async () => {
  process.env.CLIENT_ERROR_REPORTING_ENABLED = "false";
  const response = await post(validBody());
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("x-client-error-reporting"), "off");
  assert.equal(captured.length, 0);
});
