import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifySourceScopePreview } from "../lib/amux/ideaSourceScopePreviewUiCore.ts";

const ideaId = "d218de81-0c91-4f5b-8dcb-11f335d68110";
const checked = {
  ideaId, fileCount: 1, canonicalScopeJson: JSON.stringify({ version: 1,
    sources: [{ kind: "repository_file", repository: "mposition/Tomverse",
      commitSha: "a".repeat(40), path: "README.md" }] }),
  ideaDigest: "c".repeat(64), scopeDigest: "b".repeat(64),
  scopeDigestKeyId: "amux-v4-preview-key",
  collectionVerified: false, transferAuthorized: false,
};
const checkedPr = { ...checked, canonicalScopeJson: JSON.stringify({ version: 1,
  sources: [{ kind: "pull_request_file", repository: "mposition/Tomverse", number: 1917,
    baseSha: "a".repeat(40), headSha: "b".repeat(40), side: "head", path: "README.md" }] }) };

test("only a complete read-only response is shown as a checked scope", () => {
  assert.deepEqual(classifySourceScopePreview({ status: 200, body: checked }, ideaId),
    { kind: "checked", canonicalScopeJson: checked.canonicalScopeJson,
      ideaDigest: checked.ideaDigest, scopeDigest: checked.scopeDigest,
      scopeDigestKeyId: checked.scopeDigestKeyId });
  assert.deepEqual(classifySourceScopePreview({ status: 200, body: checkedPr }, ideaId),
    { kind: "checked", canonicalScopeJson: checkedPr.canonicalScopeJson,
      ideaDigest: checkedPr.ideaDigest, scopeDigest: checkedPr.scopeDigest,
      scopeDigestKeyId: checkedPr.scopeDigestKeyId });
  for (const reply of [
    { status: 202, body: checked },
    { status: 200, body: { ...checked, ideaId: "another" } },
    { status: 200, body: { ...checked, collectionVerified: true } },
    { status: 200, body: { ...checked, transferAuthorized: true } },
    { status: 200, body: { ...checked, canonicalScopeJson: "" } },
    { status: 200, body: { ...checked, canonicalScopeJson: "not json" } },
    { status: 200, body: { ...checked, canonicalScopeJson: '{"version":1,"sources":[]}' } },
    { status: 200, body: { ...checked, fileCount: 0 } },
    { status: 200, body: { ...checked, scopeDigest: "" } },
    { status: 200, body: { ...checked, ideaDigest: "" } },
    { status: 200, body: { ...checked, scopeDigestKeyId: "other/key" } },
    { status: 200, body: { ...checkedPr, canonicalScopeJson: JSON.stringify({ version: 1,
      sources: [{ kind: "pull_request_file", repository: "mposition/Tomverse", number: 0,
        baseSha: "a".repeat(40), headSha: "b".repeat(40), side: "head", path: "README.md" }] }) } },
  ]) {
    assert.deepEqual(classifySourceScopePreview(reply, ideaId),
      { kind: "error", code: "preview_unavailable" });
  }
});

test("a refused preview displays a bounded error instead of checked status", () => {
  assert.deepEqual(classifySourceScopePreview({ status: 503,
    body: { error: "preview_disabled", transferAuthorized: false } }, ideaId),
  { kind: "error", code: "preview_disabled" });
});

test("the Admin form uses the route only after a saved idea and keeps the dark switch", () => {
  const panel = readFileSync(new URL("../components/admin/AmuxIdeaInputPanel.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/(site)/(application)/admin/amux-backlog/page.tsx", import.meta.url), "utf8");
  assert.match(panel, /submission\.kind === "submitted" \? \([\s\S]*?sourceScopeTitle/);
  assert.match(panel, /\/api\/admin\/amux\/ideas\/source-scope-preview/);
  assert.match(panel, /kind: "pull_request_file"/);
  assert.match(panel, /!sourceScopePreviewAvailable \|\| sourceScopePending/);
  assert.match(page, /sourceScopePreviewPermitted\([\s\S]*?AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV/);
});
