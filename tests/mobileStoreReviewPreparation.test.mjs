import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("private credential output cannot enter the repository when run from a subfolder", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = resolve(root, "tests", "uncreated-review-credential-output");
  assert.equal(existsSync(output), false);
  const env = { ...process.env }; delete env.DATABASE_URL; delete env.DIRECT_URL;
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve(root, "scripts/prepare-mobile-store-review.mjs"), "--create-account", "--email", "play-review-synthetic@tomverse.app", "--submission", "synthetic-submission", "--build", "16", "--output", output], { cwd: resolve(root, "scripts"), env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the repository/);
  assert.equal(existsSync(output), false);
});
