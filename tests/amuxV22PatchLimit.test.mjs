import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { AMUX_V22_CHANGED_PATHS_JSON_MAX_BYTES, AMUX_V22_FILE_MAX_BYTES,
  AMUX_V22_GIT_STEP_TIMEOUT_MS, AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES,
  AMUX_V22_LEGACY_PATCH_ENVELOPE_MAX_BYTES, AMUX_V22_PATCH_MAX_BYTES } from
  "../lib/amux/v22PatchLimit.ts";
import { AMUX_V22_EMPTY_SHA256, AMUX_V22_PROXY_BODY_MAX_BYTES,
  AMUX_V22_STORAGE_MAX_BYTES, AMUX_V22_TRANSFER_BODY_MAX_BYTES,
  AMUX_V22_TRANSFER_CHUNK_BYTES, amuxV22SizeAllowanceMs } from
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
  // Deprecated names other areas still import until their own change lands.
  assert.equal(AMUX_V22_PATCH_MAX_BYTES, AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES);
  assert.equal(AMUX_V22_CHANGED_PATHS_JSON_MAX_BYTES, AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES);
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

// The bridge's transfer values land with the bridge change; until then this
// test reports itself skipped rather than passing on nothing.
const api = read("apps/tomverse-orchestrator/src/tomverse_api.rs");
const bridgeHasTransfer = /V22_TRANSFER_CHUNK_BYTES/.test(api);
test("the Rust bridge carries the same transfer values", {
  skip: bridgeHasTransfer ? undefined : "the bridge's chunked transfer is not in this tree",
}, () => {
  const rustBytes = (name) => {
    const expression = api.match(new RegExp(`pub const ${name}: (?:usize|u64) = ([0-9_ *]+);`))?.[1];
    assert.ok(expression, `${name} is not declared`);
    return expression.split("*").reduce((product, part) =>
      product * Number(part.trim().replaceAll("_", "")), 1);
  };
  assert.equal(rustBytes("V22_TRANSFER_CHUNK_BYTES"), AMUX_V22_TRANSFER_CHUNK_BYTES);
  assert.equal(rustBytes("V22_TRANSFER_BODY_MAX_BYTES"), AMUX_V22_TRANSFER_BODY_MAX_BYTES);
  assert.match(api, new RegExp(`V22_EMPTY_SHA256: &str =\\s*"${AMUX_V22_EMPTY_SHA256}"`));
  assert.match(api, /fn v22_size_allowance\(bytes: u64\) -> Duration/);
});

test("the bridge's old sidecar answer cap stays gone", () => {
  assert.doesNotMatch(read("apps/tomverse-orchestrator/src/wsl_bridge.rs"), /327_?68[01]/);
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
