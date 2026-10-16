import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_OPERATING_SCOPE_REPOSITORY_MAX,
  amuxIdeaReferencesOutsideScope,
  amuxOperatingScopeSavedMatches,
  amuxOperatingScopeSelection,
  amuxRepositoryAllowed,
  normalizeAmuxOperatingScope,
  readPendingAmuxOperatingScope,
} from "../lib/amux/ideaOperatingScopeCore.ts";

// docs/policy/amux-intake.md v19 item 2: the one human approval is the owner's operating scope.
const model = { provider: "anthropic", modelId: "claude-opus-5-5", reasoningEffort: "high" };
const scope = (repositories = ["mposition/Tomverse", "mposition/tomverse-private-docs"]) => ({ repositories, model });

test("a scope names allowed repositories and one model selection, ordered case-insensitively", () => {
  const result = normalizeAmuxOperatingScope(scope(["mposition/tomverse-private-docs", "mposition/Tomverse"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // The owner's spelling is kept; only the order is canonical.
  assert.deepEqual(result.scope.repositories, ["mposition/Tomverse", "mposition/tomverse-private-docs"]);
  assert.deepEqual(amuxOperatingScopeSelection(result.scope), model);
});

test("a malformed scope is refused with a reason, never repaired", () => {
  const refused = (value, code) => assert.deepEqual(normalizeAmuxOperatingScope(value), { ok: false, code });
  refused(null, "scope_shape_invalid");
  refused({ ...scope(), extra: true }, "scope_shape_invalid");
  refused(scope([]), "repositories_invalid");
  for (const bad of ["Tomverse", "mposition/", "/Tomverse", "a/b/c", "mposition/..", "mposition/To mverse", 7]) {
    refused(scope([bad]), "repositories_invalid");
  }
  const tooMany = Array.from({ length: AMUX_OPERATING_SCOPE_REPOSITORY_MAX + 1 }, (_, index) => `owner/repo${index}`);
  refused(scope(tooMany), "repositories_invalid");
  refused(scope(["mposition/Tomverse", "MPOSITION/tomverse"]), "repository_duplicate");
  refused({ repositories: ["mposition/Tomverse"], model: { ...model, provider: "xai" } }, "model_invalid");
  refused({ repositories: ["mposition/Tomverse"], model: { ...model, reasoningEffort: "extreme" } }, "model_invalid");
  refused({ repositories: ["mposition/Tomverse"], model: { ...model, modelId: "" } }, "model_invalid");
  refused({ repositories: ["mposition/Tomverse"], model: { ...model, extra: 1 } }, "model_invalid");
});

test("an idea reference outside the allowlist is named, through repositories and pull requests", () => {
  const admitted = normalizeAmuxOperatingScope(scope());
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.equal(amuxRepositoryAllowed(admitted.scope, "MPOSITION/tomverse"), true);
  assert.equal(amuxRepositoryAllowed(admitted.scope, "mposition/other"), false);
  assert.equal(amuxRepositoryAllowed(admitted.scope, "not a repository"), false);
  assert.deepEqual(amuxIdeaReferencesOutsideScope(admitted.scope, {
    repositories: ["mposition/Tomverse", "someone/else"],
    pullRequests: [{ repository: "mposition/tomverse-private-docs" }, { repository: "someone/else" },
      { repository: "another/repo" }],
  }), ["someone/else", "another/repo"]);
  assert.deepEqual(amuxIdeaReferencesOutsideScope(admitted.scope, { repositories: [], pullRequests: [] }), []);
});

test("a lost save is matched to its pending request exactly, never re-sent", () => {
  const admitted = normalizeAmuxOperatingScope(scope());
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  const pending = readPendingAmuxOperatingScope({
    id: "3d6f5ade-f448-40c3-80ef-79eb90399dc9", expectedPreviousVersion: 2, scope: scope() });
  assert.ok(pending);
  assert.equal(readPendingAmuxOperatingScope({ ...pending, id: "not-a-uuid" }), null);
  assert.equal(readPendingAmuxOperatingScope({ ...pending, expectedPreviousVersion: -1 }), null);
  assert.equal(readPendingAmuxOperatingScope({ ...pending, scope: scope([]) }), null);
  const saved = { state: "saved", id: pending.id, version: 3, scope: admitted.scope, auditId: "audit-1" };
  assert.equal(amuxOperatingScopeSavedMatches(saved, pending), true);
  assert.equal(amuxOperatingScopeSavedMatches({ ...saved, version: 2 }, pending), false);
  assert.equal(amuxOperatingScopeSavedMatches({ ...saved, scope: scope(["mposition/Tomverse"]) }, pending), false);
  assert.equal(amuxOperatingScopeSavedMatches({ ...saved, auditId: "" }, pending), false);
  assert.equal(amuxOperatingScopeSavedMatches({ ...saved, extra: 1 }, pending), false);
});

test("the allowlist grammar and the idea input grammar agree on every sample", async () => {
  const { inspectAmuxIdeaInput } = await import("../lib/amux/ideaInputCore.ts");
  const { isAmuxScopeRepositoryName } = await import("../lib/amux/ideaOperatingScopeCore.ts");
  const samples = ["mposition/Tomverse", "a/b", "a.b/c_d-e", "Tomverse", "mposition/", "/Tomverse", "a/b/c",
    "mposition/..", "./x", "mposition/To mverse", `${"a".repeat(64)}/b`, `${"a".repeat(65)}/b`,
    `a/${"b".repeat(100)}`, `a/${"b".repeat(101)}`, "a/.", "ünicode/x"];
  for (const sample of samples) {
    const input = inspectAmuxIdeaInput(JSON.stringify({ version: 1, idea: "Compare the repository grammar.",
      repositories: [sample], pullRequests: [] }));
    assert.equal(isAmuxScopeRepositoryName(sample), input.ok, sample);
  }
});

test("only an answer known to come before the write is a refusal; the rest is read back", async () => {
  // Review finding: the rate limiter answers { error, code: "API_RATE_LIMITED" }.
  const { classifyAmuxOperatingScopeSaveAnswer } = await import("../lib/amux/ideaOperatingScopeCore.ts");
  const admitted = normalizeAmuxOperatingScope(scope());
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  const pending = { id: "3d6f5ade-f448-40c3-80ef-79eb90399dc9", expectedPreviousVersion: 0, scope: admitted.scope };
  const classify = (status, body) => classifyAmuxOperatingScopeSaveAnswer(status, body, pending);
  assert.deepEqual(classify(201, { state: "saved", id: pending.id, version: 1, scope: admitted.scope, auditId: "a" }),
    { kind: "saved" });
  assert.deepEqual(classify(201, { state: "saved", id: pending.id, version: 2, scope: admitted.scope, auditId: "a" }),
    { kind: "unknown" });
  assert.deepEqual(classify(429, { error: "Too many requests.", code: "API_RATE_LIMITED" }),
    { kind: "refused", notice: "refused" });
  assert.deepEqual(classify(413, { error: "Request body too large.", code: "REQUEST_BODY_TOO_LARGE" }),
    { kind: "refused", notice: "refused" });
  assert.deepEqual(classify(409, { error: "revision_changed", retryWrite: false }), { kind: "refused", notice: "changed" });
  assert.deepEqual(classify(409, { error: "model_not_approved", retryWrite: false }),
    { kind: "refused", notice: "notApproved" });
  assert.deepEqual(classify(400, { error: "invalid_scope", retryWrite: false }), { kind: "refused", notice: "invalid" });
  assert.deepEqual(classify(428, { error: "ADMIN_REAUTHENTICATION_REQUIRED" }), { kind: "refused", notice: "refused" });
  assert.deepEqual(classify(503, { error: "scope_unavailable", retryWrite: false }), { kind: "refused", notice: "refused" });
  // A mismatched status, a 5xx, an unknown code or a lost body stays unknown.
  for (const [status, body] of [[429, { error: "revision_changed", retryWrite: false }],
    [503, { error: "outcome_unknown", retryWrite: false }],
    [429, { error: "Too many requests.", code: "SOMETHING_ELSE" }], [500, null], [409, { error: "revision_changed" }]]) {
    assert.deepEqual(classify(status, body), { kind: "unknown" }, `${status} ${JSON.stringify(body)}`);
  }
});
