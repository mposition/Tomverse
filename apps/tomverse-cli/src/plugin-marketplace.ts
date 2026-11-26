import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { tomverseHome } from "./config.js";
import { copyTreeSafely, insideFolder, PluginError } from "./plugin-fs.js";
import { validPluginName } from "./plugin-format.js";
import { checkGitUrl, checkRef, fetchGitSnapshot } from "./plugin-git.js";
import {
    marketplacesDir, readPluginState, stagingDir, updatePluginState, type MarketplaceRecord, type MarketplaceSource,
} from "./plugin-store.js";

/**
 * A marketplace is a catalog of plugins: a folder or git repository with `.claude-plugin/marketplace.json` (or Codex's
 * `.agents/plugins/marketplace.json`). The person adds one by naming a folder on this computer or a git address; nothing is built in.
 * Adding downloads the catalog into the CLI's own folder (git: one commit, recorded) and runs nothing. A plugin is installed from a
 * catalog entry in a separate step, with its own confirmation.
 */

export const MARKETPLACE_FILES = [join(".claude-plugin", "marketplace.json"), join(".agents", "plugins", "marketplace.json")] as const;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 500;

export type EntrySource =
    | { kind: "relative"; path: string }
    | { kind: "git"; url: string; ref?: string; sha?: string; subdir?: string }
    | { kind: "unsupported"; type: string };

export type CatalogEntry = { name: string; description?: string; version?: string; category?: string; source: EntrySource };
export type Catalog = { name: string; description?: string; owner?: string; entries: CatalogEntry[]; issues: string[]; file: string };

const clean = (text: string, limit: number) => text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);

const entrySchema = z.object({
    name: z.string().min(1).max(100),
    source: z.union([z.string().min(1).max(500), z.object({ source: z.string().max(40) }).passthrough()]),
    description: z.string().max(2000).optional(),
    version: z.union([z.string().max(100), z.number()]).optional(),
    category: z.string().max(100).optional(),
}).passthrough();

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A path inside a repository or catalog folder: relative, no `..`, no drive or backslash. */
const safeSubpath = (text: string): string | null => {
    const path = text.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!path || isAbsolute(path) || /[\\\u0000]/.test(path) || path.split("/").some((part) => part === ".." || part === "")) return null;
    return path;
};

const sourceOf = (value: z.infer<typeof entrySchema>["source"], pluginRoot: string | undefined, issues: string[], name: string): EntrySource => {
    if (typeof value === "string") {
        if (value === "." || value === "./") return { kind: "relative", path: "." };
        // A bare name (no slash) is looked up under metadata.pluginRoot; anything else must start with ./
        const path = value.startsWith("./") ? safeSubpath(value) : pluginRoot && !value.includes("/") ? safeSubpath(`${pluginRoot}/${value}`) : null;
        if (!path) {
            issues.push(`${name}: the source ${JSON.stringify(clean(value, 100))} must be a path starting with ./ inside the marketplace.`);
            return { kind: "unsupported", type: "path" };
        }
        return { kind: "relative", path };
    }
    const raw = value as Record<string, unknown>;
    const type = String(raw.source);
    const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
    try {
        const ref = text("ref");
        const sha = text("sha");
        checkRef(ref);
        if (sha !== undefined && !SHA.test(sha)) throw new PluginError("sha must be a full 40-character commit.");
        if (type === "github") {
            const repo = text("repo");
            if (!repo || !REPO.test(repo)) throw new PluginError("repo must be owner/repo.");
            return { kind: "git", url: `https://github.com/${repo}.git`, ...(ref ? { ref } : {}), ...(sha ? { sha } : {}) };
        }
        if (type === "url") {
            const url = text("url");
            if (!url) throw new PluginError("a url is needed.");
            return { kind: "git", url: checkGitUrl(url).url, ...(ref ? { ref } : {}), ...(sha ? { sha } : {}) };
        }
        if (type === "git-subdir") {
            const url = text("url");
            const subdir = safeSubpath(text("path") ?? "");
            if (!url || !subdir) throw new PluginError("url and a path inside the repository are needed.");
            const address = REPO.test(url) ? `https://github.com/${url}.git` : checkGitUrl(url).url;
            return { kind: "git", url: address, subdir, ...(ref ? { ref } : {}), ...(sha ? { sha } : {}) };
        }
        if (type === "local") {
            const path = safeSubpath(text("path") ?? "");
            if (!path) throw new PluginError("a path inside the marketplace is needed.");
            return { kind: "relative", path };
        }
    } catch (error) {
        issues.push(`${name}: ${(error as Error).message}`);
        return { kind: "unsupported", type };
    }
    return { kind: "unsupported", type: clean(type, 40) };
};

/** Reads the catalog of a marketplace folder. Throws PluginError when there is no usable catalog; an invalid entry is skipped with an issue. */
export const readCatalog = (dir: string): Catalog => {
    let file: string | null = null;
    for (const candidate of MARKETPLACE_FILES) if (existsSync(join(dir, candidate))) { file = candidate; break; }
    if (!file) throw new PluginError("There is no .claude-plugin/marketplace.json in that marketplace.");
    const path = join(dir, file);
    if (statSync(path).size > MAX_FILE_BYTES) throw new PluginError("The marketplace file is too large.");
    let json: unknown;
    try {
        json = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    } catch {
        throw new PluginError("The marketplace file is not valid JSON.");
    }
    const top = z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(2000).optional(),
        owner: z.union([z.string().max(200), z.object({ name: z.string().max(200) }).passthrough()]).optional(),
        metadata: z.object({ pluginRoot: z.string().max(200).optional() }).passthrough().optional(),
        plugins: z.array(z.unknown()).max(MAX_ENTRIES),
    }).passthrough().safeParse(json);
    if (!top.success) throw new PluginError(`The marketplace file is not valid (${clean(top.error.issues[0]?.message ?? "invalid", 100)}).`);
    if (!validPluginName(top.data.name)) throw new PluginError(`The marketplace name ${JSON.stringify(clean(top.data.name, 60))} is not usable: letters, digits, . _ - only.`);
    const issues: string[] = [];
    const entries: CatalogEntry[] = [];
    const names = new Set<string>();
    const pluginRoot = top.data.metadata?.pluginRoot;
    for (const raw of top.data.plugins) {
        const parsed = entrySchema.safeParse(raw);
        if (!parsed.success) {
            issues.push("A catalog entry without a name and a source was skipped.");
            continue;
        }
        const entry = parsed.data;
        if (!validPluginName(entry.name) || names.has(entry.name)) {
            issues.push(`The entry ${JSON.stringify(clean(entry.name, 60))} has an unusable or repeated name; it was skipped.`);
            continue;
        }
        names.add(entry.name);
        entries.push({
            name: entry.name, source: sourceOf(entry.source, pluginRoot, issues, entry.name),
            ...(entry.description ? { description: clean(entry.description, 400) } : {}),
            ...(entry.version !== undefined ? { version: clean(String(entry.version), 60) } : {}),
            ...(entry.category ? { category: clean(entry.category, 60) } : {}),
        });
    }
    const owner = top.data.owner === undefined ? undefined : typeof top.data.owner === "string" ? top.data.owner : top.data.owner.name;
    return {
        name: top.data.name, file: file.split("\\").join("/"), entries, issues,
        ...(top.data.description ? { description: clean(top.data.description, 400) } : {}), ...(owner ? { owner: clean(owner, 100) } : {}),
    };
};

/** A path in a catalog entry resolved inside the marketplace folder (a link may not lead out). Throws PluginError. */
export const resolveInMarketplace = (base: string, path: string): string => {
    const subpath = path === "." ? "" : safeSubpath(path);
    if (subpath === null) throw new PluginError("The plugin path is not inside the marketplace.");
    const realBase = realpathSync.native(base);
    let real: string;
    try {
        real = realpathSync.native(resolve(realBase, subpath));
    } catch {
        throw new PluginError(`The plugin folder ${path} is not in the marketplace.`);
    }
    if (!insideFolder(realBase, real) || !statSync(real).isDirectory()) throw new PluginError("The plugin folder is not inside the marketplace.");
    return real;
};

/* ----------------------------------------------------------------- the person's marketplaces */

export const marketplacePath = (home: string, name: string): string => {
    if (!validPluginName(name)) throw new PluginError("That is not a marketplace name.");
    return join(marketplacesDir(home), name);
};

/** A fresh folder under the CLI's own staging area. Anything older than a day left by a stopped run is removed first. */
export const newStaging = (home: string = tomverseHome()): { id: string; dir: string } => {
    const base = stagingDir(home);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    try {
        for (const entry of readdirSync(base)) {
            const path = join(base, entry);
            if (Date.now() - statSync(path).mtimeMs > 24 * 3600 * 1000) rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
        }
    } catch { /* A leftover that cannot be removed now is tried again next time. */ }
    const id = randomBytes(8).toString("hex");
    const dir = join(base, id);
    mkdirSync(dir, { recursive: true });
    return { id, dir };
};

export const discardStaging = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

export type MarketplaceInput = { kind: "directory"; path: string } | { kind: "git"; url: string; ref?: string };

const GIT_FOLDER = (path: string) => existsSync(join(path, "HEAD")) && existsSync(join(path, "objects"));

/**
 * What a person typed or picked, as a marketplace source: a folder with a catalog is copied; a bare git repository folder or any git
 * address is downloaded. Throws PluginError when it is neither.
 */
export const classifyMarketplaceInput = (text: string, ref?: string): MarketplaceInput => {
    const value = text.trim();
    let isFolder = false;
    try {
        isFolder = isAbsolute(value) && statSync(value).isDirectory();
    } catch { /* Not a folder: an address, then. */ }
    if (isFolder) {
        if (MARKETPLACE_FILES.some((file) => existsSync(join(value, file)))) return { kind: "directory", path: resolve(value) };
        if (GIT_FOLDER(value)) return { kind: "git", url: checkGitUrl(value).url, ...(ref ? { ref } : {}) };
        throw new PluginError("That folder has no .claude-plugin/marketplace.json.");
    }
    return { kind: "git", url: checkGitUrl(value).url, ...(ref ? { ref } : {}) };
};

const fill = async (input: MarketplaceInput, dir: string, signal?: AbortSignal): Promise<{ commit?: string; source: MarketplaceSource }> => {
    if (input.kind === "directory") {
        copyTreeSafely(input.path, dir);
        return { source: { kind: "directory", path: input.path } };
    }
    const { commit } = await fetchGitSnapshot({ url: input.url, ...(input.ref ? { ref: input.ref } : {}) }, dir, { signal });
    return { commit, source: { kind: "git", url: input.url, ...(input.ref ? { ref: input.ref } : {}) } };
};

export type AddedMarketplace = { name: string; catalog: Catalog; commit?: string };

/** Downloads a marketplace's catalog (and the files of its own plugins) and records it. Runs nothing from it. */
export const addMarketplace = async (home: string, input: MarketplaceInput, options: { signal?: AbortSignal } = {}): Promise<AddedMarketplace> => {
    const staging = newStaging(home);
    try {
        const tree = join(staging.dir, "tree");
        const { commit, source } = await fill(input, tree, options.signal);
        const catalog = readCatalog(tree);
        if (readPluginState(home).marketplaces[catalog.name]) throw new PluginError(`A marketplace named ${catalog.name} is already added. Remove it first, or update it.`);
        const target = marketplacePath(home, catalog.name);
        mkdirSync(marketplacesDir(home), { recursive: true, mode: 0o700 });
        rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        renameSync(tree, target);
        const now = new Date().toISOString();
        updatePluginState(home, (state) => {
            state.marketplaces[catalog.name] = { source, ...(commit ? { commit } : {}), addedAt: now, updatedAt: now };
        });
        return { name: catalog.name, catalog, ...(commit ? { commit } : {}) };
    } finally {
        discardStaging(staging.dir);
    }
};

/** Downloads the marketplace again from where it came from (git: the newest commit of the same branch). The person asked for it. */
export const refreshMarketplace = async (home: string, name: string, options: { signal?: AbortSignal } = {}): Promise<AddedMarketplace> => {
    const record = readPluginState(home).marketplaces[name];
    if (!record) throw new PluginError(`No marketplace named ${name}.`);
    const staging = newStaging(home);
    try {
        const tree = join(staging.dir, "tree");
        const input: MarketplaceInput = record.source.kind === "directory" ? record.source : { kind: "git", url: record.source.url, ...(record.source.ref ? { ref: record.source.ref } : {}) };
        const { commit } = await fill(input, tree, options.signal);
        const catalog = readCatalog(tree);
        if (catalog.name !== name) throw new PluginError(`The marketplace now calls itself ${catalog.name}; remove ${name} and add it again.`);
        const target = marketplacePath(home, name);
        const old = `${target}.old-${staging.id}`;
        if (existsSync(target)) renameSync(target, old);
        renameSync(tree, target);
        rmSync(old, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        updatePluginState(home, (state) => {
            const current = state.marketplaces[name];
            if (!current) return;
            current.updatedAt = new Date().toISOString();
            if (commit) current.commit = commit;
            else delete current.commit;
        });
        return { name, catalog, ...(commit ? { commit } : {}) };
    } finally {
        discardStaging(staging.dir);
    }
};

/** Forgets a marketplace and deletes its downloaded copy. Plugins already installed from it stay installed. */
export const removeMarketplace = (home: string, name: string) => {
    if (!readPluginState(home).marketplaces[name]) throw new PluginError(`No marketplace named ${name}.`);
    const path = marketplacePath(home, name);
    if (existsSync(path)) {
        const base = realpathSync.native(marketplacesDir(home));
        const real = realpathSync.native(path);
        if (insideFolder(base, real) && real !== base) rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    updatePluginState(home, (state) => {
        delete state.marketplaces[name];
    });
};

export type MarketplaceListing = { name: string; record: MarketplaceRecord; catalog: Catalog | null; problem?: string };

/** The downloaded catalogs. A catalog that can no longer be read is listed with its problem. */
export const listMarketplaces = (home: string): MarketplaceListing[] =>
    Object.entries(readPluginState(home).marketplaces).map(([name, record]) => {
        try {
            return { name, record, catalog: readCatalog(marketplacePath(home, name)) };
        } catch (error) {
            return { name, record, catalog: null, problem: (error as Error).message };
        }
    });

export const readMarketplace = (home: string, name: string): { record: MarketplaceRecord; catalog: Catalog; dir: string } => {
    const record = readPluginState(home).marketplaces[name];
    if (!record) throw new PluginError(`No marketplace named ${name}.`);
    const dir = marketplacePath(home, name);
    return { record, catalog: readCatalog(dir), dir };
};
