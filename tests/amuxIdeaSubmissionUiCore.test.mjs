import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

import {
  canCreateIdeaFromState,
  canStartAnotherIdea,
  canSelectRecentIdea,
  classifyIdeaSubmissionPost,
  classifyIdeaSubmissionReadBack,
  classifyRecentIdeaList,
  mergeRecentIdeaPages,
} from "../lib/amux/ideaSubmissionUiCore.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const requestId = "e7def5f0-2c78-4bd3-9558-ab8a8e3617d0";

test("a failed recent-idea read-back requires retry or explicit reset before a new write", () => {
  for (const state of ["idle", "refused"]) {
    assert.equal(canCreateIdeaFromState(state), true);
  }
  for (const state of ["pending", "submitted", "outcome_unknown",
    "recovery_unavailable", "selection_pending", "selection_unavailable"]) {
    assert.equal(canCreateIdeaFromState(state), false);
  }
  assert.equal(canStartAnotherIdea("selection_unavailable", false), true);
  assert.equal(canSelectRecentIdea("selection_unavailable", false), true);
  const panel = readFileSync(path.join(root, "components/admin/AmuxIdeaInputPanel.tsx"), "utf8");
  const submit = panel.split("const submit = async () => {")[1]?.split("const checkInput = async")[0] ?? "";
  assert.match(submit, /!canCreateIdeaFromState\(submission\.kind\)/);
  assert.match(panel, /const frozen = !canCreateIdeaFromState\(submission\.kind\)/);
  assert.match(panel, /const invalidateResult = \(\) => \{\s*if \(!canCreateIdeaFromState\(submission\.kind\)\) return/);
  const source = ts.createSourceFile("AmuxIdeaInputPanel.tsx", panel,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const protectedIds = new Set(["amux-v4-idea", "amux-v4-repositories", "amux-v4-pull-requests"]);
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const id = attributes.find((attribute) => attribute.name.text === "id")?.initializer;
      if (id && ts.isStringLiteral(id) && protectedIds.has(id.text)) {
        const disabled = attributes.find((attribute) => attribute.name.text === "disabled")?.initializer;
        assert.ok(disabled && ts.isJsxExpression(disabled));
        assert.equal(disabled.expression?.getText(source), "pending || frozen");
        protectedIds.delete(id.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual([...protectedIds], []);
});

test("another idea starts only after a definitive save and no pending check", () => {
  assert.equal(canStartAnotherIdea("submitted", false), true);
  assert.equal(canStartAnotherIdea("selection_unavailable", false), true);
  assert.equal(canStartAnotherIdea("submitted", true), false);
  for (const state of ["idle", "pending", "outcome_unknown", "recovery_unavailable", "refused",
    "selection_pending"]) {
    assert.equal(canStartAnotherIdea(state, false), false);
  }
});

test("recent idea selection cannot bypass an unresolved submission", () => {
  for (const state of ["idle", "submitted", "refused", "selection_unavailable"]) {
    assert.equal(canSelectRecentIdea(state, false), true);
    assert.equal(canSelectRecentIdea(state, true), false);
  }
  for (const state of ["pending", "outcome_unknown", "recovery_unavailable", "selection_pending"]) {
    assert.equal(canSelectRecentIdea(state, false), false);
  }
});

test("recent idea list accepts only bounded metadata", () => {
  const item = { ideaId: "e7def5f0-2c78-4bd3-9558-ab8a8e3617d0", requestId,
    submittedAt: "2026-10-03T00:00:00.000Z", analysisDeadlineAt: "2026-10-10T00:00:00.000Z" };
  assert.deepEqual(classifyRecentIdeaList({ status: 200,
    body: { status: "recent", items: [item], nextCursor: null } }),
  { items: [item], nextCursor: null });
  for (const body of [
    { status: "recent", items: [item, item], nextCursor: null },
    { status: "recent", items: [{ ...item, requestId: "invalid" }], nextCursor: null },
    { status: "recent", items: [{ ...item, submittedAt: "not-a-date" }], nextCursor: null },
    { status: "recent", items: [{ ...item, rawCiphertext: "secret" }], nextCursor: null },
  ]) {
    if (body.items[0]?.rawCiphertext) {
      assert.deepEqual(classifyRecentIdeaList({ status: 200, body }),
        { items: [item], nextCursor: null });
    } else {
      assert.equal(classifyRecentIdeaList({ status: 200, body }), null);
    }
  }
  assert.equal(classifyRecentIdeaList({ status: 503,
    body: { status: "recent", items: [item], nextCursor: null } }), null);
  assert.equal(classifyRecentIdeaList({ status: 200,
    body: { status: "recent", items: [item], nextCursor: "bad!" } }), null);
  assert.equal(classifyRecentIdeaList({ status: 200,
    body: { status: "recent", items: [], nextCursor: "abc" } }), null);
});

test("paged recent ideas preserve earlier rows and reject duplicate pages", () => {
  const first = { ideaId: "e7def5f0-2c78-4bd3-9558-ab8a8e3617d0", requestId,
    submittedAt: "2026-10-03T00:00:00.000Z", analysisDeadlineAt: "2026-10-10T00:00:00.000Z" };
  const second = { ...first, ideaId: "87def5f0-2c78-4bd3-9558-ab8a8e3617d0",
    requestId: "97def5f0-2c78-4bd3-9558-ab8a8e3617d0" };
  assert.deepEqual(mergeRecentIdeaPages([first], [second]), [first, second]);
  assert.equal(mergeRecentIdeaPages([first], [first]), null);
  assert.equal(mergeRecentIdeaPages([], [second, second]), null);
});

test("a selected idea remains retryable after refresh removes its page", () => {
  const panel = readFileSync(path.join(root, "components/admin/AmuxIdeaInputPanel.tsx"), "utf8");
  const retry = panel.split("const retryRecentIdea =")[1]?.split("useEffect(() => {")[0] ?? "";
  assert.match(retry, /void readBack\(requestId, "selection"\)/);
  assert.doesNotMatch(retry, /recentIdeas/);
  assert.match(panel, /onClick=\{\(\) => retryRecentIdea\(submission\.requestId\)\}/);
  const loadMore = panel.split("const loadMoreRecentIdeas =")[1]?.split("useEffect(() => {")[0] ?? "";
  assert.match(loadMore, /mergeRecentIdeaPages\(recentIdeas, page\.items\)/);
  assert.match(loadMore, /generation === recentRequestGeneration\.current/);
  assert.match(loadMore, /setRecentCursor\(page\.nextCursor\)/);
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

test("recent picker stays behind read-back and never treats a list row as confirmation", () => {
  const route = readFileSync(path.join(root, "app/api/admin/amux/ideas/submissions/route.ts"), "utf8");
  const get = route.split("export async function GET")[1] ?? "";
  assert.match(get, /!ideaSubmissionReadBackPermitted\(/);
  assert.match(get, /params\.get\("view"\) === "recent"/);
  assert.match(get, /parseAmuxV4RecentIdeaCursor\(rawCursor\)/);
  assert.match(get, /recent \? "admin-amux-v4-idea-recent" : "admin-amux-v4-idea-readback"/);
  const panel = readFileSync(path.join(root, "components/admin/AmuxIdeaInputPanel.tsx"), "utf8");
  const select = panel.split("const selectRecentIdea =")[1]?.split("useEffect(() => {")[0] ?? "";
  assert.match(select, /void readBack\(requestId, "selection"\)/);
  assert.match(select, /setSubmission\(\{ kind: "selection_pending", requestId \}\)/);
  assert.doesNotMatch(select, /setSubmission\(\{ kind: "submitted"/);
  assert.match(panel, /purpose === "selection"[\s\S]*?selection_unavailable/);
});
