import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { inspectAmuxIdeaInput } from "../lib/amux/ideaInputCore.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const request = (overrides = {}) => JSON.stringify({
  version: 1,
  idea: "Improve the AMUX hierarchy and its independent review workflow.",
  repositories: ["mposition/Tomverse"],
  pullRequests: [{ repository: "mposition/Tomverse", number: 1803 }],
  ...overrides,
});

test("idea input inspection accepts one project-sized idea without an eight-card limit", () => {
  const checked = inspectAmuxIdeaInput(request({ idea: "Build a safer AMUX planning flow. ".repeat(100) }));
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  assert.equal(checked.repositoryCount, 1);
  assert.equal(checked.pullRequestCount, 1);
  assert.equal(checked.input.idea.includes("safer AMUX"), true);
});

test("maximum bounded idea and reference envelope remains accepted", () => {
  const repositories = Array.from({ length: 8 }, (_, index) => `mposition/repository-${index}`);
  const pullRequests = Array.from({ length: 16 }, (_, index) => ({
    repository: "mposition/Tomverse",
    number: index + 1,
  }));
  const checked = inspectAmuxIdeaInput(request({
    idea: "\\".repeat(8192), repositories, pullRequests,
  }));
  assert.equal(checked.ok, true);
});

test("idea input rejects secrets, personal data and local paths", () => {
  for (const idea of [
    "Use sk-secretvalue123456789 in this task",
    "Contact operator@example.com before proceeding",
    "Read C:\\Users\\Operator\\private.md",
  ]) {
    assert.deepEqual(inspectAmuxIdeaInput(request({ idea })), { ok: false, code: "content_refused" });
  }
});

test("idea input rejects schema expansion, malformed references and oversized text", () => {
  assert.deepEqual(inspectAmuxIdeaInput(request({ unexpected: true })), { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaInput(request({ repositories: ["mposition/Tomverse", "mposition/Tomverse"] })), { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaInput(request({ pullRequests: [{ repository: "mposition/Tomverse", number: -1 }] })), { ok: false, code: "schema_rejected" });
  // Only the 4 MiB safety ceiling refuses an idea for its size.
  assert.deepEqual(inspectAmuxIdeaInput(request({ idea: "a".repeat(4 * 1024 * 1024 + 1) })),
    { ok: false, code: "too_large" });
});

test("a long idea with many references passes; the legacy switch restores the former limits", () => {
  // Owner direction 2026-11-15: no 8 KiB, 8-repository or 16-PR limit.
  const repositories = Array.from({ length: 30 }, (_, index) => `mposition/repository-${index}`);
  const pullRequests = Array.from({ length: 50 }, (_, index) => ({
    repository: "mposition/Tomverse", number: index + 1,
  }));
  const long = request({ idea: "한".repeat(3000), repositories, pullRequests });
  const checked = inspectAmuxIdeaInput(long);
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.equal(checked.repositoryCount, 30);
    assert.equal(checked.pullRequestCount, 50);
    assert.equal(checked.ideaBytes, 9000);
  }
  const ciLog = `Fix the failing CI.\n\n${"not ok 3 - the build step failed at line 12\n".repeat(20_000)}`;
  assert.equal(inspectAmuxIdeaInput(request({ idea: ciLog })).ok, true);
  process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS = "enabled";
  try {
    assert.deepEqual(inspectAmuxIdeaInput(request({ idea: "한".repeat(3000) })), { ok: false, code: "too_large" });
    assert.deepEqual(inspectAmuxIdeaInput(request({ repositories })), { ok: false, code: "schema_rejected" });
  } finally { delete process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS; }
});

test("input preview route is owner-only, no-store and audits only a body-free result", () => {
  const route = readFileSync(path.join(root, "app/api/admin/amux/ideas/input-preview/route.ts"), "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /consumeApiRateLimit\(/);
  assert.match(route, /private, no-store/);
  assert.match(route, /transferReady: false/);
  assert.match(route, /ideaWrites: 0/);
  assert.match(route, /writeAdminAuditLog\(\{/);
  assert.match(route, /amux\.idea\.input_checked/);
  assert.match(route, /amux\.idea\.input_refused/);
  assert.match(route, /metadata: \{ inputVersion: 1, outcome: auditOutcome \}/);
  assert.match(route, /AUDIT_REFUSAL_CODES\.has\(inspected\.code\) \? inspected\.code : "refused_other"/);
  const auditCall = route.match(/await writeAdminAuditLog\(\{[\s\S]*?\n    \}\);/)?.[0] ?? "";
  assert.ok(auditCall);
  assert.doesNotMatch(auditCall, /\braw\b|inspected\.input|`|\bideaBytes\b|\brepositories\b|\bpullRequests\b/);
  assert.match(route, /notAutomaticallyCollected:/);
  assert.doesNotMatch(route, /\bexcluded:/);
  assert.doesNotMatch(route, /prisma\.|streamText\(|generateText\(|child_process|spawn\(/);
});
