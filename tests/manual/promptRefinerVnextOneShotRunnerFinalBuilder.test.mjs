import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const builder = join(root, "scripts", "build-prompt-refiner-vnext-one-shot-runner-final.mjs");
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const run = (...args) => spawnSync(process.execPath, [builder, ...args], {
  cwd: root, encoding: "utf8",
});
const head = git("rev-parse", "HEAD").stdout.trim();

test("final builder rejects invalid source and repository output before writing", (t) => {
  const outside = mkdtempSync(join(tmpdir(), "prvnext-final-negative-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const invalid = run("--build", "not-a-sha", outside);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /runner_final_usage_invalid/);
  const inside = join(root, `.tmp-a17-final-${randomUUID()}`);
  const refused = run("--build", head, inside);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /runner_final_output_inside_repository/);
  assert.equal(existsSync(inside), false);
});

test("final builder only pins a merged commit and verifies immutable bytes", (t) => {
  if (git("status", "--porcelain", "--untracked-files=no").stdout.trim() !== "") {
    t.skip("final source checkout has tracked changes");
    return;
  }
  if (git("rev-parse", "--verify", "origin/develop^{commit}").status !== 0) {
    t.skip("origin/develop is unavailable in this checkout");
    return;
  }
  const outside = mkdtempSync(join(tmpdir(), "prvnext-final-build-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const merged = git("merge-base", "--is-ancestor", head, "origin/develop").status === 0;
  const built = run("--build", head, outside);
  if (!merged) {
    assert.equal(built.status, 1);
    assert.match(built.stderr, /runner_final_source_not_merged_develop_commit/);
    assert.equal(existsSync(join(outside,
      "prompt-refiner-vnext-one-shot-runner-0.1.0.json")), false);
    return;
  }
  assert.equal(built.status, 0, built.stderr);
  assert.equal(JSON.parse(built.stdout).status, "final_built");
  const pin = JSON.parse(readFileSync(join(outside,
    "prompt-refiner-vnext-one-shot-runner-0.1.0.json"), "utf8"));
  assert.equal(pin.version, "0.1.0");
  assert.equal(pin.status, "rebuilt_from_merged_source");
  assert.equal(pin.sourceCommit, head);
  assert.equal(pin.nodeMajor, 22);
  assert.equal(pin.b01PreregistrationPerformed, false);
  assert.equal(pin.dispatchAuthority, false);
  assert.equal(pin.verificationBoundary,
    "owner_checksum_and_runner_self_check_not_server_attestation");
  const repeatedBuild = run("--build", head, outside);
  assert.equal(repeatedBuild.status, 1);
  assert.match(repeatedBuild.stderr, /runner_final_already_built/);
  const verified = run("--verify", head, outside);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).status, "final_bytes_verified");
  appendFileSync(join(outside,
    "prompt-refiner-vnext-one-shot-runner-0.1.0.mjs.gz"), "changed");
  const changed = run("--verify", head, outside);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /runner_final_bytes_changed/);
});
