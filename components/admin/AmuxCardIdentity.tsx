import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";
import type { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";

/** The labels these components draw, taken from the page catalogue (the caller reads the locale). */
export type AmuxCardIdentityCopy = Pick<typeof adminAmuxExecutionMessages.en, "taskId" | "sourceKey">;

/** The source key is shown only when it adds information beyond the Task ID. */
export function amuxDistinctSourceKey(id: string, sourceKey: string | null | undefined): string | null {
  return sourceKey && sourceKey !== id ? sourceKey : null;
}

/** Detail header identity: the Task ID leads, the source key is a labelled secondary line. */
export function AmuxCardIdentity({ id, sourceKey, revision, m }: {
  id: string; sourceKey: string | null; revision: number; m: AmuxCardIdentityCopy;
}) {
  const source = amuxDistinctSourceKey(id, sourceKey);
  return <>
    <p data-testid="amux-detail-task-id">{m.taskId}: {amuxVisibleInspectionText(id)} · r{revision}</p>
    {source && <p className="text-xs opacity-70" data-testid="amux-detail-source-key">
      {m.sourceKey}: {amuxVisibleInspectionText(source)}</p>}
  </>;
}

/** Secondary source-key suffix for compact lists whose primary text is the Task ID. */
export function AmuxSourceKeySuffix({ id, sourceKey, m }: {
  id: string; sourceKey: string | null; m: AmuxCardIdentityCopy;
}) {
  const source = amuxDistinctSourceKey(id, sourceKey);
  return source ? <span className="text-xs opacity-70"> ({m.sourceKey}: {amuxVisibleInspectionText(source)})</span> : null;
}
