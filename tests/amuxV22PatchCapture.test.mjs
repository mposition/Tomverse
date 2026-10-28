import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { captureAmuxV22Patch, captureAmuxV22PatchBaseline,
  captureAmuxV52ChangedPaths, captureAmuxV52ReviewCommit,
  discardAmuxV52AttemptChanges, syncAmuxV22WorktreeBase } from
  "../lib/amux/v22PatchCapture.mjs";

const BASE = "a".repeat(40);
const PATCH = "diff --git a/lib/example.ts b/lib/example.ts\n" +
  "--- a/lib/example.ts\n+++ b/lib/example.ts\n@@ -1 +1 @@\n-old\n+new\n";

test("a review commit is made from the exact patch and leaves HEAD clean", async () => {
  const calls = [];
  const run = async (_binary, args) => {
    const command = args.slice(6);
    calls.push(command);
    if (command[0] === "rev-parse") return { stdout: Buffer.from(
      command[1] === "--show-toplevel" ? "/repo" : BASE) };
    if (command[0] === "diff" && command.includes("--cached"))
      return { stdout: Buffer.from(PATCH) };
    if (command[0] === "write-tree")
      return { stdout: Buffer.from("c".repeat(40)) };
    if (command[0] === "-c" && command.includes("commit-tree"))
      return { stdout: Buffer.from("d".repeat(40)) };
    if (command[0] === "diff-tree")
      return { stdout: Buffer.from("lib/example.ts\0") };
    if (["add", "reset", "status", "update-ref"].includes(command[0]))
      return { stdout: Buffer.alloc(0) };
    throw new Error("unexpected git command");
  };
  const result = await captureAmuxV52ReviewCommit("/repo", BASE,
    "11111111-1111-4111-8111-111111111111", ["lib/example.ts"], PATCH,
    { run, realpath: async (value) => value });
  assert.deepEqual(result, { ok: true, baseSha: BASE,
    commitSha: "d".repeat(40),
    reviewRef: "refs/amux-v52-review/11111111-1111-4111-8111-111111111111" });
  assert.ok(calls.some((call) => call[0] === "add" &&
    call.includes("-A") && call.includes(":(literal)lib/example.ts")));
  assert.ok(calls.some((call) => call[0] === "reset" &&
    call.includes("--hard")));
  const mismatch = await captureAmuxV52ReviewCommit("/repo", BASE,
    "11111111-1111-4111-8111-111111111111", ["lib/other.ts"], PATCH,
    { run, realpath: async (value) => value });
  assert.deepEqual(mismatch, { ok: false,
    reason: "review_commit_paths_mismatch" });
  assert.equal(calls.at(-2)[0], "reset");
  assert.equal(calls.at(-1)[0], "status");
});

test("v52 includes a new regular file in the patch, publish evidence, and review commit", async () => {
  const newPatch = "diff --git a/lib/new.ts b/lib/new.ts\n" +
    "new file mode 100644\n--- /dev/null\n+++ b/lib/new.ts\n@@ -0,0 +1 @@\n+new\n";
  const calls = [];
  const run = async (_binary, args) => {
    const command = args.slice(6);
    calls.push(command);
    if (command[0] === "rev-parse") return { stdout: Buffer.from(
      command[1] === "--show-toplevel" ? "/repo" : BASE) };
    if (command[0] === "status") return { stdout: Buffer.from(
      calls.some((call) => call[0] === "reset") ? "" : "?? lib/new.ts\0") };
    if (command[0] === "ls-files") return { stdout: Buffer.from("lib/new.ts\0") };
    if (command[0] === "diff" && command.includes("--name-status"))
      return { stdout: Buffer.from("A\0lib/new.ts\0") };
    if (command[0] === "diff" && command.includes("--cached"))
      return { stdout: Buffer.from(newPatch) };
    if (command[0] === "diff") return { stdout: Buffer.from(newPatch) };
    if (command[0] === "write-tree") return { stdout: Buffer.from("c".repeat(40)) };
    if (command[0] === "-c" && command.includes("commit-tree"))
      return { stdout: Buffer.from("d".repeat(40)) };
    if (command[0] === "diff-tree")
      return { stdout: Buffer.from("lib/new.ts\0") };
    if (["add", "reset", "update-ref"].includes(command[0]))
      return { stdout: Buffer.alloc(0) };
    throw new Error("unexpected git command");
  };
  const options = { run, realpath: async (value) => value,
    allowUntracked: true, openFile: async () => ({
      stat: async () => ({ isFile: () => true, size: 4 }),
      readFile: async () => Buffer.from("new\n"), close: async () => {},
    }) };
  const candidate = await captureAmuxV22Patch("/repo", BASE, options);
  assert.equal(candidate.ok, true);
  assert.equal(candidate.patchBody, newPatch);
  assert.deepEqual(candidate.publishFiles, [{ path: "lib/new.ts", mode: "100644",
    bytesBase64: Buffer.from("new\n").toString("base64") }]);
  assert.ok(calls.some((call) => call[0] === "add" &&
    call.includes("-N") && call.includes(":(literal)lib/new.ts")));
  assert.ok(calls.some((call) => call[0] === "reset" &&
    call.includes(":(literal)lib/new.ts")));
  const review = await captureAmuxV52ReviewCommit("/repo", BASE,
    "11111111-1111-4111-8111-111111111111", ["lib/new.ts"], newPatch,
    options);
  assert.equal(review.ok, true);
  assert.ok(calls.some((call) => call[0] === "add" &&
    call.includes("-A") && call.includes(":(literal)lib/new.ts")));
});

test("a failed review commit creation resets the staged index", async () => {
  const calls = [];
  const run = async (_binary, args) => {
    const command = args.slice(6);
    calls.push(command[0]);
    if (command[0] === "rev-parse") return { stdout: Buffer.from(
      command[1] === "--show-toplevel" ? "/repo" : BASE) };
    if (command[0] === "diff") return { stdout: Buffer.from(PATCH) };
    if (command[0] === "write-tree") throw new Error("git write failed");
    return { stdout: Buffer.alloc(0) };
  };
  assert.deepEqual(await captureAmuxV52ReviewCommit("/repo", BASE,
    "11111111-1111-4111-8111-111111111111", ["lib/example.ts"], PATCH,
    { run, realpath: async (value) => value }),
  { ok: false, reason: "review_commit_unavailable" });
  assert.deepEqual(calls.slice(-2), ["reset", "status"]);
});

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

test("v52 refuses pre-existing ignored contract files before execution", async () => {
  const calls = [];
  const run = async (_binary, args) => {
    const command = args.slice(6);
    calls.push(command);
    if (command[0] === "rev-parse") return { stdout: Buffer.from(
      command[1] === "--show-toplevel" ? "/repo" : BASE) };
    if (command[0] === "status") return { stdout: Buffer.alloc(0) };
    if (command[0] === "ls-files") return { stdout: Buffer.from(
      "lib/amux/ignored.ts\0lib/unrelated-ignored.ts\0") };
    throw new Error("unexpected git command");
  };
  const options = { run, realpath: async (path) => path,
    guardIgnoredContract: true };
  assert.deepEqual(await captureAmuxV22PatchBaseline("/repo", options),
    { ok: false, reason: "dirty_worktree" });
  const ignored = calls.find((command) => command[0] === "ls-files");
  assert.ok(ignored.includes(":(icase,literal)lib/amux/"));
  assert.ok(ignored.includes(":(icase,glob)lib/credit*"));
  assert.ok(!ignored.includes(":(icase,literal)lib/"));
  assert.ok(ignored.includes(
    ":(icase,literal)app/api/conversations/[conversationId]/"));
  assert.deepEqual(await captureAmuxV22PatchBaseline("/repo", {
    ...options, run: async (binary, args, config) => {
      if (args.includes("ls-files"))
        return { stdout: Buffer.from("lib/unrelated-ignored.ts\0") };
      return run(binary, args, config);
    },
  }), { ok: true, baseSha: BASE });
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

test("v52 includes ignored contract paths without scanning unrelated ignored files", async () => {
  const calls = [];
  const run = async (_binary, args) => {
    const command = args.slice(6);
    calls.push(command);
    if (command[0] === "rev-parse") return { stdout: Buffer.from(
      command[1] === "--show-toplevel" ? "/repo" : BASE) };
    if (command[0] === "ls-files" && command.includes("--ignored"))
      return { stdout: Buffer.from("LIB/AMUX/cache/new.ts\0lib/ordinary-cache.ts\0") };
    return { stdout: Buffer.alloc(0) };
  };
  const result = await captureAmuxV52ChangedPaths("/repo", BASE,
    { run, realpath: async (path) => path });
  assert.deepEqual(result.contractPaths, ["LIB/AMUX/cache/new.ts"]);
  const ignored = calls.find((command) => command.includes("--ignored"));
  assert.ok(ignored.includes(":(icase,literal)lib/amux/"));
  assert.ok(ignored.includes(":(icase,literal)app/api/conversations/[conversationId]/"));
  assert.ok(ignored.includes(":(icase,glob)lib/credit*"));
  assert.ok(!ignored.includes(":(icase,literal)lib/"));
  assert.ok(!ignored.some((item) => item.includes("node_modules")));
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
  const tooLarge = Array.from({ length: 600 }, (_, index) =>
    `p/${index.toString(36).padStart(3, "0")}${"x".repeat(36)}\0`).join("");
  assert.ok(Buffer.byteLength(tooLarge, "utf8") < 32 * 1024);
  assert.deepEqual(await captureAmuxV52ChangedPaths("/repo", BASE,
    { run: async (_binary, args) => ({ stdout: Buffer.from(
      args.slice(6)[0] === "rev-parse" ?
        args.slice(6)[1] === "--show-toplevel" ? "/repo" : BASE :
        args.slice(6)[0] === "diff" ? tooLarge : "") }),
      realpath: async (path) => path }),
    { ok: false, reason: "changed_paths_unavailable" });
});

test("v52 discards a contract attempt only from its original clean base", async () => {
  const calls = [];
  const run = async (_binary, args) => {
    const command = args.slice(6);
    calls.push(command);
    if (command[0] === "rev-parse") return { stdout: Buffer.from(
      command[1] === "--show-toplevel" ? "/repo" : BASE) };
    if (command[0] === "ls-files") return { stdout: Buffer.from(
      calls.filter((item) => item[0] === "ls-files").length === 1 ?
        "lib/amux/new.ts\0components/chat/ordinary.ts\0" :
        "components/chat/ordinary.ts\0") };
    if (command[0] === "status") return { stdout: Buffer.alloc(0) };
    return { stdout: Buffer.alloc(0) };
  };
  assert.equal(await discardAmuxV52AttemptChanges("/repo", BASE,
    { run, realpath: async (path) => path }), true);
  assert.deepEqual(calls.map((command) => command[0]),
    ["rev-parse", "rev-parse", "ls-files", "reset", "clean", "clean",
      "status", "ls-files"]);
  assert.deepEqual(calls.find((command) => command[0] === "clean"),
    ["clean", "-fd", "--"]);
  assert.deepEqual(calls.find((command) => command.includes("-fdx")),
    ["clean", "-fdx", "--", ":(literal)lib/amux/new.ts"]);
  assert.equal(await discardAmuxV52AttemptChanges("/repo", BASE,
    { run: async (_binary, args) => ({ stdout: Buffer.from(
      args.slice(6)[1] === "--show-toplevel" ? "/repo" : "b".repeat(40)) }),
      realpath: async (path) => path }), false);
});

test("a worker checkout moves to its publication base only when clean and the base is present", async () => {
  const base = "b".repeat(40);
  const repo = (state) => {
    const calls = [];
    const run = async (_binary, args, options) => {
      const command = args.slice(6);
      calls.push({ command, timeout: options.timeout });
      if (command[0] === "status") return { stdout: Buffer.from(state.dirty ? " M x\0" : "") };
      if (command[0] === "cat-file") {
        if (state.present) return { stdout: Buffer.alloc(0) };
        throw new Error("missing");
      }
      if (command[0] === "fetch") {
        if (state.fetchable?.includes(command.at(-1))) state.present = true;
        return { stdout: Buffer.alloc(0) };
      }
      if (command[0] === "checkout") { state.head = command.at(-1); return { stdout: Buffer.alloc(0) }; }
      if (command[0] === "rev-parse") return { stdout: Buffer.from(state.moved ?? state.head) };
      throw new Error("unexpected git command");
    };
    return { run, calls };
  };
  const names = (calls) => calls.map((call) => call.command[0]);

  const dirty = repo({ dirty: true, present: true });
  assert.deepEqual(await syncAmuxV22WorktreeBase("/repo", base, { run: dirty.run }),
    { ok: false, reason: "worktree_dirty" });
  assert.deepEqual(names(dirty.calls), ["status"]);

  const local = repo({ present: true });
  assert.deepEqual(await syncAmuxV22WorktreeBase("/repo", base, { run: local.run }),
    { ok: true, baseSha: base });
  assert.equal(names(local.calls).includes("fetch"), false);
  assert.ok(local.calls.some((call) => call.command[0] === "checkout" &&
    call.command.includes("--detach") && call.command.at(-1) === base));

  const fetched = repo({ fetchable: ["refs/heads/develop"] });
  assert.deepEqual(await syncAmuxV22WorktreeBase("/repo", base, { run: fetched.run }),
    { ok: true, baseSha: base });
  const fetch = fetched.calls.find((call) => call.command[0] === "fetch");
  assert.deepEqual(fetch.command, ["fetch", "--no-tags", "--quiet", "origin",
    "refs/heads/develop"]);
  assert.equal(fetch.timeout, 120_000);

  const exact = repo({ fetchable: [base] });
  assert.deepEqual(await syncAmuxV22WorktreeBase("/repo", base, { run: exact.run }),
    { ok: true, baseSha: base });

  const missing = repo({});
  assert.deepEqual(await syncAmuxV22WorktreeBase("/repo", base, { run: missing.run }),
    { ok: false, reason: "base_unavailable" });
  assert.equal(names(missing.calls).includes("checkout"), false);

  const moved = repo({ present: true, moved: "c".repeat(40) });
  assert.deepEqual(await syncAmuxV22WorktreeBase("/repo", base, { run: moved.run }),
    { ok: false, reason: "base_checkout_unverified" });

  for (const [path, sha] of [["repo", base], ["/repo", "B".repeat(40)], ["/repo", undefined]])
    assert.deepEqual(await syncAmuxV22WorktreeBase(path, sha, { run: local.run }),
      { ok: false, reason: "invalid_input" });
});
