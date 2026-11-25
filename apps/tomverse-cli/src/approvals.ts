import type { ApprovalView } from "./agent.js";

/** Why an approval was given without asking: an earlier "always" answer at the terminal. */
export type RememberedRule = "file_edits" | "same_command";

/**
 * "Yes, and don't ask again" answers the person gave at the terminal, for the
 * rest of this CLI process only. They are never saved in the session, never
 * read from config, a file or the model, and a resumed session starts asking
 * again. A rule only skips the question: every check the approval is bound to
 * (paths, credentials, preimages, the resolved program, the working folder)
 * still runs on every call.
 *
 * - file_edits: creating and changing files in the workspace where it was
 *   given (another folder is asked). Deleting a file is always asked.
 * - same_command: exactly the same program, arguments, working folder and
 *   environment names, and the same kind of run (background or not); any other
 *   command is asked. The timeout may differ.
 */
export class ApprovalMemory {
    /** Workspace roots where file edits were allowed; an edit without a root is always asked. */
    private readonly fileEdits = new Set<string>();
    private readonly commands = new Map<string, string>();

    private static commandKey(view: ApprovalView) {
        const c = view.command;
        if (!c) return null;
        return JSON.stringify([c.mode, c.file, c.args, c.shell, c.cwd, [...c.envNames].sort(), c.background === true]);
    }

    private static deletes(view: ApprovalView) {
        return Boolean(view.patch?.some((edit) => edit.action === "delete"));
    }

    /** Whether "always" can be offered for this request. */
    canRemember(view: ApprovalView) {
        if (view.error) return false;
        if (view.patch) return Boolean(view.root) && !ApprovalMemory.deletes(view);
        return Boolean(view.command);
    }

    match(view: ApprovalView): RememberedRule | null {
        if (view.error) return null;
        if (view.patch) return view.root && this.fileEdits.has(view.root) && !ApprovalMemory.deletes(view) ? "file_edits" : null;
        const key = ApprovalMemory.commandKey(view);
        return key && this.commands.has(key) ? "same_command" : null;
    }

    remember(view: ApprovalView): RememberedRule | null {
        if (!this.canRemember(view)) return null;
        if (view.patch) {
            this.fileEdits.add(view.root!);
            return "file_edits";
        }
        this.commands.set(ApprovalMemory.commandKey(view)!, `${view.command!.display} (in ${view.command!.cwd})`);
        return "same_command";
    }

    describe(): string[] {
        return [
            ...[...this.fileEdits].map((root) => `file edits in ${root} (creating and changing files; deleting is still asked)`),
            ...[...this.commands.values()].map((c) => `command: ${c}`),
        ];
    }

    clear() {
        this.fileEdits.clear();
        this.commands.clear();
    }
}
