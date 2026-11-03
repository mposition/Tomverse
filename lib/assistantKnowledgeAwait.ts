/**
 * Which just-uploaded knowledge files the assistant editor should select now.
 *
 * A file the owner uploads from the editor is one they mean to give the
 * assistant, but it can only be selected once extraction has finished: a
 * version manifest naming a file with no chunks would publish knowledge that
 * retrieves nothing. So the editor waits for each upload and ticks it when it
 * turns `ready`. A file that failed, or that is gone from the list, is no
 * longer waited for and is not selected.
 */

export const KNOWLEDGE_AWAIT_POLL_MS = 3_000;
/** About two minutes; past that the background sweep is the recovery path. */
export const KNOWLEDGE_AWAIT_MAX_POLLS = 40;

const IN_FLIGHT = new Set(["pending", "processing"]);

export function settleAwaitedKnowledgeFiles(
    awaiting: ReadonlySet<string>,
    files: readonly { id: string; processingStatus: string }[]
): { ready: string[]; stillAwaiting: string[] } {
    const status = new Map(files.map((file) => [file.id, file.processingStatus]));
    const ready: string[] = [];
    const stillAwaiting: string[] = [];
    for (const fileId of awaiting) {
        const current = status.get(fileId);
        if (current === "ready") ready.push(fileId);
        else if (current !== undefined && IN_FLIGHT.has(current)) {
            stillAwaiting.push(fileId);
        }
    }
    return { ready, stillAwaiting };
}
