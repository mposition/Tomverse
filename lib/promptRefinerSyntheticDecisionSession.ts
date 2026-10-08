import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  projectPromptRefinerChatHandoff,
  type PromptRefinerChatMessage,
  type PromptRefinerChatProjection,
  type PromptRefinerChatScope,
} from "@/lib/promptRefinerChatHandoff";
import {
  bindPromptRefinerSuggestion,
  promptRefinerRequestSchema,
  promptRefinerResponseSchema,
  resolvePromptRefinerDecision,
  type BoundPromptRefinerSuggestion,
  type PromptRefinerRequest,
} from "@/lib/promptRefinerSuggestion";

/** A synthetic-session lifetime, not a product retention or rollout contract. */
export const PROMPT_REFINER_SYNTHETIC_PROPOSAL_TTL_MS = 60_000;

const snapshotSchema = z.object({
  draft: z.string(),
  sourceMessageId: z.string().min(1).max(128),
  scope: z.object({
    identityKey: z.string().nullable(),
    mountedSurface: z.string(),
    conversationId: z.string().nullable(),
  }).strict(),
}).strict();

/** The decision carries ids and an explicit choice, never proposal bytes. */
const choiceSchema = z.object({
  requestId: z.string().min(1).max(128),
  suggestionId: z.string().min(1).max(128),
  decision: z.enum(["accepted", "kept_original"]),
}).strict();

type Snapshot = z.infer<typeof snapshotSchema>;
type State = "idle" | "requesting" | "ready" | "accepted" | "kept_original"
  | "closed" | "failed" | "stale" | "expired";

export class PromptRefinerSyntheticDecisionError extends Error {
  constructor(readonly code: "invalid_snapshot" | "invalid_request" | "invalid_proposal"
    | "invalid_choice" | "unavailable" | "stale" | "expired" | "clock_invalid"
    | "invalid_transcript") {
    super(`prompt_refiner_synthetic_${code}`);
    this.name = "PromptRefinerSyntheticDecisionError";
  }
}

const fail = (code: PromptRefinerSyntheticDecisionError["code"]): never => {
  throw new PromptRefinerSyntheticDecisionError(code);
};

const sameScope = (left: PromptRefinerChatScope, right: PromptRefinerChatScope) =>
  left.identityKey === right.identityKey && left.mountedSurface === right.mountedSurface
  && left.conversationId === right.conversationId;

/**
 * Server-only, process-local C03 harness. No route, product caller, provider,
 * database, receipt writer or durable authorization is connected to it.
 * The harness owner supplies server-observed draft/scope changes (including
 * transitions away and back); browser claims cannot seed or renew a proposal.
 * A restart loses the session and therefore rejects all previous ids.
 */
export function createPromptRefinerSyntheticDecisionSession(input: {
  snapshot: Snapshot;
  now?: () => number;
}) {
  const parseSnapshot = (value: Snapshot): Snapshot => {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success) return fail("invalid_snapshot");
    return parsed.data;
  };
  let snapshot = parseSnapshot(input.snapshot);
  let state: State = "idle";
  let pending: { request: PromptRefinerRequest; expiresAt: number } | null = null;
  let held: BoundPromptRefinerSuggestion | null = null;
  let lastNow = -Infinity;
  const clock = input.now ?? Date.now;

  const discard = (next: State) => {
    pending = null;
    held = null;
    state = next;
  };
  const observeTime = () => {
    let value: number;
    try { value = clock(); } catch { discard("failed"); return fail("clock_invalid"); }
    if (!Number.isSafeInteger(value) || value < 0 || value < lastNow
      || value > Number.MAX_SAFE_INTEGER - PROMPT_REFINER_SYNTHETIC_PROPOSAL_TTL_MS) {
      discard("failed");
      return fail("clock_invalid");
    }
    lastNow = value;
    if (pending && value >= pending.expiresAt) discard("expired");
    return value;
  };
  const unavailable = (): never =>
    fail(state === "stale" ? "stale" : state === "expired" ? "expired" : "unavailable");

  return {
    status(): State {
      observeTime();
      return state;
    },
    /** Only the server harness can replace its authoritative snapshot. */
    updateSnapshot(value: Snapshot) {
      let next: Snapshot;
      try { next = parseSnapshot(value); } catch {
        discard("failed");
        return fail("invalid_snapshot");
      }
      if (next.draft !== snapshot.draft || next.sourceMessageId !== snapshot.sourceMessageId
        || !sameScope(next.scope, snapshot.scope)) {
        // Irrevocable lifetime invalidation also rejects same-value ABA.
        discard("stale");
      }
      snapshot = next;
    },
    beginProposal(): PromptRefinerRequest {
      const now = observeTime();
      const parsed = promptRefinerRequestSchema.safeParse({
        requestId: `synthetic_${randomUUID()}`,
        prompt: snapshot.draft,
      });
      if (!parsed.success) { discard("failed"); return fail("invalid_request"); }
      held = null;
      pending = { request: parsed.data, expiresAt: now + PROMPT_REFINER_SYNTHETIC_PROPOSAL_TTL_MS };
      state = "requesting";
      return { ...parsed.data };
    },
    /** Called with the isolated synthetic adapter's result, never a browser body. */
    completeProposal(requestId: string, response: unknown) {
      observeTime();
      if (!pending || state !== "requesting" || pending.request.requestId !== requestId) return unavailable();
      try {
        const parsed = promptRefinerResponseSchema.parse(response);
        const bound = bindPromptRefinerSuggestion({
          request: pending.request, response: parsed, currentPrompt: snapshot.draft,
        });
        if (!bound) throw new Error("stale");
        held = bound;
        state = "ready";
        return { ...parsed };
      } catch {
        discard("failed");
        return fail("invalid_proposal");
      }
    },
    close() { discard("closed"); },
    fail() { discard("failed"); },
    /** Synchronous take-and-project: no second event can consume the same state. */
    consumeSyntheticInput<Message extends PromptRefinerChatMessage>(
      messages: readonly Message[],
      choice: unknown = null,
    ): PromptRefinerChatProjection<Message> | {
      authoredMessages: readonly Message[];
      executionMessages: readonly Message[];
      provenance: null;
    } {
      observeTime();
      if (choice === null) {
        discard("closed");
        return { authoredMessages: messages, executionMessages: messages, provenance: null };
      }
      const parsed = choiceSchema.safeParse(choice);
      if (!parsed.success) { discard("failed"); return fail("invalid_choice"); }
      if (!held || !pending || state !== "ready") return unavailable();
      if (parsed.data.requestId !== held.requestId || parsed.data.suggestionId !== held.suggestionId) {
        discard("failed");
        return fail("invalid_choice");
      }
      const suggestion = held;
      // Consume before projection, even if transcript validation then fails.
      discard("failed");
      try {
        const resolution = resolvePromptRefinerDecision({
          suggestion, currentPrompt: snapshot.draft, decision: parsed.data.decision,
        });
        const projection = projectPromptRefinerChatHandoff({
          messages, sourceMessageId: snapshot.sourceMessageId, serverSuggestion: suggestion,
          boundScope: snapshot.scope, currentScope: snapshot.scope,
          decision: parsed.data.decision, suppliedResolution: resolution,
        });
        state = parsed.data.decision;
        return projection;
      } catch {
        return fail("invalid_transcript");
      }
    },
  };
}
