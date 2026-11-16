import { createHash } from "node:crypto";
import { z } from "zod";
import { estimateTextTokens } from "@/lib/chatTokenEstimate";
import {
  CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT,
  CONTINUATION_SEED_TOKEN_BUDGET,
  type ContinuationSeedPlan,
  type ContinuationSourceMessage,
} from "@/lib/externalContinuationSeedCore";

const integer = z.number().int().nonnegative();
const range = z.object({ start: integer, end: integer }).strict()
  .refine(value => value.end > value.start);
const ranges = z.array(range).max(200);
const manifestSchema = z.object({
  version: z.literal(1),
  sourceId: z.string().min(1),
  sourceConversationDigest: z.string().min(1),
  sourceDigestVersion: integer,
  attempt: z.object({
    assistantMessageId: z.string().min(1),
    sourceUserMessageId: z.string().min(1),
    attemptIndex: integer,
    actualModelId: z.string().min(1),
    provider: z.string().min(1),
  }).strict(),
  plan: z.object({
    seedVersion: z.enum(["ext-seed-v2", "ext-seed-v3-selected-recent", "ext-seed-v4-retrieved"]),
    historyOutcome: z.enum(["matched", "no_match", "no_query", "budget_limited"]).optional(),
    fromOrdinal: integer,
    toOrdinal: integer,
    sourceMessageCount: integer,
    truncatedCount: integer,
    omittedByBudgetCount: integer,
    excludedByRoleCount: integer,
    blankSkippedCount: integer,
    estimatedTokens: integer,
    turns: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      ordinal: integer,
      shortened: z.boolean(),
      ranges: ranges.min(1),
      selectedRanges: ranges.optional(),
      recentRanges: ranges.optional(),
      retrievedRanges: ranges.optional(),
      excerptDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict()).max(200),
  }).strict(),
}).strict();

export type ContinuationSourceManifest = z.infer<typeof manifestSchema>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Null is legacy; malformed evidence is never silently treated as legacy. */
export function parseContinuationSourceManifest(value: unknown): ContinuationSourceManifest {
  return manifestSchema.parse(value);
}

/** Explicit allowlist: neither source text nor provider input is persisted. */
export function serializeContinuationSourcePlan(input: {
  plan: ContinuationSeedPlan;
  sourceId: string;
  sourceConversationDigest: string;
  sourceDigestVersion: number;
  attempt: ContinuationSourceManifest["attempt"];
}): ContinuationSourceManifest {
  const { plan } = input;
  return parseContinuationSourceManifest({
    version: 1,
    sourceId: input.sourceId,
    sourceConversationDigest: input.sourceConversationDigest,
    sourceDigestVersion: input.sourceDigestVersion,
    attempt: input.attempt,
    plan: {
      seedVersion: plan.seedVersion,
      ...(plan.historyOutcome ? { historyOutcome: plan.historyOutcome } : {}),
      fromOrdinal: plan.fromOrdinal, toOrdinal: plan.toOrdinal,
      sourceMessageCount: plan.sourceMessageCount,
      truncatedCount: plan.truncatedCount, omittedByBudgetCount: plan.omittedByBudgetCount,
      excludedByRoleCount: plan.excludedByRoleCount, blankSkippedCount: plan.blankSkippedCount,
      estimatedTokens: plan.estimatedTokens,
      turns: plan.turns.map(turn => ({
        role: turn.role, ordinal: turn.ordinal, shortened: turn.shortened,
        ranges: turn.ranges,
        ...(turn.selectedRanges ? { selectedRanges: turn.selectedRanges } : {}),
        ...(turn.recentRanges ? { recentRanges: turn.recentRanges } : {}),
        ...(turn.retrievedRanges ? { retrievedRanges: turn.retrievedRanges } : {}),
        excerptDigest: digest(turn.text),
      })),
    },
  });
}

/** Rehydrate the recorded excerpts, never run today's picker or retrieval plan. */
export function restoreContinuationSourcePlan(input: {
  manifest: ContinuationSourceManifest;
  messages: readonly ContinuationSourceMessage[];
  snapshot: { id: string; conversationDigest: string; digestVersion: number; messageCount: number };
}): ContinuationSeedPlan {
  const manifest = parseContinuationSourceManifest(input.manifest);
  const { snapshot } = input;
  if (manifest.sourceId !== snapshot.id || manifest.sourceConversationDigest !== snapshot.conversationDigest ||
      manifest.sourceDigestVersion !== snapshot.digestVersion || manifest.plan.sourceMessageCount !== snapshot.messageCount) {
    throw new Error("Continuation source binding changed.");
  }
  let previousOrdinal = -1;
  const turns = manifest.plan.turns.map(turn => {
    const row = input.messages.find(message => message.ordinal === turn.ordinal);
    if (!row || row.role !== turn.role || turn.ordinal <= previousOrdinal) throw new Error("Continuation source membership changed.");
    previousOrdinal = turn.ordinal;
    let previousEnd = -1;
    for (const part of turn.ranges) {
      if (part.start < previousEnd || part.end > row.content.length) throw new Error("Invalid continuation source range.");
      previousEnd = part.end;
      // UTF-16 coordinates must not split a surrogate pair.
      for (const offset of [part.start, part.end]) {
        if (offset > 0 && offset < row.content.length && /[\uD800-\uDBFF]/.test(row.content[offset - 1]) &&
            /[\uDC00-\uDFFF]/.test(row.content[offset])) throw new Error("Invalid continuation Unicode range.");
      }
    }
    for (const classified of [turn.selectedRanges, turn.recentRanges, turn.retrievedRanges]) {
      if (classified?.some(part => !turn.ranges.some(whole => part.start >= whole.start && part.end <= whole.end))) {
        throw new Error("Invalid continuation source classification.");
      }
    }
    const text = turn.ranges.map(part => row.content.slice(part.start, part.end)).join(" […] ");
    const { excerptDigest, ...reference } = turn;
    if (digest(text) !== excerptDigest || Array.from(text).length > CONTINUATION_SEED_MESSAGE_CHARACTER_LIMIT) {
      throw new Error("Continuation source excerpt changed.");
    }
    return { ...reference, text };
  });
  const estimatedTokens = turns.reduce((sum, turn) => sum + estimateTextTokens(turn.text), 0);
  if (estimatedTokens > CONTINUATION_SEED_TOKEN_BUDGET || estimatedTokens !== manifest.plan.estimatedTokens ||
      manifest.plan.fromOrdinal !== (turns[0]?.ordinal ?? 0) || manifest.plan.toOrdinal !== (turns.at(-1)?.ordinal ?? 0) ||
      manifest.plan.truncatedCount !== turns.filter(turn => turn.shortened).length) {
    throw new Error("Invalid continuation source budget.");
  }
  return { ...manifest.plan, turns, estimatedTokens };
}
