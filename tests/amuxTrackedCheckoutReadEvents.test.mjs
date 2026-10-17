import assert from "node:assert/strict";
import test from "node:test";

import { createAmuxTrackedCheckoutReadObserver } from
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
