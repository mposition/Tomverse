import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { captureAmuxV22Patch, captureAmuxV22PatchBaseline } from
  "../lib/amux/v22PatchCapture.mjs";

const BASE = "a".repeat(40);
const PATCH = "diff --git a/lib/example.ts b/lib/example.ts\n" +
  "--- a/lib/example.ts\n+++ b/lib/example.ts\n@@ -1 +1 @@\n-old\n+new\n";

function fixture({ sha = BASE, status = "", patch = PATCH, root = "/repo",
  names = "M\0lib/example.ts\0", file = "new\n" } = {}) {
  const calls = [];
  const run = async (binary, args, options) => {
    assert.equal(binary, "/usr/bin/git");
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0");
    const command = args.slice(6);
    calls.push(command);
    const key = command[0];
    if (key === "rev-parse") return { stdout: Buffer.from(
      command[1] === "--show-toplevel" ? root : sha) };
    if (key === "status") return { stdout: Buffer.from(status) };
    if (key === "diff") return { stdout: Buffer.from(
      command.includes("--name-status") ? names : patch) };
    throw new Error("unexpected git command");
  };
  const openFile = async (path) => {
    assert.equal(path, "/repo/lib/example.ts");
    return { stat: async () => ({ isFile: () => true,
      size: Buffer.byteLength(file) }),
    readFile: async () => Buffer.from(file), close: async () => {} };
  };
  return { run, realpath: async (value) => value, openFile, calls };
}

test("clean fixed base yields only a bounded local candidate, never publication", async () => {
  const options = fixture();
  const baseline = await captureAmuxV22PatchBaseline("/repo", options);
  assert.deepEqual(baseline, { ok: true, baseSha: BASE });
  const candidate = await captureAmuxV22Patch("/repo", baseline.baseSha, options);
  assert.deepEqual(candidate, {
    ok: true, baseSha: BASE, patchBody: PATCH,
    patchDigest: createHash("sha256").update(PATCH).digest("hex"),
    publishFiles: [{ path: "lib/example.ts", mode: "100644",
      bytesBase64: Buffer.from("new\n").toString("base64") }],
  });
  assert.equal(options.calls.at(-1)[0], "diff");
  assert.ok(options.calls.every((call) => call[0] !== "diff" ||
    call.includes("--no-ext-diff")));
});

test("non-modified or oversized files keep the private patch but no publish evidence", async () => {
  const added = await captureAmuxV22Patch("/repo", BASE,
    fixture({ names: "A\0lib/example.ts\0" }));
  assert.equal(added.ok, true);
  assert.equal(added.publishReason, "publish_files_unsupported");
  assert.equal(added.publishFiles, undefined);
  const oversized = await captureAmuxV22Patch("/repo", BASE,
    fixture({ file: "x".repeat(48 * 1024 + 1) }));
  assert.equal(oversized.ok, true);
  assert.equal(oversized.publishReason, "publish_files_unsupported");
});

test("dirty or foreign baseline is rejected before a model run", async () => {
  assert.deepEqual(await captureAmuxV22PatchBaseline("/repo",
    fixture({ status: " M lib/example.ts\0" })),
    { ok: false, reason: "dirty_worktree" });
  assert.deepEqual(await captureAmuxV22PatchBaseline("/repo",
    fixture({ root: "/other" })),
    { ok: false, reason: "foreign_worktree" });
});

test("moved HEAD and untracked files never produce a partial candidate", async () => {
  assert.deepEqual(await captureAmuxV22Patch("/repo", BASE,
    fixture({ sha: "b".repeat(40) })),
    { ok: false, reason: "base_moved" });
  assert.deepEqual(await captureAmuxV22Patch("/repo", BASE,
    fixture({ status: "?? lib/new.ts\0" })),
    { ok: false, reason: "untracked_files" });
});

test("empty, binary and oversized patches fail closed", async () => {
  assert.deepEqual(await captureAmuxV22Patch("/repo", BASE,
    fixture({ patch: "" })),
    { ok: false, reason: "no_change" });
  assert.deepEqual(await captureAmuxV22Patch("/repo", BASE,
    fixture({ patch: "abc\0def" })),
    { ok: false, reason: "patch_not_bounded_text" });
  assert.deepEqual(await captureAmuxV22Patch("/repo", BASE,
    fixture({ patch: "x".repeat(65_537) })),
    { ok: false, reason: "patch_not_bounded_text" });
});

test("local scanner refuses patch secrets and withholds unsafe file evidence", async () => {
  const secret = "ghp_" + "A".repeat(40);
  assert.deepEqual(await captureAmuxV22Patch("/repo", BASE,
    fixture({ patch: PATCH + `+${secret}\n` })),
    { ok: false, reason: "patch_secret_detected" });
  const file = await captureAmuxV22Patch("/repo", BASE,
    fixture({ file: `token = ${secret}\n` }));
  assert.equal(file.ok, true);
  assert.equal(file.publishReason, "publish_files_secret_or_binary");
  assert.equal(file.publishFiles, undefined);
});
