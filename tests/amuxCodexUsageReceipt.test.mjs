import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// This .test.mjs file is discovered by npm run test:unit in PR Fast Gate.
// The receipt extractor is Python, so keep its focused fixtures in unittest.
test("Codex attempt usage receipts reject ambiguous or duplicate usage", (context) => {
  const python = process.platform === "win32" ? "python" : "python3";
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT" && process.platform === "win32") {
    context.skip("Python is unavailable on this Windows contributor machine");
    return;
  }
  assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
  const result = spawnSync(
    python,
    ["-m", "unittest", "discover", "-s", "tests", "-p", "amux_codex_usage_receipt_test.py"],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});
