import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { listEngineeringAgentImagePaths,
  summarizeEngineeringAgentImagePaths } from
  "../scripts/report-engineering-agent-image-proof-core.mjs";

test("image report measures the deployed files, not the source ignore rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-image-proof-"));
  try {
    await mkdir(join(root, "docs", "ops"), { recursive: true });
    await mkdir(join(root, "lib"));
    await writeFile(join(root, "docs", "ops", "record.md"), "record");
    await writeFile(join(root, "lib", "app.js"), "app");
    const withoutTests = await listEngineeringAgentImagePaths(root);
    const first = summarizeEngineeringAgentImagePaths(withoutTests);
    assert.equal(first.testsPathCount, 0);
    assert.equal(first.docsOpsPathCount, 2);
    assert.equal(first.libPathCount, 2);
    assert.equal(first.completePathCount, withoutTests.length);
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests", "sample.test.js"), "test");
    const withTests = summarizeEngineeringAgentImagePaths(
      await listEngineeringAgentImagePaths(root));
    assert.equal(withTests.testsPathCount, 2);
    assert.notEqual(withTests.completePathListSha256,
      first.completePathListSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
