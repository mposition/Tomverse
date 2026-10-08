import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifySourceScopePreview } from "../lib/amux/ideaSourceScopePreviewUiCore.ts";

const ideaId = "d218de81-0c91-4f5b-8dcb-11f335d68110";
const requested = { repository: "mposition/Tomverse", commitSha: "a".repeat(40), path: "README.md" };
const checked = {
  ideaId, fileCount: 1, canonicalScopeJson: JSON.stringify({ version: 1,
    sources: [{ kind: "repository_file", ...requested }] }),
  collectionVerified: false, transferAuthorized: false,
};

test("only a complete read-only response is shown as a checked scope", () => {
  assert.deepEqual(classifySourceScopePreview({ status: 200, body: checked }, ideaId, requested),
    { kind: "checked", canonicalScopeJson: checked.canonicalScopeJson });
  for (const reply of [
    { status: 202, body: checked },
    { status: 200, body: { ...checked, ideaId: "another" } },
    { status: 200, body: { ...checked, collectionVerified: true } },
    { status: 200, body: { ...checked, transferAuthorized: true } },
    { status: 200, body: { ...checked, canonicalScopeJson: "" } },
    { status: 200, body: { ...checked, canonicalScopeJson: "not json" } },
    { status: 200, body: { ...checked, canonicalScopeJson: '{"version":1,"sources":[]}' } },
    { status: 200, body: { ...checked, fileCount: 0 } },
  ]) {
    assert.deepEqual(classifySourceScopePreview(reply, ideaId, requested),
      { kind: "error", code: "preview_unavailable" });
  }
});

test("checked scope is the exact requested file with complete canonical metadata", () => {
  const altered = [
    { ...requested, repository: "other/Tomverse" },
    { ...requested, commitSha: "b".repeat(40) },
    { ...requested, commitSha: "z".repeat(40) },
    { ...requested, commitSha: "" },
    { ...requested, path: "OTHER.md" },
    { ...requested, path: "" },
    { ...requested, extra: "unreviewed" },
  ];
  for (const source of altered) {
    const canonicalScopeJson = JSON.stringify({ version: 1,
      sources: [{ kind: "repository_file", ...source }] });
    assert.deepEqual(classifySourceScopePreview({ status: 200,
      body: { ...checked, canonicalScopeJson } }, ideaId, requested),
    { kind: "error", code: "preview_unavailable" });
  }
  for (const canonicalScopeJson of [
    JSON.stringify({ version: 1, sources: [{ kind: "repository_file", ...requested }], extra: true }),
    ` ${checked.canonicalScopeJson}`,
  ]) {
    assert.deepEqual(classifySourceScopePreview({ status: 200,
      body: { ...checked, canonicalScopeJson } }, ideaId, requested),
    { kind: "error", code: "preview_unavailable" });
  }
});

test("a refused preview displays a bounded error instead of checked status", () => {
  assert.deepEqual(classifySourceScopePreview({ status: 503,
    body: { error: "preview_disabled", transferAuthorized: false } }, ideaId, requested),
  { kind: "error", code: "preview_disabled" });
});

test("the Admin form uses the route only after a saved idea and keeps the dark switch", () => {
  const panel = readFileSync(new URL("../components/admin/AmuxIdeaInputPanel.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/(site)/(application)/admin/amux-backlog/page.tsx", import.meta.url), "utf8");
  assert.match(panel, /submission\.kind === "submitted" \? \([\s\S]*?sourceScopeTitle/);
  assert.match(panel, /\/api\/admin\/amux\/ideas\/source-scope-preview/);
  assert.match(panel, /!sourceScopePreviewAvailable \|\| sourceScopePending/);
  assert.match(page, /sourceScopePreviewPermitted\([\s\S]*?AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV/);
  for (const field of ["sourceRepository", "sourceCommitSha", "sourcePath"]) {
    assert.match(panel, new RegExp(`<input value=\\{${field}\\}[\\s\\S]*?focus-visible:outline-2`));
  }
  assert.match(panel, /onClick=\{checkSourceScope\}[\s\S]*?focus-visible:outline-2/);
});
