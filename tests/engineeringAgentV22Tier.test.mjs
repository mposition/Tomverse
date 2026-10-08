import assert from "node:assert/strict";
import test from "node:test";

import { CONVENTION_VERSIONS } from
  "../lib/agentAuthorityFiles.ts";
import { decideEngineeringAgentV22Tier } from
  "../lib/engineeringAgentV22Tier.ts";

const tsconfig = JSON.stringify({ compilerOptions: {
  module: "esnext", moduleResolution: "bundler",
  allowImportingTsExtensions: true, resolveJsonModule: true,
  paths: { "@/*": ["./*"] },
} });
const baseFiles = [
  { path: "tsconfig.json", text: tsconfig },
  { path: "package.json", text: '{"name":"app"}' },
  { path: "package-lock.json", text: '{"packages":{"":{}}}' },
  { path: "tests/fixtures/sample.json", text: '{"value":1}\n' },
];
const change = {
  path: "tests/fixtures/sample.json", status: "modified",
  oldMode: "100644", newMode: "100644", newType: "blob",
  sizeBytes: 12, isText: true, addedLines: 1, removedLines: 1,
  addedText: '{"value":2}\n', newText: '{"value":2}\n',
};
const input = (deployExcludedPrefixes) => ({
  changes: [change], baseFiles, workflows: [],
  installedVersions: { ...CONVENTION_VERSIONS }, policyDocuments: [],
  deployExcludedPrefixes,
});

test("v22 T1 tier needs an independently established image exclusion", () => {
  const before = decideEngineeringAgentV22Tier(input([]));
  assert.equal(before.tier, "T2");
  assert.ok(before.findings.some((finding) =>
    finding.reason === "control_plane_slice"));
  assert.deepEqual(decideEngineeringAgentV22Tier(input(["tests"])),
    { tier: "T1", findings: [] });
});

test("policy-named tests stay T2 even when absent from the image", () => {
  const verdict = decideEngineeringAgentV22Tier({
    ...input(["tests"]),
    policyDocuments: ["tests/fixtures/sample.json is a policy fixture"],
  });
  assert.equal(verdict.tier, "T2");
  assert.ok(verdict.findings.some((finding) =>
    finding.reason === "policy_named_test"));
});
