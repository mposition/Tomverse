import { basename } from "node:path";
import {
  PluginError, addMarketplace, classifyMarketplaceInput, commitStaged, discardStaged, listInstalledPlugins, listMarketplaces, maskUrl, pluginFolderKey,
  readMarketplace, readPluginState, refreshMarketplace, removeMarketplace, removePlugin, safeLine, setPluginEnabled, setPluginEnabledIn, stagePlugin,
  tomverseHome, type PluginRequest, type StagedPlugin,
} from "../../../tomverse-cli/src/runtime.js";
import type {
  InstalledPluginView, MarketplaceView, PluginHookLine, PluginPreview, PluginServerLine, PluginsCommand, PluginsNotice, PluginsView,
} from "../plugins-contract";

/**
 * What the Plugins screen shows and does. The window sends typed commands; the folder to install from comes from a dialog this
 * process opens. A preview is held here, and only the id of a preview this process made can be confirmed, so the window cannot make
 * the main process install a folder the person did not choose and see. A download from a git address (a marketplace, or a plugin a
 * catalog points at) is confirmed in a native dialog first, naming the address.
 */

export type PluginsHostOptions = {
  /** The folder the person picked in a dialog, or null when they cancelled. */
  pickFolder: () => Promise<string | null>;
  /** A native question before anything is downloaded from a git address. */
  confirmFetch: (address: string) => Promise<boolean>;
  home?: () => string;
};

const clean = (text: string, limit: number) => safeLine(text).slice(0, limit);

const hookLine = (hook: PluginHookLine): PluginHookLine => ({ event: clean(hook.event, 40), matcher: clean(hook.matcher, 120), command: clean(hook.command, 2000), timeoutSec: hook.timeoutSec });
const serverLine = (server: PluginServerLine): PluginServerLine => ({ name: clean(server.name, 120), transport: server.transport, summary: clean(server.summary, 2000) });
const names = (list: string[]) => list.map((name) => clean(name, 120)).slice(0, 200);

const previewOf = (staged: StagedPlugin, from: string): PluginPreview => {
  const plugin = staged.inspection;
  const diff = staged.diff;
  return {
    id: staged.id, mode: staged.mode, name: plugin.name, from: clean(from, 200),
    ...(plugin.version ? { version: clean(plugin.version, 60) } : {}), ...(staged.previous?.version ? { previousVersion: clean(staged.previous.version, 60) } : {}),
    ...(plugin.description ? { description: clean(plugin.description, 400) } : {}), ...(plugin.author ? { author: clean(plugin.author, 100) } : {}),
    files: plugin.files, kilobytes: Math.ceil(plugin.bytes / 1024),
    skills: names(plugin.skills), commands: names(plugin.commands), agents: names(plugin.agents),
    hooks: plugin.hooks.map(hookLine), servers: plugin.mcpServers.map(serverLine),
    notUsed: plugin.notUsed.map((entry) => clean(entry, 120)), issues: plugin.issues.slice(0, 10).map((issue) => clean(issue, 300)),
    ...(diff ? { diff: {
      skillsAdded: names(diff.skills.added), skillsRemoved: names(diff.skills.removed), commandsAdded: names(diff.commands.added), commandsRemoved: names(diff.commands.removed),
      agentsAdded: names(diff.agents.added), agentsRemoved: names(diff.agents.removed),
      hooksAdded: diff.hooks.added.map(hookLine), hooksRemoved: diff.hooks.removed.map(hookLine),
      serversAdded: diff.mcpServers.added.map(serverLine), serversRemoved: diff.mcpServers.removed.map(serverLine),
      serversChanged: diff.mcpServers.changed.map((change) => ({ name: clean(change.name, 120), from: clean(change.from, 2000), to: clean(change.to, 2000) })),
      needsApproval: diff.needsApproval,
    } } : {}),
  };
};

export function createPluginsHost(options: PluginsHostOptions) {
  const home = () => options.home?.() ?? tomverseHome();
  /** The one preview waiting for the person's answer. A new preview replaces it. */
  let waiting: { staged: StagedPlugin; from: string } | null = null;
  let busy = false;

  const drop = () => {
    if (waiting) discardStaged(waiting.staged);
    waiting = null;
  };

  function view(root: string | null, extra: { notice?: PluginsNotice; error?: string } = {}): PluginsView {
    const state = readPluginState(home());
    const plugins = listInstalledPlugins(home()).map((installed): InstalledPluginView => {
      const contents = installed.inspection;
      return {
        name: installed.name, ...(installed.record.version ? { version: clean(installed.record.version, 60) } : {}),
        ...(contents?.description ? { description: clean(contents.description, 300) } : {}),
        enabled: installed.record.enabled, disabledHere: root !== null && installed.record.disabledIn.includes(pluginFolderKey(root)),
        from: installed.record.source.kind === "folder" ? { kind: "folder" } : { kind: "marketplace", marketplace: clean(installed.record.source.marketplace, 100) },
        skills: names(contents?.skills ?? []), commands: names(contents?.commands ?? []), agents: names(contents?.agents ?? []),
        hooks: contents?.hooks.length ?? 0, servers: contents?.mcpServers.length ?? 0, pending: installed.pendingHooks + installed.pendingServers,
        modified: installed.modified, readable: contents !== null,
      };
    });
    const marketplaces = listMarketplaces(home()).map((listing): MarketplaceView => ({
      name: listing.name,
      location: clean(listing.record.source.kind === "directory" ? listing.record.source.path : maskUrl(listing.record.source.url), 300),
      ...(listing.record.commit ? { commit: listing.record.commit.slice(0, 12) } : {}),
      entries: (listing.catalog?.entries ?? []).map((entry) => ({
        name: entry.name, ...(entry.description ? { description: clean(entry.description, 300) } : {}), ...(entry.version ? { version: clean(entry.version, 60) } : {}),
        installed: Boolean(state.plugins[entry.name]), supported: entry.source.kind !== "unsupported",
      })),
      ...(listing.problem ? { problem: clean(listing.problem, 300) } : {}),
    }));
    return { project: root !== null, plugins, marketplaces, ...(waiting ? { preview: previewOf(waiting.staged, waiting.from) } : {}), ...extra };
  }

  /** The git addresses a request would download from, to ask about before it starts. */
  function addressesFor(request: PluginRequest): string[] {
    const out: string[] = [];
    const marketplaceOf = (name: string) => {
      const record = readPluginState(home()).marketplaces[name];
      if (record?.source.kind === "git") out.push(record.source.url);
    };
    const entryOf = (marketplace: string, plugin: string) => {
      try {
        const entry = readMarketplace(home(), marketplace).catalog.entries.find((candidate) => candidate.name === plugin);
        if (entry?.source.kind === "git") out.push(entry.source.url);
      } catch { /* The stage step reports it. */ }
    };
    if (request.kind === "marketplace") entryOf(request.marketplace, request.plugin);
    if (request.kind === "update") {
      const record = readPluginState(home()).plugins[request.name];
      if (record?.source.kind === "marketplace") {
        marketplaceOf(record.source.marketplace);
        entryOf(record.source.marketplace, record.source.plugin);
      }
    }
    return [...new Set(out)];
  }

  async function fetchAllowed(addresses: string[]) {
    for (const address of addresses) if (!(await options.confirmFetch(maskUrl(address)))) return false;
    return true;
  }

  async function preview(request: PluginRequest, from: string, root: string | null): Promise<PluginsView> {
    if (!(await fetchAllowed(addressesFor(request)))) return view(root, { notice: { code: "cancelled" } });
    drop();
    const result = await stagePlugin(home(), request);
    if ("upToDate" in result) return view(root, { notice: { code: "up-to-date", name: result.upToDate.name } });
    waiting = { staged: result.staged, from };
    return view(root);
  }

  async function run(command: PluginsCommand, root: string | null): Promise<PluginsView> {
    switch (command.type) {
      case "list":
        return view(root);
      case "preview-folder": {
        const path = await options.pickFolder();
        if (!path) return view(root, { notice: { code: "cancelled" } });
        return preview({ kind: "folder", path }, basename(path), root);
      }
      case "preview-marketplace":
        return preview({ kind: "marketplace", marketplace: command.marketplace, plugin: command.plugin }, `${command.plugin}@${command.marketplace}`, root);
      case "preview-update": {
        const record = readPluginState(home()).plugins[command.name];
        const from = !record ? command.name : record.source.kind === "folder" ? basename(record.source.path) : `${record.source.plugin}@${record.source.marketplace}`;
        return preview({ kind: "update", name: command.name }, from, root);
      }
      case "confirm": {
        if (!waiting || waiting.staged.id !== command.id) return view(root, { error: "That preview is no longer current. Look at the plugin again before installing." });
        const { staged } = waiting;
        waiting = null;
        commitStaged(home(), staged);
        return view(root, { notice: { code: staged.mode === "update" ? "updated" : "installed", name: staged.inspection.name } });
      }
      case "cancel":
        if (waiting?.staged.id === command.id) drop();
        return view(root, { notice: { code: "cancelled" } });
      case "set-enabled":
        setPluginEnabled(home(), command.name, command.enabled);
        return view(root);
      case "set-enabled-here":
        if (!root) throw new PluginError("Open a project first.");
        setPluginEnabledIn(home(), command.name, root, command.enabled);
        return view(root);
      case "remove":
        if (waiting?.staged.inspection.name === command.name) drop();
        removePlugin(home(), command.name);
        return view(root, { notice: { code: "removed", name: command.name } });
      case "marketplace-add-folder": {
        const path = await options.pickFolder();
        if (!path) return view(root, { notice: { code: "cancelled" } });
        const input = classifyMarketplaceInput(path);
        if (input.kind === "git" && !(await fetchAllowed([input.url]))) return view(root, { notice: { code: "cancelled" } });
        const added = await addMarketplace(home(), input);
        return view(root, { notice: { code: "marketplace-added", name: added.name } });
      }
      case "marketplace-add-git": {
        const input = classifyMarketplaceInput(command.url, command.ref || undefined);
        if (!(await fetchAllowed(input.kind === "git" ? [input.url] : []))) return view(root, { notice: { code: "cancelled" } });
        const added = await addMarketplace(home(), input);
        return view(root, { notice: { code: "marketplace-added", name: added.name } });
      }
      case "marketplace-refresh": {
        const record = readPluginState(home()).marketplaces[command.name];
        if (record?.source.kind === "git" && !(await fetchAllowed([record.source.url]))) return view(root, { notice: { code: "cancelled" } });
        await refreshMarketplace(home(), command.name);
        return view(root, { notice: { code: "marketplace-updated", name: command.name } });
      }
      case "marketplace-remove":
        removeMarketplace(home(), command.name);
        return view(root, { notice: { code: "marketplace-removed", name: command.name } });
    }
  }

  return {
    /** One command at a time: a second command while a download is running is refused, not queued. */
    async reply(command: PluginsCommand, root: string | null): Promise<PluginsView> {
      if (busy && command.type !== "list") return view(root, { error: "Another plugin action is still running." });
      busy = command.type !== "list";
      try {
        return await run(command, root);
      } catch (error) {
        if (error instanceof PluginError) return view(root, { error: clean(maskUrl(error.message), 500) });
        throw error;
      } finally {
        if (command.type !== "list") busy = false;
      }
    },
    /** Called when the app quits or the window closes: a preview nobody answered is thrown away. */
    discard: drop,
  };
}
