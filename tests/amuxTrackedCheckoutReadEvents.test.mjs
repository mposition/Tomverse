import assert from "node:assert/strict";
import test from "node:test";

import { createAmuxTrackedCheckoutReadObserver,
  createAmuxTrackedCheckoutReadStreamObserver,
  createAmuxTrackedCheckoutAnalysisStreamObserver } from
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

test("complete file-open trace certifies Grep/Glob and must include successful Reads", () => {
  for (const name of ["Grep", "Glob"]) {
    const observer = make();
    observe(observer, use("tool_1", name, { pattern: "needle" }));
    observe(observer, reply("tool_1"));
    observe(observer, { type: "result", subtype: "success", is_error: false });
    assert.deepEqual(observer.finish({ openTrace: { kind: "complete",
      files: ["src/b.ts", "src/a.ts"] } }), {
      kind: "complete", files: ["src/a.ts", "src/b.ts"],
    });
  }
  const missing = make();
  observe(missing, use("read_1", "Read", { file_path: file }));
  observe(missing, reply("read_1"));
  observe(missing, { type: "result", subtype: "success", is_error: false });
  assert.deepEqual(missing.finish({ openTrace: { kind: "complete", files: [] } }),
    { kind: "unverified" });
  const invalid = make();
  observe(invalid, use("tool_1", "Glob", { pattern: "*" }));
  observe(invalid, reply("tool_1"));
  observe(invalid, { type: "result", subtype: "success", is_error: false });
  assert.deepEqual(invalid.finish({ openTrace: { kind: "unverified" } }),
    { kind: "unverified" });
});

test("rejects unauthorized paths, tools, unmatched results and missing final result", () => {
  const cases = [
    [use("x", "Read", { file_path: `${directory}/src/../secrets.txt` })],
    [use("x", "Read", { file_path: "/run/amux-cli/claude-oauth-token" })],
    [use("x", "Write", { file_path: file })],
    [reply("unknown")],
    [use("x", "Read", { file_path: file })],
    [use("x", "Glob", { pattern: "*.ts" }), reply("x"),
      use("x", "Read", { file_path: file })],
    [use(undefined, "Read", { file_path: file }), reply(undefined)],
    [use("x", "Read", { file_path: file }), reply("x"), reply("x")],
    [use("x", "Read", { file_path: file }),
      { type: "user", message: { content: [{ type: "tool_result",
        tool_use_id: "x", is_error: "false", content: "bytes" }] } }],
    [{ type: "assistant", message: { content: [{ type: "server_tool_use" }] } }],
  ];
  for (const events of cases) {
    const observer = make();
    for (const event of events) observe(observer, event);
    assert.deepEqual(complete(observer), { kind: "unverified" });
    assert.equal(typeof observer.rejectReason(), "string");
  }
  const noFinal = make();
  assert.deepEqual(noFinal.finish(), { kind: "unverified" });
  assert.equal(noFinal.rejectReason(), "result_missing");
});

test("a successful tool result without is_error counts, as the pinned CLI writes it", () => {
  // CLI 2.1.288 builds `{tool_use_id, type: "tool_result", content}` for a
  // successful tool and adds is_error only on failure.
  const observer = make();
  observe(observer, use("read_1", "Read", { file_path: file }));
  observe(observer, { type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "read_1", content: "untrusted bytes" }] } });
  assert.deepEqual(complete(observer), { kind: "complete", files: ["src/a.ts"] });
  assert.equal(observer.rejectReason(), null);
  const failed = make();
  observe(failed, use("read_1", "Read", { file_path: file }));
  observe(failed, reply("read_1", true));
  assert.deepEqual(complete(failed), { kind: "unverified" });
  assert.equal(failed.rejectReason(), "tool_result_error");
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

const modelId = "claude-opus-5-5";
const analysisInit = { type: "system", subtype: "init",
  tools: ["Read", "Grep", "Glob"], permissionMode: "dontAsk",
  mcp_servers: [], skills: [], plugins: [], agents: [] };
const analysisResult = { type: "result", subtype: "success", is_error: false,
  num_turns: 2, result: '{"schemaVersion":2,"plan":[]}',
  modelUsage: { [modelId]: { inputTokens: 10, outputTokens: 2,
    cacheReadInputTokens: 3, cacheCreationInputTokens: 1 } } };
const analyze = (events, options = {}) => {
  const observer = createAmuxTrackedCheckoutAnalysisStreamObserver({
    directory, files: ["src/a.ts"], modelId,
  });
  const bytes = Buffer.from(events.map(JSON.stringify).join("\n"), "utf8");
  for (let offset = 0; offset < bytes.length; offset += 3)
    observer.observeChunk(bytes.subarray(offset, offset + 3));
  return observer.finish({ exitCode: 0, stdoutComplete: true, ...options });
};

test("analysis stream returns result, measured usage and exact successful Read manifest", () => {
  assert.deepEqual(analyze([analysisInit,
    use("read_1", "Read", { file_path: file }), reply("read_1"),
    analysisResult]), {
    kind: "verified_success", rawModelOutput: analysisResult.result,
    readFiles: ["src/a.ts"], inputTokens: 14, outputTokens: 2,
  });
});

test("analysis stream accepts Grep only with a complete checkout open trace", () => {
  const events = [analysisInit, use("grep_1", "Grep", { pattern: "x" }),
    reply("grep_1"), analysisResult];
  assert.deepEqual(analyze(events, { openTrace: { kind: "complete",
    files: ["src/a.ts"] } }), {
    kind: "verified_success", rawModelOutput: analysisResult.result,
    readFiles: ["src/a.ts"], inputTokens: 14, outputTokens: 2,
  });
  assert.deepEqual(analyze(events, { openTrace: { kind: "unverified" } }),
    { kind: "outcome_unknown" });
});

test("analysis stream accepts only the pinned inert Claude metadata shape", () => {
  const init = { ...analysisInit,
    plugins: ["a", "b"].map((name) => ({ path: `bundled/${name}`,
      source: `${name}@bundled` })), agents: [{}, {}, {}, {}] };
  const events = [init, use("read_1", "Read", { file_path: file }),
    reply("read_1"), analysisResult];
  assert.equal(analyze(events).kind, "verified_success");
  assert.deepEqual(analyze([{ ...init, plugins: [
    { ...init.plugins[0], path: "../outside" }, init.plugins[1],
  ] }, ...events.slice(1)]), { kind: "outcome_unknown" });
});

test("analysis stream accepts the descriptors the pinned CLI 2.1.288 reports, and no others", () => {
  // Measured on the v19 runner without credentials (2026-10-19).
  const plugin = (name) => ({ name, path: "builtin", source: `${name}@builtin` });
  const init = { ...analysisInit, apiKeySource: "none", model: modelId,
    plugins: ["cc-plugin-agents-md", "cc-plugin-telemetry",
      "cc-plugin-plugin-authoring"].map(plugin),
    agents: ["claude", "Explore", "general-purpose", "Plan"] };
  const rest = [use("read_1", "Read", { file_path: file }),
    { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "read_1", content: "untrusted bytes" }] } },
    analysisResult];
  assert.equal(analyze([init, ...rest]).kind, "verified_success");
  const refused = (changed) => {
    const observer = createAmuxTrackedCheckoutAnalysisStreamObserver({
      directory, files: ["src/a.ts"], modelId });
    observer.observeChunk(Buffer.from([changed, ...rest].map(JSON.stringify).join("\n")));
    assert.deepEqual(observer.finish({ exitCode: 0, stdoutComplete: true }),
      { kind: "outcome_unknown" });
    return observer.rejectReason().code;
  };
  assert.equal(refused({ ...init, plugins: [...init.plugins, plugin("cc-plugin-extra")] }),
    "init_descriptors");
  assert.equal(refused({ ...init, plugins: [plugin("cc-plugin-agents-md"),
    plugin("cc-plugin-telemetry"), { ...plugin("cc-plugin-plugin-authoring"), path: "/home/x" }] }),
  "init_descriptors");
  assert.equal(refused({ ...init, agents: [...init.agents.slice(0, 3), "Writer"] }),
    "init_descriptors");
  assert.equal(refused({ ...init, tools: ["Read", "Grep", "Bash"] }), "init_tools");
});

test("analysis stream names an unexpected system event by the CLI's own vocabulary only", () => {
  const rest = [use("read_1", "Read", { file_path: file }), reply("read_1"),
    analysisResult];
  const code = (subtype) => {
    const observer = createAmuxTrackedCheckoutAnalysisStreamObserver({
      directory, files: ["src/a.ts"], modelId });
    observer.observeChunk(Buffer.from([analysisInit, { type: "system", subtype },
      ...rest].map(JSON.stringify).join("\n")));
    assert.deepEqual(observer.finish({ exitCode: 0, stdoutComplete: true }),
      { kind: "outcome_unknown" });
    return observer.rejectReason().code;
  };
  assert.equal(code("hook_started"), "system_event_hook_started");
  assert.equal(code("private_customer_identifier"), "system_event_other");
});

test("analysis stream names the usage check that refused, with model names only", () => {
  const observer = createAmuxTrackedCheckoutAnalysisStreamObserver({
    directory, files: ["src/a.ts"], modelId });
  const twoModels = { ...analysisResult, modelUsage: {
    ...analysisResult.modelUsage,
    "claude-haiku-4-5-20251001": { inputTokens: 5, outputTokens: 1,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
  observer.observeChunk(Buffer.from([analysisInit,
    use("read_1", "Read", { file_path: file }), reply("read_1"), twoModels]
    .map(JSON.stringify).join("\n")));
  assert.deepEqual(observer.finish({ exitCode: 0, stdoutComplete: true }),
    { kind: "outcome_unknown" });
  const reason = observer.rejectReason();
  assert.equal(reason.code, "usage_model_count");
  assert.deepEqual([...reason.usageModels].sort(),
    ["claude-haiku-4-5-20251001", modelId]);
});

test("analysis stream refuses incomplete file enumeration and untrusted result envelopes", () => {
  const read = [use("read_1", "Read", { file_path: file }), reply("read_1")];
  for (const events of [
    [analysisInit, use("grep_1", "Grep", { pattern: "x" }),
      reply("grep_1"), analysisResult],
    [{ ...analysisInit, tools: ["Read", "Grep", "Bash"] },
      ...read, analysisResult],
    [{ ...analysisInit, mcp_servers: [{ name: "external" }] },
      ...read, analysisResult],
    [{ ...analysisInit, mcp_servers: { length: 0 } },
      ...read, analysisResult],
    [{ ...analysisInit, permissionMode: "bypassPermissions" },
      ...read, analysisResult],
    [analysisInit, ...read, { ...analysisResult,
      modelUsage: { "claude-other": analysisResult.modelUsage[modelId] } }],
    [analysisInit, ...read, { ...analysisResult, modelUsage: {} }],
    [analysisInit, ...read, { ...analysisResult, result: "" }],
    [analysisInit, ...read],
  ]) assert.deepEqual(analyze(events), { kind: "outcome_unknown" });
  assert.deepEqual(analyze([analysisInit, ...read, analysisResult],
    { exitCode: 1 }), { kind: "outcome_unknown" });
  assert.deepEqual(analyze([analysisInit, ...read, analysisResult],
    { stdoutComplete: false }), { kind: "outcome_unknown" });
});

test("analysis stream invalidates a result if bytes arrive after finish", () => {
  const observer = createAmuxTrackedCheckoutAnalysisStreamObserver({
    directory, files: ["src/a.ts"], modelId,
  });
  observer.observeChunk(Buffer.from([analysisInit,
    use("read_1", "Read", { file_path: file }), reply("read_1"),
    analysisResult].map(JSON.stringify).join("\n")));
  assert.equal(observer.finish({ exitCode: 0, stdoutComplete: true }).kind,
    "verified_success");
  observer.observeChunk(Buffer.from("late"));
  assert.deepEqual(observer.finish(), { kind: "outcome_unknown" });
});

test("a content-free ui_invalidate event is accepted; one paid run names every failing check", () => {
  // Measured in the sixth Max S0 call (CLI 2.1.288).
  const rest = [use("read_1", "Read", { file_path: file }), reply("read_1")];
  assert.equal(analyze([analysisInit, { type: "system", subtype: "ui_invalidate" },
    ...rest, analysisResult]).kind, "verified_success");
  const capability = createAmuxTrackedCheckoutAnalysisStreamObserver({
    directory, files: ["src/a.ts"], modelId });
  capability.observeChunk(Buffer.from([analysisInit,
    { type: "system", subtype: "ui_invalidate", tools: ["Bash"] }, ...rest, analysisResult]
    .map(JSON.stringify).join("\n")));
  assert.deepEqual(capability.finish({ exitCode: 0, stdoutComplete: true }),
    { kind: "outcome_unknown" });
  assert.equal(capability.rejectReason().code, "system_event_ui_invalidate");
  const several = createAmuxTrackedCheckoutAnalysisStreamObserver({
    directory, files: ["src/a.ts"], modelId });
  several.observeChunk(Buffer.from([analysisInit, { type: "system", subtype: "hook_started" },
    use("grep_1", "Grep", { pattern: "x" }), reply("grep_1"),
    { ...analysisResult, modelUsage: { ...analysisResult.modelUsage,
      "claude-haiku-4-5-20251001": { inputTokens: 1, outputTokens: 1 } } }]
    .map(JSON.stringify).join("\n")));
  assert.deepEqual(several.finish({ exitCode: 0, stdoutComplete: true,
    openTrace: { kind: "unverified", reason: "undecoded_open" } }), { kind: "outcome_unknown" });
  const reason = several.rejectReason();
  assert.equal(reason.code, "system_event_hook_started");
  assert.ok(reason.also.includes("stream_trace_unverified"));
  assert.ok(reason.also.includes("usage_model_count") || reason.also.includes("usage_incomplete"));
});

test("detail mode names the refused system event and its keys, never its body", () => {
  const secret = "sk-ant-oat01-SyntheticSecret_0123456789";
  const rest = [use("read_1", "Read", { file_path: file }), reply("read_1"),
    analysisResult];
  const run = (event, detail) => {
    const observer = createAmuxTrackedCheckoutAnalysisStreamObserver({
      directory, files: ["src/a.ts"], modelId, ...(detail ? { detail } : {}) });
    observer.observeChunk(Buffer.from([analysisInit, event, ...rest]
      .map(JSON.stringify).join("\n")));
    assert.deepEqual(observer.finish({ exitCode: 0, stdoutComplete: true }),
      { kind: "outcome_unknown" });
    return observer;
  };
  const event = { type: "system", subtype: "tengu.private_event-1",
    message: `prompt text ${secret}`, session_id: "9a2f", payload: { token: secret } };
  const off = run(event, false);
  assert.deepEqual(off.rejectDetail(), []);
  assert.equal(off.rejectReason().code, "system_event_other");
  const on = run(event, true);
  assert.equal(on.rejectReason().code, "system_event_other",
    "detail mode does not change the verdict or its code");
  assert.deepEqual(on.rejectDetail(), [{ code: "system_event_other",
    keys: ["type", "subtype", "message", "session_id", "payload"],
    subtype: "tengu.private_event-1" }]);
  assert.equal(JSON.stringify(on.rejectDetail()).includes(secret), false);
  assert.equal(JSON.stringify(on.rejectDetail()).includes("prompt text"), false);
  // A subtype that is not a short token is reported as such, not echoed.
  const odd = run({ type: "system", subtype: "a b/../etc" }, true);
  assert.equal(odd.rejectDetail()[0].subtype, "<invalid>");
  const long = run({ type: "system", subtype: "x".repeat(300) }, true);
  assert.equal(long.rejectDetail()[0].subtype.length, 64);
});

test("detail mode names init refusals and refused Read paths by name only", () => {
  const secret = "sk-ant-oat01-SyntheticSecret_0123456789";
  const observer = createAmuxTrackedCheckoutAnalysisStreamObserver({
    directory, files: ["src/a.ts"], modelId, detail: true });
  observer.observeChunk(Buffer.from([{ ...analysisInit,
    tools: ["Read", "Grep", "Bash"], apiKey: secret },
  use("read_1", "Read", { file_path: `${directory}/.env` }),
  use("bash_1", "Bash", { command: `echo ${secret}` }),
  analysisResult].map(JSON.stringify).join("\n")));
  observer.finish({ exitCode: 0, stdoutComplete: true });
  const detail = observer.rejectDetail();
  assert.deepEqual(detail[0], { code: "init_tools",
    keys: ["type", "subtype", "tools", "permissionMode", "mcp_servers", "skills",
      "plugins", "agents", "apiKey"],
    names: ["tool:Read", "tool:Grep", "tool:Bash"] });
  assert.equal(JSON.stringify(detail).includes(secret), false);
  const paths = createAmuxTrackedCheckoutReadObserver({ directory,
    files: ["src/a.ts"], detail: true });
  observe(paths, use("read_1", "Read", { file_path: `${directory}/.env` }));
  assert.deepEqual(paths.rejectDetail(), [{ code: "read_path_refused", path: ".env" }]);
  const outside = createAmuxTrackedCheckoutReadObserver({ directory,
    files: ["src/a.ts"], detail: true });
  observe(outside, use("read_1", "Read", { file_path: "/home/runner/.claude/x" }));
  assert.deepEqual(outside.rejectDetail(),
    [{ code: "read_path_refused", path: "<outside>" }]);
  const tool = createAmuxTrackedCheckoutReadObserver({ directory,
    files: ["src/a.ts"], detail: true });
  observe(tool, use("bash_1", "Bash", { command: `echo ${secret}` }));
  assert.deepEqual(tool.rejectDetail(), [{ code: "tool_use_refused", name: "Bash" }]);
  // Off by default: nothing is retained.
  const quiet = make();
  observe(quiet, use("read_1", "Read", { file_path: `${directory}/.env` }));
  assert.deepEqual(quiet.rejectDetail(), []);
  assert.equal(quiet.rejectReason(), "read_path_refused");
});

test("thinking_tokens progress events pass only in their measured content-free shape", () => {
  const thinking = { type: "system", subtype: "thinking_tokens",
    estimated_tokens: 1200, estimated_tokens_delta: 40,
    session_id: "s", uuid: "u" };
  const readCall = use("read_1", "Read", { file_path: file });
  const withEvent = (extra) => analyze([analysisInit, extra, readCall,
    reply("read_1"), extra, analysisResult]);
  assert.equal(withEvent(thinking).kind, "verified_success");
  const withoutUuid = { ...thinking };
  delete withoutUuid.uuid;
  for (const changed of [
    { ...thinking, text: "a thought" },
    { ...thinking, tools: ["Bash"] },
    { ...thinking, estimated_tokens: "1200" },
    withoutUuid,
  ]) assert.deepEqual(withEvent(changed), { kind: "outcome_unknown" });
});
