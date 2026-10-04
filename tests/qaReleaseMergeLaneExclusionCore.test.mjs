import assert from "node:assert/strict";
import test from "node:test";

import { judgeQaReleaseMergeLaneExclusion } from "../lib/qaReleaseMergeLaneExclusionCore.ts";

const OWN = [
  "lib/qaRelease*",
  "app/api/internal/agents/qa-release/**",
  "app/api/admin/agents/qa-release/**",
  "tests/qaRelease*",
  "tests/mergeTrainCore.test.mjs",
  "tests/mainPrSourcePolicy.test.mjs",
  ".railway/**",
];

const judge = (overrides) =>
  judgeQaReleaseMergeLaneExclusion({
    headBranch: "claude/to-develop/some-feature",
    changedFiles: [{ path: "components/chat/ChatInput.tsx" }],
    changedFilesComplete: true,
    policyTestPaths: ["tests/autoPrAutoMergeArming.test.mjs"],
    agentOwnPatterns: OWN,
    ...overrides,
  });

test("an ordinary feature PR is a candidate", () => {
  assert.deepEqual(judge({}), { excluded: false });
});

test("a migration alone does not exclude (policy: unattended develop merges include migrations)", () => {
  assert.deepEqual(
    judge({
      changedFiles: [
        {
          path: "prisma/migrations/20261003000000_x/migration.sql",
          migrationSql: 'ALTER TABLE "Conversation" ADD COLUMN "x" TEXT;',
        },
        { path: "prisma/schema.prisma" },
      ],
    }),
    { excluded: false },
  );
});

test("each gate path excludes", () => {
  for (const path of [
    ".github/workflows/pr-fast-gate.yml",
    "scripts/security-regression-check.mjs",
    "scripts/verify-smoke-coverage.mjs",
    "scripts/deep/nested/run.mjs",
    "package.json",
    "package-lock.json",
    "eslint.config.mjs",
    ".gitleaks.toml",
    "tsconfig.json",
    "next.config.ts",
    "playwright.config.ts",
    "AGENTS.md",
    "CLAUDE.md",
    "docs/policy/qa-release-agent.md",
    "docs/ui-contracts/mobile-chat-composer.md",
    "docs/release-gates/tomverse-chat-v1.yaml",
    "lib/adminAuth.ts",
    "lib/adminAuthCore.ts",
    "lib/adminAuditSystemActors.ts",
    "lib/agentAuthorityFiles.ts",
  ]) {
    assert.deepEqual(judge({ changedFiles: [{ path }] }), { excluded: true, reasons: ["gate_path"] }, path);
  }
});

test("near-miss paths are not gates", () => {
  for (const path of ["docs/ops/railway-restore-drill.md", "lib/adminAudit.ts", "components/package.json.md", "docs/AGENTS.md.bak"]) {
    assert.deepEqual(judge({ changedFiles: [{ path }] }), { excluded: false }, path);
  }
});

test("a test named by a policy document excludes, other tests do not", () => {
  assert.deepEqual(
    judge({ changedFiles: [{ path: "tests/autoPrAutoMergeArming.test.mjs" }] }),
    { excluded: true, reasons: ["policy_test"] },
  );
  assert.deepEqual(judge({ changedFiles: [{ path: "tests/chatInput.test.mjs" }] }), { excluded: false });
});

test("this agent's own paths exclude", () => {
  for (const path of [
    "lib/qaReleaseDigestFreshnessCore.ts",
    "app/api/internal/agents/qa-release/digest/route.ts",
    "tests/qaReleaseDigestFreshnessCore.test.mjs",
    ".railway/scheduled-jobs.ts",
  ]) {
    assert.deepEqual(judge({ changedFiles: [{ path }] }), { excluded: true, reasons: ["agent_own_path"] }, path);
  }
});

test("a rename is judged on both sides", () => {
  assert.deepEqual(
    judge({ changedFiles: [{ path: "lib/renamedHelper.ts", previousPath: "lib/adminAuthCore.ts" }] }),
    { excluded: true, reasons: ["gate_path"] },
  );
});

test("excluded head branches, by path segment, not substring", () => {
  for (const headBranch of [
    "agent/engineering/run-1",
    "marketing-agent/seo-topic",
    "feedback-autofix/case-9",
    "feedback-autofix-main/case-9",
    "autofix/cron",
    "visual-baseline/123",
    "dependabot/npm_and_yarn/next-16",
    "dependabot",
  ]) {
    assert.deepEqual(judge({ headBranch }), { excluded: true, reasons: ["excluded_branch"] }, headBranch);
  }
  for (const headBranch of ["agentic/feature", "claude/to-develop/agent-tools", "visual-baselines/x"]) {
    assert.deepEqual(judge({ headBranch }), { excluded: false }, headBranch);
  }
});

test("an incomplete or empty file list excludes -- unknown is not safe", () => {
  assert.deepEqual(judge({ changedFilesComplete: false }), {
    excluded: true,
    reasons: ["changed_files_incomplete"],
  });
  assert.deepEqual(judge({ changedFiles: [] }), { excluded: true, reasons: ["changed_files_empty"] });
  assert.deepEqual(judge({ changedFiles: undefined }), { excluded: true, reasons: ["changed_files_incomplete"] });
});

test("a missing input list excludes instead of reading as empty or throwing", () => {
  assert.deepEqual(judge({ policyTestPaths: undefined }), { excluded: true, reasons: ["inputs_unreadable"] });
  assert.deepEqual(judge({ agentOwnPatterns: null }), { excluded: true, reasons: ["inputs_unreadable"] });
});

test("a path that cannot be judged excludes", () => {
  for (const path of [
    "/etc/passwd",
    "lib\\x.ts",
    "lib/../AGENTS.md",
    "lib//x.ts",
    "./x.ts",
    "",
    "lib/a\u0001.ts",
    "lib/a\u007f.ts",
    "lib/\ud800.ts",
    "lib/.git/config",
    `lib/${"a".repeat(5000)}.ts`,
  ]) {
    assert.deepEqual(judge({ changedFiles: [{ path }] }), { excluded: true, reasons: ["unreadable_path"] }, JSON.stringify(path));
  }
});

test("reasons accumulate and are stable", () => {
  assert.deepEqual(
    judge({
      headBranch: "dependabot/npm/x",
      changedFiles: [{ path: "package.json" }, { path: "lib/qaReleaseX.ts" }],
    }),
    { excluded: true, reasons: ["agent_own_path", "excluded_branch", "gate_path"] },
  );
});

test("a migration naming this agent's tables, or one whose SQL cannot be read, excludes", () => {
  const path = "prisma/migrations/20261003000000_x/migration.sql";
  for (const migrationSql of [
    'CREATE TABLE "QaReleaseControlRevision" ("revision" INTEGER);',
    'DROP TABLE "QaReleaseMergeLaneState";',
    "DELETE FROM \"AgentDigestItem\" WHERE \"agentKey\" = 'qa-release';",
    null,
    undefined,
  ]) {
    assert.deepEqual(
      judge({ changedFiles: [{ path, migrationSql }] }),
      { excluded: true, reasons: ["protected_table_migration"] },
      String(migrationSql),
    );
  }
});

test("migration SQL on a non-migration path is ignored", () => {
  assert.deepEqual(
    judge({ changedFiles: [{ path: "docs/notes.md", migrationSql: 'DROP TABLE "QaReleaseX";' }] }),
    { excluded: false },
  );
});

test("npm's manifest, lockfiles and configuration are gates at any depth (policy version 3)", () => {
  for (const path of [
    "packages/shared/package.json",
    "apps/mobile/package-lock.json",
    "tools/review-orchestrator/npm-shrinkwrap.json",
    "packages/shared/.npmrc",
    "apps/mobile/Package.json",
    "a/b/c/d/.NPMRC",
  ]) {
    assert.deepEqual(judge({ changedFiles: [{ path }] }), { excluded: true, reasons: ["gate_path"] }, path);
  }
  // A rename that only moves a manifest away still touched one.
  assert.deepEqual(
    judge({ changedFiles: [{ path: "packages/shared/manifest.txt", previousPath: "packages/shared/package.json" }] }),
    { excluded: true, reasons: ["gate_path"] },
  );
});

test("names that only contain a gate file name are not gates", () => {
  for (const path of ["packages/shared/package.json.md", "lib/my-package.json", "docs/npmrc-notes.md", "lib/package-lock.json.ts"]) {
    assert.deepEqual(judge({ changedFiles: [{ path }] }), { excluded: false }, path);
  }
});
