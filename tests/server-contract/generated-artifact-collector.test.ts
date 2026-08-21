import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * The per-turn collector's contract, with object storage replaced and nothing
 * else.
 *
 * What is under test is the part a real provider call cannot exercise on
 * demand: a duplicated tool call, a specification that will not build, a
 * storage failure, and every ending that does not persist a message. Each of
 * those has a rule about what is left behind afterwards, and "nothing broken
 * or duplicated" is the promise the whole domain rests on
 * (docs/policy/generated-artifacts.md section 8).
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) =>
  pathToFileURL(resolve(ROOT, relativePath)).href;

type StoredCall = {
  userId: string;
  conversationId: string;
  ordinal: number;
  format: string;
  filename: string;
  byteSize: number;
  modelId: string | null;
};

const world = {
  puts: [] as StoredCall[],
  discarded: [] as string[],
  failNextPut: false,
  nextId: 0,
};

const resetWorld = () => {
  world.puts = [];
  world.discarded = [];
  world.failNextPut = false;
  world.nextId = 0;
};

let toolPromise: Promise<typeof import("../../lib/generatedArtifactTool")> | null =
  null;

const loadTool = () => {
  if (!toolPromise) {
    mock.module(mod("lib/generatedArtifactStorage.ts"), {
      namedExports: {
        putArtifactObject: async (input: {
          userId: string;
          conversationId: string;
          ordinal: number;
          format: string;
          filename: string;
          mediaType: string;
          bytes: Uint8Array;
          modelId: string | null;
        }) => {
          if (world.failNextPut) {
            world.failNextPut = false;
            throw new Error("storage is unavailable");
          }
          world.nextId += 1;
          const id = `art_${world.nextId}`;
          world.puts.push({
            userId: input.userId,
            conversationId: input.conversationId,
            ordinal: input.ordinal,
            format: input.format,
            filename: input.filename,
            byteSize: input.bytes.byteLength,
            modelId: input.modelId,
          });
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
        discardStoredArtifacts: async (
          stored: Array<{ objectKey: string }>
        ) => {
          world.discarded.push(...stored.map((entry) => entry.objectKey));
        },
      },
    });
    toolPromise = import("../../lib/generatedArtifactTool");
  }
  return toolPromise;
};

const collector = async (overrides: Record<string, unknown> = {}) => {
  const { GeneratedArtifactCollector } = await loadTool();
  return new GeneratedArtifactCollector({
    mode: "generate",
    userId: "user_1",
    conversationId: "conv_1",
    modelId: "gpt-5-6-luna",
    traceId: "trace_1",
    ...overrides,
  } as ConstructorParameters<typeof GeneratedArtifactCollector>[0]);
};

const QUARTERLY = {
  filename: "분기별_매출.xlsx",
  worksheets: [
    {
      name: "2026",
      columns: [{ header: "분기" }, { header: "매출", type: "number" }],
      rows: [
        ["Q1", 125_000_000],
        ["Q2", 143_500_000],
      ],
    },
  ],
};

test("a valid call stores one file and reports it as created", async () => {
  resetWorld();
  const subject = await collector();
  const report = await subject.run("spreadsheet", QUARTERLY);

  assert.equal(report.status, "created");
  assert.equal(report.filename, "분기별_매출.xlsx");
  assert.equal(report.parts, "1 worksheet, 2 rows");
  assert.equal(world.puts.length, 1);
  assert.ok(world.puts[0].byteSize > 0);
  assert.equal(subject.stored.length, 1);
  assert.equal(subject.failed.length, 0);
});

test("the model is never handed a key, an id or a URL", async () => {
  resetWorld();
  const subject = await collector();
  const report = await subject.run("spreadsheet", QUARTERLY);
  const serialized = JSON.stringify(report);

  assert.ok(!serialized.includes("message-artifacts/"));
  assert.ok(!serialized.includes("art_1"));
  assert.ok(!serialized.includes("http"));
  // What it is handed instead: the rule it is most likely to break.
  assert.match(report.note, /Do not repeat the table/);
});

test("the same specification twice produces one file", async () => {
  // A provider that replays a step must not leave two copies of one file.
  resetWorld();
  const subject = await collector();
  await subject.run("spreadsheet", QUARTERLY);
  const second = await subject.run("spreadsheet", QUARTERLY);

  assert.equal(second.status, "unchanged");
  assert.equal(world.puts.length, 1);
  assert.equal(subject.stored.length, 1);
});

test("a changed specification is a new file, not an overwrite", async () => {
  // The follow-up-edit rule: the key is the content, not the name.
  resetWorld();
  const subject = await collector();
  await subject.run("spreadsheet", QUARTERLY);
  const edited = await subject.run("spreadsheet", {
    ...QUARTERLY,
    worksheets: [
      {
        ...QUARTERLY.worksheets[0],
        rows: [...QUARTERLY.worksheets[0].rows, ["Q3", 98_000_000]],
      },
    ],
  });

  assert.equal(edited.status, "created");
  assert.equal(world.puts.length, 2);
  assert.deepEqual(
    subject.stored.map((artifact) => artifact.ordinal),
    [0, 1]
  );
});

test("a rejected specification produces a failure card, never a file", async () => {
  resetWorld();
  const subject = await collector();
  const report = await subject.run("spreadsheet", { filename: "x.xlsx", worksheets: "nope" });

  assert.equal(report.status, "failed");
  assert.equal(world.puts.length, 0);
  assert.equal(subject.stored.length, 0);
  assert.equal(subject.failed[0].failureCode, "spec_rejected");
  assert.match(report.note, /Do not describe a file that does not exist/);
});

test("a storage failure is reported and leaves nothing stored", async () => {
  resetWorld();
  world.failNextPut = true;
  const subject = await collector();
  const report = await subject.run("spreadsheet", QUARTERLY);

  assert.equal(report.status, "failed");
  assert.equal(report.reason, "storage_failed");
  assert.equal(subject.stored.length, 0);
  assert.equal(subject.failed[0].failureCode, "storage_failed");
});

test("the per-message ceiling refuses a fourth file", async () => {
  resetWorld();
  const subject = await collector();
  for (let index = 0; index < 3; index += 1) {
    const report = await subject.run("spreadsheet", {
      ...QUARTERLY,
      filename: `part-${index}.xlsx`,
    });
    assert.equal(report.status, "created");
  }
  const fourth = await subject.run("spreadsheet", { ...QUARTERLY, filename: "part-3.xlsx" });
  assert.equal(fourth.status, "failed");
  assert.equal(fourth.reason, "too_many_files");
  assert.equal(world.puts.length, 3);
});

test("a guest call refuses without generating or storing anything", async () => {
  resetWorld();
  const subject = await collector({ mode: "sign_in_required", userId: null });
  const report = await subject.run("spreadsheet", QUARTERLY);

  assert.equal(report.status, "sign_in_required");
  assert.equal(world.puts.length, 0);
  const [card] = subject.toStreamArtifacts();
  assert.equal(card.status, "blocked");
  assert.equal(card.failureCode, "sign_in_required");
  assert.equal(card.byteSize, 0);
  // A blocked card has no download, so it needs no addressable id.
  assert.match(card.id, /^pending:/);
});

test("discarding reclaims every stored object and is safe to repeat", async () => {
  resetWorld();
  const subject = await collector();
  await subject.run("spreadsheet", QUARTERLY);
  await subject.run("spreadsheet", { ...QUARTERLY, filename: "second.xlsx" });

  await subject.discard();
  assert.equal(world.discarded.length, 2);

  // Every terminal path funnels through the same release, and several of them
  // release twice.
  await subject.discard();
  assert.equal(world.discarded.length, 2);
  assert.equal(subject.stored.length, 0);
});

test("the stream shape carries public fields only", async () => {
  resetWorld();
  const subject = await collector();
  await subject.run("spreadsheet", QUARTERLY);
  const [card] = subject.toStreamArtifacts();

  assert.deepEqual(Object.keys(card).sort(), [
    "byteSize",
    "filename",
    "format",
    "id",
    "mediaType",
    "modelId",
    "ordinal",
    "status",
  ]);
  assert.equal(card.status, "ready");
  assert.equal(card.modelId, "gpt-5-6-luna");
});

test("a failed card takes the id of its row once one exists", async () => {
  resetWorld();
  const subject = await collector();
  await subject.run("spreadsheet", { filename: "x.xlsx", worksheets: [] });
  assert.match(subject.toStreamArtifacts()[0].id, /^pending:/);

  const repointed = subject.withPersistedIds([{ id: "row_9", ordinal: 0 }]);
  assert.equal(repointed[0].id, "row_9");
});

test("a fallback re-attributes later files to the model that made them", async () => {
  resetWorld();
  const subject = await collector();
  await subject.run("spreadsheet", QUARTERLY);
  subject.setModelId("claude-sonnet-5");
  await subject.run("spreadsheet", { ...QUARTERLY, filename: "after.xlsx" });

  assert.deepEqual(
    subject.stored.map((artifact) => artifact.modelId),
    ["gpt-5-6-luna", "claude-sonnet-5"]
  );
});

test("a turn with no conversation reports a failure rather than throwing", async () => {
  resetWorld();
  const subject = await collector({ conversationId: null });
  const report = await subject.run("spreadsheet", QUARTERLY);

  assert.equal(report.status, "failed");
  assert.equal(report.reason, "no_conversation");
  assert.equal(world.puts.length, 0);
});

test("progress is announced before the work, not after it", async () => {
  resetWorld();
  const order: string[] = [];
  const subject = await collector({
    emitProgress: (format: string) => order.push(`progress:${format}`),
  });
  await subject.run("spreadsheet", QUARTERLY);
  order.push(`stored:${world.puts.length}`);

  assert.deepEqual(order, ["progress:xlsx", "stored:1"]);
});

test("a rejected specification announces no progress at all", async () => {
  resetWorld();
  const emitted: string[] = [];
  const subject = await collector({
    emitProgress: (format: string) => emitted.push(format),
  });
  await subject.run("spreadsheet", { filename: "x.xlsx", worksheets: "nope" });
  assert.deepEqual(emitted, []);
});

test("a refused call still counts as an invocation", async () => {
  // `isEmpty` and `wasInvoked` answer different questions, and the route needs
  // the second one: a call refused without recording anything still put a tool
  // call and a tool result into the provider's response messages, and storing
  // those for replay would send a later turn a tool it never declared.
  resetWorld();
  const subject = await collector({ conversationId: null });
  assert.equal(subject.wasInvoked, false);

  const report = await subject.run("spreadsheet", QUARTERLY);
  assert.equal(report.status, "failed");
  assert.equal(subject.isEmpty, true);
  assert.equal(subject.wasInvoked, true);
});

test("a turn that never called the tool was never invoked", async () => {
  resetWorld();
  const subject = await collector();
  assert.equal(subject.wasInvoked, false);
});

/* -------------------------------------------------------------------------- */
/* The other four kinds                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One lifecycle, five tools.
 *
 * The collector has no per-kind branch in it -- idempotency, ordinals,
 * storage, failure recording and the report all run the same code whichever
 * tool was called. These tests are what says so: the same assertions, once per
 * kind, so a kind that grew its own path would show up here rather than in
 * production.
 */
const SPECS: Record<string, unknown> = {
  spreadsheet: QUARTERLY,
  document: {
    filename: "보고서.docx",
    format: "docx",
    title: "분기 보고서",
    blocks: [{ type: "paragraph", text: "매출이 늘었습니다." }],
  },
  presentation: {
    filename: "소개.pptx",
    format: "pptx",
    slides: [{ title: "Tomverse", bullets: ["빠릅니다"] }],
  },
  text: {
    filename: "설정.json",
    format: "json",
    content: '{"port": 3000}',
  },
  archive: {
    filename: "starter.zip",
    format: "zip",
    entries: [{ path: "README.md", format: "md", content: "# Starter\n" }],
  },
};

const EXPECTED = {
  spreadsheet: { format: "xlsx", filename: "분기별_매출.xlsx", parts: "1 worksheet, 2 rows" },
  document: { format: "docx", filename: "보고서.docx", parts: "1 block" },
  presentation: { format: "pptx", filename: "소개.pptx", parts: "1 slide" },
  text: { format: "json", filename: "설정.json", parts: "1 line" },
  archive: { format: "zip", filename: "starter.zip", parts: "1 entry" },
} as const;

for (const [kind, expected] of Object.entries(EXPECTED)) {
  test(`a ${kind} call stores one file and reports it as created`, async () => {
    resetWorld();
    const subject = await collector();
    const report = await subject.run(kind as never, SPECS[kind]);

    assert.equal(report.status, "created", JSON.stringify(report));
    assert.equal(report.format, expected.format);
    assert.equal(report.filename, expected.filename);
    assert.equal(report.parts, expected.parts);
    assert.equal(world.puts.length, 1);
    assert.equal(world.puts[0].format, expected.format);
    assert.ok(world.puts[0].byteSize > 0);
  });

  test(`a ${kind} call replayed produces one file`, async () => {
    resetWorld();
    const subject = await collector();
    await subject.run(kind as never, SPECS[kind]);
    const second = await subject.run(kind as never, SPECS[kind]);

    assert.equal(second.status, "unchanged");
    assert.equal(world.puts.length, 1);
  });

  test(`a rejected ${kind} call stores nothing and names its own format`, async () => {
    resetWorld();
    const subject = await collector();
    const report = await subject.run(kind as never, {
      ...(SPECS[kind] as Record<string, unknown>),
      filename: 42,
    });

    assert.equal(report.status, "failed");
    assert.equal(world.puts.length, 0);
    // The card names the format that was asked for, so a failed PDF request
    // does not draw a Word card.
    assert.equal(subject.failed[0].format, expected.format);
    assert.equal(subject.failed[0].failureCode, "spec_rejected");
  });
}

test("an xlsx request is never answered with a csv", async () => {
  resetWorld();
  const subject = await collector();
  await subject.run("spreadsheet", QUARTERLY);
  assert.equal(world.puts[0].format, "xlsx");
  assert.match(world.puts[0].filename, /\.xlsx$/);
});

test("content a generator refuses is a failure card, not a broken file", async () => {
  resetWorld();
  const subject = await collector();
  const report = await subject.run("text", {
    filename: "broken.json",
    format: "json",
    content: "{",
  });

  assert.equal(report.status, "failed");
  assert.equal(world.puts.length, 0);
  assert.equal(subject.failed[0].failureCode, "spec_rejected");
  assert.equal(subject.failed[0].format, "json");
});

test("an archive may not smuggle in what a direct request is refused", async () => {
  resetWorld();
  const subject = await collector();
  const report = await subject.run("archive", {
    filename: "payload.zip",
    format: "zip",
    entries: [{ path: "setup.exe", format: "exe", content: "MZ" }],
  });

  assert.equal(report.status, "failed");
  assert.equal(world.puts.length, 0);
});

test("ordinals keep counting across kinds within one answer", async () => {
  resetWorld();
  const subject = await collector();
  await subject.run("document", SPECS.document);
  await subject.run("text", SPECS.text);

  assert.deepEqual(
    subject.stored.map((artifact) => artifact.ordinal),
    [0, 1]
  );
  assert.deepEqual(
    subject.stored.map((artifact) => artifact.format),
    ["docx", "json"]
  );
});

test("every kind has a tool, and every tool a kind", async () => {
  const { ARTIFACT_TOOL_NAMES, ALL_ARTIFACT_TOOL_NAMES, buildGeneratedArtifactToolConfig } =
    await loadTool();
  const subject = await collector();
  const { tools } = buildGeneratedArtifactToolConfig(subject);

  assert.deepEqual(Object.keys(tools).sort(), [...ALL_ARTIFACT_TOOL_NAMES].sort());
  assert.deepEqual(Object.keys(ARTIFACT_TOOL_NAMES).sort(), [
    "archive",
    "document",
    "presentation",
    "spreadsheet",
    "text",
  ]);
  for (const definition of Object.values(tools)) {
    const description = definition.description;
    assert.equal(typeof description, "string");
    assert.ok(definition.inputSchema);
    // The rule every description has to restate, because it is the one a model
    // breaks by writing a link instead of calling the tool.
    assert.match(description as string, /Never write (file bytes|base64)/);
  }
});
