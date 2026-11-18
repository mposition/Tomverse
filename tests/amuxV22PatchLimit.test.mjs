import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { AMUX_V22_FILE_MAX_BYTES, AMUX_V22_GIT_STEP_TIMEOUT_MS,
  AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES, AMUX_V22_LEGACY_PATCH_ENVELOPE_MAX_BYTES } from
  "../lib/amux/v22PatchLimit.ts";
import { AMUX_V22_EMPTY_SHA256, AMUX_V22_PROXY_BODY_MAX_BYTES,
  AMUX_V22_STORAGE_MAX_BYTES, AMUX_V22_TRANSFER_BODY_MAX_BYTES,
  AMUX_V22_TRANSFER_CHUNK_BYTES, amuxV22SizeAllowanceMs,
  amuxV22TransferChunkCount, amuxV22TransferChunkRange } from
  "../lib/amux/v22TransferCore.ts";
import { TREE_LIMITS } from "../lib/engineeringAgentTreeVerify.ts";

// Owner decision 2026-11-18 (docs/policy/amux-v22-result-transfer.md): a v22
// run's result, patch and changed-path list carry no size bound of ours. They
// cross from the box in fixed-size chunks; what stays is an external system's
// limit or the old inline path's. Every hop -- the box sidecar, the Rust
// bridge, the routes, the database -- must agree, or the smallest number
// silently becomes the limit again.

const read = (path) => readFileSync(path, "utf8");
const MIB = 1024 * 1024;
const exportedNames = (source, from) => {
  const match = source.match(new RegExp(
    `import \\{([^}]*)\\} from "${from.replaceAll(".", "\\.")}";`));
  return match ? match[1].split(",").map((name) => name.trim()).filter(Boolean) : null;
};

test("what remains is GitHub's file limit, the proxy buffer and the old inline path", () => {
  assert.equal(AMUX_V22_FILE_MAX_BYTES, 100 * MIB);
  assert.equal(TREE_LIMITS.maxChangedBlobBytes, AMUX_V22_FILE_MAX_BYTES);
  assert.equal(AMUX_V22_GIT_STEP_TIMEOUT_MS, 2 * 60 * 60_000);
  assert.equal(AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES, 4 * MIB);
  assert.equal(AMUX_V22_LEGACY_PATCH_ENVELOPE_MAX_BYTES,
    2 * AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES + MIB);
  // The names of the old single patch bound are gone with it.
  assert.doesNotMatch(read("lib/amux/v22PatchLimit.ts"),
    /AMUX_V22_PATCH_MAX_BYTES|AMUX_V22_CHANGED_PATHS_JSON_MAX_BYTES/);
  // Next.js buffers a body that passes proxy.ts up to 10 MiB unless
  // experimental.proxyClientMaxBodySize says otherwise: every request -- a
  // chunk, an old inline result -- must fit it.
  assert.equal(AMUX_V22_PROXY_BODY_MAX_BYTES, 10 * MIB);
  assert.ok(AMUX_V22_LEGACY_PATCH_ENVELOPE_MAX_BYTES < AMUX_V22_PROXY_BODY_MAX_BYTES);
  assert.doesNotMatch(read("next.config.ts"), /proxyClientMaxBodySize|middlewareClientMaxBodySize/,
    "a configured proxy buffer must be checked against the requests here");
});

test("one chunk request carries a whole chunk under the proxy buffer", () => {
  assert.equal(AMUX_V22_TRANSFER_CHUNK_BYTES, 4 * MIB);
  const base64 = Math.ceil(AMUX_V22_TRANSFER_CHUNK_BYTES / 3) * 4;
  assert.ok(base64 + 64 * 1024 <= AMUX_V22_TRANSFER_BODY_MAX_BYTES);
  assert.ok(AMUX_V22_TRANSFER_BODY_MAX_BYTES < AMUX_V22_PROXY_BODY_MAX_BYTES);
  // The staging CHECK holds a chunk, and only a chunk's worth: it is the size
  // of one request, not a bound on the content.
  const sql = read("prisma/migrations/20261118120000_amux_v22_result_transfer/migration.sql");
  assert.match(sql, new RegExp(`"byteLength" BETWEEN 1 AND ${AMUX_V22_TRANSFER_CHUNK_BYTES} AND`));
  // A sealed value adds its small envelope and still fits one Postgres value (1 GB).
  assert.ok(AMUX_V22_STORAGE_MAX_BYTES + 1024 < 1_073_741_823);
  assert.equal(amuxV22SizeAllowanceMs(AMUX_V22_TRANSFER_CHUNK_BYTES + 1), 2_000);
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

test("the box sidecar and its capture hold no patch bound of ours", () => {
  const capture = read("lib/amux/v22PatchCapture.mjs");
  // Only the git step's wedge guard comes from the bounds file.
  assert.deepEqual(exportedNames(capture, "./v22PatchLimit.ts"), ["AMUX_V22_GIT_STEP_TIMEOUT_MS"]);
  assert.doesNotMatch(capture, /PATCH_LIMIT_BYTES|AMUX_V22_PATCH_MAX_BYTES|CHANGED_PATHS_JSON_MAX_BYTES/);
  assert.match(capture, /maxBuffer = Infinity/);
  assert.doesNotMatch(capture, /modifiedBlobs|MAX_PUBLISH_FILE_BYTES|publishFiles/);
  const sidecar = read("lib/amux/v22OneShotSidecar.mjs");
  const sidecarLimits = exportedNames(sidecar, "./v22PatchLimit.ts") ?? [];
  assert.ok(!sidecarLimits.includes("AMUX_V22_PATCH_MAX_BYTES"), sidecarLimits.join(","));
  assert.doesNotMatch(sidecar, /AMUX_V22_PATCH_MAX_BYTES/);
  // The old readback still inlines a patch only under the app's old inline bound.
  const legacy = sidecar.match(/const LEGACY_INLINE_PATCH_MAX_BYTES = ([0-9_ *]+);/)?.[1];
  assert.ok(legacy, "the old readback names its inline patch bound");
  assert.equal(legacy.split("*").reduce((product, part) =>
    product * Number(part.trim().replaceAll("_", "")), 1), AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES);
});

test("the result store, its evidence and the routes hold no bound of ours", () => {
  const store = read("lib/amux/v22TaskResultStore.ts");
  assert.doesNotMatch(store, /v22PatchLimit|AMUX_V22_TRANSPORT_MAX_BYTES|amuxV22ResultMaxBytes/);
  const evidence = read("lib/amux/v22PatchEvidence.ts");
  // Text evidence has no bound; the JSON (files) form keeps the old inline one.
  assert.match(evidence, /const MAX_JSON_EVIDENCE_BYTES = AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES;/);
  assert.doesNotMatch(evidence, /MAX_PATCH_BYTES/);
  assert.match(evidence, /if \(bytes\.length < 1 \|\| text\.includes\("\\0"\)\) \{/);
  assert.doesNotMatch(read("lib/amux/v22OptionalPatch.ts"), /text: z\.string\(\)\.min\(1\)\.max\(/);
  assert.doesNotMatch(read("lib/amux/ideaCrypto.ts"), /AMUX_TASK_RESULT_UNIT_MAX_BYTES|v22LocalCliFlowCore/);
  const route = (path) => read(`app/api/internal/amux/v22/${path}/route.ts`);
  assert.match(route("execution/result"),
    /readLimitedJson\(request, AMUX_V22_PROXY_BODY_MAX_BYTES, bodySchema\)/);
  assert.match(route("execution/upload"),
    /readLimitedJson\(request, AMUX_V22_TRANSFER_BODY_MAX_BYTES, bodySchema\)/);
  assert.match(route("execution/settle"),
    /readLimitedJson\(request, AMUX_V22_PROXY_BODY_MAX_BYTES, requestSchema\)/);
  assert.match(route("review/record"), /Math\.max\(AMUX_V22_PROXY_BODY_MAX_BYTES,/);
  for (const path of ["execution/result", "execution/settle", "review/record"]) {
    assert.doesNotMatch(route(path), /AMUX_V22_PATCH_ENVELOPE_MAX_BYTES|AMUX_V22_TRANSPORT_MAX_BYTES|4_096/, path);
    // Time grows with size by the one allowance, never by a fixed figure.
  }
  for (const path of ["execution/settle", "review/record"])
    assert.match(route(path), /\}, AMUX_V22_EXECUTION_ROUTE_BUDGET_MS \+ allowanceMs\);/, path);
});

test("the latest result and patch checks keep only a lower bound on the byte length", () => {
  const migrations = readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const constraint of ["AmuxV22TaskPatch_digest_check", "AmuxV22TaskResult_digest_check"]) {
    const latest = migrations.filter((name) => {
      const sql = read(`prisma/migrations/${name}/migration.sql`);
      return sql.includes(`ADD CONSTRAINT "${constraint}"`) ||
        sql.includes(`CONSTRAINT "${constraint}" CHECK`);
    }).at(-1);
    assert.equal(latest, "20261118120000_amux_v22_result_transfer", constraint);
    const sql = read(`prisma/migrations/${latest}/migration.sql`);
    const body = sql.slice(sql.lastIndexOf(constraint));
    const clause = body.slice(0, body.indexOf(");"));
    assert.match(clause, /"byteLength" >= 1/, constraint);
    assert.doesNotMatch(clause, /BETWEEN|<=/, constraint);
  }
});

test("the engineering agent copy of a patch has no bound of its own", () => {
  // Owner decision 2026-11-18 (docs/policy/amux-v22-result-transfer.md 4): its
  // size CHECK is dropped, and 4 MiB is only what a claim still carries inline.
  const store = read("lib/engineeringAgentStore.ts");
  assert.doesNotMatch(store, /ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES|patch_too_large|AMUX_V22_PATCH_MAX_BYTES/);
  assert.match(store, /export const ENGINEERING_AGENT_LEGACY_INLINE_PATCH_MAX_BYTES = 4 \* 1024 \* 1024;/);
  assert.match(read("prisma/migrations/20261118120100_engineering_agent_patch_bytes/migration.sql"),
    /DROP CONSTRAINT "EngineeringAgentWorkItem_patchBody_check",\r?\n\s*ADD CONSTRAINT "EngineeringAgentWorkItem_patchBytes_check"/);
});
