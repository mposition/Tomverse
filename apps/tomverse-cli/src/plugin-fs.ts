import { createHash } from "node:crypto";
import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * File handling for plugins, which are third-party code. Everything that reaches the CLI's plugin folder goes through here:
 * a copy never follows a link out of its source folder, never writes outside its destination, and stops at a size and file
 * count. Nothing in this file runs anything.
 */

export class PluginError extends Error {}

export const PLUGIN_LIMITS = {
    files: 5000,
    bytes: 50 * 1024 * 1024,
    fileBytes: 10 * 1024 * 1024,
    depth: 14,
} as const;

export const insideFolder = (base: string, target: string) => {
    const rel = relative(base, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const posix = (path: string) => path.split(sep).join("/");

const readDirectory = (path: string) => readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export type CopyReport = { files: number; bytes: number };

/**
 * Copies a folder into an empty destination. A link is followed only when it stays inside the source folder and leads to a file;
 * a link that leaves the folder, a link to a folder, and anything that is not a plain file or folder stops the copy. `.git` is left out.
 * Throws PluginError; the caller removes the destination.
 */
export const copyTreeSafely = (source: string, destination: string): CopyReport => {
    let realSource: string;
    try {
        realSource = realpathSync.native(source);
        if (!statSync(realSource).isDirectory()) throw new Error("not a folder");
    } catch {
        throw new PluginError("The source is not a readable folder.");
    }
    const report: CopyReport = { files: 0, bytes: 0 };
    mkdirSync(destination, { recursive: true });
    const realDestination = realpathSync.native(destination);
    const walk = (from: string, to: string, depth: number) => {
        if (depth > PLUGIN_LIMITS.depth) throw new PluginError("The folder is nested too deeply.");
        for (const entry of readDirectory(from)) {
            if (entry.name === ".git") continue;
            const path = join(from, entry.name);
            const target = join(to, entry.name);
            if (!insideFolder(realDestination, target)) throw new PluginError(`The path ${posix(relative(realSource, path))} would leave the plugin folder.`);
            const shown = posix(relative(realSource, path));
            const stat = lstatSync(path);
            let file = path;
            let size = stat.size;
            if (stat.isSymbolicLink()) {
                let real: string;
                try {
                    real = realpathSync.native(path);
                } catch {
                    throw new PluginError(`The link ${shown} points nowhere.`);
                }
                if (!insideFolder(realSource, real)) throw new PluginError(`The link ${shown} points outside the plugin folder.`);
                const linked = statSync(real);
                if (!linked.isFile()) throw new PluginError(`The link ${shown} points to a folder or a special file; only links to files are allowed.`);
                file = real;
                size = linked.size;
            } else if (stat.isDirectory()) {
                mkdirSync(target, { recursive: true });
                walk(path, target, depth + 1);
                continue;
            } else if (!stat.isFile()) {
                throw new PluginError(`${shown} is not a plain file.`);
            }
            if (size > PLUGIN_LIMITS.fileBytes) throw new PluginError(`${shown} is larger than ${PLUGIN_LIMITS.fileBytes / 1024 / 1024} MB.`);
            report.files += 1;
            report.bytes += size;
            if (report.files > PLUGIN_LIMITS.files) throw new PluginError(`The plugin has more than ${PLUGIN_LIMITS.files} files.`);
            if (report.bytes > PLUGIN_LIMITS.bytes) throw new PluginError(`The plugin is larger than ${PLUGIN_LIMITS.bytes / 1024 / 1024} MB.`);
            copyFileSync(file, target);
        }
    };
    walk(realSource, realDestination, 0);
    return report;
};

const hashFile = (path: string, hash: ReturnType<typeof createHash>) => {
    const fd = openSync(path, "r");
    try {
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
            const count = readSync(fd, buffer, 0, buffer.length, null);
            if (!count) break;
            hash.update(buffer.subarray(0, count));
        }
    } finally {
        closeSync(fd);
    }
};

/** Every file of a folder as sorted relative paths with sizes; links are not followed (an installed folder has none). */
const listFiles = (dir: string): Array<{ rel: string; path: string; size: number; mtimeMs: number }> => {
    const out: Array<{ rel: string; path: string; size: number; mtimeMs: number }> = [];
    const walk = (from: string, depth: number) => {
        if (depth > PLUGIN_LIMITS.depth + 2) return;
        for (const entry of readDirectory(from)) {
            const path = join(from, entry.name);
            const stat = lstatSync(path);
            if (stat.isDirectory()) walk(path, depth + 1);
            else if (stat.isFile()) out.push({ rel: posix(relative(dir, path)), path, size: stat.size, mtimeMs: stat.mtimeMs });
            else out.push({ rel: `${posix(relative(dir, path))}\u0000other`, path, size: -1, mtimeMs: stat.mtimeMs });
        }
    };
    walk(dir, 0);
    return out;
};

const digestCache = new Map<string, string>();

/**
 * A digest of every path and content in a folder. A hook or server of a plugin is approved for exactly this digest, so a changed
 * script asks again. The full read happens once per unchanged folder (files, sizes and modification times are the cache key).
 */
export const treeDigest = (dir: string): string => {
    const files = listFiles(dir);
    const fingerprint = createHash("sha256");
    for (const file of files) fingerprint.update(`${file.rel}\u0000${file.size}\u0000${file.mtimeMs}\n`);
    const key = `${dir}\u0000${fingerprint.digest("hex")}`;
    const cached = digestCache.get(key);
    if (cached) return cached;
    const hash = createHash("sha256");
    for (const file of files) {
        hash.update(`${file.rel}\u0000${file.size}\n`);
        if (file.size >= 0) hashFile(file.path, hash);
    }
    const digest = hash.digest("hex");
    if (digestCache.size > 64) digestCache.clear();
    digestCache.set(key, digest);
    return digest;
};

export const treeStats = (dir: string): CopyReport => {
    const files = listFiles(dir);
    return { files: files.length, bytes: files.reduce((sum, file) => sum + Math.max(0, file.size), 0) };
};
