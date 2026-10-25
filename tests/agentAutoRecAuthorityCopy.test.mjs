import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as manifest from "../lib/agentAuthorityFiles.ts";
import { AUTHORITY_COPY, AUTHORITY_SOURCE, renderAuthorityCopy } from "../scripts/generate-auto-rec-authority.mjs";
import * as copy from "../tools/auto-rec-agent/lib/agentAuthorityFiles.generated.mjs";

test("the auto-rec runner's plain-JS manifest copy is the current manifest with its types stripped", () => {
  const expected = renderAuthorityCopy(readFileSync(AUTHORITY_SOURCE, "utf8"));
  assert.equal(readFileSync(AUTHORITY_COPY, "utf8"), expected, "stale copy: run npm run generate:auto-rec-authority");
});

test("the copy exports what the manifest exports and classifies paths the same way", () => {
  // tsx adds a CommonJS `default` when an .mjs file imports a .ts module.
  const named = (module) => Object.keys(module).filter((key) => key !== "default").sort();
  assert.deepEqual(named(copy), named(manifest));
  assert.deepEqual(copy.CONTROL_PLANE_PATTERNS, manifest.CONTROL_PLANE_PATTERNS);
  assert.deepEqual(copy.PRODUCT_PATTERNS, manifest.PRODUCT_PATTERNS);
  for (const path of ["lib/chatAttemptExecution.ts", ".github/workflows/x.yml", "AGENTS.md", "tools/auto-rec-agent/lib/core.mjs", "../x", "app/page.tsx"]) {
    assert.equal(copy.classifyPath(path), manifest.classifyPath(path), path);
    assert.equal(copy.isCanonicalRepoPath(path), manifest.isCanonicalRepoPath(path), path);
  }
});

test("the runner and the gateway load no TypeScript at runtime", () => {
  for (const file of ["tools/auto-rec-agent/lib/core.mjs", "tools/auto-rec-agent/lib/contract.mjs", "tools/auto-rec-agent/bin/autorec-runner.mjs", "tools/auto-rec-agent/bin/autorec-gateway.mjs"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /from\s+["'][^"']+\.ts["']/, file);
  }
  for (const unit of ["autorec-runner.service", "autorec-gateway@.service"]) {
    assert.doesNotMatch(readFileSync(`tools/auto-rec-agent/deploy/${unit}`, "utf8"), /--experimental-strip-types/, unit);
  }
});
