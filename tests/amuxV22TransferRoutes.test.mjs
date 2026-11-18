import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { AMUX_V22_EMPTY_SHA256, AMUX_V22_STORAGE_MAX_BYTES, AMUX_V22_TRANSFER_PARTS,
  amuxV22SizeAllowanceMs, decodeAmuxV22ChangedPaths, encodeAmuxV22ChangedPaths } from
  "../lib/amux/v22TransferCore.ts";

// The v22 chunked result transfer's app routes (owner decision 2026-11-18,
// docs/policy/amux-v22-result-transfer.md 1.6): the Rust bridge implements
// against these exact keys and status codes.

test("the upload, settlement and review record routes answer the bridge's contract", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server",
    "--no-warnings=ExperimentalWarning", "--import", "tsx",
    resolve("tests/support/amuxV22TransferRoutesHarness.mjs"),
  ], { cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(child.status, 0, `stdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
  assert.match(child.stdout, /AMUX_V22_TRANSFER_ROUTES_OK/);
});

test("a changed-path list encodes as NUL-ended paths and its digest names the empty list", () => {
  const paths = ["lib/a.ts", "docs/한글.md"];
  const bytes = encodeAmuxV22ChangedPaths(paths);
  assert.deepEqual(decodeAmuxV22ChangedPaths(bytes, 2), paths);
  assert.throws(() => decodeAmuxV22ChangedPaths(bytes, 3));
  assert.equal(encodeAmuxV22ChangedPaths([]).length, 0);
  assert.equal(AMUX_V22_EMPTY_SHA256,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(amuxV22SizeAllowanceMs(0), 0);
  assert.equal(amuxV22SizeAllowanceMs(1), 1_000);
  assert.ok(AMUX_V22_STORAGE_MAX_BYTES < 2 ** 31 - 1, "an Int column holds every size");
});

test("each route names its own errors and the store keeps the commit outside the audit lock", () => {
  const read = (path) => readFileSync(path, "utf8");
  const route = (path) => read(`app/api/internal/amux/v22/${path}/route.ts`);
  const result = route("execution/result");
  for (const code of ["upload_incomplete", "upload_digest_mismatch", "exceeds_processing",
    "result_conflict", "result_expired", "binding_mismatch"])
    assert.ok(result.includes(`"${code}"`), code);
  assert.match(result, /transfer: z\.literal\("chunked_v1"\)/);
  assert.match(result, /resultBytes: result\.byteLength/);
  assert.match(result, /bytes: patch\.byteLength/);
  const paths = route("execution/changed-paths");
  for (const code of ["upload_incomplete", "upload_digest_mismatch"])
    assert.ok(paths.includes(`"${code}"`), code);
  assert.match(paths, /readAmuxV22ChangedPathsRecord\(attemptId\.data\)/);
  const upload = route("execution/upload");
  assert.match(upload, /z\.enum\(AMUX_V22_TRANSFER_PARTS\)/);
  assert.deepEqual([...AMUX_V22_TRANSFER_PARTS], ["result", "patch", "changed_paths"]);
  // The heavy half (open, assemble, check, seal) is pure and runs before the
  // transaction; the transaction only locks, checks, inserts and audits.
  const store = read("lib/amux/v22TaskResultStore.ts");
  const record = store.slice(store.indexOf("export async function recordAmuxV22TaskResult"),
    store.indexOf("/** Owner-only callers"));
  assert.ok(record.length > 0);
  assert.doesNotMatch(record, /sealAmuxContent\(|encodeV22PatchEvidence\(|parseAmuxV22Conclusion\(/);
  assert.match(record, /set_config\('statement_timeout', \$\{String\(5_000 \+ allowance\)\}/);
});

test("a chunked commit past the storage bound is answered before its chunk list is built", async () => {
  // Review r-20261118-113223-aacd9b: a declared size up to MAX_SAFE_INTEGER
  // once made the commit build a chunk list of that length.
  const result = readFileSync("app/api/internal/amux/v22/execution/result/route.ts", "utf8");
  const bound = result.indexOf("body.resultBytes > AMUX_V22_STORAGE_MAX_BYTES");
  const patchBound = result.indexOf("body.patch.bytes > AMUX_V22_STORAGE_MAX_BYTES");
  const inspect = result.indexOf("inspectAmuxV22TransferPart(prisma");
  assert.ok(bound > 0 && patchBound > bound && inspect > patchBound);
  assert.match(result.slice(patchBound, inspect), /\{ error: "exceeds_processing" \}, 409/);
  // The store holds the class: any caller past the bound throws before the
  // database is read or a list is made.
  const child = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx",
    "--input-type=module", "-e", `
      const store = await import(${JSON.stringify(
        new URL("../lib/amux/v22TransferStore.ts", import.meta.url).href)});
      const inspectAmuxV22TransferPart = store.inspectAmuxV22TransferPart ?? store.default.inspectAmuxV22TransferPart;
      const db = new Proxy({}, { get() { throw new Error("database read"); } });
      try {
        await inspectAmuxV22TransferPart(db, "00000000-0000-4000-8000-000000000001",
          { part: "result", totalBytes: ${AMUX_V22_STORAGE_MAX_BYTES + 1}, sha256: "a".repeat(64),
            baseSha: null, count: null });
        console.log("NO_THROW");
      } catch (error) { console.log(error instanceof RangeError ? "RANGE" : String(error)); }
    `], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  assert.equal(child.stdout.trim().split("\n").at(-1), "RANGE", child.stderr);
});
