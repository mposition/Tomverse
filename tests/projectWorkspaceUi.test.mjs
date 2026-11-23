import assert from "node:assert/strict";
import test from "node:test";
import { ProjectWorkspaceError, createProjectWorkspaceClient } from "@tomverse/api-client";
import {
  DEFAULT_PROJECT_CREATE_FORM,
  buildProjectCreateInput,
  conversationMoveEffect,
  createRequestIdMemo,
  deleteProjectAfterConfirmation,
  loadProjectDeletionPlan,
  materialFailureKey,
  materialIntentKey,
  memoryMoveWarning,
  projectErrorKey,
  projectReferenceFields,
  projectSettingsPatch,
  saveProjectSettings,
  settingsDraftFromProject,
  toggleProjectReference,
  withProjectAttribution,
} from "../lib/projectWorkspaceUi.ts";
import {
  parseProjectWorkspaceRoute,
  projectWorkspaceSearch,
} from "../lib/projectWorkspaceRoute.ts";
import { prepareChatContextBundle } from "../lib/chatContextBundleClient.ts";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A transport that records requests and answers from a queue. */
function recorder(...answers) {
  const calls = [];
  const queue = [...answers];
  const transport = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request ${path}`);
    return typeof next === "function" ? next() : next;
  };
  return { calls, client: createProjectWorkspaceClient(transport) };
}

const project = {
  id: "p1", name: "Launch", description: "d", instructions: "i", contextEnabled: true,
  memoryScope: "project_only", autoMemoryEnabled: false, revision: 4, archivedAt: null,
  conversationCount: 1, materialCount: 0, memoryCount: 0, updatedAt: "", createdAt: "",
};

test("the create screen asks for context explicitly and keeps personal memory opt-in", () => {
  const input = buildProjectCreateInput({ ...DEFAULT_PROJECT_CREATE_FORM, name: "  Plan  " });
  assert.equal(input.name, "Plan");
  assert.equal(input.contextEnabled, true);
  assert.equal(input.memoryScope, "project_only");
  assert.equal(input.autoMemoryEnabled, false);
  const personal = buildProjectCreateInput({ ...DEFAULT_PROJECT_CREATE_FORM, name: "Plan", includePersonalMemory: true, autoMemoryEnabled: true });
  assert.equal(personal.memoryScope, "project_and_personal");
  assert.equal(personal.autoMemoryEnabled, true);
  // A folder never claims personal memory or automatic memory it will not use.
  const folder = buildProjectCreateInput({ ...DEFAULT_PROJECT_CREATE_FORM, name: "Plan", contextEnabled: false, includePersonalMemory: true, autoMemoryEnabled: true });
  assert.deepEqual([folder.contextEnabled, folder.memoryScope, folder.autoMemoryEnabled], [false, "project_only", false]);
});

test("create posts the explicit context choice to the projects API", async () => {
  const { calls, client } = recorder(json(project));
  await client.create(buildProjectCreateInput({ ...DEFAULT_PROJECT_CREATE_FORM, name: "Launch" }));
  assert.equal(calls[0].path, "/api/projects");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.contextEnabled, true);
});

test("a new chat in a project carries projectId in the create body and nothing else changes", () => {
  const base = { title: "Hello", selectedModels: ["m"], disabledPanels: [], webSearchMode: "off", assistantProfileId: "a1" };
  assert.deepEqual(withProjectAttribution(base, "p1"), { ...base, projectId: "p1" });
  assert.deepEqual(withProjectAttribution(base, null), base);
  assert.equal("projectId" in withProjectAttribution(base, undefined), false);
});

test("settings send only changed fields with the loaded revision; a rename alone needs none", async () => {
  const draft = settingsDraftFromProject(project);
  assert.equal(projectSettingsPatch(project, draft), null);
  const patch = projectSettingsPatch(project, { ...draft, contextEnabled: false, includePersonalMemory: true });
  assert.deepEqual(patch, { contextEnabled: false, memoryScope: "project_and_personal" });
  const { calls, client } = recorder(json(project), json(project));
  await saveProjectSettings(client, project, patch);
  assert.deepEqual(calls[0].body, { contextEnabled: false, memoryScope: "project_and_personal", expectedRevision: 4 });
  await saveProjectSettings(client, project, { name: "Renamed" });
  assert.deepEqual(calls[1].body, { name: "Renamed" });
});

test("a revision conflict is reported as a conflict, not a generic failure", async () => {
  const { client } = recorder(json({ code: "PROJECT_REVISION_CONFLICT" }, 409));
  await assert.rejects(() => saveProjectSettings(client, project, { description: "x" }), (error) => {
    assert.ok(error instanceof ProjectWorkspaceError);
    assert.equal(projectErrorKey(error), "projectWorkspace.errors.revisionConflict");
    return true;
  });
  assert.equal(projectErrorKey(new ProjectWorkspaceError(409, "PROJECT_ARCHIVED")), "projectWorkspace.errors.archived");
  assert.equal(projectErrorKey(new Error("boom")), "projectWorkspace.errors.generic");
});

test("deleting a project with materials echoes exactly the summary the user confirmed", async () => {
  const summary = { conversations: 3, materials: 2, memories: 1, revision: 7 };
  const { calls, client } = recorder(json({ deletion: summary }), json({ success: true, detachedConversations: 3, deletedMaterials: 2, deletedMemories: 1 }));
  const plan = await loadProjectDeletionPlan(client, "p1");
  assert.equal(plan.needsConfirmation, true);
  const outcome = await deleteProjectAfterConfirmation(client, "p1", plan);
  assert.equal(outcome.status, "deleted");
  assert.equal(calls[0].path, "/api/projects/p1?view=deletion");
  assert.equal(calls[1].method, "DELETE");
  assert.deepEqual(calls[1].body, { confirmation: { revision: 7, materials: 2, memories: 1 } });
});

test("deleting an empty project sends no confirmation", async () => {
  const summary = { conversations: 2, materials: 0, memories: 0, revision: 3 };
  const { calls, client } = recorder(json({ deletion: summary }), json({ success: true, detachedConversations: 2, deletedMaterials: 0, deletedMemories: 0 }));
  const plan = await loadProjectDeletionPlan(client, "p1");
  assert.equal(plan.needsConfirmation, false);
  await deleteProjectAfterConfirmation(client, "p1", plan);
  assert.equal(calls[1].body, undefined);
});

test("a stale delete returns the new summary for re-confirmation and never reuses the old one", async () => {
  const fresh = { conversations: 3, materials: 5, memories: 1, revision: 9 };
  const { calls, client } = recorder(json({ code: "PROJECT_DELETE_STALE", details: fresh }, 409));
  const old = { summary: { conversations: 3, materials: 2, memories: 1, revision: 7 }, needsConfirmation: true };
  const outcome = await deleteProjectAfterConfirmation(client, "p1", old);
  assert.equal(outcome.status, "stale");
  assert.deepEqual(outcome.plan.summary, fresh);
  assert.equal(outcome.plan.needsConfirmation, true);
  assert.equal(calls.length, 1);
});

test("a stale delete without details re-reads the summary", async () => {
  const fresh = { conversations: 1, materials: 0, memories: 4, revision: 2 };
  const { calls, client } = recorder(json({ code: "PROJECT_DELETE_STALE" }, 409), json({ deletion: fresh }));
  const outcome = await deleteProjectAfterConfirmation(client, "p1", { summary: { ...fresh, revision: 1 }, needsConfirmation: true });
  assert.equal(outcome.status, "stale");
  assert.equal(calls[1].path, "/api/projects/p1?view=deletion");
  assert.deepEqual(outcome.plan.summary, fresh);
});

test("references are unique, capped at eight and omitted when empty", () => {
  const hit = (n) => ({ ref: `ref-${n}`, location: { kind: "message" }, title: "t", role: null, snippet: "s" });
  let selected = [];
  for (let n = 0; n < 10; n += 1) selected = toggleProjectReference(selected, hit(n));
  assert.equal(selected.length, 8);
  assert.equal(toggleProjectReference(selected, hit(0)).length, 7);
  assert.deepEqual(projectReferenceFields([]), {});
  assert.deepEqual(projectReferenceFields(undefined), {});
  assert.deepEqual(projectReferenceFields(["ref-1", "ref-1", "ref-2", "x"]), { projectReferences: ["ref-1", "ref-2"] });
});

test("explicit references ride on the context preparation request body", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ contextBundle: "signed" });
  });
  const base = { conversationId: "c1", modelIds: ["m"], prompt: "q" };
  assert.equal(await prepareChatContextBundle({ ...base, projectReferences: ["ref-a", "ref-b"] }), "signed");
  assert.deepEqual(bodies[0].projectReferences, ["ref-a", "ref-b"]);
  await prepareChatContextBundle(base);
  assert.equal("projectReferences" in bodies[1], false);
});

test("a save retried after a network error reuses its client request id; a finished save does not", () => {
  let n = 0;
  const memo = createRequestIdMemo(() => `id-${++n}`);
  const key = materialIntentKey("p1", { sourceKind: "generated_artifact", artifactId: "a1" });
  assert.equal(memo.get(key), memo.get(key));
  assert.notEqual(key, materialIntentKey("p2", { sourceKind: "generated_artifact", artifactId: "a1" }));
  const first = memo.get(key);
  memo.release(key);
  assert.notEqual(memo.get(key), first);
});

test("saving a source sends the shared client request id to from-source", async () => {
  const { calls, client } = recorder(json({ created: true, file: { id: "f1" } }), json({ created: false, file: { id: "f1" } }));
  await client.saveSource("p1", { sourceKind: "research_report", runId: "r1" }, "req-1");
  await client.saveSource("p1", { sourceKind: "research_report", runId: "r1" }, "req-1");
  assert.equal(calls[0].path, "/api/projects/p1/materials/from-source");
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal(calls[0].body.clientRequestId, "req-1");
});

test("moving a memory to personal warns that other chats may use it; moving into a project does not", () => {
  assert.equal(memoryMoveWarning({ projectId: "p1" }, null), "personal_wide");
  assert.equal(memoryMoveWarning({ projectId: null }, "p1"), null);
  assert.equal(memoryMoveWarning({ projectId: "p1" }, "p2"), null);
});

test("moving a chat names what changes for the next answers", () => {
  const on = { contextEnabled: true };
  const off = { contextEnabled: false };
  assert.equal(conversationMoveEffect(null, on), "gains_context");
  assert.equal(conversationMoveEffect(on, null), "loses_context");
  assert.equal(conversationMoveEffect(on, on), "switches_context");
  assert.equal(conversationMoveEffect(off, null), "folder_only");
});

test("material failures map to an owner-actionable reason", () => {
  assert.equal(materialFailureKey("ASSISTANT_KNOWLEDGE_NO_TEXT"), "projectWorkspace.materials.failure.noText");
  assert.equal(materialFailureKey("ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE"), "projectWorkspace.materials.failure.unsupported");
  assert.equal(materialFailureKey(null), "projectWorkspace.materials.failure.unknown");
});

test("the workspace route round-trips through the query string and keeps unrelated parameters", () => {
  assert.deepEqual(parseProjectWorkspaceRoute("?project=abc123&projectTab=materials"), { kind: "project", projectId: "abc123", tab: "materials" });
  assert.deepEqual(parseProjectWorkspaceRoute("?project=abc123&projectTab=bogus"), { kind: "project", projectId: "abc123", tab: "overview" });
  assert.deepEqual(parseProjectWorkspaceRoute("?project=new"), { kind: "new" });
  assert.equal(parseProjectWorkspaceRoute("?project=../etc"), null);
  assert.equal(parseProjectWorkspaceRoute("?conversation=c1"), null);
  const search = projectWorkspaceSearch({ kind: "project", projectId: "abc123", tab: "memories" }, "?conversation=c1&lang=ko");
  assert.equal(search, "?conversation=c1&lang=ko&project=abc123&projectTab=memories");
  assert.equal(projectWorkspaceSearch(null, search), "?conversation=c1&lang=ko");
  assert.equal(projectWorkspaceSearch({ kind: "project", projectId: "abc123", tab: "overview" }, ""), "?project=abc123");
});
