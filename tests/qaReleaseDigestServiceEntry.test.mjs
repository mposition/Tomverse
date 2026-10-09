import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

// scripts/qa-release-digest-service.mjs connects the ports. What it must
// never do is read from its source: pass the submission secret or its whole
// environment to a child, follow a redirect, or import beyond node builtins
// and the dependency-free cores.

const SOURCE = readFileSync(new URL("../scripts/qa-release-digest-service.mjs", import.meta.url), "utf8");

test("the entry imports node builtins and the QA-release cores only", () => {
  const imports = [...SOURCE.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), [
    "../lib/qaReleaseCiCollectCore.ts",
    "../lib/qaReleaseDigestServiceCore.ts",
    "node:child_process",
  ]);
});

test("children get a minimal environment; the secret and the whole environment never reach them", () => {
  assert.doesNotMatch(SOURCE, /\.\.\.process\.env/);
  assert.doesNotMatch(SOURCE, /QA_RELEASE_DIGEST_SECRET/);
  const childEnv = SOURCE.slice(SOURCE.indexOf("env: {"), SOURCE.indexOf("},", SOURCE.indexOf("env: {")));
  assert.deepEqual(
    [...childEnv.matchAll(/^\s+([A-Z_]+):/gm)].map((m) => m[1]),
    ["PATH", "HOME", "NODE_ENV"],
  );
});

test("a script that overruns is killed with its whole process group, and the run moves on", () => {
  assert.match(SOURCE, /detached: true/);
  assert.ok(SOURCE.includes('process.kill(-child.pid, "SIGKILL");'));
  // The timeout settles the promise itself; it does not wait for "close".
  const timeoutBlock = SOURCE.slice(SOURCE.indexOf("timer = setTimeout("), SOURCE.indexOf("}, SCRIPT_TIMEOUT_MS);"));
  assert.ok(timeoutBlock.includes('settle({ exitCode: 1, stdout: "" });'));
});

test("every request follows no redirect and has a timeout", () => {
  const fetches = SOURCE.match(/await fetch\(/g) ?? [];
  assert.equal(fetches.length, 2);
  assert.equal((SOURCE.match(/redirect: "error"/g) ?? []).length, 2);
  assert.equal((SOURCE.match(/signal: AbortSignal\.timeout\(/g) ?? []).length, 2);
});

test("run for real: an unknown name refuses", () => {
  const refused = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/qa-release-digest-service.mjs"], {
    env: { PATH: process.env.PATH ?? "", RAILWAY_ENVIRONMENT_NAME: "staging", QA_RELEASE_DIGEST_ENABLED: "true", DATABASE_URL: "postgres://x" },
    encoding: "utf8",
  });
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(JSON.parse(refused.stdout.trim().split("\n").pop()), { exitCode: 1, outcome: "refused_to_start" });
});

// Windows adds SYSTEMROOT and WINDIR to every child environment, which the
// service rightly refuses; Railway and CI run Linux, where this runs.
test("run for real: switched off it exits 0 without running anything", { skip: process.platform === "win32" }, () => {
  const base = { PATH: process.env.PATH ?? "", RAILWAY_ENVIRONMENT_NAME: "staging" };
  const off = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/qa-release-digest-service.mjs"], {
    env: { ...base, QA_RELEASE_DIGEST_ENABLED: "false" },
    encoding: "utf8",
  });
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(JSON.parse(off.stdout.trim().split("\n").pop()), { exitCode: 0, outcome: "disabled" });
});

test("the entry stops itself and its report child at the 15-minute hard timeout (policy section 10)", async () => {
  const { QA_RELEASE_DIGEST_HARD_TIMEOUT_MS } = await import("../lib/qaReleaseDigestServiceCore.ts");
  assert.equal(QA_RELEASE_DIGEST_HARD_TIMEOUT_MS, 15 * 60 * 1000);
  assert.match(SOURCE, /const supervisor = setTimeout\(\(\) => \{[\s\S]*?process\.kill\(-pid, "SIGKILL"\)[\s\S]*?outcome: "hard_timeout"[\s\S]*?process\.exit\(1\);\s*\}, QA_RELEASE_DIGEST_HARD_TIMEOUT_MS\);/);
  // Armed before any work starts, and every child is tracked until it closes.
  assert.ok(SOURCE.indexOf("const supervisor = setTimeout") < SOURCE.indexOf("await runQaReleaseDigestService"));
  assert.match(SOURCE, /activeChildren\.add\(child\.pid\)/);
  assert.equal([...SOURCE.matchAll(/activeChildren\.delete\(child\.pid\)/g)].length, 2);
});
