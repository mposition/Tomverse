// /api/ready's checks live in lib/readinessChecks.ts so a second reader asks
// the same questions (docs/policy/sre-ops.md §8, S1a). The behaviour itself is
// pinned by tests/integration/readiness-route.db.test.ts; this file pins the
// boundary: the computation reports nothing, the route computes nothing, and
// both name the same checks in the same order.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const lib = read("lib/readinessChecks.ts");
// The code without comments, so prose that names after() is not mistaken for a call.
const libCode = lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const route = read("app/api/ready/route.ts");

function block(source, opener) {
  const start = source.indexOf(opener);
  assert.ok(start !== -1, `missing: ${opener}`);
  const end = source.indexOf("}", start);
  return source.slice(start + opener.length, end);
}

const names = (text) => [...text.matchAll(/^\s+([A-Za-z]+),$/gm)].map((m) => m[1]);

test("the computation has no side effects: no after(), no reporting, no response", () => {
  assert.doesNotMatch(libCode, /from "next\/server"/);
  assert.doesNotMatch(libCode, /operationalMonitoring/);
  assert.doesNotMatch(libCode, /\bafter\(/);
  assert.doesNotMatch(libCode, /Response\b/);
  assert.doesNotMatch(libCode, /randomUUID/);
});

test("the route computes no check itself", () => {
  assert.match(route, /import \{ computeReadinessChecks \} from "@\/lib\/readinessChecks";/);
  for (const forbidden of [
    "@/lib/prisma",
    "@/lib/securityEnvironment",
    "@/lib/providerCostBudget",
    "@/lib/emailSnapshotCrypto",
    "Readiness\"",
    "checkDatabase",
    "withDeadline",
  ]) {
    assert.ok(!route.includes(forbidden), `route must not contain ${forbidden}`);
  }
});

test("the route reports exactly the checks the computation returns, in the same order", () => {
  const returned = names(block(lib, "    checks: {"));
  const destructured = names(block(route, "  const {\n    database,").replace(/^/, "    database,\n"));
  const responded = names(block(route, "      checks: {"));
  assert.equal(returned.length, 17);
  assert.deepEqual(destructured, returned);
  assert.deepEqual(responded, returned);
});

test("the ready verdict is the conjunction of every check except the biennial notice", () => {
  const conjunction = lib.slice(lib.indexOf("const ready ="), lib.indexOf(";", lib.indexOf("const ready =")));
  const gated = [...conjunction.matchAll(/\b([a-z][A-Za-z]+)\b/g)].map((m) => m[1]).filter((n) => n !== "const" && n !== "ready");
  const returned = names(block(lib, "    checks: {"));
  assert.deepEqual([...gated].sort(), returned.filter((n) => n !== "emailBiennialConsentNotice").sort());
});
