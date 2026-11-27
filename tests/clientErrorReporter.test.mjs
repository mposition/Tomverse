import assert from "node:assert/strict";
import test from "node:test";
import {
  installClientErrorListeners,
  MAX_CLIENT_ERROR_REPORTS_PER_SESSION,
  reportClientError,
  resetClientErrorReporterForTests,
} from "../lib/clientErrorReporter.ts";

const sent = [];
const listeners = new Map();
let fetchBehaviour = () => Promise.resolve({ headers: new Headers() });

globalThis.window = {
  location: { pathname: "/chat/c0123456789abcdefghijklmn", search: "?conversation=x" },
  addEventListener: (type, handler) => listeners.set(type, handler),
  removeEventListener: (type) => listeners.delete(type),
};
globalThis.document = { documentElement: { lang: "ko" } };
globalThis.fetch = (url, init) => {
  sent.push({ url, init, body: JSON.parse(init.body) });
  return fetchBehaviour();
};

test.beforeEach(() => {
  sent.length = 0;
  listeners.clear();
  resetClientErrorReporterForTests();
  fetchBehaviour = () => Promise.resolve({ headers: new Headers() });
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a report carries only the allowed fields, with no query string or id", () => {
  const error = new TypeError("x is not a function");
  reportClientError(error, "window-error");
  assert.equal(sent.length, 1);
  const { url, init, body } = sent[0];
  assert.equal(url, "/api/diagnostics/client-error");
  assert.equal(init.method, "POST");
  assert.equal(init.keepalive, true);
  assert.equal(init.credentials, "omit");
  assert.deepEqual(Object.keys(body).sort(), [
    "build",
    "language",
    "message",
    "name",
    "path",
    "sessionId",
    "source",
    "stack",
  ]);
  assert.equal(body.name, "TypeError");
  assert.equal(body.path, "/chat/:id");
  assert.equal(body.language, "ko");
  assert.equal(body.source, "window-error");
});

test("the same error is sent once and a page sends a bounded number", () => {
  for (let index = 0; index < 5; index += 1) {
    reportClientError(new Error("same"), "window-error");
  }
  assert.equal(sent.length, 1);

  // Distinct error names stay distinct after numbers are folded.
  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    reportClientError(
      Object.assign(new Error("different"), { name: `Name${letter}` }),
      "manual"
    );
  }
  assert.equal(sent.length, MAX_CLIENT_ERROR_REPORTS_PER_SESSION);
});

test("cancelled requests and extension noise are not reported", () => {
  reportClientError(new DOMException("aborted", "AbortError"), "unhandled-rejection");
  const extension = new Error("boom");
  extension.stack = "Error: boom\n    at a (chrome-extension://abc/x.js:1:1)";
  reportClientError(extension, "window-error");
  assert.equal(sent.length, 0);
});

test("a rejection that is not an Error keeps only a string's text or its type", () => {
  reportClientError({ secret: "user text" }, "unhandled-rejection");
  reportClientError("plain string reason", "unhandled-rejection");
  assert.equal(sent[0].body.message, "[object]");
  assert.equal(sent[0].body.name, "NonErrorThrown");
  assert.equal(sent[1].body.message, "plain string reason");
});

test("a failed send is swallowed", async () => {
  fetchBehaviour = () => Promise.reject(new Error("offline"));
  reportClientError(new Error("one"), "manual");
  await flush();
  globalThis.fetch = () => {
    throw new Error("fetch exploded synchronously");
  };
  assert.doesNotThrow(() => reportClientError(new Error("two"), "manual"));
  globalThis.fetch = (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return fetchBehaviour();
  };
});

test("the route turning reporting off stops later sends", async () => {
  fetchBehaviour = () =>
    Promise.resolve({ headers: new Headers({ "x-client-error-reporting": "off" }) });
  reportClientError(new Error("first"), "manual");
  await flush();
  reportClientError(new Error("second"), "manual");
  assert.equal(sent.length, 1);
});

test("window listeners report errors and rejections and can be removed", () => {
  const stop = installClientErrorListeners();
  listeners.get("error")({ error: new RangeError("bad range") });
  listeners.get("error")({ error: null, message: "Script error.", filename: "", lineno: 0, colno: 0 });
  listeners.get("unhandledrejection")({ reason: new Error("rejected") });
  assert.deepEqual(
    sent.map((entry) => entry.body.source),
    ["window-error", "unhandled-rejection"]
  );
  stop();
  assert.equal(listeners.size, 0);
});

test("a boundary report carries the digest and a handled failure its label", () => {
  reportClientError(new Error("render"), "react-boundary", { digest: "123456" });
  reportClientError(new Error("slow"), "manual", { label: "chat stream/timeout" });
  assert.equal(sent[0].body.digest, "123456");
  assert.equal(sent[1].body.label, "chat_stream_timeout");
});
