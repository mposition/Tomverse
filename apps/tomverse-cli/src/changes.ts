import { existsSync, readFileSync } from "node:fs";
import { renderFileDiff } from "./display.js";
import { currentDigest, removeFile, writeFileReplacing } from "./patch.js";
import { sha256, type ChangeRecord, type Journal } from "./session.js";
import { Workspace } from "./workspace.js";

/**
 * The CLI's own changes and nothing else. Changes that were in the folder
 * before (dirty or untracked files) or that the user made later are never
 * shown as the CLI's and never touched. Undo restores one change only when
 * the file is still exactly what the CLI wrote; otherwise it stops. There is
 * no reset, clean or folder-wide restore.
 */

export type ChangeView = ChangeRecord & { current: "as_written" | "changed_since" | "missing" | "undone" | "not_applied" | "outside" };

/**
 * Where a recorded path is now, by the same real-path rule as every file tool:
 * if a parent folder has since become a link out of the workspace, it is not
 * followed. Null when it no longer resolves inside.
 */
const locate = (journal: Journal, path: string, purpose: "read" | "write") => {
    try {
        return new Workspace(journal.state.workspace.root).resolve(path, purpose).absolute;
    } catch {
        return null;
    }
};

export const viewChanges = (journal: Journal): ChangeView[] =>
    journal.state.changes.map((change) => {
        if (change.state === "undone") return { ...change, current: "undone" };
        if (change.state !== "applied") return { ...change, current: "not_applied" };
        const absolute = locate(journal, change.path, "read");
        if (!absolute) return { ...change, current: "outside" };
        const digest = currentDigest(absolute);
        if (change.kind === "delete") return { ...change, current: digest === null ? "as_written" : "changed_since" };
        if (digest === null) return { ...change, current: "missing" };
        return { ...change, current: digest === change.postimage.sha256 ? "as_written" : "changed_since" };
    });

export const renderChange = (journal: Journal, change: ChangeRecord) => {
    const absolute = locate(journal, change.path, "read");
    const before = change.preimage.backup ? journal.readBackup(change.preimage.backup)?.toString("utf8") ?? null : null;
    const now = absolute && existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
    return renderFileDiff(change.path, change.kind === "create" ? null : before, change.kind === "delete" ? null : now);
};

export class UndoError extends Error {}

export const undoChange = (journal: Journal, changeId: string) => {
    const change = journal.state.changes.find((c) => c.changeId === changeId);
    if (!change) throw new UndoError(`No change ${changeId} in this session.`);
    if (change.state === "undone") throw new UndoError(`${changeId} is already undone.`);
    if (change.state !== "applied") throw new UndoError(`${changeId} was not applied, so there is nothing to undo.`);
    const later = journal.state.changes.find((c) => c.path === change.path && c.state === "applied" && journal.state.changes.indexOf(c) > journal.state.changes.indexOf(change));
    if (later) throw new UndoError(`${change.path} was changed again by ${later.changeId}; undo that first.`);
    // Checked again right before the write: a link swapped in later is refused.
    const absolute = locate(journal, change.path, "write");
    if (!absolute) throw new UndoError(`${change.path} no longer resolves inside the workspace (a link?). Undo stopped and changed nothing.`);
    const digest = currentDigest(absolute);
    const expected = change.kind === "delete" ? null : change.postimage.sha256;
    if (digest !== expected) {
        throw new UndoError(
            `${change.path} is not what the CLI left there (it was changed afterwards${digest === null ? " or removed" : ""}). Undo stopped and changed nothing.`
        );
    }
    if (change.kind === "create") {
        removeFile(absolute);
    } else {
        if (!change.preimage.backup) throw new UndoError(`No backup of ${change.path} was kept (a --no-persist session), so it cannot be undone.`);
        const bytes = journal.readBackup(change.preimage.backup);
        if (!bytes || sha256(bytes) !== change.preimage.sha256) throw new UndoError(`The backup of ${change.path} does not match what was there before; nothing changed.`);
        writeFileReplacing(absolute, bytes, change.preimage.mode);
    }
    change.state = "undone";
    change.undoneAt = new Date().toISOString();
    journal.commit();
    return change;
};
