import { isAbsolute, resolve } from "node:path";
import { tomverseHome } from "./config.js";
import { safeLine } from "./display.js";
import { PluginError } from "./plugin-fs.js";
import { validPluginName } from "./plugin-format.js";
import { maskUrl } from "./plugin-git.js";
import {
    commitStaged, describeStaged, discardStaged, listInstalledPlugins, removePlugin, stagePlugin, type PluginRequest,
} from "./plugin-manager.js";
import {
    addMarketplace, classifyMarketplaceInput, listMarketplaces, readMarketplace, refreshMarketplace, removeMarketplace,
} from "./plugin-marketplace.js";
import { readPluginState, setPluginEnabled, setPluginEnabledIn } from "./plugin-store.js";

/**
 * `tomverse plugin ...`: installed plugins and the marketplaces they come from. Installing, updating and adding a marketplace
 * download or copy third-party files, so they need a person at a terminal who confirms what was shown: a command the agent runs has
 * no terminal to answer, so the agent cannot install a plugin. Nothing here starts anything; a plugin's hooks and MCP servers
 * are approved separately with `tomverse hooks approve` and `tomverse mcp approve`.
 */

export type PluginIo = {
    interactive: boolean;
    confirm: (question: string) => Promise<boolean>;
    home?: string;
    /** The folder the command was started in, for `enable <name> here`. */
    root: string;
    signal?: AbortSignal;
};

type Done = { lines: string[]; ok: boolean };

const fail = (...lines: string[]): Done => ({ lines, ok: false });
const ok = (...lines: string[]): Done => ({ lines, ok: true });

const USAGE = [
    "tomverse plugin list",
    "tomverse plugin install <folder | name@marketplace>",
    "tomverse plugin update <name>",
    "tomverse plugin remove <name>",
    "tomverse plugin enable <name> [here]     (here: only for this folder)",
    "tomverse plugin disable <name> [here]",
    "tomverse plugin marketplace list",
    "tomverse plugin marketplace show <name>",
    "tomverse plugin marketplace add <folder | git address> [branch or tag]",
    "tomverse plugin marketplace update <name>",
    "tomverse plugin marketplace remove <name>",
];

const confirmStaged = async (io: PluginIo, home: string, request: PluginRequest): Promise<Done> => {
    const result = await stagePlugin(home, request, { signal: io.signal });
    if ("upToDate" in result) return ok(`${result.upToDate.name} is up to date.`);
    const { staged } = result;
    const lines = describeStaged(staged).map(safeLine);
    if (!io.interactive) {
        discardStaged(staged);
        return fail(...lines, "Installing or updating a plugin needs you at a terminal to confirm. Nothing was changed.");
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    const approved = await io.confirm(`${staged.mode === "update" ? "Update" : "Install"} ${safeLine(staged.inspection.name)} from the files above? Nothing in it runs until you approve its hooks and servers.`);
    if (!approved) {
        discardStaged(staged);
        return fail("Not installed.");
    }
    commitStaged(home, staged);
    const waiting = staged.inspection.hooks.length + staged.inspection.mcpServers.length;
    return ok(`${staged.mode === "update" ? "Updated" : "Installed"} ${safeLine(staged.inspection.name)}.${waiting
        ? ` ${waiting} hook(s) and MCP server(s) wait for your approval: see \`tomverse hooks list\` and \`tomverse mcp list\`.` : ""}`);
};

export const pluginCommand = async (args: string[], io: PluginIo): Promise<Done> => {
    const home = io.home ?? tomverseHome();
    const [sub = "list", target, third] = args;
    try {
        if (sub === "list") {
            const installed = listInstalledPlugins(home);
            if (!installed.length) return ok("No plugins are installed. Install one with `tomverse plugin install <folder | name@marketplace>`.");
            return ok(...installed.map((plugin) => {
                const contents = plugin.inspection;
                const parts = contents
                    ? `${contents.skills.length} skills, ${contents.commands.length} commands, ${contents.agents.length} agents, ${contents.hooks.length} hooks, ${contents.mcpServers.length} MCP servers`
                    : "unreadable";
                const wait = plugin.pendingHooks + plugin.pendingServers;
                const from = plugin.record.source.kind === "folder" ? "folder" : `${plugin.record.source.plugin}@${plugin.record.source.marketplace}`;
                return `${safeLine(plugin.name)}${plugin.record.version ? ` ${safeLine(plugin.record.version)}` : ""}  ${plugin.record.enabled ? "on" : "off"}  ${from}  ${parts}${wait ? `  (${wait} waiting for approval)` : ""}${plugin.modified ? "  (files changed since install)" : ""}`;
            }));
        }
        if (sub === "marketplace") return await marketplaceCommand(args.slice(1), io, home);
        if (!target) return fail(`Give a plugin. Usage:`, ...USAGE);
        if (sub === "install") {
            const at = target.lastIndexOf("@");
            const folder = isAbsolute(target) || target.startsWith(".") || /[\\/]/.test(target) || at <= 0;
            if (!folder) {
                const plugin = target.slice(0, at);
                const marketplace = target.slice(at + 1);
                if (!validPluginName(plugin) || !validPluginName(marketplace)) return fail("Use name@marketplace, or the path of a plugin folder.");
                return await confirmStaged(io, home, { kind: "marketplace", marketplace, plugin });
            }
            return await confirmStaged(io, home, { kind: "folder", path: resolve(target) });
        }
        if (sub === "update") return await confirmStaged(io, home, { kind: "update", name: target });
        if (sub === "remove") {
            if (!io.interactive) return fail("Removing a plugin needs you at a terminal.");
            if (!readPluginState(home).plugins[target]) return fail(`No plugin named ${safeLine(target)}.`);
            if (!(await io.confirm(`Remove the plugin ${safeLine(target)}? Its folder in the CLI's plugin folder is deleted; nothing else is.`))) return fail("Not removed.");
            removePlugin(home, target);
            return ok(`Removed ${safeLine(target)}.`);
        }
        if (sub === "enable" || sub === "disable") {
            if (third === "here") setPluginEnabledIn(home, target, io.root, sub === "enable");
            else setPluginEnabled(home, target, sub === "enable");
            return ok(`${safeLine(target)} is ${sub}d${third === "here" ? " for this folder" : ""}.`);
        }
        return fail(`Unknown command '${safeLine(sub)}'. Usage:`, ...USAGE);
    } catch (error) {
        if (error instanceof PluginError) return fail(safeLine(maskUrl(error.message)));
        throw error;
    }
};

const marketplaceCommand = async (args: string[], io: PluginIo, home: string): Promise<Done> => {
    const [sub = "list", target, third] = args;
    if (sub === "list") {
        const listed = listMarketplaces(home);
        if (!listed.length) return ok("No marketplaces are added. Add one with `tomverse plugin marketplace add <folder | git address>`; none is built in.");
        return ok(...listed.map((entry) => {
            const where = entry.record.source.kind === "directory" ? entry.record.source.path : entry.record.source.url;
            return `${safeLine(entry.name)}  ${entry.catalog ? `${entry.catalog.entries.length} plugin(s)` : safeLine(entry.problem ?? "unreadable")}  ${safeLine(maskUrl(where))}${entry.record.commit ? `  @${entry.record.commit.slice(0, 12)}` : ""}`;
        }));
    }
    if (!target) return fail("Give a marketplace. Usage:", ...USAGE);
    if (sub === "show") {
        const { catalog } = readMarketplace(home, target);
        const installed = readPluginState(home).plugins;
        return ok(...catalog.entries.map((entry) => `${safeLine(entry.name)}${entry.version ? ` ${safeLine(entry.version)}` : ""}${installed[entry.name] ? "  (installed)" : ""}${entry.source.kind === "unsupported" ? `  (source not supported: ${safeLine(entry.source.type)})` : ""}${entry.description ? `  ${safeLine(entry.description)}` : ""}`),
            ...catalog.issues.map((issue) => `note: ${safeLine(issue)}`));
    }
    if (sub === "add") {
        if (!io.interactive) return fail("Adding a marketplace downloads files; it needs you at a terminal.");
        const input = classifyMarketplaceInput(target, third);
        const where = input.kind === "directory" ? input.path : input.url;
        if (!(await io.confirm(`Add the marketplace at ${safeLine(maskUrl(where))}? Its catalog is copied into the CLI's plugin folder${input.kind === "git" ? " (one commit is downloaded with your git and pinned)" : ""}. Nothing in it runs.`))) return fail("Not added.");
        const added = await addMarketplace(home, input, { signal: io.signal });
        return ok(`Added the marketplace ${safeLine(added.name)} with ${added.catalog.entries.length} plugin(s)${added.commit ? ` at ${added.commit.slice(0, 12)}` : ""}.`,
            ...added.catalog.issues.map((issue) => `note: ${safeLine(issue)}`));
    }
    if (sub === "update") {
        if (!io.interactive) return fail("Updating a marketplace downloads files; it needs you at a terminal.");
        const added = await refreshMarketplace(home, target, { signal: io.signal });
        return ok(`Updated ${safeLine(added.name)}: ${added.catalog.entries.length} plugin(s)${added.commit ? ` at ${added.commit.slice(0, 12)}` : ""}.`);
    }
    if (sub === "remove") {
        if (!io.interactive) return fail("Removing a marketplace needs you at a terminal.");
        if (!(await io.confirm(`Remove the marketplace ${safeLine(target)}? Plugins already installed from it stay installed.`))) return fail("Not removed.");
        removeMarketplace(home, target);
        return ok(`Removed ${safeLine(target)}.`);
    }
    return fail(`Unknown command '${safeLine(sub)}'. Usage:`, ...USAGE);
};
