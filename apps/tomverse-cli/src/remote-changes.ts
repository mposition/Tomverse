import type { ChangeView } from "./changes.js";
import { UndoError } from "./changes.js";
import type { RemoteWorkspace } from "./remote-workspace.js";
import { RemoteError } from "./remote-target.js";
import { sha256, type ChangeRecord, type Journal } from "./session.js";
import { PathError } from "./workspace.js";

/**
 * The session's changes in a remote project: where they stand on the remote machine now, and putting one back. The rules are
 * those of changes.ts: only the session's own change is touched, and only when the file is still exactly what the session wrote.
 */

const dirIdent = (ident: string) => ident.split(":").slice(0, 2).join(":");

const locate = async (remote: RemoteWorkspace, path: string, signal?: AbortSignal) => {
    try {
        const resolved = await remote.resolve(path, "read", signal);
        return resolved.linked ? null : resolved;
    } catch (error) {
        if (error instanceof PathError) return null;
        throw error;
    }
};

/** Where a recorded change is now. An unreachable machine is an error, not "changed". */
export async function remoteViewChange(remote: RemoteWorkspace, change: ChangeRecord, signal?: AbortSignal): Promise<ChangeView> {
    if (change.state === "undone") return { ...change, current: "undone" };
    if (change.state !== "applied") return { ...change, current: "not_applied" };
    const resolved = await locate(remote, change.path, signal);
    if (!resolved) return { ...change, current: "outside" };
    if (change.directory && dirIdent(resolved.folderIdent) !== change.directory) return { ...change, current: "changed_since" };
    if (change.kind !== "delete" && resolved.kind === "none") return { ...change, current: "missing" };
    if (change.postimage.identity !== undefined && change.postimage.identity !== resolved.ident) return { ...change, current: "changed_since" };
    if (resolved.kind !== "file") return { ...change, current: change.postimage.sha256 === null && resolved.kind === "none" ? "as_written" : "changed_since" };
    const { bytes } = await remote.readFile(resolved.absolute, 8 * 1024 * 1024, signal);
    return { ...change, current: sha256(bytes) === change.postimage.sha256 ? "as_written" : "changed_since" };
}

/** Puts one change of the session back on the remote machine, or stops and changes nothing. */
export async function remoteUndoChange(journal: Journal, remote: RemoteWorkspace, changeId: string, signal?: AbortSignal, requireIdentity = false) {
    const index = journal.state.changes.findIndex((item) => item.changeId === changeId);
    const change = journal.state.changes[index];
    if (!change) throw new UndoError(`No change ${changeId} in this session.`);
    if (change.state === "undone") throw new UndoError(`${changeId} is already undone.`);
    if (change.state !== "applied") throw new UndoError(`${changeId} was not applied, so there is nothing to undo.`);
    const later = journal.state.changes.slice(index + 1).find((c) => c.path === change.path && (c.state === "applied" || c.state === "writing"));
    if (later) throw new UndoError(`${change.path} was changed again by ${later.changeId}; undo that first.`);
    if (requireIdentity && (!change.directory || change.postimage.identity === undefined)) {
        throw new UndoError("This record lacks the file identity needed for a verified undo.");
    }
    const view = await remoteViewChange(remote, change, signal);
    if (view.current !== "as_written") throw new UndoError(`${change.path} changed after the Code edit. Undo stopped and changed nothing.`);
    const resolved = await remote.resolve(change.path, "write", signal).catch((error) => {
        if (error instanceof PathError) throw new UndoError(`${change.path} no longer resolves inside the workspace (a link?). Undo stopped and changed nothing.`);
        throw error;
    });
    const guarded = async <T>(run: () => Promise<T>) => {
        try {
            return await run();
        } catch (error) {
            if (error instanceof RemoteError && ["changed", "outside-root", "exists", "not-found"].includes(error.code)) {
                throw new UndoError(`${change.path} changed during undo. The file was left untouched.`);
            }
            throw error;
        }
    };
    const folder = { folder: resolved.folder, directory: change.directory ?? dirIdent(resolved.folderIdent) };
    if (change.kind === "create") {
        await guarded(() => remote.removeIdentified(resolved.absolute, change.postimage.identity ?? resolved.ident, signal));
    } else {
        if (!change.preimage.backup) throw new UndoError(`No backup of ${change.path} was kept (a --no-persist session), so it cannot be undone.`);
        const bytes = journal.readBackup(change.preimage.backup);
        if (!bytes || sha256(bytes) !== change.preimage.sha256) throw new UndoError(`The backup of ${change.path} does not match what was there before; nothing changed.`);
        await guarded(() => remote.writeBytes(resolved.absolute, bytes, {
            create: change.kind === "delete", expect: change.kind === "delete" ? null : change.postimage.identity ?? resolved.ident, ...folder,
            ...(change.preimage.mode !== undefined ? { mode: (change.preimage.mode & 0o7777).toString(8).padStart(3, "0") } : {}),
        }, signal));
    }
    const after = await remote.resolve(change.path, "read", signal).catch(() => null);
    const previous = journal.state.changes.slice(0, index).findLast((item) => item.path === change.path && item.state === "applied");
    if (previous && change.preimage.identity !== undefined && previous.directory === change.directory &&
        previous.postimage.sha256 === change.preimage.sha256 && previous.postimage.identity === change.preimage.identity) {
        previous.postimage.identity = after?.ident ?? null;
    }
    change.state = "undone";
    change.undoneAt = new Date().toISOString();
    journal.commit();
    return change;
}

/** Whether an undo would be tried: the record is whole and the session kept what it needs. Does not ask the remote machine. */
export const remoteCanUndoRecord = (journal: Journal, change: ChangeRecord) =>
    change.state === "applied" && Boolean(change.directory) && change.postimage.identity !== undefined
    && (change.kind === "create" || Boolean(change.preimage.backup))
    && !journal.state.changes.slice(journal.state.changes.indexOf(change) + 1).some((c) => c.path === change.path && (c.state === "applied" || c.state === "writing"));
