import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxIdeaInputPanel } from "@/components/admin/AmuxIdeaInputPanel";
import { AmuxIdeaScopeRepositoryPicker } from "@/components/admin/AmuxIdeaScopeRepositoryPicker";
import {
  classifyScopeRepositoryRead, pickedScopeRepositories, scopeRepositoryBlock, toggleScopeRepository,
  type ScopeRepositoryRead,
} from "@/lib/amux/ideaScopeRepositoryPickCore";

// The Admin idea input, with session intake on, picks its repositories from the operating scope.
const scopeBody = {
  state: "current", version: 3,
  scope: { repositories: ["mposition/Tomverse", "mposition/amux"],
    model: { provider: "openai", modelId: "gpt-x", reasoningEffort: "high" } },
};
const ready: ScopeRepositoryRead = { kind: "ready", repositories: ["mposition/amux", "mposition/Tomverse"] };

const picker = (read: ScopeRepositoryRead, deselected: string[] = []) => renderToStaticMarkup(
  <AmuxIdeaScopeRepositoryPicker read={read} deselected={deselected} disabled={false}
    onToggle={() => undefined} stepUpHref="/admin/step-up" />);
const panel = (sessionIntake: boolean) => renderToStaticMarkup(
  <AmuxIdeaInputPanel submissionAvailable sourceScopePreviewAvailable initialPlanAvailable frontierModelsAvailable
    transferPreviewAvailable transferConfirmAvailable analysisResultAvailable analysisBudgetAvailable
    analysisStopAvailable operatorId="owner-1" sessionIntake={sessionIntake} />);

test("a read scope selects every allowed repository by default", () => {
  assert.deepEqual(classifyScopeRepositoryRead(200, scopeBody),
    { kind: "ready", repositories: ["mposition/amux", "mposition/Tomverse"] }, "ordered by the scope reader");
  assert.deepEqual(pickedScopeRepositories(ready, []), ["mposition/amux", "mposition/Tomverse"]);
  assert.equal(scopeRepositoryBlock(ready, pickedScopeRepositories(ready, [])), null);
  const html = picker(ready);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  assert.equal((html.match(/checked=""/g) ?? []).length, 2, "both are checked");
  assert.match(html, /mposition\/amux/);
  assert.match(html, /min-h-11/, "a 44px touch target per row");
  assert.match(html, /focus-visible:outline-2/);
});

test("unchecking narrows the picked list, and checking again restores it", () => {
  const off = toggleScopeRepository([], "mposition/amux", false);
  assert.deepEqual(pickedScopeRepositories(ready, off), ["mposition/Tomverse"]);
  assert.equal((picker(ready, off).match(/checked=""/g) ?? []).length, 1);
  assert.deepEqual(toggleScopeRepository(off, "mposition/amux", true), []);
  assert.deepEqual(toggleScopeRepository(off, "mposition/amux", false), off, "unchecking twice does not duplicate");
});

test("with nothing selected saving is blocked and the reason is shown", () => {
  const all = toggleScopeRepository(toggleScopeRepository([], "mposition/amux", false), "mposition/Tomverse", false);
  assert.deepEqual(pickedScopeRepositories(ready, all), []);
  assert.equal(scopeRepositoryBlock(ready, []), "empty");
  assert.match(picker(ready, all), /Select at least one repository to save\./);
});

test("an unread, absent or failed scope blocks saving and says why", () => {
  assert.equal(scopeRepositoryBlock({ kind: "loading" }, []), "loading");
  assert.match(picker({ kind: "loading" }), /Reading the operating scope/);
  assert.deepEqual(classifyScopeRepositoryRead(200, { state: "none", version: 0 }), { kind: "none" });
  assert.equal(scopeRepositoryBlock({ kind: "none" }, []), "none");
  const none = picker({ kind: "none" });
  assert.match(none, /No operating scope is set yet/);
  assert.match(none, /href="\/admin\/amux-settings\?tab=analysis"/, "links to the Admin settings");
  for (const [status, body] of [[500, { error: "x" }], [200, { state: "current" }], [200, null], [403, scopeBody]] as const) {
    assert.deepEqual(classifyScopeRepositoryRead(status, body), { kind: "error", reauth: false }, `${status}`);
  }
  assert.deepEqual(classifyScopeRepositoryRead(428, { error: "ADMIN_REAUTHENTICATION_REQUIRED" }), { kind: "error", reauth: true });
  assert.equal(scopeRepositoryBlock({ kind: "error", reauth: false }, []), "unavailable");
  const failed = picker({ kind: "error", reauth: false });
  assert.match(failed, /could not be read, so the idea cannot be saved/);
  assert.match(failed, /href="\/admin\/amux-settings\?tab=analysis"/);
  assert.doesNotMatch(failed, /step-up/);
  assert.match(picker({ kind: "error", reauth: true }), /href="\/admin\/step-up"/, "a 428 offers the sign-in renewal");
});

test("with session intake on the free-text repository box is replaced and the save button waits for the scope", () => {
  const session = panel(true);
  assert.match(session, /data-testid="amux-idea-scope-repositories"/);
  assert.doesNotMatch(session, /id="amux-v4-repositories"/);
  assert.match(session, /id="amux-v4-pull-requests"/, "the pull request box stays");
  assert.match(session, /disabled=""[^>]*>Queue for automatic analysis/, "blocked while the scope is unread");
  assert.match(session, /Reading the operating scope/);
});

test("with session intake off the screen is unchanged", () => {
  const v4 = panel(false);
  assert.match(v4, /id="amux-v4-repositories"/);
  assert.doesNotMatch(v4, /amux-idea-scope-repositories/);
});

test("the submitted and checked repositories are the selected ones", () => {
  const source = readFileSync("components/admin/AmuxIdeaInputPanel.tsx", "utf8");
  assert.equal((source.match(/repositories: selectedRepositories/g) ?? []).length, 3, "save, input check and build draft");
  assert.equal(/repositories: lines\(repositories\)/.test(source), false);
  assert.ok(source.includes("/api/admin/amux/ideas/operating-scope"));
  assert.equal(/method:\s*"POST"[\s\S]{0,40}operating-scope/.test(source), false, "the scope is only read here");
  assert.ok(source.includes("adminRecentAuthenticationHref") && source.includes("stepUpHref={STEP_UP_HREF}"));
  assert.match(source, /if \(scopeBlocked\) return false;/, "the input check refuses while saving is blocked");
  assert.match(source, /inFlight\.current \|\| scopeBlocked \|\|/, "and so does the save");
});
