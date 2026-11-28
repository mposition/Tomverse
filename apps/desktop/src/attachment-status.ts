import type { AttachmentPhaseEvent, DriveImportResult } from "./attachment-contract";

/** Where an attachment transfer stands in the composer: waiting on the Drive window, uploading, or nothing in flight. */
export type AttachmentTransferStatus = "driveSelecting" | "uploading" | null;

/** The host moves a Drive import from the picker window to uploading; an event for another request changes nothing. */
export function statusAfterPhase(status: AttachmentTransferStatus, activeRequestId: string | undefined, event: AttachmentPhaseEvent): AttachmentTransferStatus {
  return status === "driveSelecting" && activeRequestId === event.requestId && event.phase === "uploading" ? "uploading" : status;
}

export type DriveNotice = "googleDriveError" | "driveTimeout" | null;

export function driveNotice(result: Pick<DriveImportResult, "incomplete" | "timedOut">): DriveNotice {
  return result.timedOut ? "driveTimeout" : result.incomplete ? "googleDriveError" : null;
}
