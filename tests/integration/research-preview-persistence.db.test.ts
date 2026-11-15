import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildAccountDataExport } from "@/lib/accountDataExport";
import { PUBLIC_CHAT_MESSAGE_SELECT, toPublicChatMessage, readPublicCompletedChatMessage } from "@/lib/publicChatMessage";
import { createResearchEvidenceRegistry, validateAndRenderResearchReport } from "@/lib/researchPreviewReport";
import { buildResearchPreviewMetadata } from "@/lib/researchPreviewMetadata";
import { shareSnapshotSchema } from "@/lib/shareSnapshot";
import { formatExportMessage } from "@/lib/exportConversation";

const userIds: string[] = [];
after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

test("Research content and curated evidence reload/export/share and follow the Message deletion lifetime", async () => {
  const owner = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, plan: "Pro" } });
  const outsider = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, plan: "Pro" } });
  userIds.push(owner.id, outsider.id);
  const conversation = await prisma.conversation.create({ data: {
    userId: owner.id, title: "Public comparison", kind: "chat", productKey: "chat",
    selectedModels: '["gemini-3-flash-preview"]', selectionMode: "manual",
  } });
  const registry = createResearchEvidenceRegistry();
  registry.addToolResult({ status: "ok", searchesRemaining: 4, results: [{
    title: "Public evidence", url: "https://example.com/public-evidence", snippet: "A short cited extract.",
  }] });
  const rendered = validateAndRenderResearchReport({
    registry, allowedSourceIds: registry.sourceIds(), report: {
      status: "partial", summary: "The available excerpts cover part of the question.",
      findings: [{ heading: "Comparison", statements: [{ text: "The source reports this fact.", sourceIds: ["R1"], kind: "fact" }] }],
      contradictions: [], limitations: ["The second product has no recent excerpt."], nextQuestions: ["Can the second product confirm this?"] },
  });
  assert.equal(rendered.ok, true);
  if (!rendered.ok) throw new Error("Expected valid fixture report");
  const research = buildResearchPreviewMetadata({ outcome: rendered.outcome,
    startedAt: "2026-11-14T22:00:00Z", completedAt: "2026-11-14T22:01:00Z",
    stopReason: "report_submitted", citedSources: rendered.citedSources });
  const searchMetadata = { requested: true, supported: true, executed: true, provider: "google",
    citations: rendered.citations, executionKind: "app_managed", searchBackend: "brave",
    costMetadata: { internalCostSentinel: 25000 }, research: { ...research, rawPayload: "private-sentinel" } };
  const message = await prisma.message.create({ data: { conversationId: conversation.id,
    role: "assistant", modelId: "gemini-3-flash-preview", content: rendered.content,
    searchMetadata: searchMetadata as unknown as Prisma.InputJsonValue } });

  const stored = await prisma.message.findUniqueOrThrow({ where: { id: message.id }, select: PUBLIC_CHAT_MESSAGE_SELECT });
  const reloaded = toPublicChatMessage(stored);
  assert.equal(reloaded.content, rendered.content);
  assert.deepEqual((reloaded.searchMetadata as { research: unknown }).research, research);
  assert.match(reloaded.content, /\[1\]\(<https:\/\/example.com\/public-evidence>\)/);
  const attempt = { assistantMessageId: message.id, conversationId: conversation.id,
    actualModelId: message.modelId, requestedModelId: message.modelId! };
  assert.equal((await readPublicCompletedChatMessage(owner.id, attempt))?.id, message.id);
  assert.equal(await readPublicCompletedChatMessage(outsider.id, attempt), null);

  const exported = await buildAccountDataExport(owner.id);
  const exportedConversation = (exported.data.conversations as Array<{ id: string; messages: Array<Record<string, unknown>> }>).find((row) => row.id === conversation.id);
  assert.ok(exportedConversation);
  assert.deepEqual(exportedConversation.messages[0].research, research);
  assert.equal(exportedConversation.messages[0].content, rendered.content);
  assert.doesNotMatch(JSON.stringify(exportedConversation), /internalCostSentinel|rawPayload|private-sentinel/);

  const share = shareSnapshotSchema.parse({ version: 1, title: conversation.title,
    conversationCreatedAt: conversation.createdAt.toISOString(), sharedAt: new Date().toISOString(),
    messages: [{ id: message.id, role: "assistant", content: message.content, modelId: message.modelId,
      createdAt: message.createdAt.toISOString() }] });
  assert.match(share.messages[0].content, /public-evidence/);
  assert.match(formatExportMessage({ role: "assistant", content: message.content, modelId: message.modelId, createdAt: message.createdAt }), /public-evidence/);

  const followup = await prisma.message.create({ data: { conversationId: conversation.id, role: "user", content: "Explain the first finding." } });
  assert.equal(followup.searchMetadata, null);
  const unchanged = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
  assert.equal(unchanged.selectedModels, conversation.selectedModels);
  assert.equal(unchanged.productKey, "chat");
  await prisma.conversation.delete({ where: { id: conversation.id } });
  assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), 0);
  assert.equal((await buildAccountDataExport(owner.id)).data.conversations.length, 0);

  const accountConversation = await prisma.conversation.create({ data: { userId: outsider.id,
    title: "Account deletion", kind: "chat", productKey: "chat", selectedModels: '["gemini-3-flash-preview"]',
    messages: { create: { role: "assistant", content: rendered.content,
      searchMetadata: searchMetadata as unknown as Prisma.InputJsonValue } } } });
  await prisma.user.delete({ where: { id: outsider.id } });
  assert.equal(await prisma.message.count({ where: { conversationId: accountConversation.id } }), 0);
});
