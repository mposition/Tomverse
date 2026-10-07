import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { DEPLOY_EXCLUDED_PREFIXES } from
  "../lib/agentControlPlaneSlice.ts";

test("tests leave the deployment context but grant no T1 tier before image proof", () => {
  const patterns = readFileSync(join(process.cwd(), ".dockerignore"), "utf8")
    .split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(patterns, ["tests/", "playwright.admin.config.ts"]);
  assert.deepEqual([...DEPLOY_EXCLUDED_PREFIXES], []);
  assert.match(readFileSync(join(process.cwd(),
    "lib/marketingWebhookVerification.ts"), "utf8"),
  /readFile\(path\.join\(process\.cwd\(\), relative\)/);
});
