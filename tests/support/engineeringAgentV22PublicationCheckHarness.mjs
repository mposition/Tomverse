import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
let authorized = false;
let result = { ok: false, reason: "publication_not_authorized" };
let reads = 0;

mock.module(mod("lib/amux/guard.ts"), {
  namedExports: { isAmuxSyncAuthorized: () => authorized },
});
mock.module(mod("lib/engineeringAgentV22StoredCandidate.ts"), {
  namedExports: {
    loadEngineeringAgentV22StoredCandidate: async () => { reads++; return result; },
    engineeringAgentV22CandidateSummary: (value) => ({
      verified: true, queued: false, baseSha: value.baseSha,
      patchDigest: value.patchDigest,
      baseTreeId: value.candidate.baseRootTreeId,
      expectedTreeId: value.candidate.expectedTreeId,
      changedPaths: value.candidate.changes.map((entry) => entry.path),
    }),
  },
});

const { POST } = await import(mod(
  "app/api/internal/amux/v22/execution/publication/check/route.ts"));
const attemptId = "29cf907f-2741-4dd1-b6d4-d85c881eb357";
const request = (body) => new Request(
  "https://tomverse.test/api/internal/amux/v22/execution/publication/check",
  { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });

let response = await POST(request({ attemptId }));
assert.equal(response.status, 401);
assert.equal(reads, 0);

authorized = true;
response = await POST(request({ attemptId, patchBody: "secret" }));
assert.equal(response.status, 400);
assert.equal(reads, 0);

response = await POST(request({ attemptId }));
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { verified: false,
  reason: "publication_not_authorized" });

result = { ok: true, baseSha: "a".repeat(40),
  patchDigest: "b".repeat(64), patchBody: "private patch text",
  candidate: { baseRootTreeId: "d".repeat(40),
    expectedTreeId: "c".repeat(40),
    changes: [{ path: "tests/example.test.mjs", addedText: "private" }] } };
response = await POST(request({ attemptId }));
assert.equal(response.status, 200);
assert.equal(response.headers.get("cache-control"), "no-store");
const body = await response.json();
assert.deepEqual(body, { verified: true, queued: false,
  baseSha: result.baseSha, patchDigest: result.patchDigest,
  baseTreeId: result.candidate.baseRootTreeId,
  expectedTreeId: result.candidate.expectedTreeId,
  changedPaths: ["tests/example.test.mjs"] });
assert.equal(JSON.stringify(body).includes("private"), false);
