import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifySourceScopePreview } from "../lib/amux/ideaSourceScopePreviewUiCore.ts";

const ideaId = "d218de81-0c91-4f5b-8dcb-11f335d68110";
const checked = {
  ideaId, fileCount: 1, canonicalScopeJson: JSON.stringify({ version: 1,
    sources: [{ kind: "repository_file", repository: "mposition/Tomverse",
      commitSha: "a".repeat(40), path: "README.md" }] }),
  collectionVerified: false, transferAuthorized: false,
};

test("only a complete read-only response is shown as a checked scope", () => {
  assert.deepEqual(classifySourceScopePreview({ status: 200, body: checked }, ideaId),
    { kind: "checked", canonicalScopeJson: checked.canonicalScopeJson });
  for (const reply of [
    { status: 202, body: checked },
    { status: 200, body: { ...checked, ideaId: "another" } },
    { status: 200, body: { ...checked, collectionVerified: true } },
    { status: 200, body: { ...checked, transferAuthorized: true } },
    { status: 200, body: { ...checked, canonicalScopeJson: "" } },
    { status: 200, body: { ...checked, fileCount: 0 } },
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
  assert.match(panel, /!sourceScopePreviewAvailable \|\| sourceScopePending/);
  assert.match(page, /sourceScopePreviewPermitted\([\s\S]*?AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV/);
});
