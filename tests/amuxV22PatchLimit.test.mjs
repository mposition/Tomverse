import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { AMUX_V22_CHANGED_PATHS_JSON_MAX_BYTES, AMUX_V22_FILE_MAX_BYTES, AMUX_V22_PATCH_ENVELOPE_MAX_BYTES,
  AMUX_V22_PATCH_MAX_BYTES } from "../lib/amux/v22PatchLimit.ts";
import { TREE_LIMITS } from "../lib/engineeringAgentTreeVerify.ts";
import { AMUX_V22_EMPTY_SHA256, AMUX_V22_TRANSFER_BODY_MAX_BYTES, AMUX_V22_TRANSFER_CHUNK_BYTES,
  amuxV22SizeAllowanceMs, amuxV22TransferChunkCount, amuxV22TransferChunkRange } from "../lib/amux/v22TransferCore.ts";

// Owner decision 2026-11-15: a v22 patch is bounded only by the systems it
// passes through (lib/amux/v22PatchLimit.ts). Every hop -- the box sidecar,
// the Rust bridge, the settlement route, the database, the candidate -- must
// carry the same number, or the smallest one silently becomes the limit.

const read = (path) => readFileSync(path, "utf8");
const MIB = 1024 * 1024;

test("the bounds are GitHub's file limit and what fits the app's proxy buffer", () => {
  assert.equal(AMUX_V22_FILE_MAX_BYTES, 100 * MIB);
  assert.equal(AMUX_V22_PATCH_MAX_BYTES, 4 * MIB);
  assert.equal(AMUX_V22_PATCH_ENVELOPE_MAX_BYTES, 2 * AMUX_V22_PATCH_MAX_BYTES + MIB);
  // Next.js buffers a body that passes proxy.ts up to 10 MB unless
  // experimental.proxyClientMaxBodySize says otherwise; the escaped patch and
  // its result must fit, or the settlement body is cut and the result lost.
  assert.ok(AMUX_V22_PATCH_ENVELOPE_MAX_BYTES < 10 * 1000 * 1000);
  const config = read("next.config.ts");
  assert.doesNotMatch(config, /proxyClientMaxBodySize|middlewareClientMaxBodySize/,
    "a configured proxy buffer must be checked against the envelope here");
  assert.equal(TREE_LIMITS.maxChangedBlobBytes, AMUX_V22_FILE_MAX_BYTES);
});

test("the Rust bridge keeps the old inline patch bound for the old sidecar path only", () => {
  const api = read("apps/tomverse-orchestrator/src/tomverse_api.rs");
  assert.match(api, /pub const V22_LEGACY_INLINE_PATCH_MAX_BYTES: usize = 4 \* 1024 \* 1024;/);
  assert.match(api, /pub const V22_LEGACY_PATCH_ENVELOPE_MAX_BYTES: usize =\s+2 \* V22_LEGACY_INLINE_PATCH_MAX_BYTES \+ 1024 \* 1024;/);
  assert.match(api, /body\.len\(\) > V22_LEGACY_INLINE_PATCH_MAX_BYTES/);
  const bridge = read("apps/tomverse-orchestrator/src/wsl_bridge.rs");
  assert.match(bridge, /crate::tomverse_api::V22_LEGACY_PATCH_ENVELOPE_MAX_BYTES/);
  assert.match(bridge, /body\.len\(\) > crate::tomverse_api::V22_LEGACY_INLINE_PATCH_MAX_BYTES/);
  assert.doesNotMatch(api + bridge, /(?<!LEGACY_)(?<!LEGACY_INLINE_)V22_PATCH_(?:MAX|ENVELOPE_MAX)_BYTES/,
    "the old names are gone: a bound named without LEGACY is a bound of ours");
  assert.doesNotMatch(bridge, /327_?68[01]/, "the old 320 KiB sidecar answer cap is gone");
});

// docs/policy/amux-v22-result-transfer.md 1.2: the Rust bridge keeps the same
// values as lib/amux/v22TransferCore.ts, and this holds the two equal.
test("the Rust bridge carries the transfer values and the size allowance of the TS core", () => {
  const api = read("apps/tomverse-orchestrator/src/tomverse_api.rs");
  const mib = (name) => {
    const match = api.match(new RegExp(String.raw`pub const ${name}: usize = (\d+) \* 1024 \* 1024;`));
    assert.ok(match, name);
    return Number(match[1]) * MIB;
  };
  assert.equal(mib("V22_TRANSFER_CHUNK_BYTES"), AMUX_V22_TRANSFER_CHUNK_BYTES);
  assert.equal(mib("V22_TRANSFER_BODY_MAX_BYTES"), AMUX_V22_TRANSFER_BODY_MAX_BYTES);
  assert.match(api, new RegExp(String.raw`pub const V22_EMPTY_SHA256: &str =\s+"${AMUX_V22_EMPTY_SHA256}";`));
  // The allowance: one second per chunk's worth of bytes, none for none.
  assert.match(api, /pub fn v22_size_allowance\(bytes: u64\) -> Duration \{\s+Duration::from_secs\(bytes\.div_ceil\(V22_TRANSFER_CHUNK_BYTES as u64\)\)\s+\}/);
  const table = [0, 1, AMUX_V22_TRANSFER_CHUNK_BYTES, AMUX_V22_TRANSFER_CHUNK_BYTES + 1,
    3 * AMUX_V22_TRANSFER_CHUNK_BYTES];
  assert.deepEqual(table.map((bytes) => amuxV22SizeAllowanceMs(bytes) / 1000), [0, 1, 1, 2, 3]);
  // The chunk arithmetic the Rust unit test pins the same way.
  assert.match(api, /pub fn v22_transfer_chunk_count\(total: u64\) -> u64 \{\s+total\.div_ceil\(V22_TRANSFER_CHUNK_BYTES as u64\)\s+\}/);
  assert.equal(amuxV22TransferChunkCount(0), 0);
  assert.deepEqual(amuxV22TransferChunkRange(AMUX_V22_TRANSFER_CHUNK_BYTES + 3, 1),
    { start: AMUX_V22_TRANSFER_CHUNK_BYTES, end: AMUX_V22_TRANSFER_CHUNK_BYTES + 3 });
  assert.throws(() => amuxV22TransferChunkRange(10, 1));
  // The bridge's settle timeouts add exactly that allowance and nothing else.
  assert.match(api, /v22_size_allowance\(allowance_bytes\)/);
  assert.match(api, /TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT \+\s+v22_size_allowance\(chunk\.bytes_base64\.len\(\) as u64\)/);
});

test("the Rust bridge sends the new sidecar ops with exactly the designed keys", () => {
  const bridge = read("apps/tomverse-orchestrator/src/wsl_bridge.rs");
  assert.match(bridge, /serde_json::json!\(\{ "op": "readback_v2", "attemptId": attempt_id \}\)/);
  assert.match(bridge, /serde_json::json!\(\{ "op": "read_pending", "attemptId": attempt_id,\s+"part": part, "index": index \}\)/);
  assert.match(bridge, /serde_json::json!\(\{ "op": "confirm_changed_paths", "attemptId": attempt_id,\s+"sha256": sha256 \}\)/);
  // An answer of read_pending is one chunk's base64 and a short envelope.
  assert.match(bridge, /V22_TRANSFER_CHUNK_BYTES\.div_ceil\(3\) \* 4 \+ 64 \* 1024/);
  const base64Chunk = Math.ceil(AMUX_V22_TRANSFER_CHUNK_BYTES / 3) * 4;
  assert.ok(base64Chunk + 64 * 1024 < AMUX_V22_TRANSFER_BODY_MAX_BYTES);
});

test("the box sidecar captures and holds patches to the same bound, and no file bytes", () => {
  const capture = read("lib/amux/v22PatchCapture.mjs");
  assert.match(capture, /const PATCH_LIMIT_BYTES = AMUX_V22_PATCH_MAX_BYTES;/);
  assert.match(capture, /JSON\.stringify\(body\), "utf8"\) > 2 \* PATCH_LIMIT_BYTES/);
  assert.doesNotMatch(capture, /modifiedBlobs|MAX_PUBLISH_FILE_BYTES|publishFiles/);
  const sidecar = read("lib/amux/v22OneShotSidecar.mjs");
  assert.match(sidecar, /Buffer\.byteLength\(result\.patchBody, "utf8"\) <=\s+AMUX_V22_PATCH_MAX_BYTES/);
  assert.doesNotMatch(sidecar, /publishFiles\.length <= 5|<= 65_536\s*\n?\s*\? patchCandidate/);
});

test("the settlement route, the evidence and both database checks hold one patch", () => {
  const route = read("app/api/internal/amux/v22/execution/result/route.ts");
  // One patch envelope, and the report's transport backstop beside it.
  assert.match(route, /readLimitedJson\(request, AMUX_V22_PATCH_ENVELOPE_MAX_BYTES \+\s+2 \* AMUX_V22_TRANSPORT_MAX_BYTES, bodySchema\)/);
  assert.match(read("lib/amux/v22PatchEvidence.ts"),
    /const MAX_PATCH_BYTES = AMUX_V22_PATCH_MAX_BYTES;/);
  assert.match(read("lib/engineeringAgentStore.ts"),
    /export const ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES = AMUX_V22_PATCH_MAX_BYTES;/);
  // The latest migration that defines each check states the bound.
  const migrations = readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const constraint of ["AmuxV22TaskPatch_digest_check",
    "EngineeringAgentWorkItem_patchBody_check"]) {
    const latest = migrations.filter((name) =>
      read(`prisma/migrations/${name}/migration.sql`)
        .includes(`ADD CONSTRAINT "${constraint}"`) ||
      read(`prisma/migrations/${name}/migration.sql`)
        .includes(`CONSTRAINT "${constraint}" CHECK`)).at(-1);
    assert.ok(latest, constraint);
    const sql = read(`prisma/migrations/${latest}/migration.sql`);
    const body = sql.slice(sql.lastIndexOf(constraint));
    assert.match(body.slice(0, 400), new RegExp(`(?:<=|AND) ${AMUX_V22_PATCH_MAX_BYTES}\\b`),
      `${constraint} in ${latest}`);
  }
});

test("the result store has no patch bound of its own, and the path inventory shares the patch's", () => {
  const store = read("lib/amux/v22TaskResultStore.ts");
  assert.ok(!store.includes("export const AMUX_V22_PATCH_MAX_BYTES"));
  assert.ok(store.includes('import { AMUX_V22_PATCH_MAX_BYTES } from "@/lib/amux/v22PatchLimit";'));
  assert.equal(AMUX_V22_CHANGED_PATHS_JSON_MAX_BYTES, AMUX_V22_PATCH_MAX_BYTES);
  // Both routes that carry the inventory read the patch envelope, with no count of paths.
  for (const file of ["app/api/internal/amux/v22/execution/settle/route.ts",
    "app/api/internal/amux/v22/review/record/route.ts"]) {
    const route = read(file);
    assert.ok(route.includes("AMUX_V22_PATCH_ENVELOPE_MAX_BYTES"), file);
    assert.ok(!route.includes("4_096"), file);
  }
});
