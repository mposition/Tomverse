import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { ArtifactToolRejectionLog } from "../../lib/generatedArtifactRejectionLog";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;
type StoredInput = {
  userId: string;
  conversationId: string;
  ordinal: number;
  format: string;
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
  modelId: string | null;
};
const puts: StoredInput[] = [];

// Install the same storage boundary mock as generated-artifact-collector.test.ts,
// before importing the collector; schemas, writers and SDK execution stay real.
let toolPromise: Promise<typeof import("../../lib/generatedArtifactTool")> | null = null;
const loadTool = () => {
  if (!toolPromise) {
    mock.module(mod("lib/generatedArtifactStorage.ts"), {
      namedExports: {
        putArtifactObject: async (input: StoredInput) => {
          puts.push({ ...input, bytes: Uint8Array.from(input.bytes) });
          const id = `art_${puts.length}`;
          return {
            id,
            ordinal: input.ordinal,
            format: input.format,
            filename: input.filename,
            mediaType: input.mediaType,
            byteSize: input.bytes.byteLength,
            objectKey: `message-artifacts/${input.userId}/${input.conversationId}/${id}.${input.format}`,
            modelId: input.modelId,
          };
        },
        discardStoredArtifacts: async () => {},
      },
    });
    toolPromise = import("../../lib/generatedArtifactTool");
  }
  return toolPromise;
};

async function runCall(toolName: string, input: Record<string, unknown>) {
  const { GeneratedArtifactCollector, buildGeneratedArtifactToolConfig } =
    await loadTool();
  puts.length = 0;
  const lines: string[] = [];
  let rejectionLog: ArtifactToolRejectionLog | null = null;
  const collector = new GeneratedArtifactCollector({
    mode: "generate",
    userId: "user_1",
    conversationId: "conv_1",
    modelId: "gpt-5-6-luna",
    traceId: "trace_1",
    noteRejection: (toolCallId, name, raw, code, diagnostics) =>
      rejectionLog?.record(toolCallId, name, raw, code, diagnostics),
  });
  const { tools } = buildGeneratedArtifactToolConfig(collector);
  rejectionLog = new ArtifactToolRejectionLog(Object.keys(tools), (line) => lines.push(line));
  const model = new MockLanguageModelV4({
    doStream: {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            type: "tool-call", toolCallId: "fixture_call", toolName,
            input: JSON.stringify(input),
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
    model, tools, prompt: "fixture",
    onChunk: ({ chunk }) => rejectionLog?.noteChunk(chunk),
  });
  const parts = [];
  for await (const part of result.fullStream) parts.push(part);
  assert.equal(model.doStreamCalls.length, 1);
  return { collector, lines, parts };
}

const textInput = {
  format: "txt", filename: "SECRET_FILENAME.txt", content: "SECRET_CONTENT",
};

test("create_document stores and reports the requested txt format through the SDK", async () => {
  const { collector, lines, parts } = await runCall("create_document", {
    format: "txt", filename: "report.txt",
    blocks: [{ type: "paragraph", text: "Plain text fixture" }],
  });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].format, "txt");
  assert.equal(puts[0].filename, "report.txt");
  assert.equal(puts[0].mediaType, "text/plain; charset=utf-8");
  assert.match(new TextDecoder().decode(puts[0].bytes), /Plain text fixture/);
  assert.deepEqual(collector.stored.map((artifact) => artifact.format), ["txt"]);
  assert.deepEqual(collector.toStreamArtifacts().map((artifact) => artifact.format), ["txt"]);
  const reports = parts.filter((part) => part.type === "tool-result");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].output.status, "created");
  assert.equal(reports[0].output.filename, "report.txt");
  assert.deepEqual(lines, []);
});

test("create_text_file txt is refused with exactly one allowlisted log line", async () => {
  const { lines, parts } = await runCall("create_text_file", textInput);
  const calls = parts.filter((part) => part.type === "tool-call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].invalid, true);
  assert.equal(parts.filter((part) => part.type === "tool-error").length, 1);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{
    event: "generated_artifact_tool_rejected",
    toolName: "create_text_file",
    requestedFormat: "txt",
    rejectionCode: "input_schema_rejected",
  }]);
  assert.doesNotMatch(lines.join(""), /SECRET_|fixture_call|trace_1|user_1|conv_1/);
});

test("a refused txt call neither stores nor reports a substitute format", async () => {
  const { collector, parts } = await runCall("create_text_file", textInput);
  assert.deepEqual(puts, []);
  assert.deepEqual(collector.stored, []);
  assert.deepEqual(collector.failed, []);
  assert.deepEqual(collector.toStreamArtifacts(), []);
  assert.deepEqual(parts.filter((part) => part.type === "tool-result"), []);
});

// Fix-dependent: the owner must choose whether to accept txt/md here or route
// prose to create_document. Keep desired recovery visible without fixing policy.
test("create_text_file accepts txt and preserves the requested format if that fix is chosen", { todo: true }, async () => {
  const { collector } = await runCall("create_text_file", textInput);
  assert.deepEqual(puts.map((put) => put.format), ["txt"]);
  assert.deepEqual(collector.toStreamArtifacts().map((artifact) => artifact.format), ["txt"]);
});
test("a refused txt call names create_document as the supported recovery tool if routing is chosen", { todo: true }, async () => {
  const { parts } = await runCall("create_text_file", textInput);
  const errors = parts.filter((part) => part.type === "tool-error");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].error), /create_document/);
});
test("tool descriptions explicitly route plain txt/md to create_document", { todo: true }, async () => {
  const { GeneratedArtifactCollector, buildGeneratedArtifactToolConfig } = await loadTool();
  const collector = new GeneratedArtifactCollector({
    mode: "generate", userId: "user_1", conversationId: "conv_1",
    modelId: "gpt-5-6-luna", traceId: "trace_1",
  });
  const { tools } = buildGeneratedArtifactToolConfig(collector);
  const description = String(tools.create_text_file.description ?? "");
  assert.match(description, /create_document/);
  assert.match(description, /\.txt/);
  assert.match(description, /\.md/);
});
