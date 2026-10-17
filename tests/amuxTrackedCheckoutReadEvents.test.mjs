import assert from "node:assert/strict";
import test from "node:test";

import { createAmuxTrackedCheckoutReadObserver,
  createAmuxTrackedCheckoutReadStreamObserver } from
  "../lib/amux/ideaTrackedCheckoutReadEvents.mjs";

const directory = "/tmp/amux-v19-checkout-abcdef";
const file = `${directory}/src/a.ts`;
const make = () => createAmuxTrackedCheckoutReadObserver({
  directory, files: ["src/a.ts", "src/b.ts"],
});
const observe = (observer, event) => observer.observeLine(JSON.stringify(event));
const use = (id, name, input) => ({ type: "assistant", message: {
  role: "assistant", content: [{ type: "tool_use", id, name, input }],
} });
const reply = (id, isError = false) => ({ type: "user", message: {
  role: "user", content: [{ type: "tool_result", tool_use_id: id,
    is_error: isError, content: "untrusted file bytes" }],
} });
const complete = (observer) => {
  observe(observer, { type: "result", subtype: "success", is_error: false,
    result: "untrusted final text" });
  return observer.finish();
};

test("records successful Read results and deduplicates their paths", () => {
  const observer = make();
  observe(observer, { type: "system", subtype: "init" });
  observe(observer, use("read_1", "Read", { file_path: file }));
  observe(observer, reply("read_1"));
  observe(observer, use("read_2", "Read", { file_path: file }));
  observe(observer, reply("read_2"));
  assert.deepEqual(complete(observer), { kind: "complete", files: ["src/a.ts"] });
});

test("a bounded Read still records the file it touched", () => {
  const observer = make();
  observe(observer, use("read_1", "Read", { file_path: file,
    offset: 2, limit: 1 }));
  observe(observer, reply("read_1"));
  assert.deepEqual(complete(observer), { kind: "complete", files: ["src/a.ts"] });
});

test("failed Read and tool summaries leave the file manifest unverified", () => {
  const failed = make();
  observe(failed, use("read_1", "Read", { file_path: file }));
  observe(failed, reply("read_1", true));
  assert.deepEqual(complete(failed), { kind: "unverified" });
  const summary = make();
  observe(summary, { type: "tool_use_summary" });
  assert.deepEqual(complete(summary), { kind: "unverified" });
});

test("refuses to certify search or listing from incomplete file events", () => {
  for (const name of ["Grep", "Glob"]) {
    const observer = make();
    observe(observer, use("tool_1", name, { pattern: "needle" }));
    observe(observer, reply("tool_1"));
    assert.deepEqual(complete(observer), { kind: "unverified" });
  }
});

test("rejects unauthorized paths, tools, unmatched results and missing final result", () => {
  const cases = [
    [use("x", "Read", { file_path: `${directory}/src/../secrets.txt` })],
    [use("x", "Read", { file_path: "/run/amux-cli/anthropic-api-key" })],
    [use("x", "Write", { file_path: file })],
    [reply("unknown")],
    [use("x", "Read", { file_path: file })],
    [use("x", "Glob", { pattern: "*.ts" }), reply("x"),
      use("x", "Read", { file_path: file })],
    [use(undefined, "Read", { file_path: file }), reply(undefined)],
    [use("x", "Read", { file_path: file }), reply("x"), reply("x")],
    [use("x", "Read", { file_path: file }),
      { type: "user", message: { content: [{ type: "tool_result",
        tool_use_id: "x", content: "bytes" }] } }],
    [{ type: "assistant", message: { content: [{ type: "server_tool_use" }] } }],
  ];
  for (const events of cases) {
    const observer = make();
    for (const event of events) observe(observer, event);
    assert.deepEqual(complete(observer), { kind: "unverified" });
  }
  const noFinal = make();
  assert.deepEqual(noFinal.finish(), { kind: "unverified" });
});

test("malformed and trailing events invalidate a previously complete manifest", () => {
  const observer = make();
  assert.deepEqual(complete(observer), { kind: "complete", files: [] });
  observer.observeLine("not-json");
  assert.deepEqual(observer.finish(), { kind: "unverified" });
});

test("streamed CLI chunks preserve a Unicode Read path across byte boundaries", () => {
  const relative = "src/π.ts";
  const observer = createAmuxTrackedCheckoutReadStreamObserver({
    directory, files: [relative],
  });
  const output = [
    use("read_unicode", "Read", { file_path: `${directory}/${relative}` }),
    reply("read_unicode"),
    { type: "result", subtype: "success", is_error: false },
  ].map(JSON.stringify).join("\n");
  const bytes = Buffer.from(output, "utf8");
  for (let offset = 0; offset < bytes.length; offset++) {
    observer.observeChunk(bytes.subarray(offset, offset + 1));
  }
  assert.deepEqual(observer.finish(), { kind: "complete", files: [relative] });
});

test("malformed and truncated streamed events cannot certify a read manifest", () => {
  const malformed = createAmuxTrackedCheckoutReadStreamObserver({
    directory, files: ["src/a.ts"],
  });
  malformed.observeChunk(Buffer.from(JSON.stringify(use("x", "Read", {
    file_path: file,
  })) + "\n"));
  malformed.observeChunk(Buffer.from([0xff, 0x0a]));
  malformed.observeChunk(Buffer.from(JSON.stringify(reply("x")) + "\n"));
  assert.deepEqual(malformed.finish(), { kind: "unverified" });

  const truncated = createAmuxTrackedCheckoutReadStreamObserver({
    directory, files: ["src/a.ts"],
  });
  truncated.observeChunk(Buffer.from('{"type":"result","subtype":'));
  assert.deepEqual(truncated.finish(), { kind: "unverified" });

  const trailing = createAmuxTrackedCheckoutReadStreamObserver({
    directory, files: [],
  });
  trailing.observeChunk(Buffer.from('{"type":"result","subtype":"success","is_error":false}'));
  assert.deepEqual(trailing.finish(), { kind: "complete", files: [] });
  trailing.observeChunk(Buffer.from("\n"));
  assert.deepEqual(trailing.finish(), { kind: "unverified" });
});

test("stream decoder fails closed on broken UTF-8, blank lines and invalid chunks", () => {
  const brokenUtf8 = createAmuxTrackedCheckoutReadStreamObserver({
    directory, files: [],
  });
  brokenUtf8.observeChunk(Buffer.from([0xc3]));
  assert.deepEqual(brokenUtf8.finish(), { kind: "unverified" });

  const invalidChunk = createAmuxTrackedCheckoutReadStreamObserver({
    directory, files: [],
  });
  invalidChunk.observeChunk("not bytes");
  assert.deepEqual(invalidChunk.finish(), { kind: "unverified" });

  const blankLine = createAmuxTrackedCheckoutReadStreamObserver({
    directory, files: [],
  });
  blankLine.observeChunk(Buffer.from('\n{"type":"result","subtype":"success","is_error":false}\n'));
  assert.deepEqual(blankLine.finish(), { kind: "unverified" });

  const bom = createAmuxTrackedCheckoutReadStreamObserver({
    directory, files: [],
  });
  bom.observeChunk(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"type":"result","subtype":"success","is_error":false}')]));
  assert.deepEqual(bom.finish(), { kind: "unverified" });

  const crlf = createAmuxTrackedCheckoutReadStreamObserver({
    directory, files: [],
  });
  crlf.observeChunk(Buffer.from('{"type":"system"}\r\n{"type":"result","subtype":"success","is_error":false}\r\n'));
  assert.deepEqual(crlf.finish(), { kind: "complete", files: [] });
});
