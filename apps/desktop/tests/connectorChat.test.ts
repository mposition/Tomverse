import test from "node:test";
import assert from "node:assert/strict";
import { buildMcpProgressChunk } from "../../../lib/mcpConnectorProgress";
import { chatConversation, chatTurnInput, type ChatConversation } from "../src/chat-contract";
import { desktopChatApi } from "../src/host/chat-api";

const origin = "https://tomverse.example";
const turn = { requestId: crypto.randomUUID(), prompt: "Find the open issues", modelId: "gpt-6-luna", selectionMode: "manual", effort: "default" } as const;

test("the Chat turn accepts one plugin connection id and nothing else about plugins", () => {
  assert.equal(chatTurnInput.safeParse({ ...turn, mcpConnectionId: "conn_1" }).success, true);
  assert.equal(chatTurnInput.safeParse({ ...turn, mcpConnectionId: "../x" }).success, false);
  assert.equal(chatTurnInput.safeParse({ ...turn, mcpServerId: "github" }).success, false);
  assert.equal(chatTurnInput.safeParse({ ...turn, mcpConnectionId: "x".repeat(101) }).success, false);
});

function conversation(): ChatConversation {
  return chatConversation.parse({ id: "chat-1", title: "t", kind: "chat", surface: "chat", productKey: "chat", selectionMode: "manual",
    selectedModels: ["gpt-6-luna"], autoSelection: { offered: false }, messagePage: { nextCursor: null }, webSearchMode: "off",
    messages: [{ id: "question-1", role: "user", content: "Find the open issues", status: "normal" }] });
}

async function streamWith(mcpConnectionId: string | undefined) {
  const requests: Array<{ path: string; body?: Record<string, unknown>; headers: Headers }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, headers: new Headers(init?.headers) });
    if (url.pathname === "/api/chat/context") return Response.json({ ok: true, contextBundle: "signed-bundle" });
    return new Response(buildMcpProgressChunk("searching") + "Here are the issues.", { headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  try {
    const seen: Array<{ text: string; mcp?: string }> = [];
    const api = desktopChatApi("desktop-token", new AbortController().signal, origin);
    await api.stream(conversation(), { modelId: "gpt-6-luna", selectionMode: "manual", effort: "default", mcpConnectionId },
      "question-1", "answer-1", new AbortController().signal, (text, mcp) => seen.push({ text, mcp }));
    return { requests, seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a chosen plugin rides on the Chat turn without a signed-context step and reports its progress", async () => {
  const { requests, seen } = await streamWith("conn_1");
  assert.deepEqual(requests.map(({ path }) => path), ["/api/chat"]);
  assert.equal(requests[0].body?.mcpConnectionId, "conn_1");
  assert.equal(requests[0].body?.contextBundle, undefined);
  assert.equal(requests[0].headers.get("authorization"), "Bearer desktop-token");
  assert.equal(requests[0].headers.get("cookie"), null);
  assert.ok(seen.some(({ mcp }) => mcp === "searching"));
  assert.equal(seen.at(-1)?.text, "Here are the issues.");
});

test("without a plugin the Chat turn is unchanged", async () => {
  const { requests } = await streamWith(undefined);
  assert.deepEqual(requests.map(({ path }) => path), ["/api/chat/context", "/api/chat"]);
  assert.equal("mcpConnectionId" in (requests[1].body ?? {}), false);
  assert.equal(requests[1].body?.contextBundle, "signed-bundle");
});
