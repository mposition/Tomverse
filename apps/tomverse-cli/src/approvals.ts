import type { ApprovalView } from "./agent.js";
import { checkBoundaries, ruleForApproval, type PermissionRule } from "./permissions.js";

/** Why an approval was given without asking: an earlier "always" answer at the terminal. */
export type RememberedRule = "file_edits" | "same_command" | "web_host" | "browser_origin";

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
 * - web_host: reading public web pages from one site (host). Any other site
 *   is asked; the address is judged again on every call.
 * - browser_origin: clicking and typing in the local browser tab, on one site (origin). Another origin is asked; the page and the
 *   element are shown on every call that is asked, and passwords are refused by the host whatever was allowed.
 * - same_command: exactly the same program, arguments, working folder and
 *   environment names, and the same kind of run (background or not); any other
 *   command is asked. The timeout may differ.
 *
 * Nothing the permission boundaries (permissions.ts) leave to a person is ever
 * remembered: a command that sends something out of the computer, names a
 * credential file, or a change that is refused, is asked every time.
 *
 * A host that keeps rules in files (Desktop) gives a `persist` function: an
 * "always" answer is then also saved as an allow rule for the project, which
 * is how the permission rules and this memory are one thing.
 */
export class ApprovalMemory {
    /** Workspace roots where file edits were allowed; an edit without a root is always asked. */
    private readonly fileEdits = new Set<string>();
    private readonly commands = new Map<string, string>();
    private readonly webHosts = new Set<string>();
    private readonly browserOrigins = new Set<string>();

    constructor(private readonly persist?: (rule: PermissionRule) => void) {}

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
        if (view.error || checkBoundaries(view)) return false;
        if (view.web) return true;
        if (view.browser) return Boolean(view.browser.origin);
        if (view.patch) return Boolean(view.root) && !ApprovalMemory.deletes(view);
        return Boolean(view.command);
    }

    match(view: ApprovalView): RememberedRule | null {
        if (view.error || checkBoundaries(view)) return null;
        if (view.web) return this.webHosts.has(view.web.host) ? "web_host" : null;
        if (view.browser) return this.browserOrigins.has(view.browser.origin) ? "browser_origin" : null;
        if (view.patch) return view.root && this.fileEdits.has(view.root) && !ApprovalMemory.deletes(view) ? "file_edits" : null;
        const key = ApprovalMemory.commandKey(view);
        return key && this.commands.has(key) ? "same_command" : null;
    }

    remember(view: ApprovalView): RememberedRule | null {
        if (!this.canRemember(view)) return null;
        const rule = this.persist ? ruleForApproval(view) : null;
        if (rule) {
            try {
                this.persist!(rule);
            } catch {
                // The answer still holds for this run; a file that cannot be written only means it is asked again next time.
            }
        }
        if (view.web) {
            this.webHosts.add(view.web.host);
            return "web_host";
        }
        if (view.browser) {
            this.browserOrigins.add(view.browser.origin);
            return "browser_origin";
        }
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
            ...[...this.webHosts].map((host) => `reading web pages from ${host}`),
            ...[...this.browserOrigins].map((origin) => `clicking and typing in the browser tab on ${origin}`),
        ];
    }

    clear() {
        this.fileEdits.clear();
        this.commands.clear();
        this.webHosts.clear();
        this.browserOrigins.clear();
    }
}
