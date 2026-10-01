import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  classifyIdeaSubmissionPost,
  classifyIdeaSubmissionReadBack,
} from "../lib/amux/ideaSubmissionUiCore.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const requestId = "e7def5f0-2c78-4bd3-9558-ab8a8e3617d0";

test("only an exact successful submission response confirms the idea", () => {
  assert.deepEqual(classifyIdeaSubmissionPost({
    status: 201, body: { state: "submitted", requestId, ideaId: "idea-1" },
  }, requestId), { kind: "submitted", ideaId: "idea-1" });
  for (const reply of [
    { status: 201, body: { state: "submitted", requestId: "different", ideaId: "idea-1" } },
    { status: 201, body: { state: "submitted", requestId } },
    { status: 503, body: { error: "outcome_unknown", readBack: "committed" } },
    { status: 409, body: { error: "request_already_seen" } },
    { status: 500, body: { error: "submission_failed" } },
  ]) {
    assert.deepEqual(classifyIdeaSubmissionPost(reply, requestId), { kind: "verify" });
  }
});

test("only documented pre-transaction refusals permit a fresh submission", () => {
  for (const code of ["submission_disabled", "schema_rejected", "content_refused",
    "ADMIN_REAUTHENTICATION_REQUIRED", "audit_unavailable"]) {
    assert.deepEqual(classifyIdeaSubmissionPost({ status: 503, body: { error: code } }, requestId),
      { kind: "refused", code });
  }
  assert.deepEqual(classifyIdeaSubmissionPost({ status: 503, body: { error: "unexpected" } }, requestId),
    { kind: "verify" });
});

test("absent, partial, malformed and failed read-back all remain unknown", () => {
  assert.deepEqual(classifyIdeaSubmissionReadBack({
    status: 200, body: { status: "committed", ideaId: "idea-1" },
  }), { kind: "submitted", ideaId: "idea-1" });
  for (const reply of [
    { status: 200, body: { status: "absent" } },
    { status: 200, body: { status: "partial", ideaId: "idea-1" } },
    { status: 200, body: { status: "committed" } },
    { status: 428, body: { error: "ADMIN_REAUTHENTICATION_REQUIRED" } },
  ]) {
    assert.deepEqual(classifyIdeaSubmissionReadBack(reply), { kind: "outcome_unknown" });
  }
});

test("write route requires the independent read-back gate before admission", () => {
  const route = readFileSync(path.join(root, "app/api/admin/amux/ideas/submissions/route.ts"), "utf8");
  const post = route.split("export async function POST")[1]?.split("export async function GET")[0] ?? "";
  assert.match(post, /!ideaSubmissionWritePermitted\([\s\S]*?\) \|\|\s*!ideaSubmissionReadBackPermitted\(/);
});
