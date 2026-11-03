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
  { path: "lib/amux/gate.ts",
    text: 'import { helper } from "@/lib/helper";\nexport const gate = helper;\n' },
  { path: "lib/helper.ts", text: "export const helper = 1;\n" },
  { path: "docs/notes.md", text: "notes\n" },
  { path: "tests/fixtures/sample.json", text: '{"value":1}\n' },
];
const modified = (path, newText) => ({
  path, status: "modified",
  oldMode: "100644", newMode: "100644", newType: "blob",
  sizeBytes: newText.length, isText: true, addedLines: 1, removedLines: 1,
  addedText: newText, newText,
});
const input = (change) => ({
  changes: [change], baseFiles, workflows: [],
  installedVersions: { ...CONVENTION_VERSIONS }, policyDocuments: [],
});

test("v22 T1 tier: a product file no gate reaches is T1, one a gate imports is T2", () => {
  for (const change of [modified("docs/notes.md", "more notes\n"),
    modified("tests/fixtures/sample.json", '{"value":2}\n')]) {
    assert.deepEqual(decideEngineeringAgentV22Tier(input(change)),
      { tier: "T1", findings: [] }, change.path);
  }
  const gated = decideEngineeringAgentV22Tier(input(
    modified("lib/helper.ts", "export const helper = 2;\n")));
  assert.equal(gated.tier, "T2");
  assert.ok(gated.findings.some((finding) =>
    finding.reason === "control_plane_slice"));
});

test("policy-named tests stay T2 outside the slice", () => {
  const verdict = decideEngineeringAgentV22Tier({
    ...input(modified("tests/fixtures/sample.json", '{"value":2}\n')),
    policyDocuments: ["tests/fixtures/sample.json is a policy fixture"],
  });
  assert.equal(verdict.tier, "T2");
  assert.ok(verdict.findings.some((finding) =>
    finding.reason === "policy_named_test"));
});
