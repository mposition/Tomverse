import type { ApprovalView } from "./agent.js";
import { checkBoundaries, ruleForApproval, type PermissionRule } from "./permissions.js";

/** Why an approval was given without asking: an earlier "always" answer at the terminal. */
export type RememberedRule = "file_edits" | "same_command" | "web_host" | "browser_origin" | "mcp_tool" | "computer_window" | "web_search";

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
 * - computer_window: clicking, typing, keys and scrolling in the one desktop window the user chose, for that window only. The host
 *   checks the window and its position again on every action.
 * - web_search: searching the web through the Tomverse API, each search still
 *   charged to the account; the queries are shown on every call.
 * - same_command: exactly the same program, arguments, working folder and
 *   environment names, and the same kind of run (background or not); any other
 *   command is asked. The timeout may differ.
 *
 * Nothing the permission boundaries (permissions.ts) leave to a person is ever
 * remembered: a command that sends something out of the computer, names a
 * credential file, or a change that is refused, is asked every time.
 *
 * A host whose answer really means "always, in this project" may give a `persist`
 * function: the answer is then also saved as an allow rule for the project.
 * Desktop gives none: its button reads "Allow for this run", so the answer ends
 * with the run and lasting rules are written in its settings.
 */
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

export class ApprovalMemory {
    /** Workspace roots where file edits were allowed; an edit without a root is always asked. */
    private readonly fileEdits = new Set<string>();
    private readonly commands = new Map<string, string>();
    private readonly webHosts = new Set<string>();
    private readonly browserOrigins = new Set<string>();
    /** Sites the browser tab was allowed to open for this run: kept apart from web_fetch's, because a page runs its own code. */
    private readonly browserHosts = new Set<string>();
    private readonly computerWindows = new Set<string>();
    /** MCP tools answered "always": one tool of one server, for that exact server definition. */
    private readonly mcpTools = new Set<string>();
    /** Web searches answered "always" for this run. */
    private webSearches = false;

    private static mcpKey(view: ApprovalView) {
        return view.mcp ? JSON.stringify([view.mcp.server, view.mcp.tool, view.mcp.definition]) : null;
    }

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
        if (view.mcp) return true;
        if (view.web) return true;
        if (view.webSearch) return true;
        // A click or typing on a local page may be remembered for the site; on a public site every one is asked.
        if (view.browser) return LOOPBACK_ORIGIN.test(view.browser.origin);
        if (view.computer) return Boolean(view.computer.window.id);
        if (view.patch) return Boolean(view.root) && !ApprovalMemory.deletes(view);
        return Boolean(view.command);
    }

    match(view: ApprovalView): RememberedRule | null {
        if (view.error || checkBoundaries(view)) return null;
        if (view.mcp) return this.mcpTools.has(ApprovalMemory.mcpKey(view)!) ? "mcp_tool" : null;
        if (view.web) return (view.toolName === "browser_navigate" ? this.browserHosts : this.webHosts).has(view.web.host) ? "web_host" : null;
        if (view.webSearch) return this.webSearches ? "web_search" : null;
        if (view.browser) return this.browserOrigins.has(view.browser.origin) ? "browser_origin" : null;
        if (view.computer) return this.computerWindows.has(view.computer.window.id) ? "computer_window" : null;
        if (view.patch) return view.root && this.fileEdits.has(view.root) && !ApprovalMemory.deletes(view) ? "file_edits" : null;
        const key = ApprovalMemory.commandKey(view);
        return key && this.commands.has(key) ? "same_command" : null;
    }

    remember(view: ApprovalView): RememberedRule | null {
        if (!this.canRemember(view)) return null;
        // An MCP answer is bound to the server's exact definition, so it stays in this process and is never written as a rule.
        if (view.mcp) {
            this.mcpTools.add(ApprovalMemory.mcpKey(view)!);
            return "mcp_tool";
        }
        const rule = this.persist ? ruleForApproval(view) : null;
        if (rule) {
            try {
                this.persist!(rule);
            } catch {
                // The answer still holds for this run; a file that cannot be written only means it is asked again next time.
            }
        }
        if (view.web) {
            (view.toolName === "browser_navigate" ? this.browserHosts : this.webHosts).add(view.web.host);
            return "web_host";
        }
        if (view.webSearch) {
            this.webSearches = true;
            return "web_search";
        }
        if (view.browser) {
            this.browserOrigins.add(view.browser.origin);
            return "browser_origin";
        }
        if (view.computer) {
            this.computerWindows.add(view.computer.window.id);
            return "computer_window";
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
            ...(this.webSearches ? ["searching the web through Tomverse (each search is still charged)"] : []),
            ...[...this.browserHosts].map((host) => `opening pages of ${host} in the browser tab`),
            ...[...this.browserOrigins].map((origin) => `clicking and typing in the browser tab on ${origin}`),
            ...[...this.computerWindows].map((id) => `operating the desktop window ${id}`),
            ...[...this.mcpTools].map((key) => { const [server, tool] = JSON.parse(key) as string[]; return `MCP tool ${server}: ${tool}`; }),
        ];
    }

    clear() {
        this.mcpTools.clear();
        this.fileEdits.clear();
        this.commands.clear();
        this.webHosts.clear();
        this.browserOrigins.clear();
        this.browserHosts.clear();
        this.computerWindows.clear();
        this.webSearches = false;
    }
}
