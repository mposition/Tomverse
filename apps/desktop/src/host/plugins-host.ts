import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  PluginError, addMarketplace, classifyMarketplaceInput, commitStaged, discardStaged, listInstalledPlugins, listMarketplaces, marketplacePath, maskUrl, pluginFolderKey,
  pluginsDir, readMarketplace, readPluginState, refreshMarketplace, removeMarketplace, removePlugin, safeLine, setOfficialMarketplaceDeclined, setPluginEnabled,
  setPluginEnabledIn, shownUrl, stagePlugin, tomverseHome, type GitAuth, type MarketplaceOptions, type PluginRequest, type SourceOptions, type StagedPlugin,
} from "../../../tomverse-cli/src/runtime.js";
import officialCatalog from "../official-marketplace.json";
import type {
  InstalledPluginView, MarketplaceView, PluginHookLine, PluginPreview, PluginServerLine, PluginsCommand, PluginsNotice, PluginsView,
} from "../plugins-contract";

/**
 * What the Plugins screen shows and does. The window sends typed commands; the folder or zip file to install from comes from a dialog
 * this process opens. A preview is held here, and only the id of a preview this process made can be confirmed, so the window cannot make
 * the main process install a folder the person did not choose and see. A download (a git address, a zip file's address, an npm package)
 * is confirmed in a native dialog first, naming the address.
 *
 * Zip files, zip addresses, npm packages, private GitHub repositories and the official marketplace are offered only while `sources()` is
 * true (the server's switch, read as a capability). The official marketplace is a catalog this app carries: it is written into the
 * Tomverse folder and added like any other marketplace, can be turned off, and then is not added again.
 */

export type PluginsHostOptions = {
  /** The folder the person picked in a dialog, or null when they cancelled. */
  pickFolder: () => Promise<string | null>;
  /** The zip file the person picked in a dialog, or null when they cancelled. */
  pickZip: () => Promise<string | null>;
  /** A native question before anything is downloaded, naming where from. */
  confirmFetch: (address: string, kind: "git" | "zip" | "npm") => Promise<boolean>;
  /** Whether the extra sources and the official marketplace are on. */
  sources: () => boolean;
  /** Asks the person to use their GitHub sign-in for a private repository, and builds the way to do it. Null: they said no. */
  githubSignIn?: (address: string) => Promise<GitAuth | null>;
  /** For tests: a stand-in for the network. */
  fetchImpl?: SourceOptions["fetchImpl"];
  /** The marketplace this app carries. */
  official?: { name: string; [key: string]: unknown };
  home?: () => string;
};

const clean = (text: string, limit: number) => safeLine(text).slice(0, limit);

const hookLine = (hook: PluginHookLine): PluginHookLine => ({ event: clean(hook.event, 40), matcher: clean(hook.matcher, 120), command: clean(hook.command, 2000), timeoutSec: hook.timeoutSec });
const serverLine = (server: PluginServerLine): PluginServerLine => ({ name: clean(server.name, 120), transport: server.transport, summary: clean(server.summary, 2000) });
const names = (list: string[]) => list.map((name) => clean(name, 120)).slice(0, 200);

const originOf = (staged: StagedPlugin): PluginPreview["origin"] => {
  const origin = staged.origin;
  if (origin?.kind === "npm") return { kind: "npm", value: clean(origin.integrity, 200), detail: clean(`${origin.package}@${origin.version}`, 300) };
  if (origin?.kind === "zip") return { kind: "zip", value: origin.sha256 };
  if (origin?.kind === "zip-url") return { kind: "zip-url", value: origin.sha256, detail: clean(origin.url, 300) };
  if (staged.source.kind === "marketplace" && staged.source.commit) return { kind: "git", value: clean(staged.source.commit, 80) };
  return undefined;
};

const previewOf = (staged: StagedPlugin, from: string): PluginPreview => {
  const plugin = staged.inspection;
  const diff = staged.diff;
  const origin = originOf(staged);
  return {
    id: staged.id, mode: staged.mode, name: plugin.name, from: clean(from, 200), approval: staged.approval.slice(0, 16), ...(origin ? { origin } : {}),
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

type Download = { address: string; kind: "git" | "zip" | "npm" };

const npmAddress = (name: string, registry?: string) => `${(registry ?? "https://registry.npmjs.org").replace(/\/+$/, "")}/${name}`;

const samePath = (a: string, b: string) => (process.platform === "win32" || process.platform === "darwin" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

export function createPluginsHost(options: PluginsHostOptions) {
  const home = () => options.home?.() ?? tomverseHome();
  const official = options.official ?? officialCatalog;
  /** The one preview waiting for the person's answer. A new preview replaces it. */
  let waiting: { staged: StagedPlugin; from: string } | null = null;
  let busy = false;

  const drop = () => {
    if (waiting) discardStaged(waiting.staged);
    waiting = null;
  };

  const sourcesOn = () => options.sources();
  const needSources = () => {
    if (!sourcesOn()) throw new PluginError("This kind of source is not available.");
  };
  /** What a request may use beyond a folder and a public git address: only while the switch is on. */
  const stageOptions = () => (sourcesOn() ? { sources: { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...(options.githubSignIn ? { signIn: options.githubSignIn } : {}) } } : {});
  const marketplaceOptions = (): MarketplaceOptions => (sourcesOn() && options.githubSignIn ? { signIn: options.githubSignIn } : {});

  /* The marketplace this app carries: written into the Tomverse folder, then added like any other. */
  const officialDir = () => join(pluginsDir(home()), "builtin", official.name);
  const officialText = () => `${JSON.stringify(official, null, 2)}\n`;
  const readText = (file: string) => {
    try { return readFileSync(file, "utf8"); } catch { return null; }
  };
  const isOfficial = (name: string) => {
    const record = readPluginState(home()).marketplaces[name];
    return name === official.name && record?.source.kind === "directory" && samePath(record.source.path, officialDir());
  };

  async function ensureOfficial(): Promise<void> {
    if (!sourcesOn() || readPluginState(home()).officialMarketplaceDeclined) return;
    try {
      const file = join(officialDir(), ".claude-plugin", "marketplace.json");
      if (readText(file) !== officialText()) {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, officialText());
      }
      const record = readPluginState(home()).marketplaces[official.name];
      if (!record) await addMarketplace(home(), { kind: "directory", path: officialDir() });
      else if (isOfficial(official.name) && readText(join(marketplacePath(home(), official.name), ".claude-plugin", "marketplace.json")) !== officialText()) {
        await refreshMarketplace(home(), official.name);
      }
    } catch (error) {
      // A marketplace of the same name that the person added themselves keeps its place; any other failure is tried again next time.
      if (!(error instanceof PluginError)) throw error;
    }
  }

  function view(root: string | null, extra: { notice?: PluginsNotice; error?: string } = {}): PluginsView {
    const state = readPluginState(home());
    const plugins = listInstalledPlugins(home()).map((installed): InstalledPluginView => {
      const contents = installed.inspection;
      const record = installed.record;
      const origin = record.source.kind === "folder" ? record.origin : undefined;
      return {
        name: installed.name, ...(record.version ? { version: clean(record.version, 60) } : {}),
        ...(contents?.description ? { description: clean(contents.description, 300) } : {}),
        enabled: record.enabled, disabledHere: root !== null && record.disabledIn.includes(pluginFolderKey(root)),
        from: record.source.kind === "marketplace" ? { kind: "marketplace", marketplace: clean(record.source.marketplace, 100) }
          : origin?.kind === "npm" ? { kind: "npm", package: clean(origin.package, 214) } : origin?.kind === "zip" ? { kind: "zip" } : origin?.kind === "zip-url" ? { kind: "zip-url" } : { kind: "folder" },
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
        installed: Boolean(state.plugins[entry.name]),
        supported: entry.source.kind === "relative" || entry.source.kind === "git" || ((entry.source.kind === "npm" || entry.source.kind === "zip") && sourcesOn()),
      })),
      ...(listing.problem ? { problem: clean(listing.problem, 300) } : {}),
      ...(isOfficial(listing.name) ? { official: true } : {}),
    }));
    return {
      project: root !== null, sources: sourcesOn(), ...(sourcesOn() ? { official: { enabled: !state.officialMarketplaceDeclined } } : {}),
      plugins, marketplaces, ...(waiting ? { preview: previewOf(waiting.staged, waiting.from) } : {}), ...extra,
    };
  }

  /** What a request would download, to ask about before it starts. */
  function downloadsFor(request: PluginRequest): Download[] {
    const out: Download[] = [];
    const entryOf = (marketplace: string, plugin: string) => {
      try {
        const entry = readMarketplace(home(), marketplace).catalog.entries.find((candidate) => candidate.name === plugin);
        if (entry?.source.kind === "git") out.push({ address: entry.source.url, kind: "git" });
        if (entry?.source.kind === "npm") out.push({ address: npmAddress(entry.source.package, entry.source.registry), kind: "npm" });
        if (entry?.source.kind === "zip") out.push({ address: shownUrl(entry.source.url), kind: "zip" });
      } catch { /* The stage step reports it. */ }
    };
    if (request.kind === "marketplace") entryOf(request.marketplace, request.plugin);
    if (request.kind === "zip-url") out.push({ address: shownUrl(request.url), kind: "zip" });
    if (request.kind === "npm") out.push({ address: npmAddress(request.package, request.registry), kind: "npm" });
    if (request.kind === "update") {
      const record = readPluginState(home()).plugins[request.name];
      // A marketplace plugin's catalog was refreshed (and its address asked about) before this: these are the addresses it names now.
      if (record?.source.kind === "marketplace") entryOf(record.source.marketplace, record.source.plugin);
      else if (record?.origin?.kind === "zip-url") out.push({ address: shownUrl(record.origin.url), kind: "zip" });
      else if (record?.origin?.kind === "npm") out.push({ address: npmAddress(record.origin.package, record.origin.registry), kind: "npm" });
    }
    return out.filter((entry, index) => out.findIndex((other) => other.address === entry.address) === index);
  }

  async function fetchAllowed(downloads: Download[]) {
    for (const download of downloads) if (!(await options.confirmFetch(maskUrl(download.address), download.kind))) return false;
    return true;
  }

  async function preview(request: PluginRequest, from: string, root: string | null): Promise<PluginsView> {
    if (request.kind === "zip" || request.kind === "zip-url" || request.kind === "npm") needSources();
    // An update of a plugin from a marketplace reads the marketplace's newest catalog first, and the person is asked about what that
    // catalog names, not about what the old one named. The catalog is then not refreshed a second time.
    const record = request.kind === "update" ? readPluginState(home()).plugins[request.name] : undefined;
    let refreshed = false;
    if (record?.source.kind === "marketplace") {
      const market = readPluginState(home()).marketplaces[record.source.marketplace];
      if (market?.source.kind === "git" && !(await fetchAllowed([{ address: market.source.url, kind: "git" }]))) return view(root, { notice: { code: "cancelled" } });
      if (market) {
        if (isOfficial(record.source.marketplace)) await ensureOfficial();
        else await refreshMarketplace(home(), record.source.marketplace, marketplaceOptions());
        refreshed = true;
      }
    }
    if (!(await fetchAllowed(downloadsFor(request)))) return view(root, { notice: { code: "cancelled" } });
    drop();
    const result = await stagePlugin(home(), request, { ...stageOptions(), ...(refreshed ? { refresh: false } : {}) });
    if ("upToDate" in result) return view(root, { notice: { code: "up-to-date", name: result.upToDate.name } });
    waiting = { staged: result.staged, from };
    return view(root);
  }

  async function turnOffOfficial(root: string | null): Promise<PluginsView> {
    setOfficialMarketplaceDeclined(home(), true);
    if (isOfficial(official.name)) removeMarketplace(home(), official.name);
    return view(root, { notice: { code: "marketplace-removed", name: official.name } });
  }

  async function run(command: PluginsCommand, root: string | null): Promise<PluginsView> {
    switch (command.type) {
      case "list":
        await ensureOfficial();
        return view(root);
      case "preview-folder": {
        const path = await options.pickFolder();
        if (!path) return view(root, { notice: { code: "cancelled" } });
        return preview({ kind: "folder", path }, basename(path), root);
      }
      case "preview-zip": {
        needSources();
        const path = await options.pickZip();
        if (!path) return view(root, { notice: { code: "cancelled" } });
        return preview({ kind: "zip", path }, basename(path), root);
      }
      case "preview-zip-url":
        needSources();
        return preview({ kind: "zip-url", url: command.url }, shownUrl(command.url), root);
      case "preview-npm":
        needSources();
        return preview({ kind: "npm", package: command.package, ...(command.version ? { version: command.version } : {}) }, `npm:${command.package}${command.version ? `@${command.version}` : ""}`, root);
      case "preview-marketplace":
        return preview({ kind: "marketplace", marketplace: command.marketplace, plugin: command.plugin }, `${command.plugin}@${command.marketplace}`, root);
      case "preview-update": {
        const record = readPluginState(home()).plugins[command.name];
        const from = !record ? command.name
          : record.source.kind === "marketplace" ? `${record.source.plugin}@${record.source.marketplace}`
            : record.origin?.kind === "npm" ? `npm:${record.origin.package}` : record.origin?.kind === "zip-url" ? shownUrl(record.origin.url) : basename(record.source.path);
        if (record?.origin) needSources();
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
        if (input.kind === "git" && !(await fetchAllowed([{ address: input.url, kind: "git" }]))) return view(root, { notice: { code: "cancelled" } });
        const added = await addMarketplace(home(), input, marketplaceOptions());
        return view(root, { notice: { code: "marketplace-added", name: added.name } });
      }
      case "marketplace-add-git": {
        const input = classifyMarketplaceInput(command.url, command.ref || undefined);
        if (!(await fetchAllowed(input.kind === "git" ? [{ address: input.url, kind: "git" }] : []))) return view(root, { notice: { code: "cancelled" } });
        const added = await addMarketplace(home(), input, marketplaceOptions());
        return view(root, { notice: { code: "marketplace-added", name: added.name } });
      }
      case "marketplace-refresh": {
        if (isOfficial(command.name)) {
          await ensureOfficial();
          return view(root, { notice: { code: "marketplace-updated", name: command.name } });
        }
        const record = readPluginState(home()).marketplaces[command.name];
        if (record?.source.kind === "git" && !(await fetchAllowed([{ address: record.source.url, kind: "git" }]))) return view(root, { notice: { code: "cancelled" } });
        await refreshMarketplace(home(), command.name, marketplaceOptions());
        return view(root, { notice: { code: "marketplace-updated", name: command.name } });
      }
      case "marketplace-remove":
        if (isOfficial(command.name)) return turnOffOfficial(root);
        removeMarketplace(home(), command.name);
        return view(root, { notice: { code: "marketplace-removed", name: command.name } });
      case "set-official-marketplace":
        needSources();
        if (!command.enabled) return turnOffOfficial(root);
        setOfficialMarketplaceDeclined(home(), false);
        await ensureOfficial();
        return view(root, { notice: { code: "marketplace-added", name: official.name } });
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
