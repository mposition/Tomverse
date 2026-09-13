import { createHash } from "node:crypto";
import { z } from "zod";

export const CHAT_ATTEMPT_ID_REUSED = "CHAT_ATTEMPT_ID_REUSED" as const;
export const CHAT_ATTEMPT_REVISION_CONFLICT = "CHAT_ATTEMPT_REVISION_CONFLICT" as const;
export const CHAT_RESPONSE_ATTEMPT_MAX_LEASE_MS = 5 * 60 * 1_000;

export const CHAT_RESPONSE_ATTEMPT_ACTIVE_STATUSES = ["claimed", "streaming"] as const;
export const CHAT_RESPONSE_ATTEMPT_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;
export const CHAT_RESPONSE_ATTEMPT_STATUSES = [
  ...CHAT_RESPONSE_ATTEMPT_ACTIVE_STATUSES,
  ...CHAT_RESPONSE_ATTEMPT_TERMINAL_STATUSES,
] as const;
export const CHAT_RESPONSE_ATTEMPT_FINISH_REASONS = [
  "stop",
  "length",
  "content_filter",
  "tool_call",
  "cancelled",
  "error",
] as const;
export const CHAT_RESPONSE_ATTEMPT_FAILURE_CODES = [
  "provider_unavailable",
  "model_unavailable",
  "request_refused",
  "stream_interrupted",
  "worker_lease_expired",
  "internal_error",
] as const;
export const chatResponseAttemptStatusSchema = z.enum(CHAT_RESPONSE_ATTEMPT_STATUSES);
export const chatResponseAttemptTerminalStatusSchema = z.enum(
  CHAT_RESPONSE_ATTEMPT_TERMINAL_STATUSES
);
export const chatResponseAttemptFinishReasonSchema = z.enum(
  CHAT_RESPONSE_ATTEMPT_FINISH_REASONS
);
export const chatResponseAttemptFailureCodeSchema = z.enum(
  CHAT_RESPONSE_ATTEMPT_FAILURE_CODES
);

export type ChatResponseAttemptStatus = (typeof CHAT_RESPONSE_ATTEMPT_STATUSES)[number];
export type ChatResponseAttemptTerminalStatus =
  (typeof CHAT_RESPONSE_ATTEMPT_TERMINAL_STATUSES)[number];
export type ChatResponseAttemptFinishReason =
  (typeof CHAT_RESPONSE_ATTEMPT_FINISH_REASONS)[number];
export type ChatResponseAttemptFailureCode =
  (typeof CHAT_RESPONSE_ATTEMPT_FAILURE_CODES)[number];

const idSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const modelIdSchema = z.string().trim().min(1).max(120);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const chatResponseAttemptIdSchema = idSchema;

export const chatResponseAttemptClaimSchema = z
  .object({
    assistantMessageId: idSchema,
    conversationId: idSchema,
    sourceUserMessageId: idSchema,
    requestedModelId: modelIdSchema,
    requestPayloadDigest: sha256Schema,
    ownerId: z.string().trim().min(1).max(128),
    leaseExpiresAt: z.date(),
  })
  .strict();

export type ChatResponseAttemptClaimInput = z.infer<
  typeof chatResponseAttemptClaimSchema
>;

export type ChatResponseAttemptIdentity = {
  assistantMessageId: string;
  userId: string;
  conversationId: string;
  sourceUserMessageId: string;
  fingerprint: string;
  requestedModelId: string;
};

export type ChatResponseAttemptRecord = ChatResponseAttemptIdentity & {
  actualModelId: string | null;
  provider: string | null;
  status: ChatResponseAttemptStatus;
  partialContent: string;
  checkpointRevision: number;
  ownerId: string;
  leaseExpiresAt: Date;
  finishReason: ChatResponseAttemptFinishReason | null;
  failureCode: ChatResponseAttemptFailureCode | null;
  terminalAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const fingerprintPart = (value: string) => `${Buffer.byteLength(value, "utf8")}:${value}`;

/** Versioned and length-delimited; no prompt text is persisted by this function. */
export function chatResponseAttemptFingerprint(input: {
  conversationId: string;
  sourceUserMessageId: string;
  requestedModelId: string;
  requestPayloadDigest: string;
}): string {
  const parsed = chatResponseAttemptClaimSchema.pick({
    conversationId: true,
    sourceUserMessageId: true,
    requestedModelId: true,
    requestPayloadDigest: true,
  }).parse({
    conversationId: input.conversationId,
    sourceUserMessageId: input.sourceUserMessageId,
    requestedModelId: input.requestedModelId,
    requestPayloadDigest: input.requestPayloadDigest,
  });
  const material = [
    "chat-response-attempt.v1",
    parsed.conversationId,
    parsed.sourceUserMessageId,
    parsed.requestedModelId,
    parsed.requestPayloadDigest,
  ]
    .map(fingerprintPart)
    .join("|");
  return createHash("sha256").update(material).digest("hex");
}

export type AttemptClaimDecision =
  | { action: "create" }
  | { action: "reattach" }
  | { action: "conflict"; code: typeof CHAT_ATTEMPT_ID_REUSED };

export function decideAttemptClaim(
  existing: ChatResponseAttemptIdentity | null,
  requested: ChatResponseAttemptIdentity
): AttemptClaimDecision {
  if (!existing) return { action: "create" };
  const same =
    existing.assistantMessageId === requested.assistantMessageId &&
    existing.userId === requested.userId &&
    existing.conversationId === requested.conversationId &&
    existing.sourceUserMessageId === requested.sourceUserMessageId &&
    existing.fingerprint === requested.fingerprint &&
    existing.requestedModelId === requested.requestedModelId;
  return same
    ? { action: "reattach" }
    : { action: "conflict", code: CHAT_ATTEMPT_ID_REUSED };
}

export type AttemptCasRefusal =
  | "terminal"
  | "revision_conflict"
  | "owner_mismatch"
  | "lease_expired"
  | "lease_too_long"
  | "committed_prefix_changed";

export function validateAttemptLease(input: {
  now: Date;
  leaseExpiresAt: Date;
}): "valid" | "lease_expired" | "lease_too_long" {
  const now = input.now.getTime();
  const expires = input.leaseExpiresAt.getTime();
  if (!Number.isFinite(now) || !Number.isFinite(expires) || expires <= now) {
    return "lease_expired";
  }
  return expires - now <= CHAT_RESPONSE_ATTEMPT_MAX_LEASE_MS
    ? "valid"
    : "lease_too_long";
}

export function validateAttemptTerminalMetadata(input: {
  status: ChatResponseAttemptTerminalStatus;
  finishReason: ChatResponseAttemptFinishReason | null;
  failureCode: ChatResponseAttemptFailureCode | null;
}): boolean {
  if (input.status === "failed") {
    return input.finishReason === "error" && input.failureCode !== null;
  }
  if (input.status === "cancelled") {
    return input.finishReason === "cancelled" && input.failureCode === null;
  }
  return (
    input.failureCode === null &&
    input.finishReason !== "error" &&
    input.finishReason !== "cancelled"
  );
}

type AttemptCasDecision =
  | { action: "update"; nextRevision: number }
  | { action: "refuse"; reason: AttemptCasRefusal };

function commonAttemptCas(input: {
  status: ChatResponseAttemptStatus;
  checkpointRevision: number;
  expectedRevision: number;
  ownerId: string;
  expectedOwnerId: string;
  leaseExpiresAt: Date;
  now: Date;
}): AttemptCasDecision {
  if ((CHAT_RESPONSE_ATTEMPT_TERMINAL_STATUSES as readonly string[]).includes(input.status)) {
    return { action: "refuse", reason: "terminal" };
  }
  if (input.checkpointRevision !== input.expectedRevision) {
    return { action: "refuse", reason: "revision_conflict" };
  }
  if (input.ownerId !== input.expectedOwnerId) {
    return { action: "refuse", reason: "owner_mismatch" };
  }
  const lease = validateAttemptLease(input);
  if (lease !== "valid") {
    return { action: "refuse", reason: lease };
  }
  if (input.checkpointRevision >= 2_147_483_647) {
    return { action: "refuse", reason: "revision_conflict" };
  }
  return { action: "update", nextRevision: input.checkpointRevision + 1 };
}

export function decideAttemptCheckpoint(input: {
  status: ChatResponseAttemptStatus;
  checkpointRevision: number;
  expectedRevision: number;
  ownerId: string;
  expectedOwnerId: string;
  leaseExpiresAt: Date;
  now: Date;
  committedContent: string;
  nextContent: string;
}): AttemptCasDecision {
  const decision = commonAttemptCas(input);
  if (decision.action === "refuse") return decision;
  if (!input.nextContent.startsWith(input.committedContent)) {
    return { action: "refuse", reason: "committed_prefix_changed" };
  }
  return decision;
}

export function decideAttemptTerminal(input: {
  status: ChatResponseAttemptStatus;
  checkpointRevision: number;
  expectedRevision: number;
  ownerId: string;
  expectedOwnerId: string;
  leaseExpiresAt: Date;
  now: Date;
  committedContent: string;
  finalContent: string;
  terminalStatus: ChatResponseAttemptTerminalStatus;
}): AttemptCasDecision {
  const decision = commonAttemptCas(input);
  if (decision.action === "refuse") return decision;
  if (!input.finalContent.startsWith(input.committedContent)) {
    return { action: "refuse", reason: "committed_prefix_changed" };
  }
  return decision;
}

export function publicChatResponseAttempt(record: ChatResponseAttemptRecord) {
  return {
    assistantMessageId: record.assistantMessageId,
    conversationId: record.conversationId,
    sourceUserMessageId: record.sourceUserMessageId,
    requestedModelId: record.requestedModelId,
    actualModelId: record.actualModelId,
    provider: record.provider,
    status: record.status,
    partialContent: record.partialContent,
    checkpointRevision: record.checkpointRevision,
    finishReason: record.finishReason,
    failureCode: record.failureCode,
    terminalAt: record.terminalAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
