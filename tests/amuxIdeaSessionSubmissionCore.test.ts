import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  amuxSessionIntakeWritePermitted,
  inspectAmuxIdeaSessionSource,
  inspectAmuxIdeaSessionSubmission,
  sameAmuxOperatingScopeAuthority,
} from "@/lib/amux/ideaSessionSubmissionCore";

const source = {
  toolName: "Codex",
  modelProvider: "OpenAI",
  sessionDisplay: "AMUX intake implementation",
};
const submission = (input: Record<string, unknown>) => ({
  version: 1,
  requestId: randomUUID(),
  input,
  source,
});
const idea = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  idea: "Add one guarded intake path.",
  repositories: ["mposition/Tomverse"],
  pullRequests: [],
  ...overrides,
});

test("session intake needs both exact enabled switches and defaults off", () => {
  assert.equal(amuxSessionIntakeWritePermitted(undefined, undefined), false);
  assert.equal(amuxSessionIntakeWritePermitted("enabled", undefined), false);
  assert.equal(amuxSessionIntakeWritePermitted(undefined, "enabled"), false);
  assert.equal(amuxSessionIntakeWritePermitted("ENABLED", "enabled"), false);
  assert.equal(amuxSessionIntakeWritePermitted("enabled", "enabled"), true);
});

test("session source keeps the three encrypted provenance labels exactly", () => {
  assert.deepEqual(inspectAmuxIdeaSessionSource(source), { ok: true, source });
  assert.deepEqual(inspectAmuxIdeaSessionSource({ ...source, path: "repo" }),
    { ok: false, code: "source_invalid" });
  assert.deepEqual(inspectAmuxIdeaSessionSource({ ...source, sessionDisplay: "token=abcdefgh" }),
    { ok: false, code: "source_invalid" });
  assert.deepEqual(inspectAmuxIdeaSessionSource({ ...source, sessionDisplay: "" }),
    { ok: false, code: "source_invalid" });
});

test("session input does not inherit the owner parser's byte or item caps", () => {
  const longIdea = "Implement this guarded behavior. " + "x".repeat(8_300);
  const manyRepositories = Array.from({ length: 9 }, (_, index) => "owner/repo" + index);
  const manyPullRequests = Array.from({ length: 17 }, (_, index) => ({
    repository: manyRepositories[index % manyRepositories.length],
    number: index + 1,
  }));
  const inspected = inspectAmuxIdeaSessionSubmission(submission(idea({
    idea: longIdea,
    repositories: manyRepositories,
    pullRequests: manyPullRequests,
  })));
  assert.equal(inspected.ok, true);
  if (!inspected.ok) return;
  assert.ok(inspected.counts.ideaBytes > 8_192);
  assert.equal(inspected.counts.repositoryCount, 9);
  assert.equal(inspected.counts.pullRequestCount, 17);
  assert.equal(inspected.input.idea, longIdea);
});

test("session input refuses schema ambiguity and sensitive content", () => {
  for (const input of [
    idea({ idea: "" }),
    idea({ idea: "person@example.test" }),
    idea({ idea: "C:\\Users\\operator\\secret.txt" }),
    idea({ idea: "token=abcdefgh" }),
    idea({ repositories: ["not-a-repository"] }),
    idea({ repositories: ["owner/repo", "OWNER/REPO"] }),
    idea({ pullRequests: [{ repository: "owner/repo", number: 0 }] }),
    { ...idea(), extra: true },
  ]) {
    assert.equal(inspectAmuxIdeaSessionSubmission(submission(input)).ok, false);
  }
  assert.equal(inspectAmuxIdeaSessionSubmission({
    ...submission(idea()), requestId: "not-a-request-id",
  }).ok, false);
});

test("scope authority equality binds its row, version, owner and normalized scope", () => {
  const authority = {
    settingId: "scope-1",
    version: 2,
    approvedByUserId: "owner-1",
    scope: {
      repositories: ["mposition/Tomverse"],
      model: { provider: "openai" as const, modelId: "gpt-6-astra", reasoningEffort: "high" as const },
    },
  };
  assert.equal(sameAmuxOperatingScopeAuthority(authority, structuredClone(authority)), true);
  assert.equal(sameAmuxOperatingScopeAuthority(authority, { ...authority, version: 3 }), false);
  assert.equal(sameAmuxOperatingScopeAuthority(authority, {
    ...authority, approvedByUserId: "owner-2",
  }), false);
});
