import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  hasToDevelopSegment,
  judgeAgentPolicyApproval,
  parseAgentPolicyHeader,
  parseAllowlist,
} from "../lib/agentPolicyApprovalCore.ts";

const GENESIS = "8e3dbf64452ab75e3c6f080c8f5f531c02ace387";
const POLICY = "docs/policy/qa-release-agent.md";

const pr = (overrides = {}) => ({
  number: 1950,
  baseRef: "develop",
  headRef: "docs/qa-release-policy-v2",
  mergedBy: "mposition",
  mergedAt: "2026-10-02T13:00:00Z",
  changedFiles: [POLICY],
  commitAuthors: [{ login: "mposition", type: "User" }],
  baseSha: "b".repeat(40),
  ...overrides,
});

const facts = (overrides = {}) => ({
  policyPath: POLICY,
  header: { approvedBy: "mposition", approvedAt: "2026-10-02", version: 2, allowlistGenesisCommit: GENESIS },
  previousVersion: 1,
  lastChangeCommit: "c".repeat(40),
  pullRequests: [pr()],
  allowlist: { firstCommit: GENESIS, accountsAtBase: ["mposition"], changes: [], genesisPullRequests: [pr({ number: 1598 })] },
  ...overrides,
});

const results = (steps) => Object.fromEntries(steps.map((step) => [step.step, step.result]));

test("a policy approved by the procedure passes every step", () => {
  assert.deepEqual(results(judgeAgentPolicyApproval(facts())), {
    0: "pass", "0a": "pass", 1: "pass", 2: "pass", 3: "pass", 4: "pass", 5: "pass", 6: "pass",
  });
});

test("each step fails on its own violation", () => {
  const cases = [
    ["0", { allowlist: { firstCommit: "d".repeat(40), accountsAtBase: ["mposition"], changes: [], genesisPullRequests: [pr({ number: 1598 })] } }],
    ["0", { allowlist: { firstCommit: GENESIS, accountsAtBase: ["someone"], changes: [], genesisPullRequests: [pr({ number: 1598 })] } }],
    ["0a", { previousVersion: 2 }],
    ["2", { pullRequests: [pr(), pr({ number: 1951 })] }],
    ["3", { pullRequests: [pr({ headRef: "claude/to-develop/qa-policy" })] }],
    ["4", { pullRequests: [pr({ mergedBy: "someone" })] }],
    ["5", { pullRequests: [pr({ mergedAt: "2026-10-03T00:30:00Z" })] }],
    ["6", { pullRequests: [pr({ changedFiles: [POLICY, "AGENTS.md"] })] }],
    ["6", { pullRequests: [pr({ commitAuthors: [{ login: "github-actions[bot]", type: "Bot" }] })] }],
    ["6", { pullRequests: [pr({ commitAuthors: [{ login: "someone", type: "User" }] })] }],
  ];
  for (const [step, overrides] of cases) {
    const verdict = results(judgeAgentPolicyApproval(facts(overrides)));
    assert.equal(verdict[step], "fail", `${step} ${JSON.stringify(overrides).slice(0, 80)}`);
  }
});

test("a record that could not be read is unknown, never a pass", () => {
  const verdict = results(judgeAgentPolicyApproval(facts({
    pullRequests: null,
    lastChangeCommit: null,
    allowlist: { firstCommit: GENESIS, accountsAtBase: null, changes: null, genesisPullRequests: null },
  })));
  assert.deepEqual(verdict, { 0: "unknown", "0a": "pass", 1: "unknown", 2: "unknown", 3: "unknown", 4: "unknown", 5: "unknown", 6: "unknown" });
});

test("a later allowlist change must have kept section 3", () => {
  const change = (overrides = {}) => ({
    commit: "e".repeat(40),
    before: { accounts: ["mposition"], version: 1 },
    after: { accounts: ["mposition", "second"], version: 2 },
    pullRequests: [pr({ number: 2000, changedFiles: ["docs/policy/agent-operator-allowlist.md"], headRef: "docs/allowlist-v2" })],
    ...overrides,
  });
  const allowlist = (c) => ({
    allowlist: { firstCommit: GENESIS, accountsAtBase: ["mposition", "second"], changes: [c], genesisPullRequests: [pr({ number: 1598 })] },
  });
  assert.equal(results(judgeAgentPolicyApproval(facts(allowlist(change()))))[0], "pass");
  for (const bad of [
    change({ after: { accounts: ["mposition", "second"], version: 1 } }),
    change({ pullRequests: [pr({ number: 2000, changedFiles: ["docs/policy/agent-operator-allowlist.md", POLICY] })] }),
    change({ pullRequests: [pr({ number: 2000, changedFiles: ["docs/policy/agent-operator-allowlist.md"], headRef: "claude/to-develop/allowlist" })] }),
    change({ pullRequests: [pr({ number: 2000, changedFiles: ["docs/policy/agent-operator-allowlist.md"], mergedBy: "second" })] }),
  ]) {
    assert.equal(results(judgeAgentPolicyApproval(facts(allowlist(bad))))[0], "fail");
  }
});

test("to-develop is a path segment, not a substring", () => {
  assert.equal(hasToDevelopSegment("claude/to-develop/x"), true);
  assert.equal(hasToDevelopSegment("to-develop/x"), true);
  assert.equal(hasToDevelopSegment("feature/to-development-notes"), false);
  assert.equal(hasToDevelopSegment("chore/to-develop-later"), false);
});

test("the parsers read the real policy and allowlist files", () => {
  const header = parseAgentPolicyHeader(readFileSync(new URL(`../${POLICY}`, import.meta.url), "utf8"));
  assert.equal(header.approvedBy, "mposition");
  assert.match(header.approvedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(header.version >= 2);
  assert.equal(header.allowlistGenesisCommit, GENESIS);
  const allowlist = parseAllowlist(readFileSync(new URL("../docs/policy/agent-operator-allowlist.md", import.meta.url), "utf8"));
  assert.deepEqual(allowlist, { accounts: ["mposition"], version: 1 });
});

test("a later commit of the genesis pull request is part of the genesis, not a section 3 change", () => {
  const sameAsGenesis = {
    commit: "f".repeat(40),
    before: { accounts: ["mposition"], version: 1 },
    after: { accounts: ["mposition"], version: 1 },
    pullRequests: [pr({ number: 1598, changedFiles: ["docs/policy/agent-operator-allowlist.md"] })],
  };
  const verdict = judgeAgentPolicyApproval(facts({
    allowlist: { firstCommit: GENESIS, accountsAtBase: ["mposition"], changes: [sameAsGenesis], genesisPullRequests: [pr({ number: 1598 })] },
  }));
  assert.equal(verdict[0].result, "pass", verdict[0].reason);
  assert.match(verdict[0].reason, /0 later allowlist change/);
});

test("the version reads in both forms the policies use", () => {
  assert.equal(parseAgentPolicyHeader("approvedBy: a · approvedAt: 2026-10-03 · 정책 버전: v1").version, 1);
  assert.equal(parseAgentPolicyHeader("approvedBy: a · approvedAt: 2026-10-03 · 정책 버전: 2").version, 2);
});
