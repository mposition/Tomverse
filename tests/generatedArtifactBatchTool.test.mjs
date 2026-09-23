import assert from "node:assert/strict";
import test from "node:test";

import { ARTIFACT_LIMITS } from "../lib/generatedArtifactCore.ts";
import { ArtifactToolRejectionLog } from "../lib/generatedArtifactRejectionLog.ts";
import {
  ALL_ARTIFACT_TOOL_NAMES,
  CREATE_DOCUMENT_BATCH_TOOL_NAME,
  GeneratedArtifactCollector,
  buildGeneratedArtifactToolConfig,
} from "../lib/generatedArtifactTool.ts";
import { buildDocxTemplate, buildXlsx } from "./fixtures/officeFixtures.mjs";

// docs/policy/generated-artifacts.md sections 3 and 13.
//
// Everything here stops before object storage. The refusals are the part worth
// pinning without a bucket: a handle that names nothing on this turn, a
// template that is not a Word file, and the per-answer ceiling -- which is the
// rule the batch tool exists to satisfy rather than to raise.

const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const turnAttachments = () =>
  new Map([
    ["att_1", { name: "계약서양식.docx", mediaType: DOCX, bytes: buildDocxTemplate() }],
    [
      "att_2",
      {
        name: "명단.xlsx",
        mediaType: XLSX,
        bytes: buildXlsx({
          rows: [
            ["이름", "생년월일", "입사일", "소속팀"],
            ["김민수", "1990-03-04", "2026-04-01", "플랫폼팀"],
          ],
        }),
      },
    ],
  ]);

const collector = (overrides = {}) =>
  new GeneratedArtifactCollector({
    mode: "generate",
    userId: "user-1",
    conversationId: "conversation-1",
    modelId: "gpt-5-6-luna",
    traceId: "trace-1",
    turnAttachments: turnAttachments(),
    now: new Date("2026-08-22T09:00:00Z"),
    ...overrides,
  });

const batchInput = (overrides = {}) => ({
  filename: "contracts.zip",
  templateAttachment: "att_1",
  dataAttachment: "att_2",
  filenameTemplate: "{{이름}}_근로계약서",
  ...overrides,
});

const runRejectedBatchWithDiagnostic = async (input, overrides = {}) => {
  const lines = [];
  const calls = [];
  const log = new ArtifactToolRejectionLog(
    [CREATE_DOCUMENT_BATCH_TOOL_NAME],
    (line) => lines.push(line)
  );
  const artifacts = collector({
    ...overrides,
    noteRejection: (...args) => {
      calls.push(args);
      log.record(...args);
    },
  });
  const report = await artifacts.runDocumentBatch(input, "SECRET_TOOL_CALL_ID");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), [
    "SECRET_TOOL_CALL_ID", CREATE_DOCUMENT_BATCH_TOOL_NAME,
  ]);
  assert.strictEqual(calls[0][2], input);
  assert.equal(calls[0][3], "spec_rejected");
  assert.deepEqual(lines.map(JSON.parse), [{
    event: "generated_artifact_tool_rejected",
    toolName: CREATE_DOCUMENT_BATCH_TOOL_NAME,
    requestedFormat: null,
    rejectionCode: "spec_rejected",
  }]);
  assert.doesNotMatch(lines[0], /SECRET_|contracts|att_[0-9]|계약서양식|명단|메모/);
  assert.equal(artifacts.failed.length, 1);
  assert.equal(artifacts.failed[0].failureCode, "spec_rejected");
  return report;
};

/* -------------------------------------------------------------------------- */
/* Registration                                                                 */
/* -------------------------------------------------------------------------- */

test("the batch tool is only sent when the turn asked for it", () => {
  const withoutBatch = buildGeneratedArtifactToolConfig(collector());
  assert.equal(
    Object.keys(withoutBatch.tools).includes(CREATE_DOCUMENT_BATCH_TOOL_NAME),
    false
  );
  const withBatch = buildGeneratedArtifactToolConfig(collector(), {
    registerDocumentBatch: true,
  });
  assert.equal(
    Object.keys(withBatch.tools).includes(CREATE_DOCUMENT_BATCH_TOOL_NAME),
    true
  );
});

test("the tool name list covers every tool that can be registered", () => {
  const names = Object.keys(
    buildGeneratedArtifactToolConfig(collector(), {
      registerDocumentBatch: true,
    }).tools
  );
  for (const name of names) {
    assert.equal(
      ALL_ARTIFACT_TOOL_NAMES.includes(name),
      true,
      `${name} is registered but not in ALL_ARTIFACT_TOOL_NAMES`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Refusals that never touch storage                                            */
/* -------------------------------------------------------------------------- */

test("a handle that names nothing on this turn is refused, and the real ones are listed", async () => {
  const report = await runRejectedBatchWithDiagnostic(
    batchInput({ templateAttachment: "att_9" })
  );
  assert.equal(report.status, "failed");
  assert.match(report.reason, /attachment_not_on_turn:att_9/);
  assert.match(report.note, /att_1, att_2/);
  assert.match(report.note, /do not invent a file/);
});

test("a throwing rejection diagnostic preserves the ordinary failure report and one card", async () => {
  let calls = 0;
  const artifacts = collector({
    noteRejection: () => {
      calls += 1;
      throw new Error("diagnostic sink failed");
    },
  });
  const report = await artifacts.run(
    "text",
    { filename: "x", format: "nope" },
    "call_1"
  );

  assert.equal(calls, 1);
  assert.equal(report.status, "failed");
  assert.match(report.reason, /format/);
  assert.match(report.note, /The file was not created/);
  assert.equal(artifacts.failed.length, 1);
  assert.equal(artifacts.failed[0].failureCode, "spec_rejected");
  assert.deepEqual(artifacts.toStreamArtifacts().map(({ ordinal, status, failureCode }) => ({
    ordinal, status, failureCode,
  })), [{ ordinal: 0, status: "failed", failureCode: "spec_rejected" }]);
});

test("an async rejecting diagnostic preserves the ordinary failure report and one card", async () => {
  let calls = 0;
  const artifacts = collector({
    noteRejection: async () => {
      calls += 1;
      await Promise.resolve();
      throw new Error("async diagnostic sink failed");
    },
  });
  const report = await artifacts.run(
    "text",
    { filename: "x", format: "nope" },
    "call_1"
  );

  assert.equal(calls, 1);
  assert.equal(report.status, "failed");
  assert.match(report.reason, /format/);
  assert.match(report.note, /The file was not created/);
  assert.equal(artifacts.failed.length, 1);
  assert.equal(artifacts.failed[0].failureCode, "spec_rejected");
  assert.deepEqual(artifacts.toStreamArtifacts().map(({ ordinal, status, failureCode }) => ({
    ordinal, status, failureCode,
  })), [{ ordinal: 0, status: "failed", failureCode: "spec_rejected" }]);
  await new Promise((resolve) => setImmediate(resolve));
});

test("a throwing rejection diagnostic preserves the batch failure report and one card", async () => {
  let calls = 0;
  const artifacts = collector({
    noteRejection: () => {
      calls += 1;
      throw new Error("diagnostic sink failed");
    },
  });
  const report = await artifacts.runDocumentBatch(
    batchInput({ templateAttachment: "att_9" }),
    "call_1"
  );

  assert.equal(calls, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.reason, "attachment_not_on_turn:att_9");
  assert.match(report.note, /att_1, att_2/);
  assert.equal(artifacts.failed.length, 1);
  assert.equal(artifacts.failed[0].failureCode, "spec_rejected");
  assert.deepEqual(artifacts.toStreamArtifacts().map(({ ordinal, status, failureCode }) => ({
    ordinal, status, failureCode,
  })), [{ ordinal: 0, status: "failed", failureCode: "spec_rejected" }]);
});

test("a template that is not a Word document is refused by name", async () => {
  const report = await runRejectedBatchWithDiagnostic(
    batchInput({ templateAttachment: "att_2", dataAttachment: "att_1" })
  );
  assert.equal(report.status, "failed");
  assert.equal(report.reason, "template_not_docx");
  assert.match(report.note, /명단.xlsx/);
});

test("a data file that is not tabular is refused by name", async () => {
  const attachments = turnAttachments();
  attachments.set("att_3", {
    name: "메모.txt",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("hello"),
  });
  const report = await runRejectedBatchWithDiagnostic(
    batchInput({ dataAttachment: "att_3" }),
    { turnAttachments: attachments }
  );
  assert.equal(report.status, "failed");
  assert.equal(report.reason, "data_not_tabular");
  assert.match(report.note, /메모.txt/);
});

test("a turn with no attachments at all says so rather than failing generically", async () => {
  const report = await collector({ turnAttachments: new Map() }).runDocumentBatch(
    batchInput()
  );
  assert.equal(report.status, "failed");
  assert.match(report.note, /No files are attached/);
});

test("a guest is refused with the sign-in card, not with a table", async () => {
  const report = await collector({ mode: "sign_in_required" }).runDocumentBatch(
    batchInput()
  );
  assert.equal(report.status, "sign_in_required");
  assert.match(report.note, /Do not write the contents as a table/);
});

test("bytes, base64 or a path in the input is a schema refusal", async () => {
  for (const bad of [
    { templateBytes: "UEsDBA==" },
    { templatePath: "/tmp/t.docx" },
    { templateAttachment: "attachments/abc/t.docx" },
  ]) {
    const report = await collector().runDocumentBatch(batchInput(bad));
    assert.equal(report.status, "failed");
  }
});

/* -------------------------------------------------------------------------- */
/* The per-answer ceiling                                                       */
/* -------------------------------------------------------------------------- */

// Three top-level files, and the fourth is refused -- unchanged by this work.
// What changed is the sentence the model is given when it happens: the way to
// deliver more files is one archive, not a follow-up message.
test("a fourth top-level artifact is still refused, and names the archive route", async () => {
  const artifacts = collector();
  for (let index = 0; index < ARTIFACT_LIMITS.maxArtifactsPerMessage; index += 1) {
    // A rejected specification records a failed artifact without writing
    // anything, which is exactly the counter the ceiling reads.
    const report = await artifacts.run("text", { filename: "x", format: "nope" });
    assert.equal(report.status, "failed");
  }
  const fourth = await artifacts.run("text", {
    filename: "x.txt",
    format: "txt",
    content: "hello",
  });
  assert.equal(fourth.status, "failed");
  assert.equal(fourth.reason, "too_many_files");
  assert.match(fourth.note, /top-level files/);
  assert.match(
    fourth.note,
    new RegExp(`holds up to ${ARTIFACT_LIMITS.maxArchiveEntries} files`)
  );
});

test("the batch tool obeys the same ceiling, and says the same thing", async () => {
  const artifacts = collector();
  for (let index = 0; index < ARTIFACT_LIMITS.maxArtifactsPerMessage; index += 1) {
    await artifacts.run("text", { filename: "x", format: "nope" });
  }
  const report = await artifacts.runDocumentBatch(batchInput());
  assert.equal(report.status, "failed");
  assert.equal(report.reason, "too_many_files");
  assert.match(report.note, /one archive\s+can hold up to/i);
});
