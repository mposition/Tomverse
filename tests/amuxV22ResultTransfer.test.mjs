import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createConnection } from "node:net";
import test from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { applyAmuxV22PriorPatch, createAmuxV22SidecarHandler,
  createAmuxV22SidecarServer, parseAmuxV22ContextParts, parseAmuxV22OneShotRequest,
  runAmuxV22OneShot, writeAmuxV22ContextFiles } from "../lib/amux/v22OneShotSidecar.mjs";
import { AMUX_V22_EMPTY_SHA256, AMUX_V22_TRANSFER_CHUNK_BYTES,
  decodeAmuxV22ChangedPaths, encodeAmuxV22ChangedPaths } from "../lib/amux/v22TransferCore.ts";

// The sidecar side of the v22 result transfer in parts
// (docs/policy/amux-v22-result-transfer.md, owner decision 2026-11-18): no size
// bound of ours on a run's report, patch or changed-path list; each part waits
// in a pending file and leaves in fixed-size chunks.

const attemptId = "00000000-0000-4000-8000-000000000001";
const request = { version: 1, attemptId, worker: "worker-a",
  role: "implement", modelId: "claude-opus-5-5",
  budgetMicrousd: 1_250_000, prompt: "Change a small file." };
const sha = (value) => createHash("sha256").update(value).digest("hex");
const BASE = "a".repeat(40);
const MIB = 1024 * 1024;

async function withState(body) {
  const stateDir = await mkdtemp(join(tmpdir(), "amux-v22-transfer-"));
  try { await body(stateDir); } finally { await rm(stateDir, { recursive: true, force: true }); }
}

/** A handler whose run returns `outcome` (the fields the part writing reads). */
const handlerFor = (stateDir, outcome) => createAmuxV22SidecarHandler({
  worker: "worker-a", stateDir,
  run: async (input) => ({ kind: "succeeded", attemptId: input.attemptId, ...outcome }) });

async function finished(handler) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const answer = await handler({ op: "readback_v2", attemptId });
    if (answer.kind !== "in_progress") return answer;
    if (Date.now() > deadline) throw new Error("sidecar result was not recorded");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const execute = (handler) => handler({ op: "execute", ...request });
const pathNames = (count) => Array.from({ length: count }, (_, index) =>
  `lib/generated/module-${index}.ts`);

/** Every chunk of a part, read through `read_pending` and joined. */
async function readParts(handler, part) {
  const chunks = [];
  for (let index = 0; ; index += 1) {
    const answer = await handler({ op: "read_pending", attemptId, part, index });
    if (answer.kind === "refused") break;
    assert.equal(answer.kind, "pending_chunk");
    assert.deepEqual(Object.keys(answer).sort(),
      ["attemptId", "bytesBase64", "index", "kind", "part", "totalBytes"]);
    chunks.push({ answer, bytes: Buffer.from(answer.bytesBase64, "base64") });
  }
  return chunks;
}

test("readback_v2 answers with the terminal's fields and its parts, never a body", async () => {
  await withState(async (stateDir) => {
    const text = "A report";
    const patchBody = "diff --git a/lib/a.ts b/lib/a.ts\n+x\n";
    const handler = handlerFor(stateDir, { resultText: text, resultSha256: sha(text),
      patchBody, patchDigest: sha(patchBody), patchBaseSha: BASE,
      changedPaths: ["lib/a.ts", "lib/b.ts"] });
    assert.equal((await execute(handler)).kind, "in_progress");
    const answer = await finished(handler);
    assert.equal(answer.kind, "succeeded");
    for (const key of ["resultText", "patchBody", "publishFiles", "changedPaths",
      "readRoleChangedPaths"])
      assert.equal(Object.hasOwn(answer, key), false, key);
    const encoded = encodeAmuxV22ChangedPaths(["lib/a.ts", "lib/b.ts"]);
    assert.deepEqual(answer.parts, {
      result: { bytes: Buffer.byteLength(text), sha256: sha(text), pending: true },
      patch: { bytes: Buffer.byteLength(patchBody), sha256: sha(patchBody),
        baseSha: BASE, pending: true },
      changed_paths: { bytes: encoded.length, sha256: sha(encoded), count: 2, pending: true },
    });
    // The terminal names sizes and the list's digest; the list is not in it.
    const terminal = JSON.parse(await readFile(join(stateDir, `${attemptId}.result`), "utf8"));
    assert.equal(terminal.resultBytes, Buffer.byteLength(text));
    assert.equal(terminal.patchBytes, Buffer.byteLength(patchBody));
    assert.equal(terminal.changedPathsSha256, sha(encoded));
    assert.equal(terminal.changedPathsBytes, encoded.length);
    assert.equal(terminal.changedPathsCount, 2);
    assert.equal(Object.hasOwn(terminal, "changedPaths"), false);
    assert.deepEqual((await readdir(stateDir)).filter((name) => name.endsWith(".pending")).sort(),
      [`${attemptId}.changed_paths.pending`, `${attemptId}.patch.pending`,
        `${attemptId}.result.pending`]);
  });
});

test("readback_v2 takes exactly attemptId and op, and names a missing attempt", async () => {
  await withState(async (stateDir) => {
    const handler = handlerFor(stateDir, {});
    await assert.rejects(handler({ op: "readback_v2", attemptId, extra: 1 }));
    await assert.rejects(handler({ op: "readback_v2" }));
    assert.deepEqual(await handler({ op: "readback_v2", attemptId }),
      { kind: "not_found", attemptId });
  });
});

test("a run with no path list and one with an empty list leave no changed_paths part to send", async () => {
  await withState(async (stateDir) => {
    const handler = handlerFor(stateDir, { gradeGuard: true, changedPaths: [] });
    await execute(handler);
    const answer = await finished(handler);
    assert.deepEqual(answer.parts, { changed_paths:
      { bytes: 0, sha256: AMUX_V22_EMPTY_SHA256, count: 0, pending: false } });
    assert.equal(answer.changedPathsSha256, AMUX_V22_EMPTY_SHA256);
    assert.equal(answer.changedPathsBytes, 0);
    assert.equal(answer.changedPathsCount, 0);
    assert.deepEqual(await readdir(stateDir).then((names) =>
      names.filter((name) => name.endsWith(".pending"))), []);
    assert.equal((await handler({ op: "confirm_changed_paths", attemptId,
      sha256: AMUX_V22_EMPTY_SHA256 })).kind, "confirmed");
  });
  await withState(async (stateDir) => {
    // Not a grade-guard run: no list is named at all.
    const handler = handlerFor(stateDir, {});
    await execute(handler);
    assert.deepEqual((await finished(handler)).parts, {});
  });
  await withState(async (stateDir) => {
    // An unavailable list keeps its reason and names no digest.
    const handler = handlerFor(stateDir, { gradeGuard: true,
      changedPathsReason: "changed_paths_unavailable" });
    await execute(handler);
    const answer = await finished(handler);
    assert.equal(answer.changedPathsReason, "changed_paths_unavailable");
    assert.equal(Object.hasOwn(answer, "changedPathsSha256"), false);
    assert.deepEqual(answer.parts, {});
  });
});

test("a list that cannot be encoded is reported unavailable, never as an empty list", async () => {
  await withState(async (stateDir) => {
    const handler = handlerFor(stateDir, { gradeGuard: true,
      changedPaths: ["lib/a.ts", "lib/a.ts"] });
    await execute(handler);
    const answer = await finished(handler);
    assert.equal(answer.changedPathsReason, "changed_paths_unavailable");
    assert.equal(Object.hasOwn(answer, "changedPathsSha256"), false);
  });
});

test("a patch past 4 MiB travels in two or more chunks that join to the exact bytes", async () => {
  await withState(async (stateDir) => {
    const patchBody = `diff --git a/lib/big.ts b/lib/big.ts\n+${"x".repeat(9 * MIB + 17)}\n`;
    const handler = handlerFor(stateDir, { patchBody, patchDigest: sha(patchBody),
      patchBaseSha: BASE });
    await execute(handler);
    const answer = await finished(handler);
    const total = Buffer.byteLength(patchBody);
    assert.equal(answer.parts.patch.bytes, total);
    const chunks = await readParts(handler, "patch");
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map(({ bytes }) => bytes.length),
      [AMUX_V22_TRANSFER_CHUNK_BYTES, AMUX_V22_TRANSFER_CHUNK_BYTES,
        total - 2 * AMUX_V22_TRANSFER_CHUNK_BYTES]);
    for (const [index, { answer: chunk }] of chunks.entries()) {
      assert.equal(chunk.index, index);
      assert.equal(chunk.totalBytes, total);
      assert.equal(chunk.part, "patch");
    }
    const joined = Buffer.concat(chunks.map(({ bytes }) => bytes));
    assert.equal(sha(joined), sha(patchBody));
    assert.equal(joined.toString("utf8"), patchBody);
  });
});

test("a part of exactly one chunk and a 5 MiB patch have the chunk counts the core names", async () => {
  await withState(async (stateDir) => {
    const exact = "y".repeat(AMUX_V22_TRANSFER_CHUNK_BYTES);
    const handler = handlerFor(stateDir, { resultText: exact, resultSha256: sha(exact),
      patchBody: `d\n${"z".repeat(5 * MIB)}`, patchDigest: sha(`d\n${"z".repeat(5 * MIB)}`),
      patchBaseSha: BASE });
    await execute(handler);
    await finished(handler);
    assert.equal((await readParts(handler, "result")).length, 1);
    const patch = await readParts(handler, "patch");
    assert.equal(patch.length, 2);
    assert.equal(patch[1].bytes.length, 5 * MIB + 2 - AMUX_V22_TRANSFER_CHUNK_BYTES);
  });
});

test("read_pending refuses a bad part, index or key set, and says when a part is gone", async () => {
  await withState(async (stateDir) => {
    const handler = handlerFor(stateDir, { resultText: "ok", resultSha256: sha("ok") });
    await execute(handler);
    await finished(handler);
    const refused = { kind: "refused" };
    for (const bad of [
      { part: "patch", index: -1 }, { part: "result", index: -1 },
      { part: "result", index: 1 }, { part: "result", index: 1.5 },
      { part: "result", index: "0" }, { part: "result", index: null },
      { part: "other", index: 0 }, { part: "../result", index: 0 },
      { part: "result.pending", index: 0 }, { part: undefined, index: 0 },
    ]) assert.deepEqual(await handler({ op: "read_pending", attemptId, ...bad }),
      refused, JSON.stringify(bad));
    assert.deepEqual(await handler({ op: "read_pending", attemptId, part: "result" }), refused);
    assert.deepEqual(await handler({ op: "read_pending", attemptId, part: "result",
      index: 0, extra: true }), refused);
    // A part the run never had, and one already confirmed away.
    assert.deepEqual(await handler({ op: "read_pending", attemptId, part: "patch", index: 0 }),
      { kind: "not_found", attemptId });
    assert.equal((await handler({ op: "confirm_result", attemptId,
      sourceSha256: sha("ok") })).kind, "confirmed");
    assert.deepEqual(await handler({ op: "read_pending", attemptId, part: "result", index: 0 }),
      { kind: "not_found", attemptId });
    await assert.rejects(handler({ op: "read_pending", attemptId: "not-an-id",
      part: "result", index: 0 }));
  });
});

test("a list of thousands of paths is one part that decodes to the same list", async () => {
  await withState(async (stateDir) => {
    const paths = pathNames(5_000);
    const handler = handlerFor(stateDir, { gradeGuard: true, changedPaths: paths });
    await execute(handler);
    const answer = await finished(handler);
    const encoded = encodeAmuxV22ChangedPaths(paths);
    assert.deepEqual(answer.parts.changed_paths,
      { bytes: encoded.length, sha256: sha(encoded), count: 5_000, pending: true });
    const chunks = await readParts(handler, "changed_paths");
    const joined = Buffer.concat(chunks.map(({ bytes }) => bytes));
    assert.equal(sha(joined), answer.parts.changed_paths.sha256);
    assert.deepEqual(decodeAmuxV22ChangedPaths(joined, 5_000), paths);
  });
});

test("confirm_changed_paths drops the pending list only for the terminal's digest", async () => {
  await withState(async (stateDir) => {
    const paths = pathNames(3);
    const handler = handlerFor(stateDir, { gradeGuard: true, changedPaths: paths });
    await execute(handler);
    const answer = await finished(handler);
    const digest = answer.parts.changed_paths.sha256;
    await assert.rejects(handler({ op: "confirm_changed_paths", attemptId }));
    await assert.rejects(handler({ op: "confirm_changed_paths", attemptId,
      sha256: "nope" }));
    await assert.rejects(handler({ op: "confirm_changed_paths", attemptId,
      sha256: digest, extra: 1 }));
    assert.deepEqual(await handler({ op: "confirm_changed_paths", attemptId,
      sha256: "f".repeat(64) }), { kind: "outcome_unknown", attemptId });
    assert.equal((await stat(join(stateDir, `${attemptId}.changed_paths.pending`))).isFile(), true);
    assert.deepEqual(await handler({ op: "confirm_changed_paths", attemptId,
      sha256: digest }), { kind: "confirmed", attemptId });
    await assert.rejects(stat(join(stateDir, `${attemptId}.changed_paths.pending`)));
    // The terminal still names the part; only its pending bytes are gone.
    const after = await handler({ op: "readback_v2", attemptId });
    assert.equal(after.parts.changed_paths.sha256, digest);
    assert.equal(after.parts.changed_paths.pending, false);
    // A repeated confirmation is the same answer.
    assert.equal((await handler({ op: "confirm_changed_paths", attemptId,
      sha256: digest })).kind, "confirmed");
  });
});

test("confirm_result and confirm_patch compare the terminal's digest and read no body", async () => {
  await withState(async (stateDir) => {
    const text = "report";
    const patchBody = "diff --git a/a b/a\n+1\n";
    const handler = handlerFor(stateDir, { resultText: text, resultSha256: sha(text),
      patchBody, patchDigest: sha(patchBody), patchBaseSha: BASE });
    await execute(handler);
    await finished(handler);
    // A pending file that no longer holds the bytes does not change the answer:
    // the confirmation is the terminal's digest against the app's.
    await writeFile(join(stateDir, `${attemptId}.result.pending`), "damaged");
    await writeFile(join(stateDir, `${attemptId}.patch.pending`), "damaged");
    assert.deepEqual(await handler({ op: "confirm_result", attemptId,
      sourceSha256: "f".repeat(64) }), { kind: "outcome_unknown", attemptId });
    assert.equal((await handler({ op: "confirm_result", attemptId,
      sourceSha256: sha(text) })).kind, "confirmed");
    assert.equal((await handler({ op: "confirm_patch", attemptId,
      patchDigest: sha(patchBody) })).kind, "confirmed");
    assert.deepEqual((await readdir(stateDir)).filter((name) => name.endsWith(".pending")), []);
  });
});

test("the terminal stays small for a run of 100,000 changed paths", async () => {
  await withState(async (stateDir) => {
    const paths = pathNames(100_000);
    const readRole = pathNames(100_000).map((path) => `read/${path}`);
    const handler = handlerFor(stateDir, { gradeGuard: true, changedPaths: paths,
      readRoleChangedPaths: readRole,
      preserved: { changed: true, ref: "refs/amux-v22-preserved/x", commit: BASE,
        changedPaths: paths },
      readRolePreserved: { changed: true, ref: "refs/amux-v22-preserved/y", commit: BASE,
        changedPaths: readRole } });
    await execute(handler);
    const answer = await finished(handler);
    const text = await readFile(join(stateDir, `${attemptId}.result`), "utf8");
    // The recovery inspection reads the terminal up to 128 KiB.
    assert.ok(Buffer.byteLength(text) < 16 * 1024, `terminal is ${text.length} bytes`);
    const terminal = JSON.parse(text);
    assert.equal(terminal.changedPathsCount, 100_000);
    assert.equal(terminal.readRoleChangedPathCount, 100_000);
    for (const key of ["changedPaths", "readRoleChangedPaths"])
      assert.equal(Object.hasOwn(terminal, key), false, key);
    assert.equal(Object.hasOwn(terminal.preserved, "changedPaths"), false);
    assert.equal(Object.hasOwn(terminal.readRolePreserved, "changedPaths"), false);
    assert.equal(answer.parts.changed_paths.count, 100_000);
    assert.equal(answer.readRoleChangedPathCount, 100_000);
    const encoded = encodeAmuxV22ChangedPaths(paths);
    assert.equal(answer.parts.changed_paths.bytes, encoded.length);
    // The list itself is a pending part, in chunks.
    const chunks = await readParts(handler, "changed_paths");
    assert.equal(chunks.length, Math.ceil(encoded.length / AMUX_V22_TRANSFER_CHUNK_BYTES));
    assert.equal(sha(Buffer.concat(chunks.map(({ bytes }) => bytes))), sha(encoded));
  });
});

test("a result and patch of any size are written whole, with no check of ours on their size", async () => {
  await withState(async (stateDir) => {
    // 33 MiB report (the old 32 MiB bound) and a patch past the old 4 MiB one.
    const text = "r".repeat(33 * MIB);
    const patchBody = `diff --git a/a b/a\n+${"p".repeat(6 * MIB)}\n`;
    const handler = handlerFor(stateDir, { resultText: text, resultSha256: sha(text),
      patchBody, patchDigest: sha(patchBody), patchBaseSha: BASE });
    await execute(handler);
    const answer = await finished(handler);
    assert.equal(answer.parts.result.bytes, 33 * MIB);
    assert.equal(answer.parts.result.pending, true);
    assert.equal(answer.parts.patch.bytes, Buffer.byteLength(patchBody));
    assert.equal(answer.parts.patch.pending, true);
    assert.equal((await stat(join(stateDir, `${attemptId}.result.pending`))).size, 33 * MIB);
  });
});

test("the old readback carries a part inline only within its old bound, and its digest otherwise", async () => {
  await withState(async (stateDir) => {
    const text = "r".repeat(32 * MIB + 1);
    const patchBody = `diff --git a/a b/a\n+${"p".repeat(4 * MIB)}\n`;
    const handler = handlerFor(stateDir, { resultText: text, resultSha256: sha(text),
      patchBody, patchDigest: sha(patchBody), patchBaseSha: BASE });
    await execute(handler);
    await finished(handler);
    const big = await handler({ op: "readback", attemptId });
    assert.equal(big.kind, "succeeded");
    assert.equal(Object.hasOwn(big, "resultText"), false);
    assert.equal(Object.hasOwn(big, "patchBody"), false);
    assert.equal(big.resultSha256, sha(text));
    assert.equal(big.patchDigest, sha(patchBody));
    assert.equal(big.patchBaseSha, BASE);
  });
  await withState(async (stateDir) => {
    const text = "r".repeat(32 * MIB);
    const patchBody = `diff --git a/a b/a\n+${"p".repeat(4 * MIB - 40)}\n`;
    assert.ok(Buffer.byteLength(patchBody) <= 4 * MIB);
    const handler = handlerFor(stateDir, { resultText: text, resultSha256: sha(text),
      patchBody, patchDigest: sha(patchBody), patchBaseSha: BASE });
    await execute(handler);
    await finished(handler);
    const edge = await handler({ op: "readback", attemptId });
    assert.equal(edge.resultText, text);
    assert.equal(edge.patchBody, patchBody);
  });
});

test("the old readback rebuilds the changed-path array within 4 MiB of JSON, and names a larger list unavailable", async () => {
  await withState(async (stateDir) => {
    const paths = pathNames(2_000);
    const handler = handlerFor(stateDir, { gradeGuard: true, changedPaths: paths });
    await execute(handler);
    await finished(handler);
    const answer = await handler({ op: "readback", attemptId });
    assert.deepEqual(answer.changedPaths, paths);
    assert.equal(Object.hasOwn(answer, "changedPathsReason"), false);
  });
  await withState(async (stateDir) => {
    const handler = handlerFor(stateDir, { gradeGuard: true, changedPaths: [] });
    await execute(handler);
    await finished(handler);
    assert.deepEqual((await handler({ op: "readback", attemptId })).changedPaths, []);
  });
  await withState(async (stateDir) => {
    const paths = Array.from({ length: 30_000 }, (_, index) =>
      `p/${index.toString(36).padStart(5, "0")}${"x".repeat(150)}`);
    assert.ok(Buffer.byteLength(JSON.stringify(paths)) > 4 * MIB);
    const handler = handlerFor(stateDir, { gradeGuard: true, changedPaths: paths });
    await execute(handler);
    const v2 = await finished(handler);
    assert.equal(v2.parts.changed_paths.count, 30_000);
    const answer = await handler({ op: "readback", attemptId });
    assert.equal(Object.hasOwn(answer, "changedPaths"), false);
    assert.equal(answer.changedPathsReason, "changed_paths_unavailable");
    assert.equal(answer.changedPathsCount, 30_000);
  });
});

test("a terminal an older sidecar wrote is read by stat, and its inline list becomes a pending part once", async () => {
  await withState(async (stateDir) => {
    const text = "Older report";
    const patchBody = "diff --git a/a b/a\n+1\n";
    const paths = ["lib/a.ts", "lib/b.ts", "lib/c.ts"];
    const terminalPath = join(stateDir, `${attemptId}.result`);
    const terminalText = JSON.stringify({ kind: "succeeded", attemptId, cliStarted: true,
      resultSha256: sha(text), patchBaseSha: BASE, patchDigest: sha(patchBody),
      gradeGuard: true, changedPaths: paths, readRoleChangedPaths: ["x/y.ts"],
      preserved: { changed: true, ref: "refs/amux-v22-preserved/z", commit: BASE,
        changedPaths: paths } });
    await writeFile(terminalPath, terminalText);
    await writeFile(join(stateDir, `${attemptId}.claimed`), `${"0".repeat(64)}\n`);
    await writeFile(join(stateDir, `${attemptId}.result.pending`), text);
    await writeFile(join(stateDir, `${attemptId}.patch.pending`), patchBody);
    const handler = handlerFor(stateDir, {});
    const answer = await handler({ op: "readback_v2", attemptId });
    const encoded = encodeAmuxV22ChangedPaths(paths);
    assert.deepEqual(answer.parts, {
      result: { bytes: Buffer.byteLength(text), sha256: sha(text), pending: true },
      patch: { bytes: Buffer.byteLength(patchBody), sha256: sha(patchBody),
        baseSha: BASE, pending: true },
      changed_paths: { bytes: encoded.length, sha256: sha(encoded), count: 3, pending: true },
    });
    for (const key of ["changedPaths", "readRoleChangedPaths"])
      assert.equal(Object.hasOwn(answer, key), false, key);
    assert.equal(answer.readRoleChangedPathCount, 1);
    assert.equal(Object.hasOwn(answer.preserved, "changedPaths"), false);
    // The terminal is not touched; the list became a pending file, once.
    assert.equal(await readFile(terminalPath, "utf8"), terminalText);
    assert.deepEqual(await readFile(join(stateDir, `${attemptId}.changed_paths.pending`)), encoded);
    assert.deepEqual(decodeAmuxV22ChangedPaths(Buffer.concat(
      (await readParts(handler, "changed_paths")).map(({ bytes }) => bytes)), 3), paths);
    // Confirming it compares the digest the list had.
    assert.equal((await handler({ op: "confirm_changed_paths", attemptId,
      sha256: sha(encoded) })).kind, "confirmed");
    // The old readback still serves such a terminal as it did.
    const old = await handler({ op: "readback", attemptId });
    assert.deepEqual(old.changedPaths, paths);
    assert.equal(old.resultText, text);
    assert.equal(old.patchBody, patchBody);
  });
});

test("an older terminal with a part whose pending file is gone reports it as not pending", async () => {
  await withState(async (stateDir) => {
    await writeFile(join(stateDir, `${attemptId}.result`), JSON.stringify({
      kind: "succeeded", attemptId, resultSha256: sha("old"),
      patchBaseSha: BASE, patchDigest: sha("patch") }));
    const answer = await createAmuxV22SidecarHandler({ worker: "worker-a", stateDir,
      run: async () => ({}) })({ op: "readback_v2", attemptId });
    assert.deepEqual(answer.parts, {
      result: { bytes: 0, sha256: sha("old"), pending: false },
      patch: { bytes: 0, sha256: sha("patch"), baseSha: BASE, pending: false },
    });
  });
});

test("execute for a finished attempt and stop answer with the terminal, without bodies", async () => {
  await withState(async (stateDir) => {
    const text = "report";
    const handler = handlerFor(stateDir, { resultText: text, resultSha256: sha(text),
      gradeGuard: true, changedPaths: ["lib/a.ts"] });
    await execute(handler);
    await finished(handler);
    for (const answer of [await execute(handler), await handler({ op: "stop", attemptId })]) {
      assert.equal(answer.kind, "succeeded");
      assert.equal(answer.resultSha256, sha(text));
      for (const key of ["resultText", "patchBody", "changedPaths", "parts"])
        assert.equal(Object.hasOwn(answer, key), false, key);
    }
  });
});

test("an unreadable terminal is an unknown outcome on every read", async () => {
  await withState(async (stateDir) => {
    await writeFile(join(stateDir, `${attemptId}.result`), "{not json");
    const handler = handlerFor(stateDir, {});
    for (const op of ["readback", "readback_v2"])
      assert.deepEqual(await handler({ op, attemptId }), { kind: "outcome_unknown", attemptId }, op);
    assert.deepEqual(await handler({ op: "confirm_result", attemptId,
      sourceSha256: "f".repeat(64) }), { kind: "outcome_unknown", attemptId });
  });
});

/** A fake CLI that prints `output` and exits 0. */
function fakeSpawn(output) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    queueMicrotask(() => {
      child.emit("spawn");
      child.stdout.once("end", () => { child.exitCode = 0; child.emit("close", 0, null); });
      child.stdout.end(output);
    });
    return child;
  };
}
const config = { worker: "worker-a", binaryPath: "/usr/bin/claude",
  worktreePath: "/srv/tomverse/worktrees/worker-a", homePath: "/home/tommy",
  claudeConfigDir: "/home/tommy/.amux-cli-profiles/claude" };
const resultEvent = (text) => `${JSON.stringify({ type: "result", subtype: "success",
  is_error: false, result: text, num_turns: 3, modelUsage: { "claude-opus-5-5": {
    inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2,
    cacheCreationInputTokens: 1 } } })}\n`;

test("the local CLI flow keeps a report past the old 32 MiB whole, and refuses only an empty one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "amux-v22-transfer-flow-"));
  try {
    const answer = `${"head ".repeat(10)}${"m".repeat(33 * MIB)}\nconclusion at the end`;
    const result = await runAmuxV22OneShot({ ...request, role: "investigate" }, config, {
      syntheticPlatform: true, spawnChild: fakeSpawn(resultEvent(answer)),
      transcriptPath: join(dir, `${attemptId}.transcript.jsonl`),
      captureBaseline: async () => ({ ok: true, baseSha: BASE }),
      ensureDependencies: async () => ({ ok: true }),
      createShellJail: async () => ({ binPath: "/j/bin", prefixPath: "/j/prefix",
        cleanup: async () => {} }) });
    assert.equal(result.kind, "succeeded");
    assert.equal(result.resultText, answer);
    assert.equal(result.resultText.includes("omitted"), false);
    assert.equal(result.resultSha256, sha(answer));
    const empty = await runAmuxV22OneShot({ ...request, role: "investigate" }, config, {
      syntheticPlatform: true, spawnChild: fakeSpawn(resultEvent("")),
      transcriptPath: join(dir, `${attemptId}.empty.jsonl`),
      captureBaseline: async () => ({ ok: true, baseSha: BASE }),
      ensureDependencies: async () => ({ ok: true }),
      createShellJail: async () => ({ binPath: "/j/bin", prefixPath: "/j/prefix",
        cleanup: async () => {} }) });
    assert.equal(empty.resultText, null);
    assert.equal(empty.resultSha256, null);
    const nul = await runAmuxV22OneShot({ ...request, role: "investigate" }, config, {
      syntheticPlatform: true, spawnChild: fakeSpawn(resultEvent("a\u0000b")),
      transcriptPath: join(dir, `${attemptId}.nul.jsonl`),
      captureBaseline: async () => ({ ok: true, baseSha: BASE }),
      ensureDependencies: async () => ({ ok: true }),
      createShellJail: async () => ({ binPath: "/j/bin", prefixPath: "/j/prefix",
        cleanup: async () => {} }) });
    assert.equal(nul.resultText, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Ubuntu socket serves readback_v2 and read_pending, and refuses a bad chunk request",
  { skip: process.platform !== "linux" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "amux-v22-transfer-socket-"));
    const socketPath = join(root, "sidecar.sock");
    const patchBody = `diff --git a/a b/a\n+${"p".repeat(5 * MIB)}\n`;
    const handler = handlerFor(root, { patchBody, patchDigest: sha(patchBody),
      patchBaseSha: BASE });
    const server = createAmuxV22SidecarServer(socketPath, handler);
    const send = (message) => new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const parts = [];
      socket.on("data", (part) => parts.push(part));
      socket.on("error", reject);
      socket.on("end", () => resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))));
      socket.end(`${JSON.stringify(message)}\n`);
    });
    try {
      await server.listen();
      await execute(handler);
      let answer;
      for (let i = 0; i < 500; i += 1) {
        answer = await send({ op: "readback_v2", attemptId });
        if (answer.kind !== "in_progress") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(answer.kind, "succeeded");
      assert.equal(answer.parts.patch.bytes, Buffer.byteLength(patchBody));
      const chunk = await send({ op: "read_pending", attemptId, part: "patch", index: 1 });
      assert.equal(chunk.kind, "pending_chunk");
      assert.equal(Buffer.from(chunk.bytesBase64, "base64").length,
        Buffer.byteLength(patchBody) - AMUX_V22_TRANSFER_CHUNK_BYTES);
      assert.deepEqual(await send({ op: "read_pending", attemptId, part: "patch", index: 2 }),
        { kind: "refused" });
      assert.deepEqual(await send({ op: "readback_v2", attemptId, extra: 1 }),
        { kind: "refused" });
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  });

// The way down (docs/policy/amux-v22-result-transfer.md 10.1): `put_context`
// stages a context file in chunks, and an execute's `contextParts` names it.

const CHUNK = AMUX_V22_TRANSFER_CHUNK_BYTES;
const PRIOR = "prior.patch";
const CONCLUSIONS = "prior-conclusions.md";
const hostRun = (binary, args, options) => promisify(execFile)(binary,
  ["-c", "core.autocrlf=false", ...args], { ...options, env: process.env });
const partName = (name, id = attemptId) => `${id}.ctx-${name}.part`;
const stagedNames = async (stateDir) =>
  (await readdir(stateDir)).filter((name) => name.includes(".ctx-"));

/** Every chunk of `bytes` as a put_context request; `change` edits each one. */
async function stage(handler, name, bytes, change = {}) {
  const answers = [];
  for (let index = 0; index * CHUNK < bytes.length; index += 1) {
    const slice = bytes.subarray(index * CHUNK, Math.min(bytes.length, (index + 1) * CHUNK));
    answers.push(await handler({ op: "put_context", attemptId, name, index,
      totalBytes: bytes.length, sha256: sha(bytes), bytesBase64: slice.toString("base64"),
      ...change }));
  }
  return answers;
}
const partOf = (bytes, name) => ({ name, bytes: bytes.length, sha256: sha(bytes) });

test("put_context stages a file of several chunks, again and again, in a file no readback reads", async () => {
  await withState(async (stateDir) => {
    const handler = handlerFor(stateDir, {});
    const bytes = Buffer.from(`diff --git a/한글.txt b/한글.txt\n+${"p".repeat(5 * MIB)}\n`);
    assert.ok(bytes.length > CHUNK && bytes.length < 2 * CHUNK);
    const first = await stage(handler, PRIOR, bytes);
    assert.deepEqual(first, [0, 1].map((index) => ({ kind: "context_stored", attemptId,
      name: PRIOR, index })));
    // A chunk sent again, in any order, leaves the same file.
    await stage(handler, PRIOR, bytes);
    await handler({ op: "put_context", attemptId, name: PRIOR, index: 1,
      totalBytes: bytes.length, sha256: sha(bytes),
      bytesBase64: bytes.subarray(CHUNK).toString("base64") });
    const staged = await readFile(join(stateDir, partName(PRIOR)));
    assert.equal(staged.equals(bytes), true);
    if (process.platform !== "win32")
      assert.equal((await stat(join(stateDir, partName(PRIOR)))).mode & 0o777, 0o600);
    // A second file stages independently of the first.
    await stage(handler, CONCLUSIONS, Buffer.from("conclusions"));
    assert.deepEqual((await readdir(stateDir)).sort(), [
      partName(CONCLUSIONS), `${partName(CONCLUSIONS)}.meta`,
      partName(PRIOR), `${partName(PRIOR)}.meta`].sort());
    // Neither the pending check nor a result readback can see a staged file.
    for (const name of await readdir(stateDir))
      assert.equal(name.endsWith(".pending") || name.endsWith(".result"), false, name);
    assert.deepEqual(await handler({ op: "readback_v2", attemptId }),
      { kind: "not_found", attemptId });
    assert.deepEqual(await handler({ op: "readback", attemptId }),
      { kind: "not_found", attemptId });
    await assert.rejects(() => handler({ op: "put_context", attemptId: "nope" }));
  });
});

test("put_context refuses a name, key, range or chunk that is not exactly what the contract names", async () => {
  await withState(async (stateDir) => {
    const handler = handlerFor(stateDir, {});
    const bytes = Buffer.from("one small file");
    const good = { op: "put_context", attemptId, name: PRIOR, index: 0,
      totalBytes: bytes.length, sha256: sha(bytes), bytesBase64: bytes.toString("base64") };
    const refused = { kind: "refused" };
    const withoutSha = { ...good }; delete withoutSha.sha256;
    for (const [label, message] of [
      ["a name outside the allowed two", { ...good, name: "brief.md" }],
      ["a path as the name", { ...good, name: "../prior.patch" }],
      ["an extra key", { ...good, extra: 1 }],
      ["a missing key", withoutSha],
      ["a bad sha256", { ...good, sha256: "A".repeat(64) }],
      ["an empty file", { ...good, totalBytes: 0, bytesBase64: "" }],
      ["a fractional size", { ...good, totalBytes: 1.5 }],
      ["an index past the last chunk", { ...good, index: 1 }],
      ["a negative index", { ...good, index: -1 }],
      ["a chunk shorter than its range", { ...good, totalBytes: bytes.length + 1 }],
      ["a chunk longer than its range", { ...good, totalBytes: bytes.length - 1 }],
      ["base64 with a line break", { ...good,
        bytesBase64: `${good.bytesBase64.slice(0, 4)}\n${good.bytesBase64.slice(4)}` }],
      ["base64 without its padding", { ...good, bytesBase64: good.bytesBase64.replace(/=+$/, "") }],
      ["base64 that is not base64", { ...good, bytesBase64: "####" }],
      ["a chunk that is not a string", { ...good, bytesBase64: [1] }],
    ]) assert.deepEqual(await handler(message), refused, label);
    assert.deepEqual(await readdir(stateDir), [], "a refused chunk stages nothing");
    assert.equal((await handler(good)).kind, "context_stored");
  });
});

test("put_context refuses once the attempt has started, is running, or has ended", async () => {
  await withState(async (stateDir) => {
    const bytes = Buffer.from("context");
    const message = { op: "put_context", attemptId, name: PRIOR, index: 0,
      totalBytes: bytes.length, sha256: sha(bytes), bytesBase64: bytes.toString("base64") };
    // A run in progress.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const running = createAmuxV22SidecarHandler({ worker: "worker-a", stateDir,
      run: async (input) => { await gate; return { kind: "failed", attemptId: input.attemptId,
        failure: "stopped" }; } });
    assert.equal((await running({ op: "execute", ...request })).kind, "in_progress");
    assert.deepEqual(await running(message), { kind: "refused" });
    release();
    await finished(running);
    // The attempt has a terminal now.
    assert.deepEqual(await running(message), { kind: "refused" });
    // A claim alone (a crash before the terminal) also ends staging.
    const other = "00000000-0000-4000-8000-000000000002";
    await writeFile(join(stateDir, `${other}.claimed`), `${"0".repeat(64)}\n`);
    assert.deepEqual(await running({ ...message, attemptId: other }), { kind: "refused" });
    assert.deepEqual(await stagedNames(stateDir), []);
  });
});

test("put_context for other content than the staged chunks starts that file over", async () => {
  await withState(async (stateDir) => {
    const handler = handlerFor(stateDir, {});
    const older = Buffer.alloc(CHUNK + 100, "a");
    const newer = Buffer.alloc(CHUNK + 100, "b");
    await stage(handler, PRIOR, older);
    // Same size, other digest: the first chunk of the new content replaces the old file.
    assert.equal((await handler({ op: "put_context", attemptId, name: PRIOR, index: 0,
      totalBytes: newer.length, sha256: sha(newer),
      bytesBase64: newer.subarray(0, CHUNK).toString("base64") })).kind, "context_stored");
    assert.equal((await stat(join(stateDir, partName(PRIOR)))).size, CHUNK,
      "the older chunks are gone, not mixed in");
    assert.equal((await handler({ op: "put_context", attemptId, name: PRIOR, index: 1,
      totalBytes: newer.length, sha256: sha(newer),
      bytesBase64: newer.subarray(CHUNK).toString("base64") })).kind, "context_stored");
    assert.equal((await readFile(join(stateDir, partName(PRIOR)))).equals(newer), true);
    // Another size: starts over as well, and the file is what it names.
    const shorter = Buffer.from("short");
    await stage(handler, PRIOR, shorter);
    assert.equal((await readFile(join(stateDir, partName(PRIOR)))).equals(shorter), true);
  });
});

test("chunks sent at once for one file are written one after another", async () => {
  await withState(async (stateDir) => {
    const handler = handlerFor(stateDir, {});
    const bytes = Buffer.concat([Buffer.alloc(CHUNK, "x"), Buffer.alloc(CHUNK, "y"),
      Buffer.alloc(77, "z")]);
    const send = (index) => handler({ op: "put_context", attemptId, name: CONCLUSIONS, index,
      totalBytes: bytes.length, sha256: sha(bytes),
      bytesBase64: bytes.subarray(index * CHUNK, (index + 1) * CHUNK).toString("base64") });
    const answers = await Promise.all([2, 0, 1, 0].map(send));
    assert.deepEqual(answers.map((answer) => answer.kind), Array(4).fill("context_stored"));
    assert.equal((await readFile(join(stateDir, partName(CONCLUSIONS)))).equals(bytes), true);
  });
});

test("execute takes contextParts and nothing else of the kind", () => {
  const good = [{ name: PRIOR, bytes: 5, sha256: "a".repeat(64) },
    { name: CONCLUSIONS, bytes: 1, sha256: "b".repeat(64) }];
  assert.deepEqual(parseAmuxV22OneShotRequest({ ...request, contextParts: good },
    "worker-a").contextParts, good);
  assert.doesNotThrow(() => parseAmuxV22OneShotRequest(request, "worker-a"));
  for (const bad of [[], {}, "x", [good[0], good[0]],
    [{ ...good[0], name: "brief.md" }], [{ ...good[0], extra: 1 }],
    [{ name: PRIOR, bytes: 5 }], [{ ...good[0], bytes: 0 }], [{ ...good[0], bytes: 1.5 }],
    [{ ...good[0], sha256: "A".repeat(64) }], [null], [[]], [...good, good[0]]])
    assert.throws(() => parseAmuxV22ContextParts(bad), TypeError, JSON.stringify(bad));
  assert.throws(() => parseAmuxV22OneShotRequest({ ...request, contextParts: [] },
    "worker-a"), TypeError);
});

/** A checkout (a temp git repo) with one committed file and the change that edits it. */
async function checkout() {
  const repo = await mkdtemp(join(tmpdir(), "amux-v22-context-repo-"));
  const git = (...args) => execFileSync("git", ["-c", "user.email=t@example.invalid",
    "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd: repo }).toString();
  git("init", "-q");
  await writeFile(join(repo, "a.txt"), "one\ntwo\n");
  git("add", "a.txt"); git("commit", "-q", "-m", "base");
  await writeFile(join(repo, "a.txt"), "one\nTWO\n");
  const patch = Buffer.from(git("diff"));
  git("checkout", "-q", "--", "a.txt");
  return { repo, git, patch };
}

/** A handler that runs the real flow against `repo`: the real context writer and prior-patch apply. */
const flowHandler = (stateDir, repo, extra = {}) => createAmuxV22SidecarHandler({
  worker: "worker-a", stateDir,
  run: (input, options) => runAmuxV22OneShot(input, config, { ...options,
    syntheticPlatform: true, spawnChild: fakeSpawn(resultEvent("done")),
    writeContextFiles: (_worktree, files, writer) =>
      writeAmuxV22ContextFiles(repo, files, { ...writer, run: hostRun }),
    applyPriorPatch: () => applyAmuxV22PriorPatch(repo, { run: hostRun }), ...extra }) });

test("a staged prior.patch reaches the checkout byte for byte and applies, as an inline one does", async () => {
  const { repo, git, patch } = await checkout();
  await withState(async (stateDir) => {
    try {
      const handler = flowHandler(stateDir, repo);
      const conclusions = Buffer.from("## 앞선 결론\n- done\n");
      await stage(handler, PRIOR, patch);
      await stage(handler, CONCLUSIONS, conclusions);
      const answer = await handler({ op: "execute", ...request,
        contextParts: [partOf(patch, PRIOR), partOf(conclusions, CONCLUSIONS)] });
      assert.equal(answer.kind, "in_progress");
      const done = await finished(handler);
      assert.equal(done.kind, "succeeded");
      assert.equal((await readFile(join(repo, ".amux", "context", PRIOR))).equals(patch), true);
      assert.equal((await readFile(join(repo, ".amux", "context", CONCLUSIONS)))
        .equals(conclusions), true);
      // The previous change was applied three-way to the checkout.
      assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "one\nTWO\n");
      assert.equal(git("status", "--porcelain", "--untracked-files=all").trim(), "M a.txt",
        "the context directory stays out of git's view");
      // The staged files are gone: moved ones, and the records beside them.
      assert.deepEqual(await stagedNames(stateDir), []);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});

test("a staged file of several chunks is placed whole, and a read role gets it without applying it", async () => {
  const repo = await mkdtemp(join(tmpdir(), "amux-v22-context-big-"));
  await withState(async (stateDir) => {
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      const handler = flowHandler(stateDir, repo, {
        applyPriorPatch: async () => { throw new Error("a read role applies nothing"); } });
      const big = Buffer.from(`${"가나다 ".repeat(2 * MIB)}\nend\n`);
      assert.ok(big.length > 2 * CHUNK);
      await stage(handler, PRIOR, big);
      assert.equal((await handler({ op: "execute", ...request, role: "investigate",
        contextParts: [partOf(big, PRIOR)] })).kind, "in_progress");
      assert.equal((await finished(handler)).kind, "succeeded");
      assert.equal((await readFile(join(repo, ".amux", "context", PRIOR))).equals(big), true);
      assert.deepEqual(await stagedNames(stateDir), []);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});

test("a staged file that is not what the execute named stops the run before the CLI starts", async () => {
  const { repo, patch } = await checkout();
  await withState(async (stateDir) => {
    try {
      const calls = [];
      const spawnChild = () => { calls.push("spawn"); return fakeSpawn(resultEvent("done"))(); };
      const named = partOf(patch, PRIOR);
      const attempt = (id, parts, options = {}) => runAmuxV22OneShot(
        { ...request, attemptId: id, contextParts: parts }, config, { syntheticPlatform: true,
          spawnChild,
          writeContextFiles: (_worktree, files, writer) =>
            writeAmuxV22ContextFiles(repo, files, { ...writer, run: hostRun }),
          applyPriorPatch: async () => ({ applied: true }),
          contextPartPath: (name) => join(stateDir, `${id}.ctx-${name}.part`), ...options });
      const failed = (result) => [result.kind, result.cliStarted, result.failure];
      const expected = ["failed", false, "context_parts_invalid"];
      const stagedFile = (id, bytes) => writeFile(join(stateDir, `${id}.ctx-${PRIOR}.part`), bytes);
      const id = (n) => `00000000-0000-4000-8000-00000000010${n}`;
      // Not staged at all.
      assert.deepEqual(failed(await attempt(id(1), [named])), expected);
      // Staged, but a different size.
      await stagedFile(id(2), Buffer.concat([patch, Buffer.from("x")]));
      assert.deepEqual(failed(await attempt(id(2), [named])), expected);
      // Same size, one byte different: caught while it is placed, and no copy is left.
      const flipped = Buffer.from(patch); flipped[0] ^= 1;
      await stagedFile(id(3), flipped);
      assert.deepEqual(failed(await attempt(id(3), [named])), expected);
      await assert.rejects(() => lstat(join(repo, ".amux", "context", PRIOR)));
      // A run with no way to find staged files.
      await stagedFile(id(4), patch);
      assert.deepEqual(failed(await attempt(id(4), [named], { contextPartPath: undefined })),
        expected);
      // A link where the staged file should be is not followed.
      if (process.platform !== "win32") {
        const { symlink } = await import("node:fs/promises");
        await symlink(join(stateDir, `${id(4)}.ctx-${PRIOR}.part`),
          join(stateDir, `${id(5)}.ctx-${PRIOR}.part`));
        assert.deepEqual(failed(await attempt(id(5), [named])), expected);
      }
      assert.deepEqual(calls, [], "the CLI never started");
      // A part that checks out runs, and is gone from the journal directory.
      await stagedFile(id(6), patch);
      assert.equal((await attempt(id(6), [named])).kind, "succeeded");
      assert.deepEqual(calls, ["spawn"]);
      assert.equal((await readFile(join(repo, ".amux", "context", PRIOR))).equals(patch), true);
      await assert.rejects(() => lstat(join(stateDir, `${id(6)}.ctx-${PRIOR}.part`)));
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});

test("a file staged and also sent inline is refused rather than guessed between", async () => {
  await withState(async (stateDir) => {
    const { amuxV22EmbedContextFiles, amuxV22ContextPromptSection } =
      await import("../lib/amux/v22LocalCliFlowCore.ts");
    const files = [{ name: PRIOR, text: "diff --git a/x b/x\n" }];
    const prompt = `Task: t\n\n${amuxV22ContextPromptSection(files)}\n\n` +
      amuxV22EmbedContextFiles(files);
    const staged = Buffer.from("diff --git a/y b/y\n");
    await writeFile(join(stateDir, partName(PRIOR)), staged);
    const spawned = [];
    const result = await runAmuxV22OneShot({ ...request, prompt,
      contextParts: [partOf(staged, PRIOR)] }, config, { syntheticPlatform: true,
      spawnChild: () => { spawned.push(1); return fakeSpawn("")(); },
      contextPartPath: (name) => join(stateDir, `${attemptId}.ctx-${name}.part`) });
    assert.deepEqual([result.kind, result.cliStarted, result.failure],
      ["failed", false, "context_parts_invalid"]);
    assert.deepEqual(spawned, []);
  });
});

test("staged files of started or long-idle attempts are removed when a run starts; waiting ones stay", async () => {
  await withState(async (stateDir) => {
    const id = (n) => `00000000-0000-4000-8000-00000000020${n}`;
    const write = (n, name = PRIOR) => writeFile(join(stateDir, `${id(n)}.ctx-${name}.part`), "x");
    // 1 started (claimed) and never finished: its execute is gone for good.
    await write(1);
    await writeFile(join(stateDir, `${id(1)}.ctx-${PRIOR}.part.meta`), "{}");
    await writeFile(join(stateDir, `${id(1)}.claimed`), `${"0".repeat(64)}\n`);
    // 2 never started and recent: its bridge may still be sending, so it waits.
    await write(2);
    await write(2, CONCLUSIONS);
    // 3 never started and idle past the retention.
    await write(3);
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(stateDir, `${id(3)}.ctx-${PRIOR}.part`), old, old);
    const handler = createAmuxV22SidecarHandler({ worker: "worker-a", stateDir,
      transcriptRetentionMs: 60_000, run: async (input) => ({ kind: "succeeded",
        attemptId: input.attemptId }) });
    assert.equal((await handler({ op: "execute", ...request })).kind, "in_progress");
    await finished(handler);
    assert.deepEqual((await stagedNames(stateDir)).sort(),
      [`${id(2)}.ctx-${PRIOR}.part`, `${id(2)}.ctx-${CONCLUSIONS}.part`].sort());
  });
});

test("a run that ends leaves none of its staged files, whatever it did with them", async () => {
  await withState(async (stateDir) => {
    const bytes = Buffer.from("context");
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000003"];
    const runs = [async (input) => ({ kind: "succeeded", attemptId: input.attemptId }),
      async () => { throw new Error("crash"); }];
    for (const [position, run] of runs.entries()) {
      const handler = createAmuxV22SidecarHandler({ worker: "worker-a", stateDir, run });
      const id = ids[position];
      await handler({ op: "put_context", attemptId: id, name: PRIOR, index: 0,
        totalBytes: bytes.length, sha256: sha(bytes), bytesBase64: bytes.toString("base64") });
      assert.deepEqual((await stagedNames(stateDir)).map((name) => name.endsWith(".meta")).sort(),
        [false, true]);
      await handler({ op: "execute", ...request, attemptId: id,
        contextParts: [partOf(bytes, PRIOR)] });
      const deadline = Date.now() + 5_000;
      while ((await stagedNames(stateDir)).length > 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(await stagedNames(stateDir), []);
    }
  });
});

test("Ubuntu socket takes a full 4 MiB put_context chunk and refuses a bad one",
  { skip: process.platform !== "linux" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "amux-v22-context-socket-"));
    const socketPath = join(root, "sidecar.sock");
    const handler = handlerFor(root, {});
    const server = createAmuxV22SidecarServer(socketPath, handler);
    const send = (message) => new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const parts = [];
      socket.on("data", (part) => parts.push(part));
      socket.on("error", reject);
      socket.on("end", () => resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))));
      socket.end(`${JSON.stringify(message)}\n`);
    });
    try {
      await server.listen();
      const bytes = Buffer.alloc(CHUNK + 5, "q");
      const message = (index, range) => ({ op: "put_context", attemptId, name: PRIOR, index,
        totalBytes: bytes.length, sha256: sha(bytes),
        bytesBase64: bytes.subarray(...range).toString("base64") });
      assert.deepEqual(await send(message(0, [0, CHUNK])),
        { kind: "context_stored", attemptId, name: PRIOR, index: 0 });
      assert.deepEqual(await send(message(1, [CHUNK, bytes.length])),
        { kind: "context_stored", attemptId, name: PRIOR, index: 1 });
      assert.equal((await readFile(join(root, partName(PRIOR)))).equals(bytes), true);
      assert.deepEqual(await send({ ...message(1, [CHUNK, bytes.length]), name: "brief.md" }),
        { kind: "refused" });
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  });
