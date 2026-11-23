import type { MobileProjectsCopy } from "../../../locales/mobileProjects";
import { projectDeletionNeedsConfirmation, type ProjectAnswerReceipt, type ProjectDeletionSummary, type ProjectSearchHit } from "@tomverse/api-client";

/**
 * Pure rules behind the native project workspace UI. Kept free of React so
 * node tests can exercise them without a DOM.
 */

/** The server re-reads at most this many references per question. */
export const MAX_PROJECT_REFERENCES = 8;

export type ProjectFailure =
  | "unavailable" | "conflict" | "archived" | "deleteRequired" | "deleteStale"
  | "nameTaken" | "limit" | "memoryOff" | "memoryConflict" | "memoryChanged" | "memoryLocked" | "notFound" | "aborted" | "failed";

/** Maps a thrown project client error to the one message class the UI shows. */
export function classifyProjectFailure(error: unknown): ProjectFailure {
  const input = (error ?? {}) as { name?: unknown; status?: unknown; code?: unknown };
  if (input.name === "AbortError") return "aborted";
  const code = typeof input.code === "string" ? input.code : "";
  const status = typeof input.status === "number" ? input.status : 0;
  switch (code) {
    case "PROJECT_REVISION_CONFLICT": return "conflict";
    case "PROJECT_ARCHIVED": return "archived";
    case "PROJECT_DELETE_CONFIRMATION_REQUIRED": return "deleteRequired";
    case "PROJECT_DELETE_STALE": return "deleteStale";
    case "PROJECT_NAME_TAKEN": return "nameTaken";
    case "PROJECT_LIMIT_REACHED": return "limit";
    case "MEMORY_FEATURE_DISABLED": return "memoryOff";
    case "MEMORY_ITEM_CONFLICT": return "memoryConflict";
    case "MEMORY_ITEM_STATE": return "memoryChanged";
    case "MEMORY_SOURCE_LOCKED": return "memoryLocked";
    case "PROJECT_NOT_FOUND": return "notFound";
    default: break;
  }
  // A switched-off native route answers 503 (older servers 401); both mean "not available".
  if (status === 401 || status === 501 || status === 503) return "unavailable";
  if (status === 404) return "notFound";
  return "failed";
}

/** Reads the summary a 409 delete refusal carries, or null when it carries none. */
export function deletionSummaryFromError(error: unknown): ProjectDeletionSummary | null {
  const details = (error as { details?: Partial<ProjectDeletionSummary> } | null)?.details;
  if (!details) return null;
  const { conversations, materials, memories, revision } = details;
  return [conversations, materials, memories, revision].every(value => Number.isInteger(value))
    ? { conversations: conversations!, materials: materials!, memories: memories!, revision: revision! }
    : null;
}

/** The confirmation a delete must echo: only needed when content would be lost. */
export function deletionConfirmation(summary: ProjectDeletionSummary) {
  return projectDeletionNeedsConfirmation(summary)
    ? { revision: summary.revision, materials: summary.materials, memories: summary.memories }
    : undefined;
}

export type ProjectReference = { ref: string; title: string; kind: ProjectSearchHit["location"]["kind"] };

/** Adds or removes one reference; adding past the limit returns the list unchanged. */
export function toggleReference(items: readonly ProjectReference[], hit: ProjectReference, max = MAX_PROJECT_REFERENCES): ProjectReference[] {
  if (items.some(item => item.ref === hit.ref)) return items.filter(item => item.ref !== hit.ref);
  return items.length >= max ? [...items] : [...items, hit];
}

/**
 * References belong to one project conversation and one signed-in account.
 * A different conversation, project, or owner starts from an empty list, so a
 * quick switch can never send an earlier selection with a later question.
 */
export type ReferenceSelection = { owner: string | null; conversationId: string | null; projectId: string | null; items: ProjectReference[] };
export const emptySelection: ReferenceSelection = { owner: null, conversationId: null, projectId: null, items: [] };
export function selectionFor(selection: ReferenceSelection, owner: string | null, conversationId: string | null, projectId: string | null): ProjectReference[] {
  return selection.owner === owner && selection.conversationId === conversationId && selection.projectId === projectId ? selection.items : [];
}

/** Splits a receipt into what was sent as context and what the model looked up. */
export function receiptGroups(receipt: ProjectAnswerReceipt) {
  const sources = receipt?.sources ?? [];
  return { context: sources.filter(source => source.via === "context"), tool: sources.filter(source => source.via === "tool") };
}

/** Request ordering: only the newest request's result may be applied. */
export function createLatestGuard() {
  let sequence = 0;
  return {
    begin(): () => boolean { const mine = ++sequence; return () => mine === sequence; },
    invalidate() { sequence++; },
  };
}

/** The messages a project conversation may not be sent with. */
export function projectSendBlock(project: { archivedAt: string | null } | null, failure: ProjectFailure | null): "archived" | "unavailable" | null {
  if (project?.archivedAt) return "archived";
  return failure === "unavailable" ? "unavailable" : null;
}

/** The one sentence a failure class is shown as. */
export function failureMessage(copy: MobileProjectsCopy, failure: ProjectFailure | null): string {
  switch (failure) {
    case "unavailable": return copy.unavailable;
    case "conflict": return copy.conflict;
    case "archived": return copy.archivedChat;
    case "nameTaken": return copy.nameTaken;
    case "limit": return copy.limitReached;
    case "memoryOff": return copy.memoryOff;
    case "memoryConflict": return copy.memoryConflict;
    case "memoryChanged": return copy.memoryChanged;
    case "memoryLocked": return copy.memorySourceLocked;
    case "notFound": return copy.notFound;
    case "deleteStale": return copy.deleteStale;
    default: return copy.failed;
  }
}
