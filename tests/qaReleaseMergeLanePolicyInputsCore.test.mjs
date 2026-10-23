import assert from "node:assert/strict";
import { compileManifestPattern } from "../lib/agentAuthorityFiles.ts";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isQaReleasePolicyDocument,
  qaReleaseAgentOwnPatterns,
  qaReleasePolicyTestPaths,
} from "../lib/qaReleaseMergeLanePolicyInputsCore.ts";

const POLICY = readFileSync(new URL("../docs/policy/qa-release-agent.md", import.meta.url), "utf8");

test("the appendix A patterns are read from the policy as it stands", () => {
  const patterns = qaReleaseAgentOwnPatterns(POLICY);
  assert.ok(patterns, "appendix A is found");
  // Only what changes the lane itself (owner, 2026-10-23): its merge code, its start check and the IaC.
  assert.ok(patterns.includes("lib/qaReleaseMergeLane*"));
  assert.ok(patterns.includes("scripts/merge-train-core.mjs"));
  assert.ok(patterns.includes(".railway/**"));
  assert.ok(!patterns.includes("lib/qaRelease*"));
  assert.ok(!patterns.some((pattern) => pattern.startsWith("components/") || pattern.startsWith("tests/")));
  // What controls the lane stays too (independent review, 2026-10-23): its API entry points, the
  // operator control and its Admin routes, the stores that write the audit chain, the train.
  const own = (path) => patterns.some((pattern) => compileManifestPattern(pattern).test(path));
  for (const path of [
    "app/api/internal/agents/qa-release/merge-lane/consume/route.ts",
    "app/api/admin/agent-digests/qa-release/control/route.ts",
    "lib/qaReleaseOperatorControlAdmin.ts",
    "lib/qaReleaseTrainStore.ts",
    "lib/qaReleaseTrainPorts.ts",
    "lib/agentDigestStore.ts",
    "scripts/qa-release-train-service.mjs",
  ]) assert.ok(own(path), path);
  for (const path of ["components/admin/QaReleaseLaneVerdictsSection.tsx", "lib/qaReleaseAttentionCore.ts", "lib/qaReleaseDigestBuildCore.ts", "tests/qaReleaseTrainService.test.mjs"]) {
    assert.ok(!own(path), path);
  }
  assert.ok(patterns.every((pattern) => !pattern.includes(" ")));
});

test("a policy without its appendix, or with a malformed block, gives no list -- which excludes", () => {
  assert.equal(qaReleaseAgentOwnPatterns("# policy\n\nno appendix"), null);
  assert.equal(qaReleaseAgentOwnPatterns("## 부록 A. 파일\n\nno block\n"), null);
  assert.equal(qaReleaseAgentOwnPatterns("## 부록 A. 파일\n\n```\n\n```\n"), null);
  assert.equal(qaReleaseAgentOwnPatterns("## 부록 A. 파일\n\n```\nlib/a*\nrm -rf /\n```\n"), null);
  // Only the appendix's own block counts, not one in a later section.
  assert.equal(qaReleaseAgentOwnPatterns("## 부록 A. 파일\n\n본문\n\n## 부록 B. 다른 것\n\n```\nlib/x\n```\n"), null);
  assert.deepEqual(qaReleaseAgentOwnPatterns("## 부록 A. 파일\n\n```\nlib/a*\n  tests/b*  \n```\n\n## 다음\n"), ["lib/a*", "tests/b*"]);
});

test("policy tests are the tests/** paths the documents name, nothing looser", () => {
  const paths = qaReleasePolicyTestPaths([
    "`tests/autoPrAutoMergeArming.test.mjs`와 `security-regression-check`가 고정합니다.",
    "see tests/integration/conversation-product-key.db.test.ts and (tests/e2e/mobile-short-viewport-drawer.spec.ts)",
    "not a path: mytests/x.test.mjs, tests/, tests/../etc/passwd.mjs, tests//x.mjs, tests/fixtures/data.json",
    "again tests/autoPrAutoMergeArming.test.mjs",
  ]);
  assert.deepEqual(paths, [
    "tests/autoPrAutoMergeArming.test.mjs",
    "tests/e2e/mobile-short-viewport-drawer.spec.ts",
    "tests/integration/conversation-product-key.db.test.ts",
  ]);
});

test("the documents are AGENTS.md, CLAUDE.md and the lane's own policy only (owner 2026-10-23)", () => {
  for (const path of ["AGENTS.md", "CLAUDE.md", "docs/policy/qa-release-agent.md"]) {
    assert.equal(isQaReleasePolicyDocument(path), true, path);
  }
  for (const path of [
    "docs/policy/image-generation.md",
    "docs/policy/tomverse-chat-data-domain-registry.yaml",
    "docs/policy/sub/x.md",
    "docs/ops/x.md",
    "docs/policyx/a.md",
    "docs/policy/",
    "agents.md",
    "lib/AGENTS.md",
  ]) {
    assert.equal(isQaReleasePolicyDocument(path), false, path);
  }
});

test("a YAML document's named tests are read like a Markdown one's", () => {
  const registry = readFileSync(new URL("../docs/policy/tomverse-chat-data-domain-registry.yaml", import.meta.url), "utf8");
  assert.ok(qaReleasePolicyTestPaths([registry]).includes("tests/comparisonReviewRunCore.test.mjs"));
});
