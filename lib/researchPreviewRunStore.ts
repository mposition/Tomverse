import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ResearchPreviewRunError, researchPreviewSettlementForExpiry,
  stoppedResearchPreviewUsage, type ResearchPreviewSettlementUsage } from "@/lib/deepResearchSettlementHandoff";
export { ResearchPreviewRunError, parseResearchPreviewSettlementUsage, researchPreviewSettlementForExpiry,
  type ResearchPreviewSettlementUsage } from "@/lib/deepResearchSettlementHandoff";
import { prisma } from "@/lib/prisma";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import {
  PUBLIC_CHAT_MESSAGE_SELECT,
  toPublicChatMessage,
} from "@/lib/publicChatMessage";
import {
  researchPreviewRunStatusSchema,
  researchPreviewRunStopReasonSchema,
  toResearchPreviewRunPublicStatus,
  type ResearchPreviewRunDto,
  type ResearchPreviewRunStopReason,
} from "@/lib/researchPreviewRunTypes";

export const RESEARCH_PREVIEW_RUN_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1_000;
export const RESEARCH_PREVIEW_RUN_ACTIVE_LIMIT_MS = 10 * 60 * 1_000;
export const RESEARCH_PREVIEW_RUN_LEASE_MS = 90 * 1_000;
export const RESEARCH_PREVIEW_PREPARING_STALE_MS = 90 * 1_000;
export const RESEARCH_PREVIEW_RUN_MAX_CHECKPOINT_BYTES = 512 * 1024;

export const researchPreviewQuestionDigest = (question: string) =>
  `sha256:${createHash("sha256").update(question, "utf8").digest("hex")}`;

export async function readEligibleResearchPreviewSource(input: {
  userId: string;
  conversationId: string;
  sourceUserMessageId: string;
}) {
  const [source, head] = await Promise.all([
    prisma.message.findFirst({
      where: {
        id: input.sourceUserMessageId,
        conversationId: input.conversationId,
        role: "user",
        conversation: { userId: input.userId },
      },
      select: {
        id: true,
        content: true,
        attachments: { select: { id: true }, take: 1 },
      },
    }),
    prisma.message.findFirst({
      where: {
        conversationId: input.conversationId,
        conversation: { userId: input.userId },
      },
      select: { id: true, role: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  const question = source?.content.trim() ?? "";
  if (
    !source ||
    source.attachments.length > 0 ||
    head?.id !== source.id ||
    head.role !== "user" ||
    !question ||
    question.length > 4_000
  ) {
    return null;
  }
  return { id: source.id, question };
}

const CHECKPOINTED_SELECT = {
  id: true,
  conversationId: true,
  assistantMessageId: true,
  modelId: true,
  status: true,
  stopReason: true,
  stepCount: true,
  searchCount: true,
  readCount: true,
  checkpoint: true,
  checkpointExpiresAt: true,
  reservationId: true,
  cancelRequestedAt: true,
  createdAt: true,
  updatedAt: true,
  message: { select: PUBLIC_CHAT_MESSAGE_SELECT },
  conversation: { select: { password: true } },
  generations: {
    where: { status: { in: ["dispatch_started", "outcome_unknown"] } },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.ResearchPreviewRunSelect;

type DtoRow = Prisma.ResearchPreviewRunGetPayload<{
  select: typeof CHECKPOINTED_SELECT;
}>;

export const toResearchPreviewRunDto = (
  row: DtoRow,
  now = new Date()
): ResearchPreviewRunDto => {
  const status = researchPreviewRunStatusSchema.parse(row.status);
  const stopReason = row.stopReason
    ? researchPreviewRunStopReasonSchema.parse(row.stopReason)
    : undefined;
  const canResume =
    status === "checkpointed" &&
    row.checkpoint !== null &&
    row.checkpointExpiresAt !== null &&
    row.checkpointExpiresAt > now &&
    row.reservationId !== null &&
    row.cancelRequestedAt === null &&
    row.generations.length === 0;
  return {
    id: row.id,
    conversationId: row.conversationId,
    assistantMessageId: row.assistantMessageId,
    modelId: row.modelId,
    status: toResearchPreviewRunPublicStatus(status),
    stepCount: row.stepCount,
    searchCount: row.searchCount,
    readCount: row.readCount,
    canResume,
    ...(stopReason ? { stopReason } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.message ? { message: toPublicChatMessage(row.message) } : {}),
  };
};

const canReadResearchRun = (row: DtoRow, userId: string, request?: Request) =>
  !row.conversation.password || Boolean(request && hasConversationUnlockGrant(request, userId, row.conversationId, row.conversation.password));

export async function readResearchPreviewRunDto(userId: string, id: string, request?: Request) {
  const row = await prisma.researchPreviewRun.findFirst({
    where: { id, userId },
    select: CHECKPOINTED_SELECT,
  });
  if (row && !canReadResearchRun(row, userId, request)) throw new ResearchPreviewRunError(
    423, "RESEARCH_CONVERSATION_LOCKED", "Unlock this conversation before reading Research."
  );
  return row ? toResearchPreviewRunDto(row) : null;
}

export async function listResearchPreviewRunDtos(input: {
  userId: string;
  conversationId?: string;
  assistantMessageId?: string;
  request?: Request;
}) {
  const rows = await prisma.researchPreviewRun.findMany({
    where: {
      userId: input.userId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.assistantMessageId
        ? { assistantMessageId: input.assistantMessageId }
        : {}),
    },
    select: CHECKPOINTED_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.assistantMessageId ? 1 : 100,
  });
  if (input.conversationId && rows.some(row => !canReadResearchRun(row, input.userId, input.request))) {
    throw new ResearchPreviewRunError(423, "RESEARCH_CONVERSATION_LOCKED", "Unlock this conversation before reading Research.");
  }
  return rows.filter(row => canReadResearchRun(row, input.userId, input.request)).map(row => toResearchPreviewRunDto(row));
}

export async function createPreparingResearchPreviewRun(input: {
  userId: string;
  conversationId: string;
  sourceUserMessageId: string;
  assistantMessageId: string;
  modelId: string;
  provider: string;
  apiModel: string;
  locale: string;
  currentDate: string;
  questionDigest: string;
  pageReadingEnabled: boolean;
  totalOutputTokens: number;
  inputTokenCeiling: number;
  searchSurchargeCredits: number;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`research-preview-assistant:${input.assistantMessageId}`}))`;
    const existing = await tx.researchPreviewRun.findUnique({
      where: { assistantMessageId: input.assistantMessageId },
    });
    if (existing) {
      const matches =
        existing.userId === input.userId &&
        existing.conversationId === input.conversationId &&
        existing.sourceUserMessageId === input.sourceUserMessageId &&
        existing.modelId === input.modelId &&
        existing.questionDigest === input.questionDigest;
      if (!matches) {
        throw new ResearchPreviewRunError(
          409,
          "RESEARCH_RUN_ID_REUSED",
          "The assistant message identity is already bound to another run."
        );
      }
      return { created: false as const, run: existing };
    }
    const run = await tx.researchPreviewRun.create({ data: input });
    return { created: true as const, run };
  });
}

export async function activateResearchPreviewRun(input: {
  runId: string;
  userId: string;
  reservationId: string;
}) {
  const updated = await prisma.researchPreviewRun.updateMany({
    where: {
      id: input.runId,
      userId: input.userId,
      status: "preparing",
      reservationId: null,
    },
    data: { status: "queued", reservationId: input.reservationId },
  });
  if (updated.count !== 1) {
    throw new ResearchPreviewRunError(
      409,
      "RESEARCH_RUN_ACTIVATION_CONFLICT",
      "The Research run could not be activated."
    );
  }
}

export async function failPreparingResearchPreviewRun(
  runId: string,
  stopReason: ResearchPreviewRunStopReason,
  errorCode: string
) {
  await prisma.researchPreviewRun.updateMany({
    where: { id: runId, status: "preparing", reservationId: null },
    data: {
      status: "failed",
      stopReason,
      lastErrorCode: errorCode.slice(0, 80),
      completedAt: new Date(),
    },
  });
}

export type ClaimedResearchPreviewRun = Awaited<
  ReturnType<typeof claimNextResearchPreviewRun>
>;

export async function claimNextResearchPreviewRun(ownerId: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; startedAt: Date | null }>>`
      SELECT "id", "startedAt" FROM "ResearchPreviewRun"
      WHERE "status" = 'queued'
        AND "cancelRequestedAt" IS NULL
        AND "reservationId" IS NOT NULL
      ORDER BY "createdAt", "id"
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const id = rows[0]?.id;
    if (!id) return null;
    const now = new Date();
    return tx.researchPreviewRun.update({
      where: { id },
      data: {
        status: "running",
        leaseOwner: ownerId,
        leaseEpoch: { increment: 1 },
        leaseExpiresAt: new Date(now.getTime() + RESEARCH_PREVIEW_RUN_LEASE_MS),
        activeDeadlineAt: new Date(
          now.getTime() + RESEARCH_PREVIEW_RUN_ACTIVE_LIMIT_MS
        ),
        startedAt: rows[0]?.startedAt ?? now,
      },
      include: { generations: { orderBy: { generationIndex: "asc" } } },
    });
  });
}

export async function heartbeatResearchPreviewRun(input: {
  runId: string;
  ownerId: string;
  leaseEpoch: number;
}) {
  const now = new Date();
  const result = await prisma.researchPreviewRun.updateMany({
    where: {
      id: input.runId,
      status: "running",
      leaseOwner: input.ownerId,
      leaseEpoch: input.leaseEpoch,
      leaseExpiresAt: { gt: now },
      activeDeadlineAt: { gt: now },
      cancelRequestedAt: null,
    },
    data: {
      leaseExpiresAt: new Date(now.getTime() + RESEARCH_PREVIEW_RUN_LEASE_MS),
    },
  });
  return result.count === 1;
}

export async function releaseResearchPreviewClaimToQueue(input: {
  runId: string;
  ownerId: string;
  leaseEpoch: number;
}) {
  const result = await prisma.researchPreviewRun.updateMany({
    where: {
      id: input.runId,
      status: "running",
      leaseOwner: input.ownerId,
      leaseEpoch: input.leaseEpoch,
      cancelRequestedAt: null,
    },
    data: {
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      activeDeadlineAt: null,
    },
  });
  return result.count === 1;
}

export async function beginResearchPreviewGeneration(input: {
  runId: string;
  ownerId: string;
  leaseEpoch: number;
  checkpointVersion: number;
  generationIndex: number;
}) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.researchPreviewRun.findUnique({ where: { id: input.runId } });
    const now = new Date();
    if (
      !run ||
      run.status !== "running" ||
      run.leaseOwner !== input.ownerId ||
      run.leaseEpoch !== input.leaseEpoch ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= now ||
      run.cancelRequestedAt ||
      run.checkpointVersion !== input.checkpointVersion ||
      run.stepCount + 1 !== input.generationIndex ||
      input.generationIndex < 1 ||
      input.generationIndex > 3
    ) {
      throw new ResearchPreviewRunError(
        409,
        "RESEARCH_RUN_LEASE_LOST",
        "The Research run lease is no longer active."
      );
    }
    const existing = await tx.researchPreviewGeneration.findUnique({
      where: {
        runId_generationIndex: {
          runId: input.runId,
          generationIndex: input.generationIndex,
        },
      },
    });
    if (existing) {
      if (existing.status !== "intent") {
        throw new ResearchPreviewRunError(
          409,
          "RESEARCH_GENERATION_ALREADY_DISPATCHED",
          "This Research generation cannot be retried."
        );
      }
      return tx.researchPreviewGeneration.update({
        where: { id: existing.id },
        data: {
          leaseEpoch: input.leaseEpoch,
          checkpointVersionBefore: input.checkpointVersion,
        },
      });
    }
    return tx.researchPreviewGeneration.create({
      data: {
        runId: input.runId,
        generationIndex: input.generationIndex,
        leaseEpoch: input.leaseEpoch,
        checkpointVersionBefore: input.checkpointVersion,
      },
    });
  });
}

export async function markResearchPreviewDispatchStarted(input: {
  runId: string;
  generationId: string;
  ownerId: string;
  leaseEpoch: number;
}) {
  const changed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ResearchPreviewRun" WHERE "id" = ${input.runId} FOR UPDATE`;
    const now = new Date();
    const run = await tx.researchPreviewRun.findFirst({
      where: {
        id: input.runId,
        status: "running",
        leaseOwner: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        leaseExpiresAt: { gt: now },
        activeDeadlineAt: { gt: now },
        cancelRequestedAt: null,
      },
      select: { id: true },
    });
    if (!run) return 0;
    const generation = await tx.researchPreviewGeneration.updateMany({
      where: {
        id: input.generationId,
        runId: input.runId,
        status: "intent",
        leaseEpoch: input.leaseEpoch,
      },
      data: { status: "dispatch_started", dispatchStartedAt: now },
    });
    return generation.count;
  });
  if (changed !== 1) {
    throw new ResearchPreviewRunError(
      409,
      "RESEARCH_DISPATCH_REFUSED",
      "The Research generation is no longer authorized to dispatch."
    );
  }
}

const checkpointJson = (value: unknown): Prisma.InputJsonValue => {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > RESEARCH_PREVIEW_RUN_MAX_CHECKPOINT_BYTES) {
    throw new ResearchPreviewRunError(
      500,
      "RESEARCH_CHECKPOINT_TOO_LARGE",
      "The Research checkpoint exceeded its server limit."
    );
  }
  return JSON.parse(serialized) as Prisma.InputJsonValue;
};

export async function completeResearchPreviewGeneration(input: {
  runId: string;
  generationId: string;
  ownerId: string;
  leaseEpoch: number;
  checkpoint: unknown;
  stepCount: number;
  searchCount: number;
  readCount: number;
  stepUsage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  settlementUsage: ResearchPreviewSettlementUsage;
  terminal?: {
    content: string;
    modelId: string;
    searchMetadata: Prisma.InputJsonValue;
  };
  terminalFailure?: {
    status: "failed" | "cancelled" | "attention";
    stopReason: ResearchPreviewRunStopReason;
    errorCode?: string;
  };
}) {
  const checkpoint = checkpointJson(input.checkpoint);
  const settlementUsage = checkpointJson(input.settlementUsage);
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const run = await tx.researchPreviewRun.findFirst({
      where: {
        id: input.runId,
        status: "running",
        leaseOwner: input.ownerId,
        leaseEpoch: input.leaseEpoch,
      },
    });
    if (!run) {
      throw new ResearchPreviewRunError(
        409,
        "RESEARCH_RUN_LEASE_LOST",
        "The Research run lease is no longer active."
      );
    }
    const generation = await tx.researchPreviewGeneration.updateMany({
      where: {
        id: input.generationId,
        runId: input.runId,
        status: "dispatch_started",
        leaseEpoch: input.leaseEpoch,
      },
      data: {
        status: "completed",
        inputTokens: input.stepUsage.inputTokens,
        cachedInputTokens: input.stepUsage.cachedInputTokens,
        cacheWriteInputTokens: input.stepUsage.cacheWriteInputTokens,
        outputTokens: input.stepUsage.outputTokens,
        reasoningTokens: input.stepUsage.reasoningTokens,
        searchCount: input.searchCount,
        readCount: input.readCount,
        stopReason: input.terminal ? "report_submitted" : null,
        completedAt: now,
      },
    });
    if (generation.count !== 1) {
      throw new ResearchPreviewRunError(
        409,
        "RESEARCH_GENERATION_COMMIT_CONFLICT",
        "The Research generation was not committed."
      );
    }
    if (input.terminal) {
      await tx.message.create({
        data: {
          id: run.assistantMessageId,
          role: "assistant",
          content: input.terminal.content,
          status: "normal",
          modelId: input.terminal.modelId,
          searchMetadata: input.terminal.searchMetadata,
          conversationId: run.conversationId,
          researchRunId: run.id,
        },
      });
      return tx.researchPreviewRun.update({
        where: { id: run.id },
        data: {
          status: "completed",
          stopReason: "report_submitted",
          checkpoint: Prisma.DbNull,
          checkpointExpiresAt: null,
          checkpointVersion: input.stepCount,
          stepCount: input.stepCount,
          searchCount: input.searchCount,
          readCount: input.readCount,
          settlementUsage,
          leaseOwner: null,
          leaseExpiresAt: null,
          activeDeadlineAt: null,
          completedAt: now,
        },
      });
    }
    if (input.terminalFailure) {
      return tx.researchPreviewRun.update({
        where: { id: run.id },
        data: {
          status: input.terminalFailure.status,
          stopReason: input.terminalFailure.stopReason,
          lastErrorCode: input.terminalFailure.errorCode?.slice(0, 80),
          checkpoint: Prisma.DbNull,
          checkpointExpiresAt: null,
          checkpointVersion: input.stepCount,
          stepCount: input.stepCount,
          searchCount: input.searchCount,
          readCount: input.readCount,
          settlementUsage,
          leaseOwner: null,
          leaseExpiresAt: null,
          activeDeadlineAt: null,
          completedAt: now,
        },
      });
    }
    return tx.researchPreviewRun.update({
      where: { id: run.id },
      data: {
        checkpoint,
        checkpointExpiresAt: new Date(
          now.getTime() + RESEARCH_PREVIEW_RUN_CHECKPOINT_TTL_MS
        ),
        checkpointVersion: input.stepCount,
        stepCount: input.stepCount,
        searchCount: input.searchCount,
        readCount: input.readCount,
        settlementUsage,
      },
    });
  });
}

export async function checkpointResearchPreviewRun(input: {
  runId: string;
  ownerId: string;
  leaseEpoch: number;
}) {
  const changed = await prisma.researchPreviewRun.updateMany({
    where: {
      id: input.runId,
      status: "running",
      leaseOwner: input.ownerId,
      leaseEpoch: input.leaseEpoch,
      checkpoint: { not: Prisma.DbNull },
      cancelRequestedAt: null,
    },
    data: {
      status: "checkpointed",
      leaseOwner: null,
      leaseExpiresAt: null,
      activeDeadlineAt: null,
    },
  });
  return changed.count === 1;
}

export async function resumeResearchPreviewRun(userId: string, runId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`research-preview-run:${runId}`}))`;
    const run = await tx.researchPreviewRun.findFirst({ where: { id: runId, userId } });
    const now = new Date();
    if (
      !run ||
      run.status !== "checkpointed" ||
      !run.checkpoint ||
      !run.checkpointExpiresAt ||
      run.checkpointExpiresAt <= now ||
      !run.reservationId ||
      run.cancelRequestedAt
    ) {
      throw new ResearchPreviewRunError(
        409,
        "RESEARCH_RUN_CANNOT_RESUME",
        "This Research run has no safe checkpoint to resume."
      );
    }
    const unknown = await tx.researchPreviewGeneration.count({
      where: {
        runId,
        status: { in: ["dispatch_started", "outcome_unknown"] },
      },
    });
    if (unknown > 0) {
      throw new ResearchPreviewRunError(
        409,
        "RESEARCH_RUN_OUTCOME_UNKNOWN",
        "This Research run cannot repeat an unknown dispatch."
      );
    }
    await tx.researchPreviewRun.update({
      where: { id: runId },
      data: { status: "queued", stopReason: null },
    });
  });
}

export async function requestResearchPreviewCancellation(
  userId: string,
  runId: string
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`research-preview-run:${runId}`}))`;
    await tx.$queryRaw`SELECT "id" FROM "ResearchPreviewRun" WHERE "id" = ${runId} FOR UPDATE`;
    const run = await tx.researchPreviewRun.findFirst({ where: { id: runId, userId } });
    if (!run) return null;
    if (["completed", "failed", "cancelled", "attention"].includes(run.status)) {
      return { run, terminalized: false };
    }
    const now = new Date();
    const inFlight = await tx.researchPreviewGeneration.count({
      where: { runId, status: "dispatch_started" },
    });
    if (run.status === "running" || inFlight > 0) {
      const updated = await tx.researchPreviewRun.update({
        where: { id: runId },
        data: { cancelRequestedAt: now },
      });
      return { run: updated, terminalized: false };
    }
    const settlementUsage = checkpointJson(await stoppedResearchPreviewUsage(tx, run, "cancelled"));
    const updated = await tx.researchPreviewRun.update({
      where: { id: runId },
      data: {
        status: "cancelled",
        stopReason: "cancelled",
        cancelRequestedAt: now,
        checkpoint: Prisma.DbNull,
        checkpointExpiresAt: null,
        settlementUsage,
        completedAt: now,
      },
    });
    return { run: updated, terminalized: true };
  });
}

export async function expireResearchPreviewCheckpoints(limit = 50) {
  const now = new Date();
  const runs = await prisma.researchPreviewRun.findMany({ where: {
    status: { in: ["checkpointed", "queued"] }, checkpointExpiresAt: { lte: now }, reservationId: { not: null },
  }, select: { reservationId: true }, take: Math.min(100, Math.max(1, limit)), orderBy: { checkpointExpiresAt: "asc" } });
  for (const run of runs) await prisma.$transaction(tx => researchPreviewSettlementForExpiry(tx, run.reservationId!, now));
  return runs.length;
}

export async function finishResearchPreviewRunWithoutReport(input: {
  runId: string;
  ownerId: string;
  leaseEpoch: number;
  status: "failed" | "cancelled" | "attention";
  stopReason: ResearchPreviewRunStopReason;
  generationId?: string;
  generationStatus?: "dispatch_refused" | "outcome_unknown";
  settlementUsage: ResearchPreviewSettlementUsage;
  errorCode?: string;
}) {
  const usage = checkpointJson(input.settlementUsage);
  return prisma.$transaction(async (tx) => {
    const run = await tx.researchPreviewRun.findFirst({
      where: {
        id: input.runId,
        status: "running",
        leaseOwner: input.ownerId,
        leaseEpoch: input.leaseEpoch,
      },
    });
    if (!run) return false;
    if (input.generationId && input.generationStatus) {
      await tx.researchPreviewGeneration.updateMany({
        where: {
          id: input.generationId,
          runId: run.id,
          status:
            input.generationStatus === "outcome_unknown"
              ? "dispatch_started"
              : "intent",
        },
        data: {
          status: input.generationStatus,
          stopReason: input.stopReason,
          completedAt: new Date(),
        },
      });
    }
    await tx.researchPreviewRun.update({
      where: { id: run.id },
      data: {
        status: input.status,
        stopReason: input.stopReason,
        lastErrorCode: input.errorCode?.slice(0, 80),
        checkpoint: Prisma.DbNull,
        checkpointExpiresAt: null,
        settlementUsage: usage,
        leaseOwner: null,
        leaseExpiresAt: null,
        activeDeadlineAt: null,
        completedAt: new Date(),
      },
    });
    return true;
  });
}

export async function staleResearchPreviewRuns(limit = 50) {
  return prisma.researchPreviewRun.findMany({
    where: { status: "running", leaseExpiresAt: { lte: new Date() } },
    include: { generations: { orderBy: { generationIndex: "desc" }, take: 1 } },
    orderBy: { leaseExpiresAt: "asc" },
    take: Math.min(100, Math.max(1, limit)),
  });
}

export async function stalePreparingResearchPreviewRuns(limit = 50) {
  return prisma.researchPreviewRun.findMany({
    where: {
      status: "preparing",
      createdAt: {
        lte: new Date(Date.now() - RESEARCH_PREVIEW_PREPARING_STALE_MS),
      },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: Math.min(100, Math.max(1, limit)),
  });
}

export async function recoverStalePreparingResearchPreviewRun(runId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`research-preview-run:${runId}`}))`;
    const run = await tx.researchPreviewRun.findUnique({ where: { id: runId } });
    const cutoff = new Date(Date.now() - RESEARCH_PREVIEW_PREPARING_STALE_MS);
    if (
      !run ||
      run.status !== "preparing" ||
      run.reservationId !== null ||
      run.createdAt > cutoff
    ) {
      return "unchanged" as const;
    }
    const reservation = await tx.chatCreditReservation.findFirst({
      where: {
        userId: run.userId,
        traceId: run.id,
        source: "chat",
        status: "reserved",
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    await tx.researchPreviewRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        stopReason: "dispatch_refused",
        lastErrorCode: "RESEARCH_PREPARATION_EXPIRED",
        ...(reservation ? { reservationId: reservation.id } : {}),
        settlementUsage: reservation
          ? checkpointJson({
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              usageFromProvider: true,
              outcome: "failed",
              searchSurchargeCredits: run.searchSurchargeCredits,
              searchExecuted: false,
              searchQueryCount: 0,
              searchBackendRequestCount: 0,
              searchQueriesObserved: true,
            } satisfies ResearchPreviewSettlementUsage)
          : Prisma.DbNull,
        completedAt: new Date(),
      },
    });
    return reservation ? ("failed_with_reservation" as const) : ("failed" as const);
  });
}

export async function recoverStaleResearchPreviewRun(runId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`research-preview-run:${runId}`}))`;
    const run = await tx.researchPreviewRun.findUnique({
      where: { id: runId },
      include: { generations: { orderBy: { generationIndex: "desc" }, take: 1 } },
    });
    const now = new Date();
    if (!run || run.status !== "running" || !run.leaseExpiresAt || run.leaseExpiresAt > now) {
      return "unchanged" as const;
    }
    const generation = run.generations[0];
    if (generation?.status === "dispatch_started") {
      await tx.researchPreviewGeneration.update({
        where: { id: generation.id },
        data: {
          status: "outcome_unknown",
          stopReason: "outcome_unknown",
          completedAt: now,
        },
      });
      await tx.researchPreviewRun.update({
        where: { id: run.id },
        data: {
          status: "attention",
          stopReason: "outcome_unknown",
          checkpoint: Prisma.DbNull,
          checkpointExpiresAt: null,
          settlementUsage: checkpointJson({
            usageFromProvider: false,
            outcome: "failed",
            searchSurchargeCredits: run.searchSurchargeCredits,
            searchQueriesObserved: false,
          } satisfies ResearchPreviewSettlementUsage),
          leaseOwner: null,
          leaseExpiresAt: null,
          activeDeadlineAt: null,
          completedAt: now,
        },
      });
      return "outcome_unknown" as const;
    }
    if (run.cancelRequestedAt) {
      const usage = await stoppedResearchPreviewUsage(tx, run, "cancelled");
      if (generation?.status === "intent") await tx.researchPreviewGeneration.update({
        where: { id: generation.id }, data: { status: "dispatch_refused", stopReason: "cancelled", completedAt: now },
      });
      await tx.researchPreviewRun.update({ where: { id: run.id }, data: {
        status: usage.usageFromProvider ? "cancelled" : "attention",
        stopReason: usage.usageFromProvider ? "cancelled" : "outcome_unknown",
        checkpoint: Prisma.DbNull, checkpointExpiresAt: null, settlementUsage: checkpointJson(usage),
        leaseOwner: null, leaseExpiresAt: null, activeDeadlineAt: null, completedAt: now,
      } });
      return "cancelled" as const;
    }
    if (generation?.status === "intent") {
      await tx.researchPreviewGeneration.update({
        where: { id: generation.id },
        data: { leaseEpoch: run.leaseEpoch },
      });
    }
    const resumable = run.checkpoint !== null && run.checkpointExpiresAt && run.checkpointExpiresAt > now;
    await tx.researchPreviewRun.update({
      where: { id: run.id },
      data: {
        status: resumable ? "checkpointed" : "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        activeDeadlineAt: null,
      },
    });
    return resumable ? ("checkpointed" as const) : ("queued" as const);
  });
}

export async function readResearchPreviewRunForWorker(id: string) {
  return prisma.researchPreviewRun.findUnique({
    where: { id },
    include: { generations: { orderBy: { generationIndex: "asc" } } },
  });
}

export async function researchPreviewRunsAwaitingSettlement(limit = 50) {
  return prisma.researchPreviewRun.findMany({
    where: {
      status: { in: ["completed", "failed", "cancelled", "attention"] },
      reservationId: { not: null },
      settlementUsage: { not: Prisma.DbNull },
    },
    orderBy: { completedAt: "asc" },
    take: Math.min(100, Math.max(1, limit)),
  });
}

export async function markResearchPreviewRunSettled(runId: string) {
  await prisma.researchPreviewRun.updateMany({
    where: { id: runId, settlementUsage: { not: Prisma.DbNull } },
    data: { settlementUsage: Prisma.DbNull },
  });
}

export const researchPreviewWorkerId = () => `research-preview:${randomUUID()}`;
