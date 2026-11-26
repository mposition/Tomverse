import { PathError, type Workspace } from "./workspace.js";

/**
 * Write scopes of worker subtasks. A scope is a list of workspace-relative files or folders; "." is the whole workspace. A worker
 * may change only what its scope contains, and two workers whose scopes overlap never run at the same time. Both are decided by
 * comparing resolved paths, not by asking a model.
 */

const fold = (path: string) => (process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path);

export const MAX_SCOPE_ENTRIES = 20;

/** A pattern is not a path: the scope names files and folders exactly. */
const PATTERN = /[*?[\]{}]/;

export type ScopeResult = { ok: true; scope: string[] } | { ok: false; error: string };

/** The declared paths as resolved, de-duplicated workspace-relative entries; a path that cannot be written is an error. */
export const parseScope = (workspace: Workspace, paths: readonly string[] | undefined): ScopeResult => {
    if (!paths?.length) return { ok: false, error: "A worker subtask must declare paths: the files or folders it may change." };
    if (paths.length > MAX_SCOPE_ENTRIES) return { ok: false, error: `At most ${MAX_SCOPE_ENTRIES} paths per subtask.` };
    const entries: string[] = [];
    for (const path of paths) {
        if (PATTERN.test(path)) return { ok: false, error: `"${path}" looks like a pattern. Name files or folders exactly.` };
        try {
            const resolved = workspace.resolve(path.trim() || ".", "write").relative;
            if (!entries.some((entry) => fold(entry) === fold(resolved))) entries.push(resolved);
        } catch (error) {
            if (!(error instanceof PathError)) throw error;
            return { ok: false, error: error.message };
        }
    }
    // A folder and something inside it: the folder covers both.
    return { ok: true, scope: entries.filter((entry) => !entries.some((other) => other !== entry && scopeContains([other], entry))) };
};

/** Whether a resolved workspace-relative path is inside the scope. */
export const scopeContains = (scope: readonly string[], relative: string) => {
    const path = fold(relative);
    return scope.some((entry) => {
        const root = fold(entry);
        return root === "." || path === root || path.startsWith(`${root}/`);
    });
};

/** Whether two scopes can touch the same file. */
export const scopesOverlap = (left: readonly string[], right: readonly string[]) =>
    left.some((entry) => scopeContains(right, entry)) || right.some((entry) => scopeContains(left, entry));

/** The paths of a patch's edits that are outside the scope (resolved the way the patch tool resolves them). Empty when all are inside. */
export const outsideScope = (workspace: Workspace, scope: readonly string[], edits: ReadonlyArray<{ path: string }>): { outside: string[]; error?: string } => {
    const outside: string[] = [];
    for (const edit of edits) {
        try {
            const relative = workspace.resolve(edit.path, "write").relative;
            if (!scopeContains(scope, relative)) outside.push(relative);
        } catch (error) {
            if (!(error instanceof PathError)) throw error;
            return { outside, error: error.message };
        }
    }
    return { outside };
};
