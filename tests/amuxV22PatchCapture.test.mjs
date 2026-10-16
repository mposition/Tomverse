import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { captureAmuxV22Patch, captureAmuxV22PatchBaseline,
  captureAmuxV52ChangedPaths, discardAmuxV52ContractChanges } from
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

test("v52 inventories every changed name independently of the publish patch cap", async () => {
  const names = Array.from({ length: 42 }, (_, index) =>
    `lib/ordinary-${index}.ts`);
  names.push("LIB/AMUX/Execution.ts", "docs/policy/new.md");
  const calls = [];
  const run = async (_binary, args, options) => {
    const command = args.slice(6);
    calls.push({ command, maxBuffer: options.maxBuffer });
    if (command[0] === "rev-parse") return { stdout: Buffer.from(
      command[1] === "--show-toplevel" ? "/repo" : BASE) };
    if (command[0] === "diff") return { stdout: Buffer.from(
      names.join("\0") + "\0") };
    if (command[0] === "ls-files") return { stdout: Buffer.from(
      "new/one.ts\0") };
    throw new Error("unexpected git command");
  };
  const result = await captureAmuxV52ChangedPaths("/repo", BASE,
    { run, realpath: async (path) => path });
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 45);
  assert.deepEqual(result.contractPaths,
    ["LIB/AMUX/Execution.ts", "docs/policy/new.md"]);
  assert.equal(calls.find(({ command }) => command[0] === "diff")
    .maxBuffer, 32 * 1024);
});

test("v52 treats missing, malformed and invalid path inventories as unavailable", async () => {
  const run = async (_binary, args) => {
    const command = args.slice(6);
    if (command[0] === "rev-parse") return { stdout: Buffer.from(
      command[1] === "--show-toplevel" ? "/repo" : BASE) };
    if (command[0] === "diff") return { stdout: Buffer.from("../escape.ts\0") };
    if (command[0] === "ls-files") return { stdout: Buffer.alloc(0) };
    throw new Error("unexpected git command");
  };
  assert.deepEqual(await captureAmuxV52ChangedPaths("/repo", BASE,
    { run, realpath: async (path) => path }),
    { ok: false, reason: "invalid_path" });
  assert.deepEqual(await captureAmuxV52ChangedPaths("/repo", BASE,
    { run: async () => { throw new Error("git failed"); } }),
    { ok: false, reason: "changed_paths_unavailable" });
  const tooMany = Array.from({ length: 4_097 }, (_, index) =>
    `${index.toString(36)}\0`).join("");
  assert.deepEqual(await captureAmuxV52ChangedPaths("/repo", BASE,
    { run: async (_binary, args) => ({ stdout: Buffer.from(
      args.slice(6)[0] === "rev-parse" ?
        args.slice(6)[1] === "--show-toplevel" ? "/repo" : BASE :
        args.slice(6)[0] === "diff" ? tooMany : "") }),
      realpath: async (path) => path }),
    { ok: false, reason: "changed_paths_unavailable" });
});

test("v52 discards a contract attempt only from its original clean base", async () => {
  const calls = [];
  const run = async (_binary, args) => {
    const command = args.slice(6);
    calls.push(command[0]);
    if (command[0] === "rev-parse") return { stdout: Buffer.from(
      command[1] === "--show-toplevel" ? "/repo" : BASE) };
    if (command[0] === "status") return { stdout: Buffer.alloc(0) };
    return { stdout: Buffer.alloc(0) };
  };
  assert.equal(await discardAmuxV52ContractChanges("/repo", BASE,
    { run, realpath: async (path) => path }), true);
  assert.deepEqual(calls, ["rev-parse", "rev-parse", "reset", "clean", "status"]);
  assert.equal(await discardAmuxV52ContractChanges("/repo", BASE,
    { run: async (_binary, args) => ({ stdout: Buffer.from(
      args.slice(6)[1] === "--show-toplevel" ? "/repo" : "b".repeat(40)) }),
      realpath: async (path) => path }), false);
});
