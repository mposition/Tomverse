import { tomverseHome } from "./config.js";
import { loadHooks, type HookDef } from "./hooks.js";
import { describeMcpServer, loadMcpServers, type McpServerDef } from "./mcp-config.js";
import { openProjectTrust } from "./project-trust.js";
import { safeLine } from "./display.js";

/**
 * `tomverse mcp` and `tomverse hooks`: what the folder and the user define, and the person's approvals of what the
 * folder defines. Approving needs a person at a terminal: a command the agent runs has no terminal to answer, so the
 * agent cannot approve its own project's servers or hooks.
 */

export type ExtensionsIo = {
    interactive: boolean;
    confirm: (question: string) => Promise<boolean>;
    home?: string;
};

const state = (approved: boolean, enabled: boolean, scope: string) => (scope === "user" ? (enabled ? "on" : "off") : !approved ? "needs approval" : enabled ? "approved, on" : "approved, off");

export const extensionsCommand = async (kind: "mcp" | "hooks", args: string[], root: string, io: ExtensionsIo): Promise<{ lines: string[]; ok: boolean }> => {
    const home = io.home ?? tomverseHome();
    const trust = openProjectTrust(root, home);
    const [sub = "list", target] = args;
    const lines: string[] = [];
    if (kind === "mcp") {
        const { servers, problems } = loadMcpServers(root, home);
        const find = () => servers.find((s) => s.id === target || s.name === target);
        const show = (s: McpServerDef) => `${safeLine(s.id)}  ${s.plugin ? `plugin ${safeLine(s.plugin)}` : s.scope}  ${state(trust.mcpApproved(s), trust.mcpEnabled(s), s.scope)}${s.transport === "unsupported" ? " (unsupported)" : ""}  ${safeLine(describeMcpServer(s))}`;
        if (sub === "list") {
            lines.push(...(servers.length ? servers.map(show) : ["No MCP servers are set up (user: mcp.json in the CLI folder; project: .mcp.json)."]), ...problems.map((p) => `note: ${safeLine(p)}`));
            return { lines, ok: true };
        }
        const server = find();
        if (!server) return { lines: [`No MCP server named ${safeLine(target ?? "")}.`], ok: false };
        if (sub === "enable" || sub === "disable") {
            trust.setMcpEnabled(server, sub === "enable");
            return { lines: [`${safeLine(server.id)} is ${sub}d for this folder.`], ok: true };
        }
        if (sub === "approve") {
            if (server.scope === "user") return { lines: [`${safeLine(server.id)} is your own server; it needs no approval.`], ok: true };
            if (!io.interactive) return { lines: ["Approving a project server needs you at a terminal."], ok: false };
            const question = `Allow ${server.plugin ? `the MCP server ${safeLine(server.id)} of the plugin ${safeLine(server.plugin)}` : `this project's MCP server ${safeLine(server.id)}`} to run on this computer?\n  ${safeLine(describeMcpServer(server))}\n  It runs with your permissions until you disable it; any change to its definition asks again.`;
            if (!(await io.confirm(question))) return { lines: ["Not approved."], ok: false };
            trust.approveMcp(server);
            return { lines: [`Approved ${safeLine(server.id)}.`], ok: true };
        }
        return { lines: [`Unknown command '${safeLine(sub)}'. Use list, approve <name>, enable <name> or disable <name>.`], ok: false };
    }
    const { hooks, problems } = loadHooks(root, { tomverse: home });
    const index = Number(target);
    const hook: HookDef | undefined = Number.isInteger(index) ? hooks[index - 1] : undefined;
    const show = (h: HookDef, i: number) => `${i + 1}. ${h.event}${h.matcher ? ` [${safeLine(h.matcher)}]` : ""}  ${h.plugin ? `plugin ${safeLine(h.plugin)}` : h.scope}  ${state(trust.hookApproved(h), trust.hookEnabled(h), h.scope)}  ${safeLine(h.command).slice(0, 160)}`;
    if (sub === "list") {
        lines.push(...(hooks.length ? hooks.map(show) : ["No hooks are set up."]), ...problems.map((p) => `note: ${safeLine(p)}`));
        return { lines, ok: true };
    }
    if (!hook) return { lines: [`Give the number of a hook from \`tomverse hooks list\`.`], ok: false };
    if (sub === "enable" || sub === "disable") {
        trust.setHookEnabled(hook, sub === "enable");
        return { lines: [`Hook ${index} is ${sub}d for this folder.`], ok: true };
    }
    if (sub === "approve") {
        if (hook.scope === "user") return { lines: ["This is your own hook; it needs no approval."], ok: true };
        if (!io.interactive) return { lines: ["Approving a project hook needs you at a terminal."], ok: false };
        if (!(await io.confirm(`Allow this ${hook.plugin ? `hook of the plugin ${safeLine(hook.plugin)}` : "project hook"} to run on this computer, at ${hook.event}?\n  ${safeLine(hook.command)}\n  It runs with your permissions; any change to it asks again.`))) return { lines: ["Not approved."], ok: false };
        trust.approveHook(hook);
        return { lines: [`Approved hook ${index}.`], ok: true };
    }
    return { lines: [`Unknown command '${safeLine(sub)}'. Use list, approve <n>, enable <n> or disable <n>.`], ok: false };
};
