import "server-only";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from
  "@/lib/apiSecurity";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { PromptRefinerChatExecutionError } from
  "@/lib/promptRefinerChatExecutionCore";
import {
  advancePromptRefinerChatScope,
  capturePromptRefinerChatDraft,
} from "@/lib/promptRefinerChatExecutionStore";
import { promptRefinerChatExecutionRelease } from
  "@/lib/promptRefinerChatExecutionRelease";
import {
  promptRefinerProductPrepareRequestSchema,
  promptRefinerProductProposalRequestSchema,
  promptRefinerProductScopeRequestSchema,
} from "@/lib/promptRefinerProductApiContract";
import { preparePromptRefinerProductSuggestion } from
  "@/lib/promptRefinerProductService";
import { PROMPT_REFINER_PRODUCT_TIMEOUT_MS } from
  "@/lib/promptRefinerProductContract";
import { prisma } from "@/lib/prisma";

const headers = { "Cache-Control": "private, no-store, max-age=0" };
const unavailable = () => Response.json(
  { code: "PROMPT_REFINER_UNAVAILABLE" }, { status: 503, headers });
const stale = () => Response.json(
  { code: "PROMPT_REFINER_STALE" }, { status: 409, headers });
export type PromptRefinerProductRequestDeadline = Readonly<{
  requestedAt: Date;
  deadlineAtMonotonicMs: number;
}>;

async function conversationAccessible(request: Request, userId: string,
  conversationId: string) {
  const row = await prisma.conversation.findFirst({ where: {
    id: conversationId, userId, kind: "chat", productKey: "chat",
  }, select: { password: true } });
  return Boolean(row && hasConversationUnlockGrant(request, userId,
    conversationId, row.password));
}

export async function handlePromptRefinerProductScope(request: Request,
  userId: string) {
  await consumeApiRateLimit(request, userId, "prompt-refiner-product-scope",
    { minute: 60, day: 2_000 });
  const release = await promptRefinerChatExecutionRelease();
  if (!release.explicitEnabled && !release.autoEnabled) return unavailable();
  const body = await readLimitedJson(request, 4 * 1024,
    promptRefinerProductScopeRequestSchema);
  if (body.surface !== "chat" ||
      !await conversationAccessible(request, userId, body.conversationId)) {
    return stale();
  }
  const scope = await advancePromptRefinerChatScope({ userId,
    mountId: body.mountId, conversationId: body.conversationId,
    surface: body.surface });
  return Response.json({ scopeId: scope.id, epoch: scope.epoch }, { headers });
}

async function capture(request: Request, userId: string, body: {
  conversationId: string; scopeId: string; epoch: number;
  draftRevision: number;
}) {
  if (!await conversationAccessible(request, userId, body.conversationId)) {
    throw new PromptRefinerChatExecutionError();
  }
  return capturePromptRefinerChatDraft({ userId,
    conversationId: body.conversationId, scopeId: body.scopeId,
    epoch: body.epoch, expectedDraftRevision: body.draftRevision });
}

export async function handlePromptRefinerProductProposal(request: Request,
  userId: string, requestDeadline?: PromptRefinerProductRequestDeadline) {
  const requestedAt = requestDeadline?.requestedAt ?? new Date();
  const deadlineAtMonotonicMs = requestDeadline?.deadlineAtMonotonicMs ??
    performance.now() + PROMPT_REFINER_PRODUCT_TIMEOUT_MS;
  await consumeApiRateLimit(request, userId, "prompt-refiner-product-proposal",
    { minute: 30, day: 1_000 });
  const body = await readLimitedJson(request, 4 * 1024,
    promptRefinerProductProposalRequestSchema);
  const snapshot = await capture(request, userId, body);
  const result = await preparePromptRefinerProductSuggestion({ snapshot,
    mode: "explicit", requestedAt, deadlineAtMonotonicMs });
  if (result.outcome === "original_fallback") {
    return Response.json({ code: "PROMPT_REFINER_FALLBACK_ORIGINAL",
      reason: result.reason }, { headers });
  }
  const held = result.held;
  return Response.json({ requestId: held.requestId,
    suggestionId: held.suggestionId, refinedPrompt: held.refinedPrompt,
    refinerVersion: held.refinerVersion, inputScope: held.inputScope,
    scopeId: held.scopeId, epoch: held.epoch,
    clientRequestId: held.clientRequestId }, { headers });
}

export async function handlePromptRefinerProductPrepare(request: Request,
  userId: string, requestDeadline?: PromptRefinerProductRequestDeadline) {
  const requestedAt = requestDeadline?.requestedAt ?? new Date();
  const deadlineAtMonotonicMs = requestDeadline?.deadlineAtMonotonicMs ??
    performance.now() + PROMPT_REFINER_PRODUCT_TIMEOUT_MS;
  await consumeApiRateLimit(request, userId, "prompt-refiner-product-prepare",
    { minute: 30, day: 1_000 });
  const body = await readLimitedJson(request, 4 * 1024,
    promptRefinerProductPrepareRequestSchema);
  const snapshot = await capture(request, userId, body);
  const result = await preparePromptRefinerProductSuggestion({ snapshot,
    mode: "auto", requestedAt, deadlineAtMonotonicMs });
  if (result.outcome === "original_fallback") {
    return Response.json({ outcome: "original_fallback",
      reason: result.reason }, { headers });
  }
  return Response.json({ outcome: "auto_held", decision: {
    suggestionId: result.held.suggestionId, scopeId: result.held.scopeId,
    epoch: result.held.epoch, decision: "accepted",
  }, clientRequestId: result.held.clientRequestId }, { headers });
}

export function promptRefinerProductApiErrorResponse(error: unknown) {
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", headers["Cache-Control"]);
    return security;
  }
  if (error instanceof PromptRefinerChatExecutionError) return stale();
  return null;
}

