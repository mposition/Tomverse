import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_ERROR_LIMITS,
  clientErrorFingerprint,
  isIgnorableClientError,
  normalizeClientErrorPath,
  redactClientErrorText,
} from "../lib/clientErrorReportCore.ts";

test("a page path loses its query string, hash and identifier segments", () => {
  assert.equal(
    normalizeClientErrorPath(
      "/chat/c0123456789abcdefghijklmn?conversation=secret#frag"
    ),
    "/chat/:id"
  );
  assert.equal(
    normalizeClientErrorPath("/share/3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab"),
    "/share/:id"
  );
  assert.equal(
    normalizeClientErrorPath("https://tomverse.app/settings/memory?tab=1"),
    "/settings/memory"
  );
  assert.equal(
    normalizeClientErrorPath("/support/help-centre/getting-started"),
    "/support/help-centre/getting-started"
  );
  assert.equal(normalizeClientErrorPath("/users/me@example.com/x"), "/users/:id/x");
  assert.ok(normalizeClientErrorPath(`/${"a".repeat(500)}`).length <= CLIENT_ERROR_LIMITS.path);
});

test("quoted input inside an engine message is removed, identifiers stay", () => {
  const json = redactClientErrorText(
    `Unexpected token 'h', "hello world, my card is"... is not valid JSON`,
    300
  );
  assert.ok(!json.includes("hello"), json);
  assert.ok(!json.includes("card"), json);
  assert.ok(json.includes("is not valid JSON"));

  // An HTML page parsed as JSON is the useful case; the '<' is punctuation.
  const html = redactClientErrorText(
    `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
    300
  );
  assert.ok(html.includes("'<'"), html);
  assert.ok(!html.includes("DOCTYPE"), html);

  const regex = redactClientErrorText(
    "Invalid regular expression: /private text(/: Unterminated group",
    300
  );
  assert.ok(!regex.includes("private"), regex);

  const selector = redactClientErrorText(
    "Failed to execute 'querySelector' on 'Document': 'my private words' is not a valid selector.",
    300
  );
  assert.ok(!selector.includes("private"), selector);
  assert.ok(selector.includes("'querySelector'"), selector);

  assert.equal(
    redactClientErrorText("Cannot read properties of undefined (reading 'map')", 300),
    "Cannot read properties of undefined (reading 'map')"
  );
  assert.equal(
    redactClientErrorText(`can't read "foo" of undefined; don't retry`, 300),
    `can't read "foo" of undefined; don't retry`
  );
});

test("emails, ids, secrets and URL queries are removed from text", () => {
  const cleaned = redactClientErrorText(
    [
      "Failed https://tomverse.app/api/x?token=abc123&conversation=1 for jane@example.com",
      "id 3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab",
      "Bearer abc.def.ghi password=hunter2",
      "/auth/email/verify?t=SECRET",
    ].join(" "),
    1_000
  );
  for (const leaked of ["abc123", "jane@", "3f2b8c1e", "abc.def.ghi", "hunter2", "SECRET"]) {
    assert.ok(!cleaned.includes(leaked), `${leaked} survived: ${cleaned}`);
  }
});

test("a stack keeps its line breaks and the position after a stripped query", () => {
  const stack = redactClientErrorText(
    "TypeError: x\n    at f (https://tomverse.app/_next/static/chunks/a.js?dpl=abc:10:20)\n    at g (https://tomverse.app/_next/static/chunks/b.js:1:2)",
    4_000,
    { multiline: true }
  );
  assert.equal(stack.split("\n").length, 3);
  assert.ok(stack.includes("a.js:10:20"), stack);
  assert.ok(!stack.includes("dpl"), stack);
});

test("text is cut to its limit", () => {
  assert.equal(redactClientErrorText("ab ".repeat(400), 50).length, 50);
});

test("noise that says nothing about the product is ignorable", () => {
  assert.ok(isIgnorableClientError({ name: "AbortError", message: "aborted" }));
  assert.ok(
    isIgnorableClientError({
      name: "Error",
      message: "x",
      stack: "at a (chrome-extension://abc/content.js:1:1)",
    })
  );
  assert.ok(
    isIgnorableClientError({
      name: "Error",
      message: "ResizeObserver loop completed with undelivered notifications.",
    })
  );
  assert.ok(isIgnorableClientError({ name: "Error", message: "Script error." }));
  assert.ok(!isIgnorableClientError({ name: "TypeError", message: "x is undefined" }));
  assert.ok(
    !isIgnorableClientError({ name: "ChunkLoadError", message: "Loading chunk 12 failed" })
  );
});

test("the fingerprint folds numbers and ignores line positions", () => {
  const a = clientErrorFingerprint({
    name: "TypeError",
    message: "item 12 is bad",
    stack: "TypeError: x\n    at f (https://t/a.js:10:20)",
  });
  const b = clientErrorFingerprint({
    name: "TypeError",
    message: "item 99 is bad",
    stack: "TypeError: x\n    at f (https://t/a.js:11:5)",
  });
  assert.equal(a, b);
  assert.notEqual(
    a,
    clientErrorFingerprint({ name: "RangeError", message: "item 12 is bad" })
  );
});
