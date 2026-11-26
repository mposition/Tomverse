import { ImportRequestError, type AssistantPackageImportRequests } from "../../../../lib/assistantPackageImportClient";
import type { PickedAssistantPackage } from "../../../../components/assistants/import/AssistantPackageImportWizard";
import type { AssistantImportAction, AssistantImportInput, AssistantImportResult } from "../assistant-import-contract";

// The web wizard's five requests and its file dialog, answered through the main process.
// Nothing here decides anything: a refusal keeps the status and code the server gave, and
// the wizard turns it into the same sentence it shows on the web.

export type AssistantImportCall = <Action extends AssistantImportAction>(
  input: Extract<AssistantImportInput, { action: Action }>,
) => Promise<AssistantImportResult<Action>>;

function unwrap<Action extends AssistantImportAction>(result: AssistantImportResult<Action>) {
  if (!result.ok) throw new ImportRequestError(result.status, result.code);
  return result.value;
}

export function createDesktopImportRequests(call: AssistantImportCall): AssistantPackageImportRequests {
  return {
    createImport: async body => unwrap(await call({ action: "create", body })),
    // The main process derives the type from the name and checks the bytes; only the name and bytes cross.
    uploadDocument: async (importId, file) => unwrap(await call({ action: "upload", importId, filename: file.filename, bytes: file.bytes })),
    readImport: async importId => unwrap(await call({ action: "read", importId })),
    publishImport: async (importId, body) => unwrap(await call({ action: "publish", importId, body })),
    cancelImport: async importId => { unwrap(await call({ action: "cancel", importId })); },
  };
}

/** The file dialog of the main process: the package it read, or the refusal it already decided. */
export async function pickDesktopPackage(call: AssistantImportCall): Promise<PickedAssistantPackage | null> {
  const picked = unwrap(await call({ action: "pickPackage" }));
  if (picked.kind === "cancelled") return null;
  if (picked.kind === "refused") return { refused: picked.code, cause: "desktop_file_check", name: picked.name, bytes: picked.size };
  return { file: new File([new Uint8Array(picked.bytes)], picked.name) };
}
