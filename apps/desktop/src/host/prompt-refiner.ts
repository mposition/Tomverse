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
  /**
   * Removes the draft written for this attempt, only if it is still that draft; safe to call more than once, and never throws.
   * Call it once the question is saved: the server then keeps the held decision, because the saved message is the draft's text.
   */
  finish(): Promise<void>;
}>;

type Sender = Pick<AccountSettingsApi, "send">;

// A budgeted Refiner call may take most of the server's own 13 s deadline; the others are small reads and writes.
const PREPARE_TIMEOUT_MS = 16_000;
const STEP_TIMEOUT_MS = 8_000;

// One mount id for the life of this app run, as one open web composer has one. The server keeps a scope row per mount id and
// moves its epoch on every call, so a turn never leaves a scope row behind and a later turn invalidates an unused held row.
const mountId = randomUUID();

const draftWritten = z.object({ draft: z.object({ revision: z.number().int().positive(), createdAt: z.string().min(1) }) });
const draftRead = z.object({ draft: z.object({ revision: z.number().int().positive(), text: z.string(), createdAt: z.string().min(1) }).nullable() });
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
  // The draft this attempt created: set once a write was answered, whatever its body said, so cleanup never depends on reading it.
  let wrote = false;
  let createdAt: string | undefined;
  const call = (path: string, method: "GET" | "POST" | "PUT" | "DELETE", body: object | undefined, timeout: number) =>
    settings.send({ path, method, ...(body ? { body } : {}) }, "application/json", timeout);
  const finish = async () => {
    if (!wrote) return;
    wrote = false;
    try {
      // Remove the draft only if it is still the one written here: another client may have deleted it and started its own, which
      // would also be revision 1. The creation time tells them apart, and the text must still be what was sent.
      const read = await call(draftPath, "GET", undefined, STEP_TIMEOUT_MS);
      const current = read.ok ? draftRead.safeParse(await read.json().catch(() => null)) : null;
      if (!read.ok) await read.body?.cancel().catch(() => {});
      if (!current?.success || !current.data.draft) return;
      const { revision, text, createdAt: created } = current.data.draft;
      if (text !== input.prompt || (createdAt !== undefined && created !== createdAt)) return;
      // The delete names the draft that was read, so it applies only to that one: a draft another client started in between,
      // also at revision 1, is left alone by the server in the same statement.
      const response = await call(draftPath, "DELETE", { expectedRevision: revision, expectedCreatedAt: created }, STEP_TIMEOUT_MS);
      await response.body?.cancel().catch(() => {});
    } catch { /* A draft left behind only restores the text that was sent, and the next write reports it as a conflict. */ }
  };
  try {
    signal.throwIfAborted();
    const put = await call(draftPath, "PUT", { expectedRevision: 0, text: input.prompt, attachmentReferences: [] }, STEP_TIMEOUT_MS);
    if (!put.ok) {
      await put.body?.cancel().catch(() => {});
      return none;
    }
    wrote = true;
    const written = draftWritten.safeParse(await put.json().catch(() => null));
    if (!written.success) return { refined: null, finish };
    createdAt = written.data.draft.createdAt;
    const revision = written.data.draft.revision;

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
