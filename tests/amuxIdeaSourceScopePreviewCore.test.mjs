import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  AMUX_V4_SOURCE_SCOPE_PREVIEW_ENVELOPE_MAX_BYTES,
  inspectAmuxSourceScopePreviewRequest,
  sourceScopePreviewPermitted,
} from "../lib/amux/ideaSourceScopePreviewCore.ts";

const ideaId = randomUUID();
const scope = { version: 1, sources: [{ kind: "repository_file", repository: "mposition/Tomverse",
  commitSha: "a".repeat(40), path: "lib/amux/ideaSourceScopeCore.ts" }] };
const scopeJson = JSON.stringify(scope);

test("source scope preview requires its dedicated environment value", () => {
  assert.equal(sourceScopePreviewPermitted("enabled"), true);
  assert.equal(sourceScopePreviewPermitted(undefined), false);
});

test("source scope preview envelope retains only a typed idea id and untrusted scope JSON", () => {
  const result = inspectAmuxSourceScopePreviewRequest(JSON.stringify({ schemaVersion: 1, ideaId, scopeJson }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.request, { schemaVersion: 1, ideaId, scopeJson });
});

test("source scope preview refuses malformed, extra and oversized envelopes", () => {
  for (const candidate of [
    "not-json",
    JSON.stringify({ schemaVersion: 1, ideaId, scopeJson, authorizeTransfer: true }),
    JSON.stringify({ schemaVersion: 2, ideaId, scopeJson }),
    JSON.stringify({ schemaVersion: 1, ideaId: "not-an-id", scopeJson }),
    JSON.stringify({ schemaVersion: 1, ideaId, scopeJson: [] }),
    JSON.stringify({ schemaVersion: 1, ideaId, scopeJson: null }),
  ]) assert.deepEqual(inspectAmuxSourceScopePreviewRequest(candidate),
    { ok: false, code: "schema_rejected" });
  const oversized = JSON.stringify({ schemaVersion: 1, ideaId,
    scopeJson: "x".repeat(AMUX_V4_SOURCE_SCOPE_PREVIEW_ENVELOPE_MAX_BYTES) });
  assert.deepEqual(inspectAmuxSourceScopePreviewRequest(oversized),
    { ok: false, code: "too_large" });
});
