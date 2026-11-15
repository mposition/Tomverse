import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { ASSISTANT_PROMPT_FORMAT_VERSION } from "@/lib/assistantProfileVersioning";
import { parseChatStreamTrailer, splitSearchMetadataTrailer } from "@/lib/webSearchStreamTrailer";
import { splitStreamKeepaliveSignal } from "@/lib/chatStreamKeepalive";
import { createConversationUnlockCookie } from "@/lib/conversationLock";

// Only authentication and the paid model transport are replaced. Admission,
// fake Brave, the AI SDK loop, reservations, settlement and persistence are real.
const root = resolve(import.meta.dirname, "../..");
const mod = (file: string) => pathToFileURL(resolve(root, file)).href;
const modelId = "gemini-3-1-pro";
const question = "Compare the public release notes for two products.";
let session: unknown = null;
let activeModel: MockLanguageModelV4;
mock.module("next-auth/next", { namedExports: { getServerSession: async () => session } });
mock.module(mod("lib/chatRouteSession.ts"), { namedExports: { resolveChatRouteSession: async () => ({ session }) } });
mock.module(mod("lib/researchPreviewPageRead.ts"), { namedExports: {
  readResearchPage: async ({ sourceId, sources }: { sourceId: string; sources: Array<{ sourceId: string; url: string }> }) => ({
    sourceId, url: sources.find(source => source.sourceId === sourceId)!.url, status: "read", readAt: new Date().toISOString(),
    content: "<html>BOUNDED_ORIGINAL_PAGE_SENTINEL</html>", contentType: "text/html", truncated: true,
  }),
} });
mock.module(mod("lib/activeAiModel.ts"), { namedExports: {
  getActiveAiModel: () => activeModel,
  qwenLookupStep: () => undefined,
  QWEN_GROUNDED_THINKING_BUDGET: 128,
} });
mock.module(mod("lib/researchPreviewModel.ts"), { namedExports: { getResearchPreviewAiModel: () => activeModel } });

process.env.RESEARCH_PREVIEW_ENABLED = "true";
process.env.RESEARCH_PREVIEW_MODEL_IDS = modelId;
process.env.WEB_SEARCH_FAKE_BACKEND = "1";
process.env.GOOGLE_GENERATIVE_AI_API_KEY = "synthetic-model-never-sent";
process.env.CHAT_PROVIDER_GOOGLE_COST_MICROUSD_PER_DAY = "1000000000";
process.env.CHAT_PROVIDER_GOOGLE_COST_MICROUSD_PER_MONTH = "1000000000";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let POST: (request: Request) => Promise<Response>;
const users: string[] = [];
const contextFlagKeys = ["feature.memoryInjectionEnabled", "feature.assistantProfilesEnabled", "feature.assistantKnowledgeEnabled"];
let originalContextFlags: Array<{ key: string; value: string }> = [];
const realFetch = globalThis.fetch;
const realInfo = console.info;
const unexpectedNetwork: string[] = [];
const stoppedReasons: string[] = [];
before(async () => {
  console.info = (...args: unknown[]) => {
    try {
      const record = JSON.parse(String(args[0]));
      if (record?.event === "research_preview_stopped") stoppedReasons.push(record.stopReason);
    } catch { /* Ordinary log lines are not structured Research events. */ }
    realInfo(...args);
  };
  globalThis.fetch = (async (url: unknown) => {
    unexpectedNetwork.push(String(url));
    throw new Error("Offline Research fixture refuses network requests");
  }) as typeof fetch;
  ({ prisma } = await import(mod("lib/prisma.ts")));
  originalContextFlags = await prisma.appSetting.findMany({ where: { key: { in: contextFlagKeys } }, select: { key: true, value: true } });
  ({ POST } = await import(mod("app/api/chat/route.ts")));
});
beforeEach(() => { session = null; unexpectedNetwork.length = 0; stoppedReasons.length = 0; });
after(async () => {
  globalThis.fetch = realFetch;
  console.info = realInfo;
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  for (const key of contextFlagKeys) {
    const previous = originalContextFlags.find((row) => row.key === key);
    if (previous) await prisma.appSetting.upsert({ where: { key }, create: previous, update: { value: previous.value } });
    else await prisma.appSetting.deleteMany({ where: { key } });
  }
  await prisma.$disconnect();
});

async function fixture(profileTools = { webSearch: true, deepResearch: true }) {
  const user = await prisma.user.create({ data: { email: `research-route-${randomUUID()}@example.test`,
    plan: "Pro", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
  users.push(user.id);
  session = { user: { id: user.id, email: user.email } };
  const profile = await prisma.assistantProfile.create({ data: { userId: user.id, name: "Private fixture" } });
  const version = await prisma.assistantProfileVersion.create({ data: {
    profileId: profile.id, userId: user.id, revision: 1, instructions: "PRIVATE_PROFILE_SENTINEL",
    models: [modelId], toolPolicy: profileTools, memoryPolicy: { useAccountMemory: true },
    starters: [], knowledgeManifest: [], retrievalVersion: 1, promptFormatVersion: ASSISTANT_PROMPT_FORMAT_VERSION,
  } });
  await prisma.assistantProfile.update({ where: { id: profile.id }, data: { currentVersionId: version.id } });
  await prisma.memoryItem.create({ data: { userId: user.id, kind: "preference", statement: "PRIVATE_MEMORY_SENTINEL", confidence: 0.9 } });
  await prisma.userMemorySettings.create({ data: { userId: user.id, masterEnabled: true } });
  for (const key of contextFlagKeys) {
    await prisma.appSetting.upsert({ where: { key }, create: { key, value: "true" }, update: { value: "true" } });
  }
  const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Research route fixture",
    kind: "chat", productKey: "chat", selectionMode: "manual", selectedModels: JSON.stringify([modelId]),
    memoryMode: "on", assistantProfileVersionId: version.id,
    messages: { create: [
      { role: "user", content: "PRIVATE_HISTORY_SENTINEL PRIVATE_IMPORT_BODY_SENTINEL" },
      { role: "assistant", content: "PRIVATE_PREVIOUS_ANSWER_SENTINEL", modelId },
    ] } } });
  const source = await prisma.message.create({ data: { id: randomUUID(), conversationId: conversation.id, role: "user", content: question } });
  return { user, conversation, source, assistantId: randomUUID() };
}

const terminal = {
  status: "partial", summary: "The public excerpts support a limited comparison.",
  findings: [{ heading: "Release notes", statements: [{ text: "The public source describes the release.", sourceIds: ["R4"], kind: "fact" }] }],
  contradictions: [], limitations: ["This synthetic fixture uses search excerpts only."], nextQuestions: ["Which release date should be compared next?"],
};
function scriptedModel(unknownUsage = false, readPage = false) {
  return new MockLanguageModelV4({ provider: "google", modelId: "gemini-3.1-pro-preview", doStream: async () => {
    const index = activeModel.doStreamCalls.length - 1;
    assert.ok(index < 3, "no repair or fallback generation is permitted");
    const part: LanguageModelV4StreamPart = { type: "tool-call", toolCallId: `fixture-${index}`,
      toolName: readPage && index === 1 ? "read_research_sources" : index < 2 ? "web_search" : "submit_research_report",
      input: JSON.stringify(readPage && index === 1 ? { sourceIds: ["R1"] } : index < 2 ? { query: index === 0 ? "first public product" : "second public product" } : readPage
        ? { ...terminal, findings: terminal.findings.map(finding => ({ ...finding, statements: finding.statements.map(statement => ({ ...statement, sourceIds: ["R1"], evidenceLevel: "page_text" })) })) } : terminal) };
    return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
      controller.enqueue(part);
      controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "fixture" }, usage: {
        inputTokens: { total: 200 + index * 100, noCache: 200 + index * 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: unknownUsage ? { total: undefined, text: undefined, reasoning: undefined }
          : { total: 100 + index * 100, text: 80 + index * 100, reasoning: 20 },
      } });
      controller.close();
    } }) };
  } });
}
function request(input: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return new Request("http://127.0.0.1:3100/api/chat", { method: "POST",
    headers: { "Content-Type": "application/json", "Accept-Language": "en" }, body: JSON.stringify({
      researchMode: "preview", webSearchMode: "always", modelId,
      conversationId: input.conversation.id, assistantMessageId: input.assistantId, sourceUserMessageId: input.source.id,
      messages: [{ id: input.source.id, role: "user", content: question }], ...overrides,
    }) });
}

test("real Chat route stores a tool-only report, isolates private context and settles all three SDK steps", async () => {
  const input = await fixture();
  activeModel = scriptedModel();
  const response = await POST(request(input));
  assert.equal(response.status, 200, await (response.status === 200 ? Promise.resolve("") : response.text()));
  const raw = await response.text();
  const split = splitSearchMetadataTrailer(raw);
  const displayedContent = splitStreamKeepaliveSignal(split.displayText).text;
  const trailer = parseChatStreamTrailer(split.searchMetadataJson);
  assert.equal(activeModel.doStreamCalls.length, 3);
  assert.deepEqual(activeModel.doStreamCalls.map((call) => call.maxOutputTokens), [4096, 3996, 3796]);
  const prompts = JSON.stringify(activeModel.doStreamCalls.map((call) => call.prompt));
  assert.match(prompts, /Compare the public release notes/);
  assert.doesNotMatch(prompts, /PRIVATE_(?:PROFILE|MEMORY|HISTORY|IMPORT_BODY|PREVIOUS_ANSWER)_SENTINEL/);
  assert.match(displayedContent, /The public excerpts support a limited comparison/);
  const message = await prisma.message.findUniqueOrThrow({ where: { id: input.assistantId } });
  assert.equal(message.content, displayedContent);
  assert.equal((message.searchMetadata as { research: { outcome: string } }).research.outcome, "partial");
  assert.deepEqual(message.searchMetadata, trailer?.searchMetadata);
  const reservation = await prisma.chatCreditReservation.findFirstOrThrow({ where: { userId: input.user.id } });
  assert.equal(reservation.status, "settled");
  assert.equal(reservation.settledInputTokens, 900);
  assert.equal(reservation.settledOutputTokens, 600);
  assert.ok(reservation.settledCostMicroUsd > BigInt(0));
  const repeat = await POST(request(input));
  assert.equal(repeat.headers.get("X-Chat-Response-Mode"), "durable-attempt");
  assert.equal((await repeat.json()).message.content, message.content);
  assert.equal(activeModel.doStreamCalls.length, 3, "reload/retransmit must not dispatch another paid model step");
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: input.conversation.id } });
  assert.equal(conversation.selectedModels, JSON.stringify([modelId]));
  assert.equal(conversation.productKey, "chat");
  assert.deepEqual(unexpectedNetwork, []);
});

test("Research admission rejects a stale unlock grant before dispatch and accepts the current version", async () => {
  const input = await fixture();
  const locked = await prisma.conversation.update({ where: { id: input.conversation.id }, data: { password: "protected" } });
  activeModel = scriptedModel();
  const stale = request(input);
  stale.headers.set("Cookie", createConversationUnlockCookie(input.user.id, locked.id, input.conversation.passwordVersion).split(";", 1)[0]!);
  const denied = await POST(stale);
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).code, "RESEARCH_PREVIEW_UNAVAILABLE");
  assert.equal(activeModel.doStreamCalls.length, 0);
  assert.equal(await prisma.chatCreditReservation.count({ where: { userId: input.user.id } }), 0);
  const current = request(input);
  current.headers.set("Cookie", createConversationUnlockCookie(input.user.id, locked.id, locked.passwordVersion).split(";", 1)[0]!);
  const accepted = await POST(current);
  assert.equal(accepted.status, 200);
  await accepted.text();
  assert.equal(activeModel.doStreamCalls.length, 3);
});

test("Research rejects attached/history payloads and profile prohibitions before any dispatch", async () => {
  const input = await fixture();
  activeModel = scriptedModel();
  for (const messages of [
    [{ role: "user", content: "PRIVATE_HISTORY_SENTINEL" }, { role: "user", content: question }],
    [{ role: "user", content: question, attachments: [{ name: "private.txt", mediaType: "text/plain" }] }],
  ]) {
    const response = await POST(request(input, { messages }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_RESEARCH_PREVIEW_REQUEST");
  }
  const restricted = await fixture({ webSearch: true, deepResearch: false });
  const response = await POST(request(restricted));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "RESEARCH_PREVIEW_UNAVAILABLE");
  assert.equal(activeModel.doStreamCalls.length, 0);
  assert.equal(await prisma.chatCreditReservation.count({ where: { userId: { in: [input.user.id, restricted.user.id] } } }), 0);
  assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: input.source.id } })).content, question);
  assert.deepEqual(unexpectedNetwork, []);
});

test("unknown model usage stops after one dispatched step and never persists an unfinished report", async () => {
  const input = await fixture();
  activeModel = scriptedModel(true);
  const response = await POST(request(input));
  assert.equal(response.status, 200);
  await response.text().catch(() => "");
  assert.equal(activeModel.doStreamCalls.length, 1);
  assert.equal(await prisma.message.findUnique({ where: { id: input.assistantId } }), null);
  const attempt = await prisma.chatResponseAttempt.findUniqueOrThrow({ where: { assistantMessageId: input.assistantId } });
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.partialContent, "");
  const reservation = await prisma.chatCreditReservation.findFirstOrThrow({ where: { userId: input.user.id } });
  assert.ok(reservation.settledCostMicroUsd > BigInt(0), "dispatched unknown usage is not zero provider cost");
  const providerAttempt = await prisma.chatAttemptUsage.findFirstOrThrow({ where: { reservationId: reservation.id } });
  assert.ok(providerAttempt.costMicroUsd > BigInt(0));
  assert.notEqual(providerAttempt.usageSource, "provider_usage_metadata", "unknown usage must remain an estimate, not a measured zero");
  assert.deepEqual(stoppedReasons, ["usage_unknown"], "the underlying unknown-usage cause must survive the text-only transport");
  assert.deepEqual(unexpectedNetwork, []);
});

test("inline page reading uses the reserved feature and saves only curated page evidence", async () => {
  const previous = process.env.RESEARCH_PREVIEW_PAGE_READING_ENABLED;
  process.env.RESEARCH_PREVIEW_PAGE_READING_ENABLED = "true";
  try {
    const input = await fixture();
    activeModel = scriptedModel(false, true);
    const response = await POST(request(input));
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(activeModel.doStreamCalls.length, 3);
    assert.doesNotMatch(JSON.stringify(activeModel.doStreamCalls[1].prompt), /BOUNDED_ORIGINAL_PAGE_SENTINEL/);
    assert.match(JSON.stringify(activeModel.doStreamCalls[2].prompt), /BOUNDED_ORIGINAL_PAGE_SENTINEL/);
    const message = await prisma.message.findUniqueOrThrow({ where: { id: input.assistantId } });
    const metadata = message.searchMetadata as { research: { version: number; evidenceLevel: string } };
    assert.equal(metadata.research.version, 2);
    assert.equal(metadata.research.evidenceLevel, "search_snippets_and_pages");
    assert.doesNotMatch(JSON.stringify(message), /BOUNDED_ORIGINAL_PAGE_SENTINEL/);
    assert.deepEqual(unexpectedNetwork, []);
  } finally {
    if (previous === undefined) delete process.env.RESEARCH_PREVIEW_PAGE_READING_ENABLED;
    else process.env.RESEARCH_PREVIEW_PAGE_READING_ENABLED = previous;
  }
});

test("the already enrolled main Chat endpoint cannot bypass the Native Research flag", async () => {
  const previous = process.env.RESEARCH_PREVIEW_NATIVE_ENABLED;
  delete process.env.RESEARCH_PREVIEW_NATIVE_ENABLED;
  try {
    const input = await fixture();
    activeModel = scriptedModel();
    const incoming = request(input);
    incoming.headers.set("Authorization", "Bearer synthetic-authenticated-owner");
    const response = await POST(incoming);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "RESEARCH_PREVIEW_NATIVE_UNAVAILABLE");
    assert.equal(activeModel.doStreamCalls.length, 0);
    assert.equal(await prisma.chatCreditReservation.count({ where: { userId: input.user.id } }), 0);
  } finally {
    if (previous !== undefined) process.env.RESEARCH_PREVIEW_NATIVE_ENABLED = previous;
  }
});
