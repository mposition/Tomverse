import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root,
  "lib/chatRefinerInitialAutoRelease.ts"), "utf8");
const document = readFileSync(resolve(root,
  "docs/policy/chat-refiner-stable-release-authority-v2.md"), "utf8")
  .replaceAll("\r\n", "\n");
const policyBody = (value) => {
  assert.ok(value.startsWith("---\n"));
  const end = value.indexOf("\n---\n", 4);
  assert.ok(end > 4);
  return value.slice(end + 5);
};
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("release policy binds body but not mutable status frontmatter", () => {
  const constant = source.match(/CHAT_REFINER_STABLE_RELEASE_POLICY_SHA256 =\s*\n\s*"([0-9a-f]{64})"/);
  assert.ok(constant);
  assert.equal(digest(policyBody(document)), constant[1]);
  assert.ok(document.includes(
    "status: approved"));
  assert.equal(digest(policyBody(document.replace(
    "status: approved",
    "status: implementation_merged_activation_pending"))), constant[1]);
  assert.notEqual(digest(`${policyBody(document)}\nDifferent policy body.\n`),
    constant[1]);
});
