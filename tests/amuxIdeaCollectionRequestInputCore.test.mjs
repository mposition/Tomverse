import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V4_COLLECTION_REQUEST_MAX_BYTES,
  AMUX_V4_COLLECTION_SOURCE_BYTE_LIMIT,
  checkAmuxIdeaCollectionSource,
  inspectAmuxIdeaCollectionRequestInput,
} from "../lib/amux/ideaCollectionRequestInputCore.ts";

const ids = {
  requestId: "123e4567-e89b-42d3-a456-426614174001",
  previewId: "123e4567-e89b-42d3-a456-426614174002",
  ideaId: "123e4567-e89b-42d3-a456-426614174003",
  scopeApprovalId: "123e4567-e89b-42d3-a456-426614174004",
  frontierApprovalId: "123e4567-e89b-42d3-a456-426614174005",
};
const input = {
  schemaVersion: 1,
  ...ids,
  frontierVersion: 2,
  provider: "openai",
  modelId: "gpt-frontier",
  reasoningEffort: "high",
  sourceIndex: 0,
};
const idea = { version: 1, idea: "Review the repository module.",
  repositories: ["mposition/Tomverse"], pullRequests: [] };
const source = { kind: "repository_file", repository: "mposition/Tomverse",
  commitSha: "a".repeat(40), path: "lib/amux/ideaInputCore.ts" };
const scopeJson = (sources) => JSON.stringify({ version: 1, sources });

test("one strict first-attempt request derives server limits and never collects data", () => {
  assert.deepEqual(inspectAmuxIdeaCollectionRequestInput(JSON.stringify(input)), {
    ok: true,
    request: { ...input, attempt: 1, sourceByteLimit: AMUX_V4_COLLECTION_SOURCE_BYTE_LIMIT },
  });
  assert.equal(AMUX_V4_COLLECTION_SOURCE_BYTE_LIMIT, 8_192);
});

test("untrusted content, credentials, caller limits, retries and replacement are refused", () => {
  for (const extra of [
    { sourceText: "contents" }, { githubToken: "token" }, { payload: "text" },
    { sourceByteLimit: 1 }, { attempt: 2 }, { replacesPreviewId: ids.previewId },
    { repository: "mposition/Tomverse" }, { commitSha: "a".repeat(40) },
  ]) {
    assert.deepEqual(inspectAmuxIdeaCollectionRequestInput(JSON.stringify({ ...input, ...extra })),
      { ok: false, code: "schema_rejected" });
  }
});

test("IDs, model selection and scope index fail closed", () => {
  for (const changed of [
    { schemaVersion: 2 }, { requestId: ids.previewId },
    { previewId: ids.ideaId }, { scopeApprovalId: "bad" },
    { frontierApprovalId: "bad" }, { frontierVersion: 0 },
    { frontierVersion: 1_000_000_001 },
    { provider: "xai" }, { modelId: "" }, { modelId: "bad model" },
    { reasoningEffort: "fast" }, { sourceIndex: 1 },
    { sourceIndex: -1 }, { sourceIndex: "0" },
  ]) {
    assert.deepEqual(inspectAmuxIdeaCollectionRequestInput(JSON.stringify({ ...input, ...changed })),
      { ok: false, code: "schema_rejected" });
  }
  assert.deepEqual(inspectAmuxIdeaCollectionRequestInput("{"),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaCollectionRequestInput("[]"),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaCollectionRequestInput(null),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaCollectionRequestInput(JSON.stringify({
    ...input, padding: "x".repeat(AMUX_V4_COLLECTION_REQUEST_MAX_BYTES),
  })), { ok: false, code: "too_large" });
});

test("only the exact canonical single repository file scope is eligible", () => {
  const checked = inspectAmuxIdeaCollectionRequestInput(JSON.stringify(input));
  assert.equal(checked.ok, true);
  const request = checked.request;
  assert.deepEqual(checkAmuxIdeaCollectionSource(request, ids.ideaId,
    scopeJson([source]), idea), { decision: "eligible", source });
  assert.deepEqual(checkAmuxIdeaCollectionSource(request, ids.previewId,
    scopeJson([source]), idea), { decision: "hold", reason: "idea_unverified" });
  assert.deepEqual(checkAmuxIdeaCollectionSource(request, ids.ideaId,
    JSON.stringify({ sources: [source], version: 1 }), idea),
  { decision: "hold", reason: "scope_unverified" });
  for (const malformed of [null, undefined, 42]) {
    assert.deepEqual(checkAmuxIdeaCollectionSource(request, ids.ideaId,
      malformed, idea), { decision: "hold", reason: "scope_unverified" });
  }
  assert.deepEqual(checkAmuxIdeaCollectionSource(request, ids.ideaId,
    scopeJson([source, { ...source, path: "lib/amux/other.ts" }]), idea),
  { decision: "reject", reason: "source_selection_unsupported" });
});

test("PR files, undeclared repositories and corrupted idea metadata do not collect", () => {
  const checked = inspectAmuxIdeaCollectionRequestInput(JSON.stringify(input));
  assert.equal(checked.ok, true);
  const request = checked.request;
  const prIdea = { ...idea, pullRequests: [{ repository: source.repository, number: 7 }] };
  const prSource = { kind: "pull_request_file", repository: source.repository, number: 7,
    baseSha: "b".repeat(40), headSha: "c".repeat(40), side: "head", path: source.path };
  assert.deepEqual(checkAmuxIdeaCollectionSource(request, ids.ideaId,
    scopeJson([prSource]), prIdea),
  { decision: "reject", reason: "source_selection_unsupported" });
  assert.deepEqual(checkAmuxIdeaCollectionSource(request, ids.ideaId,
    scopeJson([{ ...source, repository: "other/Repo" }]), idea),
  { decision: "hold", reason: "scope_unverified" });
  assert.deepEqual(checkAmuxIdeaCollectionSource(request, ids.ideaId,
    scopeJson([source]), { ...idea, repositories: ["not a repo"] }),
  { decision: "hold", reason: "idea_unverified" });
});
