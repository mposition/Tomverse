import assert from "node:assert/strict";
import test from "node:test";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";
import { ProjectWorkspaceError } from "../packages/api-client/src/projectWorkspace.ts";
import {
  MAX_PROJECT_REFERENCES, classifyProjectFailure, createLatestGuard, deletionConfirmation, deletionSummaryFromError, emptySelection,
  failureMessage, projectSendBlock, receiptGroups, selectionFor, toggleReference,
} from "../apps/mobile/src/projectWorkspaceState.ts";
import { mobileProjectsCopy, projectText } from "../locales/mobileProjects.ts";
import { mobileErrorText } from "../locales/mobileErrors.ts";
import { mobileLanguages } from "../locales/mobile.ts";

const bridge = { hasSession: async () => ({ signedIn: true }), signIn: async () => {}, signOut: async () => {} };
const signal = () => new AbortController().signal;

/** A fake server for one project conversation. `contextReplies` and `chatReplies` script the answers in order. */
function fixture({ contextReplies = [], chatReplies = [], projectId = "project-a", workspace = true } = {}) {
  const calls = [];
  const conversation = { id: "conversation-a", title: "Test", selectedModels: ["fixture-model"], messages: [], responseAttempts: [], projectId };
  let contexts = 0; let chats = 0;
  const run = async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/api/chat/location-intent") return Response.json({ requiresLocation: false });
    if (path === "/api/user/account") return Response.json({ id: "owner", actionsEnabled: false });
    if (path === "/api/products/mobile/capabilities") return Response.json({ reviewEasy: false, assistants: false, maxModels: 3, plan: "Pro", projectWorkspace: workspace });
    if (path === "/api/products/chat/conversations") return Response.json({ id: conversation.id });
    if (path === "/api/conversations/conversation-a/messages") {
      const input = JSON.parse(init.body).messages[0];
      conversation.messages.push({ id: "source-1", role: "user", content: input.content });
      return Response.json({ messageMappings: [{ requestId: input.clientRequestId, messageId: "source-1" }] });
    }
    if (path === "/api/conversations/conversation-a") return Response.json(conversation);
    if (path === "/api/chat/context") {
      const reply = contextReplies[contexts++] ?? { contextBundle: `bundle-${contexts}` };
      return reply instanceof Response ? reply : Response.json(reply);
    }
    if (path === "/api/chat") {
      const reply = chatReplies[chats++];
      if (reply) return reply;
      const body = JSON.parse(init.body);
      conversation.messages.push({ id: body.assistantMessageId, role: "assistant", content: "ok", status: "normal" });
      const bytes = new TextEncoder().encode("ok\u0000TOMVERSE_SEARCH_METADATA" + JSON.stringify({ completion: { status: "normal" } }));
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
    }
    throw Error(`Unexpected request ${path}`);
  };
  return { transport: createApiTransport(run, bridge), conversation, calls, run };
}
const stale = (refusalReason) => Response.json({ code: "CHAT_CONTEXT_BUNDLE_STALE", details: { refusalReason } }, { status: 409 });

test("a project's new Chat is created inside the project, before the first Send", async () => {
  const f = fixture();
  await f.transport.create(undefined, undefined, "project-a");
  const create = f.calls.find(call => call.path === "/api/products/chat/conversations");
  assert.equal(create.body.projectId, "project-a");
  await f.transport.create("Plain");
  assert.equal(f.calls.filter(call => call.path === "/api/products/chat/conversations").at(-1).body.projectId, undefined);
});

test("a project conversation prepares context first and sends the same bundle and references", async () => {
  const f = fixture();
  await f.transport.account();
  await f.transport.send(f.conversation, "What did we decide?", [], signal(), () => {}, { projectReferences: ["msg:a:1", "mat:2"] });
  const paths = f.calls.map(call => call.path);
  assert.ok(paths.indexOf("/api/chat/context") !== -1 && paths.indexOf("/api/chat/context") < paths.indexOf("/api/chat"));
  const context = f.calls.find(call => call.path === "/api/chat/context").body;
  const chat = f.calls.find(call => call.path === "/api/chat").body;
  assert.equal(context.conversationId, "conversation-a");
  assert.deepEqual(context.projectReferences, ["msg:a:1", "mat:2"]);
  assert.equal(chat.contextBundle, "bundle-1");
  assert.deepEqual(chat.projectReferences, ["msg:a:1", "mat:2"]);
});

test("a conversation outside a project never prepares context", async () => {
  const f = fixture({ projectId: null });
  await f.transport.account();
  await f.transport.send(f.conversation, "Hello", [], signal(), () => {});
  assert.equal(f.calls.some(call => call.path === "/api/chat/context"), false);
  assert.equal("contextBundle" in f.calls.find(call => call.path === "/api/chat").body, false);
});

test("a stale context bundle is prepared again exactly once and the send retried", async () => {
  const f = fixture({ chatReplies: [stale("changed")] });
  await f.transport.account();
  await f.transport.send(f.conversation, "Question", [], signal(), () => {}, { projectReferences: ["mat:2"] });
  const contexts = f.calls.filter(call => call.path === "/api/chat/context");
  const chats = f.calls.filter(call => call.path === "/api/chat");
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1].body.previousContextBundle, "bundle-1");
  assert.equal(chats.length, 2);
  assert.equal(chats[0].body.contextBundle, "bundle-1");
  assert.equal(chats[1].body.contextBundle, "bundle-2");
  assert.deepEqual(chats[1].body.projectReferences, ["mat:2"]);
});

test("a stale refusal that already consumed the bundle is not retried", async () => {
  const f = fixture({ chatReplies: [stale("already_consumed")] });
  await f.transport.account();
  await assert.rejects(f.transport.send(f.conversation, "Question", [], signal(), () => {}));
  assert.equal(f.calls.filter(call => call.path === "/api/chat/context").length, 1);
  assert.equal(f.calls.filter(call => call.path === "/api/chat").length, 1);
});

test("a second stale refusal is not retried a second time", async () => {
  const f = fixture({ chatReplies: [stale("changed"), stale("changed")] });
  await f.transport.account();
  await assert.rejects(f.transport.send(f.conversation, "Question", [], signal(), () => {}));
  assert.equal(f.calls.filter(call => call.path === "/api/chat/context").length, 2);
  assert.equal(f.calls.filter(call => call.path === "/api/chat").length, 2);
});

test("signing out discards the result of a project request that was already in flight", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture();
  const transport = createApiTransport(async (path, init) => {
    if (path === "/api/projects") { await gate; return Response.json({ projects: [{ id: "project-a", name: "Old account" }] }); }
    return f.run(path, init);
  }, bridge);
  await transport.account();
  const pending = transport.projects.list();
  await transport.signOut();
  release();
  await assert.rejects(pending, { name: "AbortError" });
});

test("a 401 on a project route that is really a lost session discards the in-flight result and signs out", async () => {
  let lost = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const transport = createApiTransport(async path => {
    if (path === "/api/projects/project-a") { await gate; return Response.json({ code: "MOBILE_TOKEN_INVALID" }, { status: 401 }); }
    if (path === "/api/projects") return Response.json({ projects: [] });
    return Response.json({ code: "MOBILE_TOKEN_INVALID" }, { status: 401 });
  }, bridge);
  transport.onSessionLost(() => { lost++; });
  const pending = transport.projects.detail("project-a");
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(lost, 1);
});

test("a project route switched off for this device does not sign the user out", async () => {
  let lost = 0;
  const transport = createApiTransport(async path => {
    if (path === "/api/user/account") return Response.json({ id: "owner" });
    return Response.json({ code: "MOBILE_TOKEN_INVALID" }, { status: 401 });
  }, bridge);
  transport.onSessionLost(() => { lost++; });
  await assert.rejects(transport.projects.list(), error => error instanceof ProjectWorkspaceError && error.status === 503);
  assert.equal(lost, 0);
  assert.equal(classifyProjectFailure(new ProjectWorkspaceError(503, "NATIVE_ROUTE_UNAVAILABLE")), "unavailable");
});

test("a project route answering 503 is unavailable and never signs the user out", async () => {
  let lost = 0;
  const calls = [];
  const transport = createApiTransport(async path => {
    calls.push(path);
    return Response.json({ code: "NATIVE_PROJECT_WORKSPACE_UNAVAILABLE" }, { status: 503 });
  }, bridge);
  transport.onSessionLost(() => { lost++; });
  await assert.rejects(transport.projects.list(), error => classifyProjectFailure(error) === "unavailable");
  assert.equal(lost, 0);
  assert.deepEqual(calls, ["/api/projects"]);
});

test("with the project workspace switch off, a folder conversation still sends, without a bundle, and keeps the session", async () => {
  // The server alone decides: a folder-era project (context off) answers; a
  // project whose context is on refuses the turn because none was prepared.
  let lost = 0;
  const f = fixture({ contextReplies: [Response.json({ code: "NATIVE_PROJECT_WORKSPACE_UNAVAILABLE" }, { status: 503 })] });
  f.transport.onSessionLost(() => { lost++; });
  await f.transport.account();
  await f.transport.send(f.conversation, "Question", [], signal(), () => {});
  const chat = f.calls.find(call => call.path === "/api/chat");
  assert.ok(chat);
  assert.equal(chat.body.contextBundle, undefined);
  assert.equal(lost, 0);
});

test("where the server does not serve the workspace, a folder conversation never calls context preparation", async () => {
  // With the switch off the edge refuses /api/chat/context before any handler
  // (an unregistered bearer POST fails the origin check), so it is not called.
  const f = fixture({ workspace: false });
  await f.transport.account();
  await f.transport.send(f.conversation, "Question", [], signal(), () => {});
  assert.equal(f.calls.some(call => call.path === "/api/chat/context"), false);
  const chat = f.calls.find(call => call.path === "/api/chat");
  assert.ok(chat);
  assert.equal(chat.body.contextBundle, undefined);
});

test("any other context preparation failure stops the send before /api/chat", async () => {
  const f = fixture({ contextReplies: [Response.json({ code: "PROJECT_REQUEST_FAILED" }, { status: 500 })] });
  await f.transport.account();
  await assert.rejects(f.transport.send(f.conversation, "Question", [], signal(), () => {}));
  assert.equal(f.calls.some(call => call.path === "/api/chat"), false);
});

test("a personal memory is moved into the project with its own revision, and conflicts are classified", async () => {
  const calls = [];
  const transport = createApiTransport(async (path, init = {}) => {
    calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/api/projects/project-a/memories?scope=personal") return Response.json({ memories: [{ id: "m1", revision: 4, statement: "x" }], total: 1 });
    if (path === "/api/memories/m1/scope") return calls.filter(call => call.path === path).length === 1
      ? Response.json({ moved: true, projectId: "project-a" })
      : Response.json({ code: "MEMORY_ITEM_CONFLICT" }, { status: 409 });
    throw Error(path);
  }, bridge);
  const [memory] = (await transport.projects.personalMemories("project-a")).memories;
  assert.deepEqual(await transport.projects.moveMemory(memory.id, memory.revision, "project-a"), { moved: true, projectId: "project-a" });
  assert.deepEqual(calls.at(-1).body, { expectedRevision: 4, targetProjectId: "project-a" });
  await assert.rejects(transport.projects.moveMemory(memory.id, memory.revision, "project-a"), error => classifyProjectFailure(error) === "memoryConflict");
  assert.equal(failureMessage(mobileProjectsCopy.ko, "memoryConflict"), mobileProjectsCopy.ko.memoryConflict);
});

test("failures are classified into the message classes the workspace shows", () => {
  const cases = [
    [new ProjectWorkspaceError(409, "PROJECT_REVISION_CONFLICT"), "conflict"],
    [new ProjectWorkspaceError(409, "PROJECT_ARCHIVED"), "archived"],
    [new ProjectWorkspaceError(409, "PROJECT_DELETE_STALE"), "deleteStale"],
    [new ProjectWorkspaceError(409, "PROJECT_DELETE_CONFIRMATION_REQUIRED"), "deleteRequired"],
    [new ProjectWorkspaceError(409, "PROJECT_NAME_TAKEN"), "nameTaken"],
    [new ProjectWorkspaceError(403, "MEMORY_FEATURE_DISABLED"), "memoryOff"],
    [new ProjectWorkspaceError(401, "MOBILE_TOKEN_INVALID"), "unavailable"],
    [new ProjectWorkspaceError(503, "NATIVE_PARITY_UNAVAILABLE"), "unavailable"],
    [new ProjectWorkspaceError(503, "NATIVE_PROJECT_WORKSPACE_UNAVAILABLE"), "unavailable"],
    [new ProjectWorkspaceError(409, "MEMORY_ITEM_CONFLICT"), "memoryConflict"],
    [new ProjectWorkspaceError(409, "MEMORY_ITEM_STATE"), "memoryChanged"],
    [new ProjectWorkspaceError(409, "MEMORY_SOURCE_LOCKED"), "memoryLocked"],
    [new ProjectWorkspaceError(500, "PROJECT_REQUEST_FAILED"), "failed"],
    [new DOMException("Session changed", "AbortError"), "aborted"],
  ];
  for (const [error, expected] of cases) assert.equal(classifyProjectFailure(error), expected);
});

test("a project delete confirmation echoes the shown summary, and only when content would be lost", () => {
  assert.deepEqual(deletionConfirmation({ conversations: 3, materials: 2, memories: 1, revision: 7 }), { revision: 7, materials: 2, memories: 1 });
  assert.equal(deletionConfirmation({ conversations: 3, materials: 0, memories: 0, revision: 7 }), undefined);
  const stale = new ProjectWorkspaceError(409, "PROJECT_DELETE_STALE", { conversations: 3, materials: 4, memories: 1, revision: 8 });
  assert.deepEqual(deletionSummaryFromError(stale), { conversations: 3, materials: 4, memories: 1, revision: 8 });
  assert.equal(deletionSummaryFromError(new ProjectWorkspaceError(409, "PROJECT_DELETE_STALE", { materials: "x" })), null);
});

test("picked references are limited, toggled, and belong to one account, conversation and project", () => {
  const ref = (id) => ({ ref: `msg:${id}`, title: id, kind: "message" });
  let items = [];
  for (let index = 0; index < MAX_PROJECT_REFERENCES + 2; index++) items = toggleReference(items, ref(index));
  assert.equal(items.length, MAX_PROJECT_REFERENCES);
  assert.equal(toggleReference(items, ref(0)).length, MAX_PROJECT_REFERENCES - 1);
  const selection = { owner: "a", conversationId: "c", projectId: "p", items };
  assert.equal(selectionFor(selection, "a", "c", "p").length, MAX_PROJECT_REFERENCES);
  for (const other of [["b", "c", "p"], ["a", "d", "p"], ["a", "c", "q"], ["a", null, "p"]]) assert.deepEqual(selectionFor(selection, ...other), []);
  assert.deepEqual(selectionFor(emptySelection, "a", "c", "p"), []);
});

test("only the newest request may apply its result", () => {
  const guard = createLatestGuard();
  const first = guard.begin(); const second = guard.begin();
  assert.equal(first(), false); assert.equal(second(), true);
  guard.invalidate();
  assert.equal(second(), false);
});

test("a receipt separates what was sent as context from what the model looked up", () => {
  const receipt = { projectId: "p", createdAt: "now", sources: [
    { ref: "a", kind: "message", title: "A", via: "context" }, { ref: "b", kind: "material", title: "B", via: "tool" }, { ref: "c", kind: "material", title: "C", via: "context" } ] };
  const groups = receiptGroups(receipt);
  assert.deepEqual(groups.context.map(source => source.ref), ["a", "c"]);
  assert.deepEqual(groups.tool.map(source => source.ref), ["b"]);
  assert.deepEqual(receiptGroups(null), { context: [], tool: [] });
});

test("an archived or unreachable project blocks the send before anything is saved", () => {
  assert.equal(projectSendBlock({ archivedAt: "2026-11-01T00:00:00.000Z" }, null), "archived");
  assert.equal(projectSendBlock(null, "unavailable"), "unavailable");
  assert.equal(projectSendBlock({ archivedAt: null }, null), null);
  assert.equal(projectSendBlock(null, null), null);
});

test("every native language has the complete project copy with matching placeholders", () => {
  const english = mobileProjectsCopy.en;
  const keys = Object.keys(english).sort();
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort().join(",");
  assert.deepEqual([...mobileLanguages].sort(), Object.keys(mobileProjectsCopy).sort());
  for (const language of mobileLanguages) {
    const copy = mobileProjectsCopy[language];
    assert.deepEqual(Object.keys(copy).sort(), keys, language);
    for (const key of keys) {
      assert.ok(copy[key].trim(), `${language}.${key}`);
      assert.equal(placeholders(copy[key]), placeholders(english[key]), `${language}.${key}`);
    }
  }
  assert.equal(projectText(english.summaryChats, { count: 3 }), "Conversations: 3");
  assert.match(mobileProjectsCopy.ko.deleteMaterials, /삭제되는 자료/);
});

test("honesty copy never claims automatic memory or model use that the server does not guarantee", () => {
  for (const language of mobileLanguages) {
    assert.ok(mobileProjectsCopy[language].autoMemoryNote.length > 25, language);
    assert.ok(mobileProjectsCopy[language].receiptNote.length > 25, language);
  }
  assert.match(mobileProjectsCopy.en.receiptNote, /not prove/);
  assert.match(mobileProjectsCopy.en.autoMemoryNote, /nothing is saved automatically/i);
});

test("an archived project refusal gets the project copy and the failure helper falls back safely", () => {
  assert.equal(mobileErrorText({ status: 409, code: "PROJECT_ARCHIVED" }, "ko", "x"), mobileProjectsCopy.ko.archivedChat);
  assert.equal(failureMessage(mobileProjectsCopy.en, "failed"), mobileProjectsCopy.en.failed);
  assert.equal(failureMessage(mobileProjectsCopy.en, null), mobileProjectsCopy.en.failed);
  assert.equal(failureMessage(mobileProjectsCopy.en, "conflict"), mobileProjectsCopy.en.conflict);
});
