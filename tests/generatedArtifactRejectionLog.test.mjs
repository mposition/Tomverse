import assert from "node:assert/strict";
import test from "node:test";
import { streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import {
  ArtifactToolRejectionLog,
  MAX_ARTIFACT_REJECTION_LOGS_PER_TURN,
} from "../lib/generatedArtifactRejectionLog.ts";

const createLog = () => {
  const lines = [];
  return {
    lines,
    subject: new ArtifactToolRejectionLog(
      ["create_text_file", "create_document"],
      (line) => lines.push(line)
    ),
  };
};

test("default logger resolves console.warn when a rejection is emitted", () => {
  const subject = new ArtifactToolRejectionLog(["create_text_file"]);
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => lines.push(line);
  try {
    subject.record("call_1", "create_text_file", {
      format: "txt", filename: "SECRET_FILENAME.txt",
    }, "spec_rejected");
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(lines.map(JSON.parse), [{
    event: "generated_artifact_tool_rejected",
    toolName: "create_text_file",
    requestedFormat: "txt",
    rejectionCode: "spec_rejected",
  }]);
  assert.doesNotMatch(lines[0], /SECRET_|call_1/);
});

test("SDK-invalid calls log only allowlisted metadata, once per call", () => {
  const { lines, subject } = createLog();
  const input = {
    format: "txt",
    filename: "SECRET_FILENAME.txt",
    content: "SECRET_CONTENT",
    prompt: "SECRET_PROMPT",
  };
  const invalid = {
    type: "tool-call",
    invalid: true,
    toolCallId: "call_1",
    toolName: "create_text_file",
    input,
    error: new Error("SECRET_PROVIDER_ERROR"),
  };
  subject.noteChunk(invalid);
  subject.noteChunk({ ...invalid, type: "tool-error" });
  subject.noteChunk(invalid);
  subject.record("call_1", "create_text_file", input, "spec_rejected");

  assert.deepEqual(lines.map(JSON.parse), [{
    event: "generated_artifact_tool_rejected",
    toolName: "create_text_file",
    requestedFormat: "txt",
    rejectionCode: "input_schema_rejected",
  }]);
  assert.doesNotMatch(lines[0], /SECRET_|call_1/);
});

test("unrecognised formats become null, and unrelated or valid calls are silent", () => {
  const { lines, subject } = createLog();
  subject.noteChunk({
    type: "tool-call", invalid: true, toolCallId: "search",
    toolName: "web_search", input: { format: "txt" },
  });
  subject.noteChunk({
    type: "tool-call", invalid: true, providerExecuted: true,
    toolCallId: "hosted", toolName: "create_text_file",
    input: { format: "txt" },
  });
  subject.noteChunk({
    type: "tool-call", invalid: false, toolCallId: "valid",
    toolName: "create_text_file", input: { format: "txt" },
  });
  subject.noteChunk({
    type: "tool-call", invalid: true, toolCallId: "bad_format",
    toolName: "create_text_file",
    input: { format: "SECRET_FORMAT", content: "SECRET_CONTENT" },
  });
  subject.noteChunk({
    type: "tool-call", invalid: true, toolCallId: "raw_input",
    toolName: "create_text_file", input: '{"format":"txt","content":"SECRET"}',
  });

  assert.deepEqual(lines.map(JSON.parse), [
    { event: "generated_artifact_tool_rejected", toolName: "create_text_file", requestedFormat: null, rejectionCode: "input_schema_rejected" },
    { event: "generated_artifact_tool_rejected", toolName: "create_text_file", requestedFormat: null, rejectionCode: "input_schema_rejected" },
  ]);
  assert.doesNotMatch(lines.join(""), /SECRET_/);
});

test("hostile format access and a failing sink cannot disrupt rejection handling", () => {
  const { lines, subject } = createLog();
  const input = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error("SECRET_GETTER_ERROR"); },
  });
  assert.doesNotThrow(() =>
    subject.record("hostile", "create_text_file", input, "spec_rejected")
  );
  assert.equal(JSON.parse(lines[0]).requestedFormat, null);
  assert.doesNotMatch(lines[0], /SECRET_/);

  const brokenSink = new ArtifactToolRejectionLog(
    ["create_text_file"],
    () => { throw new Error("sink unavailable"); }
  );
  assert.doesNotThrow(() =>
    brokenSink.record("sink", "create_text_file", { format: "txt" }, "spec_rejected")
  );
});

test("hostile SDK event property reads fail closed without affecting the turn", () => {
  const { lines, subject } = createLog();
  const throwsImmediately = new Proxy({}, {
    get() { throw new Error("SECRET_EVENT_ERROR"); },
  });
  const throwsOnInput = new Proxy({
    type: "tool-call", invalid: true, toolCallId: "hostile_call",
    toolName: "create_text_file",
  }, {
    get(target, key) {
      if (key === "input") throw new Error("SECRET_INPUT_ERROR");
      return Reflect.get(target, key);
    },
  });

  assert.doesNotThrow(() => subject.noteChunk(throwsImmediately));
  assert.doesNotThrow(() => subject.noteChunk(throwsOnInput));
  assert.deepEqual(lines, []);
  subject.noteChunk({
    type: "tool-call", invalid: true, toolCallId: "valid_after_hostile",
    toolName: "create_text_file", input: { format: "txt" },
  });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /SECRET_/);
});

test("per-turn diagnostics cap bounds output across new and repeated call IDs", () => {
  const { lines, subject } = createLog();
  const invalid = (id) => ({
    type: "tool-call", invalid: true, toolCallId: `call_${id}`,
    toolName: "create_text_file", input: { format: "txt" },
  });

  subject.noteChunk(invalid(0));
  subject.noteChunk(invalid(0));
  assert.equal(lines.length, 1, "a duplicate before the cap is emitted once");
  for (let i = 1; i < MAX_ARTIFACT_REJECTION_LOGS_PER_TURN; i++) {
    subject.noteChunk(invalid(i));
  }
  assert.equal(lines.length, MAX_ARTIFACT_REJECTION_LOGS_PER_TURN);

  for (let i = MAX_ARTIFACT_REJECTION_LOGS_PER_TURN; i < 1000; i++) {
    subject.noteChunk(invalid(i));
  }
  subject.noteChunk(invalid(0));
  subject.record("collector_after_cap", "create_text_file", { format: "txt" }, "spec_rejected");
  assert.deepEqual(lines.map(JSON.parse), Array.from(
    { length: MAX_ARTIFACT_REJECTION_LOGS_PER_TURN },
    () => ({
      event: "generated_artifact_tool_rejected",
      toolName: "create_text_file",
      requestedFormat: "txt",
      rejectionCode: "input_schema_rejected",
    })
  ));
});

test("collector admission can report a known but wrong-kind requested format", () => {
  const { lines, subject } = createLog();
  subject.record("call_2", "create_text_file", {
    format: "txt", filename: "SECRET_FILENAME", content: "SECRET_CONTENT",
  }, "spec_rejected");
  assert.deepEqual(JSON.parse(lines[0]), {
    event: "generated_artifact_tool_rejected",
    toolName: "create_text_file",
    requestedFormat: "txt",
    rejectionCode: "spec_rejected",
  });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /SECRET_/);
});

test("installed SDK rejects invalid input before execute and delivers one loggable tool-call", async () => {
  const chunks = [];
  let executions = 0;
  const model = new MockLanguageModelV4({
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: "tool-call", toolCallId: "sdk_invalid_1",
            toolName: "create_text_file",
            input: JSON.stringify({
              format: "txt", filename: "SECRET_FILENAME", content: "SECRET_CONTENT",
            }),
          });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    },
  });
  const result = streamText({
    model,
    prompt: "fixture",
    tools: {
      create_text_file: tool({
        inputSchema: z.object({ format: z.literal("html"), content: z.string() }),
        execute: async () => { executions += 1; return "created"; },
      }),
    },
    onChunk: ({ chunk }) => chunks.push(chunk),
  });
  let streamedParts = 0;
  for await (const part of result.fullStream) {
    assert.ok(part);
    streamedParts += 1;
  }

  assert.equal(model.doStreamCalls.length, 1);
  assert.ok(streamedParts >= 2);
  assert.equal(executions, 0);
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === "tool-call").map((chunk) => [chunk.invalid, chunk.input?.format]),
    [[true, "txt"]]
  );
  assert.equal(chunks.filter((chunk) => chunk.type === "tool-error").length, 1);
  const { subject, lines } = createLog();
  for (const chunk of chunks) subject.noteChunk(chunk);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{
    event: "generated_artifact_tool_rejected",
    toolName: "create_text_file",
    requestedFormat: "txt",
    rejectionCode: "input_schema_rejected",
  }]);
});
