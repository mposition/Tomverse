import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";
import type { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";

/** The labels these components draw, taken from the page catalogue (the caller reads the locale). */
export type AmuxCardIdentityCopy = Pick<typeof adminAmuxExecutionMessages.en, "taskId" | "sourceKey">;

/** The source key is shown only when it adds information beyond the Task ID. */
export function amuxDistinctSourceKey(id: string, sourceKey: string | null | undefined): string | null {
  return sourceKey && sourceKey !== id ? sourceKey : null;
}

/**
 * The name a card is listed under: its readable number when it has one
 * (docs/policy/amux-card-display-key.md §2-5), otherwise its Task ID.
 */
export function amuxCardLabel(card: { id: string; displayKey?: string | null }): string {
  return card.displayKey ?? card.id;
}

/**
 * Detail header identity: the card number leads when there is one, the Task ID
 * sits right under it, and the source key is a labelled secondary line.
 */
export function AmuxCardIdentity({ id, displayKey = null, sourceKey, revision, m }: {
  id: string; displayKey?: string | null; sourceKey: string | null; revision: number; m: AmuxCardIdentityCopy;
}) {
  const source = amuxDistinctSourceKey(id, sourceKey);
  return <>
    {displayKey && <p className="font-semibold" data-testid="amux-detail-card-number">
      {amuxVisibleInspectionText(displayKey)}</p>}
    <p data-testid="amux-detail-task-id">{m.taskId}: {amuxVisibleInspectionText(id)} · r{revision}</p>
    {source && <p className="text-xs opacity-70" data-testid="amux-detail-source-key">
      {m.sourceKey}: {amuxVisibleInspectionText(source)}</p>}
  </>;
}

/**
 * Secondary identity for compact lists whose primary text is `amuxCardLabel`:
 * the Task ID when a number leads, otherwise a distinct source key.
 */
export function AmuxSourceKeySuffix({ id, displayKey = null, sourceKey, m }: {
  id: string; displayKey?: string | null; sourceKey: string | null; m: AmuxCardIdentityCopy;
}) {
  if (displayKey) {
    return <span className="text-xs opacity-70"> ({m.taskId}: {amuxVisibleInspectionText(id)})</span>;
  }
  const source = amuxDistinctSourceKey(id, sourceKey);
  return source ? <span className="text-xs opacity-70"> ({m.sourceKey}: {amuxVisibleInspectionText(source)})</span> : null;
}
