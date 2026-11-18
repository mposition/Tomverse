import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createConnection } from "node:net";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAmuxV22SidecarHandler, createAmuxV22SidecarServer,
  runAmuxV22OneShot } from "../lib/amux/v22OneShotSidecar.mjs";
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
