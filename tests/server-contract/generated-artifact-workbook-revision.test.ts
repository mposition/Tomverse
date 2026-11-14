import assert from "node:assert/strict";
import test, { before, mock } from "node:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { canonicalWorkbookSpecFor } from "../../lib/generatedArtifactWorkbookRevision";
import { workbookSpecSchema, documentSpecSchema, presentationSpecSchema, textFileSpecSchema, archiveSpecSchema } from "../../lib/generatedArtifactCore";
import { readSpreadsheetGrid } from "../../lib/spreadsheetDataRows";

const path = pathToFileURL(resolve(import.meta.dirname, "../../lib/generatedArtifactStorage.ts")).href;
type Stored = Record<string, unknown> & { id: string; bytes: Uint8Array; canonicalSpec?: unknown; lineageId: string; parentArtifactId?: string | null };
let stored: Stored[] = [];
mock.module(path, { namedExports: {
  putArtifactObject: async (input: Record<string, unknown> & { bytes: Uint8Array }) => {
    const id = `stored-private-id-${stored.length}`;
    const row = { ...input, id, bytes: Uint8Array.from(input.bytes), byteSize: input.bytes.byteLength,
      lineageId: String(input.lineageId ?? id), objectKey: `private/${id}` } as Stored;
    stored.push(row); return row;
  },
  discardStoredArtifacts: async () => {},
} });
let toolModule: typeof import("../../lib/generatedArtifactTool");
before(async () => { toolModule = await import("../../lib/generatedArtifactTool"); });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const base = { filename: "same.xlsx", worksheets: [
  { name: "Sales", title: "Plan", columns: [{ header: "Item", width: 35 }, { header: "Amount", type: "number", format: "currency_usd", width: 22 }],
    rows: [["Keep", 0], ["Change", 100], ["", false], [null, null]], freezeHeader: false },
  { name: "Notes", columns: [{ header: "Text" }], rows: [["Unchanged"]] },
] };
const subject = (source?: Stored, extra: Record<string, unknown> = {}) => new toolModule.GeneratedArtifactCollector({
  mode: "generate", userId: "user", conversationId: "conversation", modelId: "gpt-6-luna", traceId: "fixture",
  revisionEnabled: true,
  ...(source ? {
    turnAttachments: new Map([["att_1", { name: "same.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: source.bytes }]]),
    revisionSources: new Map([["att_1", { sourceArtifactId: source.id, lineageId: source.lineageId, canonicalSpec: source.canonicalSpec }]]),
  } : {}), ...extra,
});
const edit = (value: number) => ({ filename: "same.xlsx", format: "xlsx", revisionOf: "att_1",
  cellUpdates: [{ sheet: "Sales", row: 2, column: 2, value }] });

test("existing create_spreadsheet produces two exact cell revisions and carries real parent links without exposing them to the model", async () => {
  stored = [];
  assert.equal((await subject().run("spreadsheet", base)).status, "created");
  const original = stored[0], originalHash = digest(original.bytes);
  assert.ok(original.canonicalSpec);
  const firstCollector = subject(original);
  const firstReport = await firstCollector.run("spreadsheet", edit(200));
  assert.equal(firstReport.status, "created");
  const first = stored[1];
  assert.equal(first.parentArtifactId, original.id);
  assert.equal(first.lineageId, original.lineageId);
  assert.deepEqual((first.canonicalSpec as { spec: typeof base }).spec.worksheets[1],
    (original.canonicalSpec as { spec: typeof base }).spec.worksheets[1]);
  assert.equal((await subject(first).run("spreadsheet", edit(300))).status, "created");
  assert.equal(stored[2].parentArtifactId, first.id);
  assert.equal(stored[2].lineageId, original.lineageId);
  const data = readSpreadsheetGrid(stored[2].bytes, { mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    maxRows: 10001, maxValueLength: 20000, preserveEmptyRows: true });
  assert.equal(data.grid[3][1], "$300.00");
  assert.equal(data.grid.length, 6, "title/header plus all four data rows survive");
  assert.equal(digest(original.bytes), originalHash);
  const publicCard = firstCollector.toStreamArtifacts()[0];
  assert.equal(publicCard.parentArtifactId, original.id);
  assert.equal(publicCard.lineageId, original.lineageId);
  assert.equal("canonicalSpec" in publicCard, false);
  assert.doesNotMatch(JSON.stringify(firstReport), /stored-private-id|private\/|canonicalSpec/);
});

test("the final stream card uses the committed standalone edge when source evidence disappeared", async () => {
  stored = [];
  await subject().run("spreadsheet", base);
  const original = stored[0], collector = subject(original);
  await collector.run("spreadsheet", edit(200));
  const revised = stored[1];
  assert.equal(collector.toStreamArtifacts()[0].parentArtifactId, original.id);
  const [card] = collector.withPersistedIds([
    { id: revised.id, ordinal: 0, parentArtifactId: null, lineageId: revised.id },
  ]);
  assert.equal(card.parentArtifactId, null); assert.equal(card.lineageId, revised.id);
  assert.doesNotMatch(JSON.stringify(card), new RegExp(original.id));
});

test("a flag disabled between storage and final save removes old lineage from the final stream card", async (t) => {
  const previous = process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.GENERATED_ARTIFACT_REVISION_ENABLED; else process.env.GENERATED_ARTIFACT_REVISION_ENABLED = previous; });
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
  stored = [];
  await subject().run("spreadsheet", base);
  const collector = subject(stored[0]);
  await collector.run("spreadsheet", edit(200));
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "false";
  const [card] = collector.withPersistedIds([
    { id: stored[1].id, ordinal: 0, parentArtifactId: null, lineageId: null },
  ]);
  assert.equal(card.status, "ready"); assert.equal(card.id, stored[1].id);
  assert.equal(card.parentArtifactId, undefined); assert.equal(card.lineageId, undefined);
});

test("a revision requires an actual readable latest input handle, not ids, stale handles or metadata alone", async () => {
  for (const options of [{}, { revisionSources: new Map([["att_1", { sourceArtifactId: "private", lineageId: "line", canonicalSpec: canonicalWorkbookSpecFor(base as never) }]]) }]) {
    stored = [];
    const report = await subject(undefined, options).run("spreadsheet", edit(200));
    assert.equal(report.status, "failed"); assert.equal(stored.length, 0);
  }
  stored = [];
  await subject().run("spreadsheet", base);
  const source = stored[0];
  for (const revisionOf of [source.id, "att_2", "att_0", "https://source.invalid"]) {
    assert.equal((await subject(source).run("spreadsheet", { ...edit(200), revisionOf })).status, "failed");
  }
  assert.equal(stored.length, 1);
});

test("full rewrites, invalid cells and formula-shaped values cannot bypass canonical preservation", async () => {
  stored = []; await subject().run("spreadsheet", base);
  const source = stored[0];
  for (const input of [ { ...base, revisionOf: "att_1" },
    { ...edit(200), worksheets: base.worksheets }, { ...edit(200), format: "csv" },
    { ...edit(200), cellUpdates: [{ sheet: "Sales", row: 0, column: 2, value: 3 }] },
    { ...edit(200), cellUpdates: [{ sheet: "Sales", row: 1, column: 2, value: { formula: "SUM(A1:A2)" } }] },
  ]) assert.equal((await subject(source).run("spreadsheet", input)).status, "failed");
  assert.equal(stored.length, 1);
});

test("unrelated output does not gain a parent just because a revision input is present", async () => {
  stored = []; await subject().run("spreadsheet", base);
  const source = stored[0];
  await subject(source).run("spreadsheet", { ...base, filename: "unrelated.xlsx" });
  assert.equal(stored[1].parentArtifactId, undefined);
  assert.equal(stored[1].lineageId, stored[1].id);
  const result = await subject(source).run("document", { filename: "summary.txt", format: "txt", revisionOf: "att_1",
    blocks: [{ type: "paragraph", text: "A new document from the selected workbook" }] });
  assert.equal(result.status, "created");
  assert.equal(stored[2].parentArtifactId, source.id);
  assert.equal(stored[2].canonicalSpec, undefined);
});

test("the same revision call remains idempotent and the source identity participates in dedupe", async () => {
  stored = []; await subject().run("spreadsheet", base);
  const source = stored[0], collector = subject(source);
  assert.equal((await collector.run("spreadsheet", edit(200))).status, "created");
  assert.equal((await collector.run("spreadsheet", edit(200))).status, "unchanged");
  assert.equal(stored.length, 2);
  const other = { ...source, id: "other-private-parent", lineageId: "other-private-lineage" };
  const sources = new Map([["att_1", { sourceArtifactId: source.id, lineageId: source.lineageId, canonicalSpec: source.canonicalSpec }],
    ["att_2", { sourceArtifactId: other.id, lineageId: other.lineageId, canonicalSpec: other.canonicalSpec }]]);
  const selected = subject(source, { revisionSources: sources, turnAttachments: new Map([
    ["att_1", { name: "same.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: source.bytes }],
    ["att_2", { name: "same.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: other.bytes }],
  ]) });
  assert.equal((await selected.run("spreadsheet", edit(400))).status, "created");
  assert.equal((await selected.run("spreadsheet", { ...edit(400), revisionOf: "att_2" })).status, "created");
  assert.deepEqual(selected.toStreamArtifacts().map(card => card.parentArtifactId), [source.id, other.id]);
  assert.equal((await selected.run("spreadsheet", { ...edit(400), revisionOf: "att_2" })).status, "unchanged");
});

test("an independently retained source snapshot remains usable after its original artifact was deleted", async () => {
  stored = []; await subject().run("spreadsheet", base);
  const source = stored[0];
  const collector = subject(source, { revisionSources: new Map([["att_1", {
    sourceArtifactId: null, lineageId: source.lineageId, canonicalSpec: source.canonicalSpec,
  }]]) });
  assert.equal((await collector.run("spreadsheet", edit(500))).status, "created");
  assert.equal(stored[1].parentArtifactId, null);
  assert.equal(stored[1].lineageId, source.lineageId);
});

test("flag-off turns keep the original tool schemas and store no canonical source copy", async () => {
  stored = [];
  const collector = subject(undefined, { revisionEnabled: false });
  const tools = toolModule.buildGeneratedArtifactToolConfig(collector).tools;
  for (const [name, expected] of [ ["create_spreadsheet", workbookSpecSchema], ["create_document", documentSpecSchema],
    ["create_presentation", presentationSpecSchema], ["create_text_file", textFileSpecSchema], ["create_archive", archiveSpecSchema] ] as const) {
    assert.deepEqual(z.toJSONSchema(tools[name].inputSchema as z.ZodObject, { io: "input" }), z.toJSONSchema(expected, { io: "input" }));
  }
  await collector.run("spreadsheet", base);
  assert.equal(stored[0].canonicalSpec, undefined);
  assert.equal((await subject(stored[0], { revisionEnabled: false }).run("spreadsheet", edit(200))).status, "failed");
});
