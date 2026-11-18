import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { AMUX_V22_CHANGED_PATHS_JSON_MAX_BYTES, AMUX_V22_FILE_MAX_BYTES, AMUX_V22_PATCH_ENVELOPE_MAX_BYTES,
  AMUX_V22_PATCH_MAX_BYTES } from "../lib/amux/v22PatchLimit.ts";
import { TREE_LIMITS } from "../lib/engineeringAgentTreeVerify.ts";

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

test("the Rust bridge carries the same patch bound", () => {
  const api = read("apps/tomverse-orchestrator/src/tomverse_api.rs");
  assert.match(api, /pub const V22_PATCH_MAX_BYTES: usize = 4 \* 1024 \* 1024;/);
  assert.match(api, /pub const V22_PATCH_ENVELOPE_MAX_BYTES: usize = 2 \* V22_PATCH_MAX_BYTES \+ 1024 \* 1024;/);
  assert.match(api, /body\.len\(\) > V22_PATCH_MAX_BYTES/);
  const bridge = read("apps/tomverse-orchestrator/src/wsl_bridge.rs");
  assert.match(bridge, /crate::tomverse_api::V22_PATCH_ENVELOPE_MAX_BYTES/);
  assert.match(bridge, /body\.len\(\) > crate::tomverse_api::V22_PATCH_MAX_BYTES/);
  assert.doesNotMatch(bridge, /327_?68[01]/, "the old 320 KiB sidecar answer cap is gone");
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
  // The engineering agent's copy has no bound of its own (owner decision
  // 2026-11-18, docs/policy/amux-v22-result-transfer.md §4): its size CHECK is
  // dropped, and 4 MiB is only what a claim still carries inline.
  const store = read("lib/engineeringAgentStore.ts");
  assert.doesNotMatch(store, /ENGINEERING_AGENT_PATCH_BODY_MAX_BYTES|patch_too_large|AMUX_V22_PATCH_MAX_BYTES/);
  assert.match(store, /export const ENGINEERING_AGENT_LEGACY_INLINE_PATCH_MAX_BYTES = 4 \* 1024 \* 1024;/);
  assert.match(read("prisma/migrations/20261118120100_engineering_agent_patch_bytes/migration.sql"),
    /DROP CONSTRAINT "EngineeringAgentWorkItem_patchBody_check",\n\s*ADD CONSTRAINT "EngineeringAgentWorkItem_patchBytes_check"/);
  // The latest migration that defines each check states the bound.
  const migrations = readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const constraint of ["AmuxV22TaskPatch_digest_check"]) {
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
