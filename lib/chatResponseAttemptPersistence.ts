import "server-only";

import { Prisma } from "@prisma/client";

import {
  CHAT_ATTEMPT_ID_REUSED,
  CHAT_ATTEMPT_REVISION_CONFLICT,
  chatResponseAttemptClaimSchema,
  chatResponseAttemptFailureCodeSchema,
  chatResponseAttemptFingerprint,
  chatResponseAttemptFinishReasonSchema,
  chatResponseAttemptStatusSchema,
  chatResponseAttemptTerminalStatusSchema,
  decideAttemptCheckpoint,
  decideAttemptClaim,
  decideAttemptTerminal,
  validateAttemptLease,
  validateAttemptTerminalMetadata,
  type ChatResponseAttemptFailureCode,
  type ChatResponseAttemptFinishReason,
  type ChatResponseAttemptRecord,
  type ChatResponseAttemptTerminalStatus,
} from "@/lib/chatResponseAttemptCore";
import { prisma } from "@/lib/prisma";

const ATTEMPT_SELECT = {
  assistantMessageId: true,
  userId: true,
  conversationId: true,
  sourceUserMessageId: true,
  fingerprint: true,
  requestedModelId: true,
  actualModelId: true,
  provider: true,
  status: true,
  partialContent: true,
  checkpointRevision: true,
  ownerId: true,
  leaseExpiresAt: true,
  finishReason: true,
  failureCode: true,
  terminalAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class ChatAttemptIdentityConflictError extends Error {
  readonly code = CHAT_ATTEMPT_ID_REUSED;

  constructor() {
    super("The assistant message id is already bound to another request.");
    this.name = "ChatAttemptIdentityConflictError";
  }
}

export class ChatAttemptCasError extends Error {
  readonly code = CHAT_ATTEMPT_REVISION_CONFLICT;

  constructor(readonly reason: string) {
    super("The Chat response attempt changed before this request was applied.");
    this.name = "ChatAttemptCasError";
  }
}

export class ChatAttemptScopeError extends Error {
  readonly code = "CHAT_ATTEMPT_SCOPE_NOT_FOUND";

  constructor() {
    super("The Chat response attempt scope was not found.");
    this.name = "ChatAttemptScopeError";
  }
}

const normalizeAttempt = (row: Omit<ChatResponseAttemptRecord, "status" | "finishReason" | "failureCode"> & {
  status: string;
  finishReason: string | null;
  failureCode: string | null;
}) => ({
  ...row,
  status: chatResponseAttemptStatusSchema.parse(row.status),
  finishReason:
    row.finishReason === null ? null : chatResponseAttemptFinishReasonSchema.parse(row.finishReason),
  failureCode:
    row.failureCode === null ? null : chatResponseAttemptFailureCodeSchema.parse(row.failureCode),
});

export async function readChatResponseAttempt(userId: string, assistantMessageId: string) {
  const row = await prisma.chatResponseAttempt.findFirst({
    where: { assistantMessageId, userId },
    select: ATTEMPT_SELECT,
  });
  return row ? normalizeAttempt(row) : null;
}

/**
 * The future dispatch route must call this before reservations or providers.
 * Repeating an identity is a read/reattach decision, never another execution.
 */
export async function claimChatResponseAttempt(input: {
  userId: string;
  assistantMessageId: string;
  conversationId: string;
  sourceUserMessageId: string;
  requestedModelId: string;
  requestPayloadDigest: string;
  ownerId: string;
  leaseExpiresAt: Date;
}): Promise<{ disposition: "claimed" | "reattach"; attempt: ChatResponseAttemptRecord }> {
  const parsed = chatResponseAttemptClaimSchema.parse({
    assistantMessageId: input.assistantMessageId,
    conversationId: input.conversationId,
    sourceUserMessageId: input.sourceUserMessageId,
    requestedModelId: input.requestedModelId,
    requestPayloadDigest: input.requestPayloadDigest,
    ownerId: input.ownerId,
    leaseExpiresAt: input.leaseExpiresAt,
  });
  const fingerprint = chatResponseAttemptFingerprint(parsed);
  const identity = { ...parsed, userId: input.userId, fingerprint };

  const existing = await prisma.chatResponseAttempt.findFirst({
    where: { assistantMessageId: parsed.assistantMessageId, userId: input.userId },
    select: ATTEMPT_SELECT,
  });
  const decision = decideAttemptClaim(existing, identity);
  if (decision.action === "conflict") throw new ChatAttemptIdentityConflictError();
  if (decision.action === "reattach" && existing) {
    return { disposition: "reattach", attempt: normalizeAttempt(existing) };
  }

  const scoped = await prisma.conversation.findFirst({
    where: {
      id: parsed.conversationId,
      userId: input.userId,
      kind: "chat",
      productKey: "chat",
      messages: { some: { id: parsed.sourceUserMessageId, role: "user" } },
    },
    select: { id: true },
  });
  if (!scoped) throw new ChatAttemptScopeError();

  // A replay reads or conflicts with the existing identity irrespective of
  // the new caller's proposed lease. Lease validity governs creation only.
  const lease = validateAttemptLease({ now: new Date(), leaseExpiresAt: parsed.leaseExpiresAt });
  if (lease !== "valid") {
    throw new ChatAttemptCasError(lease);
  }

  try {
    const created = await prisma.chatResponseAttempt.create({
      data: {
        assistantMessageId: parsed.assistantMessageId,
        userId: input.userId,
        conversationId: parsed.conversationId,
        sourceUserMessageId: parsed.sourceUserMessageId,
        fingerprint,
        requestedModelId: parsed.requestedModelId,
        ownerId: parsed.ownerId,
        leaseExpiresAt: parsed.leaseExpiresAt,
      },
      select: ATTEMPT_SELECT,
    });
    return { disposition: "claimed", attempt: normalizeAttempt(created) };
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) {
      throw error;
    }
    const raced = await prisma.chatResponseAttempt.findFirst({
      where: { assistantMessageId: parsed.assistantMessageId, userId: input.userId },
      select: ATTEMPT_SELECT,
    });
    if (decideAttemptClaim(raced, identity).action !== "reattach" || !raced) {
      throw new ChatAttemptIdentityConflictError();
    }
    return { disposition: "reattach", attempt: normalizeAttempt(raced) };
  }
}

export async function checkpointChatResponseAttempt(input: {
  userId: string;
  assistantMessageId: string;
  ownerId: string;
  expectedRevision: number;
  partialContent: string;
  actualModelId?: string | null;
  provider?: string | null;
  leaseExpiresAt?: Date;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const current = await readChatResponseAttempt(input.userId, input.assistantMessageId);
  if (!current) throw new ChatAttemptCasError("revision_conflict");
  const decision = decideAttemptCheckpoint({
    ...current,
    expectedRevision: input.expectedRevision,
    expectedOwnerId: input.ownerId,
    now,
    committedContent: current.partialContent,
    nextContent: input.partialContent,
  });
  if (decision.action === "refuse") throw new ChatAttemptCasError(decision.reason);
  if (input.leaseExpiresAt) {
    const lease = validateAttemptLease({ now, leaseExpiresAt: input.leaseExpiresAt });
    if (lease !== "valid") throw new ChatAttemptCasError(lease);
  }

  const assignments = [
    Prisma.sql`"status" = 'streaming'`,
    Prisma.sql`"partialContent" = ${input.partialContent}`,
    Prisma.sql`"checkpointRevision" = ${decision.nextRevision}`,
  ];
  if (input.actualModelId !== undefined) {
    assignments.push(Prisma.sql`"actualModelId" = ${input.actualModelId}`);
  }
  if (input.provider !== undefined) {
    assignments.push(Prisma.sql`"provider" = ${input.provider}`);
  }
  if (input.leaseExpiresAt) {
    assignments.push(Prisma.sql`"leaseExpiresAt" = ${input.leaseExpiresAt}`);
  }
  const replacementLeaseGuard = input.leaseExpiresAt
    ? Prisma.sql`AND ${input.leaseExpiresAt} > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND ${input.leaseExpiresAt} <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes'`
    : Prisma.empty;
  const updated = await prisma.$executeRaw(
    Prisma.sql`
      UPDATE "ChatResponseAttempt"
      SET ${Prisma.join(assignments)},
          "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE "assistantMessageId" = ${input.assistantMessageId}
        AND "userId" = ${input.userId}
        AND "ownerId" = ${input.ownerId}
        AND "checkpointRevision" = ${input.expectedRevision}
        AND "status" IN ('claimed', 'streaming')
        AND "leaseExpiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND "leaseExpiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes'
        ${replacementLeaseGuard}
    `
  );
  if (updated !== 1) throw new ChatAttemptCasError("revision_conflict");
  return readChatResponseAttempt(input.userId, input.assistantMessageId);
}

export async function terminalChatResponseAttempt(input: {
  userId: string;
  assistantMessageId: string;
  ownerId: string;
  expectedRevision: number;
  status: ChatResponseAttemptTerminalStatus;
  finalContent: string;
  actualModelId?: string | null;
  provider?: string | null;
  finishReason?: ChatResponseAttemptFinishReason | null;
  failureCode?: ChatResponseAttemptFailureCode | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const status = chatResponseAttemptTerminalStatusSchema.safeParse(input.status);
  if (!status.success) {
    throw new ChatAttemptCasError("terminal_status_invalid");
  }
  const finishReason =
    input.finishReason == null
      ? null
      : chatResponseAttemptFinishReasonSchema.parse(input.finishReason);
  const failureCode =
    input.failureCode == null
      ? null
      : chatResponseAttemptFailureCodeSchema.parse(input.failureCode);
  if (
    !validateAttemptTerminalMetadata({
      status: status.data,
      finishReason,
      failureCode,
    })
  ) {
    throw new ChatAttemptCasError("terminal_metadata_invalid");
  }
  const current = await readChatResponseAttempt(input.userId, input.assistantMessageId);
  if (!current) throw new ChatAttemptCasError("revision_conflict");
  const decision = decideAttemptTerminal({
    ...current,
    expectedRevision: input.expectedRevision,
    expectedOwnerId: input.ownerId,
    now,
    committedContent: current.partialContent,
    finalContent: input.finalContent,
    terminalStatus: status.data,
  });
  if (decision.action === "refuse") throw new ChatAttemptCasError(decision.reason);

  const assignments = [
    Prisma.sql`"status" = ${status.data}`,
    Prisma.sql`"partialContent" = ${input.finalContent}`,
    Prisma.sql`"checkpointRevision" = ${decision.nextRevision}`,
    Prisma.sql`"terminalAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
    Prisma.sql`"finishReason" = ${finishReason}`,
    Prisma.sql`"failureCode" = ${failureCode}`,
  ];
  if (input.actualModelId !== undefined) {
    assignments.push(Prisma.sql`"actualModelId" = ${input.actualModelId}`);
  }
  if (input.provider !== undefined) {
    assignments.push(Prisma.sql`"provider" = ${input.provider}`);
  }
  const updated = await prisma.$executeRaw(
    Prisma.sql`
      UPDATE "ChatResponseAttempt"
      SET ${Prisma.join(assignments)},
          "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE "assistantMessageId" = ${input.assistantMessageId}
        AND "userId" = ${input.userId}
        AND "ownerId" = ${input.ownerId}
        AND "checkpointRevision" = ${input.expectedRevision}
        AND "status" IN ('claimed', 'streaming')
        AND "leaseExpiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND "leaseExpiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes'
    `
  );
  if (updated !== 1) throw new ChatAttemptCasError("revision_conflict");
  return readChatResponseAttempt(input.userId, input.assistantMessageId);
}
