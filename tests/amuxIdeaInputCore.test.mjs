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
  assert.deepEqual(inspectAmuxIdeaInput(request({ idea: "한".repeat(3000) })), { ok: false, code: "too_large" });
});

test("input preview route is owner-only, no-store and has no write or model call", () => {
  const route = readFileSync(path.join(root, "app/api/admin/amux/ideas/input-preview/route.ts"), "utf8");
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /consumeApiRateLimit\(/);
  assert.match(route, /private, no-store/);
  assert.match(route, /transferReady: false/);
  assert.match(route, /ideaWrites: 0/);
  assert.match(route, /notAutomaticallyCollected:/);
  assert.doesNotMatch(route, /\bexcluded:/);
  assert.doesNotMatch(route, /prisma\.|streamText\(|generateText\(|child_process|spawn\(/);
});
