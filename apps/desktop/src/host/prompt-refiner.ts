import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  promptRefinerProductPrepareResponseSchema,
  promptRefinerProductScopeResponseSchema,
  type PromptRefinerProductChatDecision,
} from "../../../../lib/promptRefinerProductApiContract";
import type { AccountSettingsApi } from "./account-settings-api";

/**
 * The Prompt Refiner for an Auto Chat turn, as the web composer does it, without any panel: the Refiner is automatic
 * (owner decision 2026-11-23), so Desktop only prepares what the server asks for and sends the decision it hands back.
 *
 * The server holds the exact draft, so the typed text is written as the conversation's durable composer draft first
 * (created, never overwritten: a draft the web already holds for this conversation makes this turn go on without a
 * Refiner). The held suggestion, its one-time consume, the budget and the release authority are the server's own; this
 * module sends nothing but identifiers and never sees the rewritten text. Every failure is the authored original: one
 * attempt, no retry, no second paid call from the same send.
 */
export type RefinedTurn = Readonly<{ decision: PromptRefinerProductChatDecision; clientRequestId: string }>;

export type RefinerAttempt = Readonly<{
  /** Null when the turn goes on as typed. */
  refined: RefinedTurn | null;
  /** Removes the draft written for this attempt; safe to call more than once, and never throws. */
  finish(): Promise<void>;
}>;

type Sender = Pick<AccountSettingsApi, "send">;

// A budgeted Refiner call may take most of the server's own 13 s deadline; the others are small reads and writes.
const PREPARE_TIMEOUT_MS = 16_000;
const STEP_TIMEOUT_MS = 8_000;

// One mount id for the life of this app run, as one open web composer has one. The server keeps a scope row per mount id and
// moves its epoch on every call, so a turn never leaves a scope row behind and a later turn invalidates an unused held row.
const mountId = randomUUID();

const draftWritten = z.object({ draft: z.object({ revision: z.number().int().positive() }) });
const none: RefinerAttempt = Object.freeze({ refined: null, finish: async () => {} });

/** What a turn must be for the Refiner to run on it: Auto, plain text, in a saved conversation. */
export function refinerEligible(input: {
  enabled: boolean; conversationId: string | undefined; prompt: string; selectionMode: "auto" | "manual";
  attachmentCount: number; deepResearch: boolean; plugin: boolean; handoff: boolean;
}) {
  return input.enabled && input.selectionMode === "auto" && Boolean(input.conversationId) && input.prompt.length > 0 &&
    input.attachmentCount === 0 && !input.deepResearch && !input.plugin && !input.handoff;
}

export async function prepareRefinedTurn(settings: Sender, input: { conversationId: string; prompt: string }, signal: AbortSignal): Promise<RefinerAttempt> {
  const draftPath = "/api/products/chat/drafts/" + encodeURIComponent(input.conversationId);
  let revision: number | undefined;
  const call = (path: string, method: "POST" | "PUT" | "DELETE", body: object, timeout: number) =>
    settings.send({ path, method, body }, "application/json", timeout);
  const finish = async () => {
    const written = revision;
    revision = undefined;
    if (written === undefined) return;
    try {
      const response = await call(draftPath, "DELETE", { expectedRevision: written }, STEP_TIMEOUT_MS);
      await response.body?.cancel().catch(() => {});
    } catch { /* A draft left behind only restores the text that was sent, and the next write reports it as a conflict. */ }
  };
  try {
    signal.throwIfAborted();
    const put = await call(draftPath, "PUT", { expectedRevision: 0, text: input.prompt, attachmentReferences: [] }, STEP_TIMEOUT_MS);
    const written = put.ok ? draftWritten.safeParse(await put.json().catch(() => null)) : null;
    if (!put.ok) await put.body?.cancel().catch(() => {});
    if (!written?.success) return none;
    revision = written.data.draft.revision;

    const scopeResponse = await call("/api/chat/prompt-refiner/scope",
      "POST", { mountId, conversationId: input.conversationId, surface: "chat" }, STEP_TIMEOUT_MS);
    const scope = scopeResponse.ok ? promptRefinerProductScopeResponseSchema.safeParse(await scopeResponse.json().catch(() => null)) : null;
    if (!scopeResponse.ok) await scopeResponse.body?.cancel().catch(() => {});
    if (!scope?.success) return { refined: null, finish };
    signal.throwIfAborted();

    const prepareResponse = await call("/api/chat/prompt-refiner/prepare", "POST", {
      conversationId: input.conversationId, scopeId: scope.data.scopeId, epoch: scope.data.epoch, draftRevision: revision,
    }, PREPARE_TIMEOUT_MS);
    const prepared = prepareResponse.ok
      ? promptRefinerProductPrepareResponseSchema.safeParse(await prepareResponse.json().catch(() => null)) : null;
    if (!prepareResponse.ok) await prepareResponse.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    // A held row for another scope is not this turn's: the original goes as typed.
    if (prepared?.success && prepared.data.outcome === "auto_held" &&
        prepared.data.decision.scopeId === scope.data.scopeId && prepared.data.decision.epoch === scope.data.epoch) {
      return { refined: { decision: prepared.data.decision, clientRequestId: prepared.data.clientRequestId }, finish };
    }
    return { refined: null, finish };
  } catch (error) {
    // A stop ends the turn; anything else only costs the Refiner.
    if (signal.aborted) { await finish(); throw error; }
    return { refined: null, finish };
  }
}
