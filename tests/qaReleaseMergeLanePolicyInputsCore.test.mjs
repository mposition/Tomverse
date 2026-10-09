import assert from "node:assert/strict";
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
  assert.ok(patterns.includes("lib/qaRelease*"));
  assert.ok(patterns.includes(".railway/**"));
  assert.ok(patterns.includes("app/(site)/(application)/admin/agent-digests/**"));
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

test("the documents are AGENTS.md, CLAUDE.md and every file under docs/policy/", () => {
  for (const path of [
    "AGENTS.md",
    "CLAUDE.md",
    "docs/policy/qa-release-agent.md",
    "docs/policy/sub/x.md",
    "docs/policy/tomverse-chat-data-domain-registry.yaml",
    "docs/policy/x.txt",
    "docs/policy/a",
    "docs/policy/b/c",
  ]) {
    assert.equal(isQaReleasePolicyDocument(path), true, path);
  }
  for (const path of ["docs/ops/x.md", "docs/policyx/a.md", "docs/policy/", "docs/policy/sub/", "agents.md", "lib/AGENTS.md"]) {
    assert.equal(isQaReleasePolicyDocument(path), false, path);
  }
});

test("a test only a YAML registry under docs/policy names is still a policy test", () => {
  const registry = readFileSync(new URL("../docs/policy/tomverse-chat-data-domain-registry.yaml", import.meta.url), "utf8");
  assert.ok(isQaReleasePolicyDocument("docs/policy/tomverse-chat-data-domain-registry.yaml"));
  assert.ok(qaReleasePolicyTestPaths([registry]).includes("tests/comparisonReviewRunCore.test.mjs"));
});
