import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  canSetAsidePreviousIdea,
  canStartAnotherIdea,
  canOpenSavedIdea,
  classifyIdeaSubmissionPost,
  classifyIdeaSubmissionReadBack,
} from "../lib/amux/ideaSubmissionUiCore.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const requestId = "e7def5f0-2c78-4bd3-9558-ab8a8e3617d0";

test("saved idea lookup cannot reset pending or unknown writes", () => {
  for (const state of ["idle", "submitted", "refused"]) {
    assert.equal(canOpenSavedIdea(state, false, requestId), true);
    assert.equal(canOpenSavedIdea(state, true, requestId), false);
  }
  for (const state of ["pending", "outcome_unknown", "recovery_unavailable"]) {
    assert.equal(canOpenSavedIdea(state, false, requestId), false);
  }
  assert.equal(canOpenSavedIdea("submitted", false, "not-a-request"), false);
  assert.equal(canOpenSavedIdea("submitted", false,
    "e7def5f0-2c78-1bd3-9558-ab8a8e3617d0"), false);
});

test("manual reopen uses only the existing audited receipt readback", () => {
  const panel = readFileSync(path.join(root, "components/admin/AmuxIdeaInputPanel.tsx"), "utf8");
  const reopen = panel.split("const openSavedIdea = async")[1]?.split("useEffect(")[0] ?? "";
  assert.match(reopen, /adminFetch\(`\/api\/admin\/amux\/ideas\/submissions\?/);
  assert.match(reopen, /classifyIdeaSubmissionReadBack/);
  assert.doesNotMatch(reopen, /method:\s*["']POST/);
  assert.match(panel, /htmlFor="amux-saved-request-id"/);
  assert.match(panel, /const frozen = readBackPending \|\|/);
  assert.match(panel, /hasUnsavedInput = !!\(idea\.trim\(\) \|\| repositories\.trim\(\) \|\| pullRequests\.trim\(\)\)/);
});

test("another idea starts only after a definitive save and no pending check", () => {
  assert.equal(canStartAnotherIdea("submitted", false), true);
  assert.equal(canStartAnotherIdea("submitted", true), false);
  for (const state of ["idle", "pending", "outcome_unknown", "recovery_unavailable", "refused"]) {
    assert.equal(canStartAnotherIdea(state, false), false);
  }
});

test("only an exact successful submission response confirms the idea", () => {
  assert.deepEqual(classifyIdeaSubmissionPost({
    status: 201, body: { state: "submitted", requestId, ideaId: "idea-1",
      hasExternalSources: true, transferReady: false },
  }, requestId), { kind: "submitted", ideaId: "idea-1", hasExternalSources: true });
  for (const reply of [
    { status: 201, body: { state: "submitted", requestId: "different", ideaId: "idea-1" } },
    { status: 201, body: { state: "submitted", requestId } },
    { status: 201, body: { state: "submitted", requestId, ideaId: "idea-1",
      hasExternalSources: false, transferReady: true } },
    { status: 201, body: { state: "submitted", requestId, ideaId: "idea-1",
      transferReady: false } },
    { status: 503, body: { error: "outcome_unknown", readBack: "committed" } },
    { status: 409, body: { error: "request_already_seen" } },
    { status: 500, body: { error: "submission_failed" } },
  ]) {
    assert.deepEqual(classifyIdeaSubmissionPost(reply, requestId), { kind: "verify" });
  }
});

test("only documented pre-transaction refusals permit a fresh submission", () => {
  for (const [code, status] of [["submission_disabled", 503], ["schema_rejected", 400],
    ["content_refused", 400], ["ADMIN_REAUTHENTICATION_REQUIRED", 428],
    ["audit_unavailable", 503]]) {
    assert.deepEqual(classifyIdeaSubmissionPost({ status, body: { error: code } }, requestId),
      { kind: "refused", code });
  }
  assert.deepEqual(classifyIdeaSubmissionPost({ status: 503, body: { error: "unexpected" } }, requestId),
    { kind: "verify" });
  assert.deepEqual(classifyIdeaSubmissionPost({ status: 200, body: { error: "audit_unavailable" } }, requestId),
    { kind: "verify" });
});

test("absent, partial, malformed and failed read-back all remain unknown", () => {
  assert.deepEqual(classifyIdeaSubmissionReadBack({
    status: 200, body: { requestId, status: "committed", ideaId: "idea-1",
      hasExternalSources: false },
  }, requestId), { kind: "submitted", ideaId: "idea-1", hasExternalSources: false });
  for (const reply of [
    { status: 200, body: { requestId, status: "absent" } },
    { status: 200, body: { requestId, status: "partial", ideaId: "idea-1" } },
    { status: 200, body: { requestId, status: "committed" } },
    { status: 200, body: { requestId, status: "committed", ideaId: "idea-1" } },
    { status: 200, body: { requestId: "different", status: "committed", ideaId: "idea-1" } },
    { status: 428, body: { error: "ADMIN_REAUTHENTICATION_REQUIRED" } },
  ]) {
    assert.deepEqual(classifyIdeaSubmissionReadBack(reply, requestId), { kind: "outcome_unknown" });
  }
});

test("write route requires the independent read-back gate before admission", () => {
  const route = readFileSync(path.join(root, "app/api/admin/amux/ideas/submissions/route.ts"), "utf8");
  const post = route.split("export async function POST")[1]?.split("export async function GET")[0] ?? "";
  assert.match(post, /!ideaSubmissionWritePermitted\([\s\S]*?\) \|\|\s*!ideaSubmissionReadBackPermitted\(/);
  assert.match(post, /hasExternalSources: inspected\.counts\.repositoryCount \+ inspected\.counts\.pullRequestCount > 0/);
  const panel = readFileSync(path.join(root, "components/admin/AmuxIdeaInputPanel.tsx"), "utf8");
  assert.match(panel, /declaredExternalSources=\{submission\.kind === "submitted" && submission\.hasExternalSources\}/);
});

test("an unknown or unrecoverable previous request can be set aside only by an explicit, idle decision", () => {
  for (const state of ["outcome_unknown", "recovery_unavailable"]) {
    assert.equal(canSetAsidePreviousIdea(state, false, true), true, state);
    assert.equal(canSetAsidePreviousIdea(state, false, false), false, `${state} needs the acknowledgement`);
    assert.equal(canSetAsidePreviousIdea(state, true, true), false, `${state} waits for a read-back in flight`);
  }
  for (const state of ["idle", "pending", "submitted", "refused"]) {
    assert.equal(canSetAsidePreviousIdea(state, false, true), false, state);
  }
  const panel = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "../components/admin/AmuxIdeaInputPanel.tsx"), "utf8");
  const handler = panel.slice(panel.indexOf("const setAsidePreviousIdea = () =>"), panel.indexOf("const checkSourceScope"));
  assert.equal(handler.includes("adminFetch(") || handler.includes("readBack("), false,
    "setting aside never writes or retries the old request");
  assert.ok(handler.indexOf("forgetIdeaRequestReceipts(") < handler.indexOf("resetInput()"),
    "the input unlocks only after the receipts are forgotten");
});
