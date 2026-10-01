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

type AttemptDb = Pick<
  Prisma.TransactionClient,
  "chatResponseAttempt" | "conversation" | "$executeRaw" | "$queryRaw"
>;

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const CHAT_RESPONSE_ATTEMPT_STORAGE_LIMITS = {
  perConversation: () =>
    positiveInteger(process.env.CHAT_RESPONSE_ATTEMPTS_PER_CONVERSATION, 2_000),
  perUser: () => positiveInteger(process.env.CHAT_RESPONSE_ATTEMPTS_PER_USER, 10_000),
};

export const chatRecoveryConversationLockKey = (userId: string, conversationId: string) =>
  `chat-recovery:${userId}:${conversationId}`;

export async function lockChatRecoveryConversation(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  userId: string,
  conversationId: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${chatRecoveryConversationLockKey(
    userId,
    conversationId
  )}))`;
}

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

export class ChatAttemptCapacityError extends Error {
  readonly code = "CHAT_ATTEMPT_STORAGE_QUOTA_EXCEEDED";
  readonly status = 409;

  constructor() {
    super("Chat response recovery storage quota exceeded.");
    this.name = "ChatAttemptCapacityError";
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

async function readChatResponseAttemptFrom(
  db: AttemptDb,
  userId: string,
  assistantMessageId: string,
  expectedConversationId?: string
) {
  const row = await db.chatResponseAttempt.findFirst({
    where: {
      assistantMessageId,
      userId,
      ...(expectedConversationId === undefined
        ? {}
        : { conversationId: expectedConversationId }),
    },
    select: ATTEMPT_SELECT,
  });
  return row ? normalizeAttempt(row) : null;
}

/**
 * A dead worker cannot leave polling in an active state forever. The database
 * clock is authoritative, and the single conditional UPDATE makes concurrent
 * pollers converge on one terminal revision.
 */
export async function reconcileExpiredChatResponseAttempt(
  userId: string,
  assistantMessageId: string,
  expectedConversationId?: string
) {
  const conversationGuard = expectedConversationId === undefined
    ? Prisma.empty
    : Prisma.sql`AND "conversationId" = ${expectedConversationId}`;
  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE "ChatResponseAttempt"
      SET "status" = 'failed',
          "checkpointRevision" = "checkpointRevision" + 1,
          "finishReason" = 'error',
          "failureCode" = 'worker_lease_expired',
          "terminalAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
          "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE "assistantMessageId" = ${assistantMessageId}
        AND "userId" = ${userId}
        ${conversationGuard}
        AND "status" IN ('claimed', 'streaming')
        AND "leaseExpiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND "checkpointRevision" < 2147483647
    `
  );
}

export async function readChatResponseAttempt(
  userId: string,
  assistantMessageId: string,
  expectedConversationId?: string
) {
  await reconcileExpiredChatResponseAttempt(
    userId,
    assistantMessageId,
    expectedConversationId
  );
  return readChatResponseAttemptFrom(
    prisma,
    userId,
    assistantMessageId,
    expectedConversationId
  );
}

/** Ownership-scoped, non-mutating lookup used before conversation unlock. */
export async function peekChatResponseAttempt(userId: string, assistantMessageId: string) {
  return readChatResponseAttemptFrom(prisma, userId, assistantMessageId);
}

export async function listChatResponseAttempts(input: {
  userId: string;
  conversationId: string;
  limit?: number;
}) {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 50));
  await prisma.$executeRaw(
    Prisma.sql`
      UPDATE "ChatResponseAttempt"
      SET "status" = 'failed',
          "checkpointRevision" = "checkpointRevision" + 1,
          "finishReason" = 'error',
          "failureCode" = 'worker_lease_expired',
          "terminalAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
          "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE "userId" = ${input.userId}
        AND "conversationId" = ${input.conversationId}
        AND "status" IN ('claimed', 'streaming')
        AND "leaseExpiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND "checkpointRevision" < 2147483647
    `
  );
  const rows = await prisma.chatResponseAttempt.findMany({
    where: {
      userId: input.userId,
      conversationId: input.conversationId,
      // A context-consumption loser never reached credit reservation or a
      // provider. It stays directly queryable for security/audit recovery but
      // is not a phantom assistant turn in conversation discovery.
      NOT: {
        status: "failed",
        failureCode: "request_refused",
        partialContent: "",
      },
    },
    orderBy: [{ updatedAt: "desc" }, { assistantMessageId: "desc" }],
    take: limit,
    select: ATTEMPT_SELECT,
  });
  return rows.map(normalizeAttempt);
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
  expectedRecoveryEpoch: number;
  ownerId: string;
  leaseExpiresAt: Date;
}): Promise<{ disposition: "claimed" | "reattach"; attempt: ChatResponseAttemptRecord }> {
  if (!Number.isInteger(input.expectedRecoveryEpoch) || input.expectedRecoveryEpoch < 0) {
    throw new ChatAttemptCasError("recovery_epoch_invalid");
  }
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

  return prisma.$transaction(async (tx) => {
    // Serialize the account-wide count before the narrower conversation lock.
    // Existing identities are checked after both locks and may always
    // reattach, even when the account has since reached its creation cap.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${
      `chat-response-attempts:${input.userId}`
    }))`;
    await lockChatRecoveryConversation(tx, input.userId, parsed.conversationId);
    const existing = await tx.chatResponseAttempt.findFirst({
      where: { assistantMessageId: parsed.assistantMessageId, userId: input.userId },
      select: ATTEMPT_SELECT,
    });
    const decision = decideAttemptClaim(existing, identity);
    if (decision.action === "conflict") throw new ChatAttemptIdentityConflictError();
    if (decision.action === "reattach" && existing) {
      return { disposition: "reattach" as const, attempt: normalizeAttempt(existing) };
    }

    const scoped = await tx.conversation.findFirst({
      where: {
        id: parsed.conversationId,
        userId: input.userId,
        kind: "chat",
        productKey: "chat",
        messages: { some: { id: parsed.sourceUserMessageId, role: "user" } },
      },
      select: { id: true, chatRecoveryEpoch: true },
    });
    if (!scoped) throw new ChatAttemptScopeError();
    if (scoped.chatRecoveryEpoch !== input.expectedRecoveryEpoch) {
      throw new ChatAttemptCasError("recovery_epoch_changed");
    }

    const [conversationAttempts, userAttempts] = await Promise.all([
      tx.chatResponseAttempt.count({
        where: { userId: input.userId, conversationId: parsed.conversationId },
      }),
      tx.chatResponseAttempt.count({ where: { userId: input.userId } }),
    ]);
    if (
      conversationAttempts >= CHAT_RESPONSE_ATTEMPT_STORAGE_LIMITS.perConversation() ||
      userAttempts >= CHAT_RESPONSE_ATTEMPT_STORAGE_LIMITS.perUser()
    ) {
      throw new ChatAttemptCapacityError();
    }

    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS "now"
    `;
    const lease = validateAttemptLease({
      now: clock?.now ?? new Date(),
      leaseExpiresAt: parsed.leaseExpiresAt,
    });
    if (lease !== "valid") throw new ChatAttemptCasError(lease);

    try {
      const created = await tx.chatResponseAttempt.create({
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
      return { disposition: "claimed" as const, attempt: normalizeAttempt(created) };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) {
        throw error;
      }
      throw new ChatAttemptIdentityConflictError();
    }
  });
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
}, db: AttemptDb = prisma) {
  const now = input.now ?? new Date();
  const current = await readChatResponseAttemptFrom(db, input.userId, input.assistantMessageId);
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
  const updated = await db.$executeRaw(
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
  return readChatResponseAttemptFrom(db, input.userId, input.assistantMessageId);
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
}, db: AttemptDb = prisma) {
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
  const current = await readChatResponseAttemptFrom(db, input.userId, input.assistantMessageId);
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
  const updated = await db.$executeRaw(
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
  return readChatResponseAttemptFrom(db, input.userId, input.assistantMessageId);
}
