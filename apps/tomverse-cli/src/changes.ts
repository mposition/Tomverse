import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderFileDiff } from "./display.js";
import { assertBoundFile, currentDigest, pathIdentity, removeFile, writeFileReplacing } from "./patch.js";
import { sha256, type ChangeRecord, type Journal } from "./session.js";
import { same, Workspace } from "./workspace.js";

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
        const root = journal.state.workspace.root;
        const absolute = new Workspace(root).resolve(path, purpose).absolute;
        return same(absolute, resolve(root, path)) ? absolute : null;
    } catch {
        return null;
    }
};

export function viewChange(journal: Journal, change: ChangeRecord): ChangeView {
    if (change.state === "undone") return { ...change, current: "undone" };
    if (change.state !== "applied") return { ...change, current: "not_applied" };
    const absolute = locate(journal, change.path, "read");
    if (!absolute) return { ...change, current: "outside" };
    try {
        if (change.directory && pathIdentity(dirname(absolute), "directory") !== change.directory) {
            return { ...change, current: "changed_since" };
        }
        const identity = pathIdentity(absolute, "file");
        if (change.kind !== "delete" && identity === null) return { ...change, current: "missing" };
        if (change.postimage.identity !== undefined && change.postimage.identity !== identity) {
            return { ...change, current: "changed_since" };
        }
        const digest = currentDigest(absolute);
        return { ...change, current: digest === change.postimage.sha256 ? "as_written" : "changed_since" };
    } catch {
        return { ...change, current: "changed_since" };
    }
}

export const viewChanges = (journal: Journal): ChangeView[] => journal.state.changes.map((change) => viewChange(journal, change));

function snapshotText(journal: Journal, image: { sha256: string | null; backup?: string | null }) {
    if (image.sha256 === null) return null;
    if (!image.backup) throw new UndoError("The recorded file snapshot is unavailable.");
    const bytes = journal.readBackup(image.backup);
    if (!bytes || sha256(bytes) !== image.sha256) throw new UndoError("The recorded file snapshot could not be verified.");
    return bytes.toString("utf8");
}

export const renderChange = (journal: Journal, change: ChangeRecord) => {
    const before = snapshotText(journal, change.preimage);
    if (change.postimage.backup !== undefined || change.postimage.sha256 === null) {
        return renderFileDiff(change.path, before, snapshotText(journal, change.postimage));
    }
    const absolute = locate(journal, change.path, "read");
    if (!absolute || viewChange(journal, change).current !== "as_written") throw new UndoError("The recorded file snapshot is unavailable.");
    const bytes = readFileSync(absolute);
    if (sha256(bytes) !== change.postimage.sha256) throw new UndoError("The file changed during the read.");
    return renderFileDiff(change.path, before, bytes.toString("utf8"));
};

export class UndoError extends Error {}

function undoTarget(journal: Journal, changeId: string, requireIdentity: boolean) {
    const index = journal.state.changes.findIndex((item) => item.changeId === changeId);
    const change = journal.state.changes[index];
    if (!change) throw new UndoError(`No change ${changeId} in this session.`);
    if (change.state === "undone") throw new UndoError(`${changeId} is already undone.`);
    if (change.state !== "applied") throw new UndoError(`${changeId} was not applied, so there is nothing to undo.`);
    const later = journal.state.changes.slice(index + 1).find((c) => same(c.path, change.path) && (c.state === "applied" || c.state === "writing"));
    if (later) throw new UndoError(`${change.path} was changed again by ${later.changeId}; undo that first.`);
    if (requireIdentity && (!change.directory || change.postimage.identity === undefined)) {
        throw new UndoError("This record lacks the file identity needed for a verified undo.");
    }
    if (viewChange(journal, change).current !== "as_written") {
        throw new UndoError(`${change.path} changed after the Code edit. Undo stopped and changed nothing.`);
    }
    const absolute = locate(journal, change.path, "write");
    if (!absolute) throw new UndoError(`${change.path} no longer resolves inside the workspace (a link?). Undo stopped and changed nothing.`);
    const folder = dirname(absolute);
    const directory = change.directory ?? pathIdentity(folder, "directory");
    if (!directory) throw new UndoError("The file’s parent folder is no longer available.");
    const identity = change.postimage.identity === undefined ? pathIdentity(absolute, "file") : change.postimage.identity;
    return { change, index, absolute, binding: { folder, directory, file: identity } };
}

export function canUndoChange(journal: Journal, change: ChangeRecord) {
    try {
        undoTarget(journal, change.changeId, true);
        return change.kind === "create" || !!change.preimage.backup;
    } catch {
        return false;
    }
}

export const undoChange = (journal: Journal, changeId: string, beforeWrite?: (absolute: string) => void, requireIdentity = false) => {
    const { change, index, absolute, binding } = undoTarget(journal, changeId, requireIdentity);
    const workspace = new Workspace(journal.state.workspace.root);
    const guard = () => {
        try {
            assertBoundFile(workspace, change.path, absolute, binding, change.postimage.sha256);
        } catch {
            throw new UndoError(`${change.path} changed during undo. The file was left untouched.`);
        }
    };
    beforeWrite?.(absolute);
    if (change.kind === "create") {
        guard();
        removeFile(absolute);
    } else {
        if (!change.preimage.backup) throw new UndoError(`No backup of ${change.path} was kept (a --no-persist session), so it cannot be undone.`);
        const bytes = journal.readBackup(change.preimage.backup);
        if (!bytes || sha256(bytes) !== change.preimage.sha256) throw new UndoError(`The backup of ${change.path} does not match what was there before; nothing changed.`);
        writeFileReplacing(absolute, bytes, change.preimage.mode, guard, change.kind === "delete");
    }
    const previous = journal.state.changes.slice(0, index).findLast((item) => same(item.path, change.path) && item.state === "applied");
    if (previous && change.preimage.identity !== undefined && previous.directory === change.directory &&
        previous.postimage.sha256 === change.preimage.sha256 && previous.postimage.identity === change.preimage.identity) {
        previous.postimage.identity = pathIdentity(absolute, "file");
    }
    change.state = "undone";
    change.undoneAt = new Date().toISOString();
    journal.commit();
    return change;
};
