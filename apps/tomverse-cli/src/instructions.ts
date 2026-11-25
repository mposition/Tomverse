import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Workspace } from "./workspace.js";

/**
 * The instruction files of a project, as information for the model: AGENTS.md
 * and CLAUDE.md (with the `@file` lines of a CLAUDE.md that pull another file
 * in), and the unconditional rules of `.claude/rules/*.md`. They describe the
 * project. They are never read as permissions, configuration, endpoints or
 * approvals, and the CLI never runs anything because a file says so.
 *
 * At the start of a task the folder's own files are read, bounded in total.
 * When the agent first reads or changes a file in a subfolder, that subfolder's
 * own AGENTS.md / CLAUDE.md are added once, so more specific guidance reaches
 * the model when it is working there. Every file goes through the same path
 * check as every read: a link out of the folder, a credential file or the CLI's
 * own data folder is never sent.
 */

export const MAX_INSTRUCTIONS_LENGTH = 32_000;
const MAX_RULE_FILES = 20;
const MAX_IMPORT_DEPTH = 3;
/** One subfolder's files, and all of them together for a task. */
const NESTED_FOLDER_LENGTH = 12_000;
const NESTED_TOTAL_LENGTH = 48_000;

type Piece = { path: string; text: string; truncated: boolean };

/** One file's text, bounded to `limit` characters, read through the workspace's path check. Null when it is not there or not readable. */
const readBounded = (workspace: Workspace, path: string, limit: number, name = path): { text: string; truncated: boolean; absolute: string } | null => {
    try {
        const resolved = workspace.resolve(path, "read");
        if (!resolved.exists || !statSync(resolved.absolute).isFile()) return null;
        const file = openSync(resolved.absolute, "r");
        try {
            if (!fstatSync(file).isFile()) return null;
            const buffer = Buffer.alloc(limit * 4 + 4);
            let offset = 0;
            while (offset < buffer.length) {
                const count = readSync(file, buffer, offset, buffer.length - offset, offset);
                if (!count) break;
                offset += count;
            }
            const text = buffer.toString("utf8", 0, offset);
            const truncated = text.length > limit;
            if (!truncated) return { text, truncated, absolute: resolved.absolute };
            const lastIncludedUnit = text.charCodeAt(limit - 1);
            const end = lastIncludedUnit >= 0xd800 && lastIncludedUnit <= 0xdbff ? limit - 1 : limit;
            return { text: `${text.slice(0, end)}\n[${name} continues; read the file for the rest]`, truncated, absolute: resolved.absolute };
        } finally {
            closeSync(file);
        }
    } catch {
        return null;
    }
};

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const IMPORT_LINE = /^@(\S+)[ \t]*$/;

/**
 * The text of a CLAUDE.md or rule file with its whole-line `@path` imports
 * replaced by those files, relative to the file, inside the folder only, each
 * file at most once (so CLAUDE.md saying `@AGENTS.md` adds nothing the folder's
 * AGENTS.md has not already given).
 */
const withImports = (workspace: Workspace, dir: string, text: string, seen: Set<string>, depth: number): string => {
    if (depth >= MAX_IMPORT_DEPTH) return text;
    const out: string[] = [];
    for (const line of text.split("\n")) {
        const target = IMPORT_LINE.exec(line.replace(/\r$/, ""))?.[1];
        if (!target) {
            out.push(line);
            continue;
        }
        const path = posix.normalize(posix.join(dir, target));
        const imported = path.startsWith("..") ? null : readBounded(workspace, path, MAX_INSTRUCTIONS_LENGTH, path);
        if (!imported) {
            out.push(line);
            continue;
        }
        if (seen.has(imported.absolute)) continue;
        seen.add(imported.absolute);
        out.push(withImports(workspace, posix.dirname(path), imported.text, seen, depth + 1));
    }
    return out.join("\n");
};

/** AGENTS.md and CLAUDE.md of one folder, in that order. `seen` holds the files already given, so none is sent twice. */
const folderPieces = (workspace: Workspace, dir: string, seen: Set<string>, limit: number): Piece[] => {
    const pieces: Piece[] = [];
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const path = dir === "." ? name : `${dir}/${name}`;
        const file = readBounded(workspace, path, limit, path);
        if (!file || seen.has(file.absolute)) continue;
        seen.add(file.absolute);
        const text = name === "AGENTS.md" ? file.text : withImports(workspace, dir, file.text, seen, 0);
        if (text.trim()) pieces.push({ path, text, truncated: file.truncated });
    }
    return pieces;
};

/** The unconditional rules of `.claude/rules`: files with no `paths` (or `globs`) front matter, which apply to every file. */
const rulePieces = (workspace: Workspace, seen: Set<string>): Piece[] => {
    let directory: string;
    try {
        const resolved = workspace.resolve(".claude/rules", "read");
        if (!resolved.exists || !statSync(resolved.absolute).isDirectory()) return [];
        directory = resolved.absolute;
    } catch {
        return [];
    }
    const files: string[] = [];
    const walk = (relative: string, depth: number) => {
        let entries;
        try {
            entries = readdirSync(join(directory, relative), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
            if (entry.isSymbolicLink()) continue;
            const next = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory() && depth < 2) walk(next, depth + 1);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(next);
        }
    };
    walk("", 0);
    const pieces: Piece[] = [];
    for (const name of files.slice(0, MAX_RULE_FILES)) {
        const path = `.claude/rules/${name}`;
        const file = readBounded(workspace, path, MAX_INSTRUCTIONS_LENGTH, path);
        if (!file || seen.has(file.absolute)) continue;
        let text = file.text;
        const header = FRONT_MATTER.exec(text);
        if (header) {
            // A rule that names the files it applies to is not unconditional: it is left out.
            if (/^\s*(paths|globs)\s*:/m.test(header[1]!)) continue;
            text = text.slice(header[0].length);
        }
        seen.add(file.absolute);
        text = withImports(workspace, posix.dirname(path), text, seen, 0);
        if (text.trim()) pieces.push({ path, text, truncated: file.truncated });
    }
    return pieces;
};

/**
 * The folder's own instructions, for the start of a task: AGENTS.md, CLAUDE.md
 * and the unconditional `.claude/rules`, bounded to 32,000 characters in all.
 * A folder with only an AGENTS.md gets exactly that file's text, as before.
 */
export const readProjectInstructions = (workspace: Workspace): { text: string; truncated: boolean } | null => {
    const seen = new Set<string>();
    const pieces = [...folderPieces(workspace, ".", seen, MAX_INSTRUCTIONS_LENGTH), ...rulePieces(workspace, seen)];
    if (!pieces.length) return null;
    if (pieces.length === 1 && pieces[0]!.path === "AGENTS.md") return { text: pieces[0]!.text, truncated: pieces[0]!.truncated };
    let remaining = MAX_INSTRUCTIONS_LENGTH;
    const parts: string[] = [];
    let included = 0;
    let truncated = false;
    for (const piece of pieces) {
        const header = `--- ${piece.path} ---\n`;
        if (remaining <= header.length + 40) {
            truncated = true;
            break;
        }
        const room = remaining - header.length;
        let text = piece.text;
        if (text.length > room) {
            const end = text.charCodeAt(room - 1) >= 0xd800 && text.charCodeAt(room - 1) <= 0xdbff ? room - 1 : room;
            text = `${text.slice(0, end)}\n[${piece.path} continues; read the file for the rest]`;
            truncated = true;
        } else if (piece.truncated) truncated = true;
        parts.push(header + text);
        included += 1;
        remaining -= header.length + text.length + 1;
    }
    if (included < pieces.length) parts.push(`[${pieces.length - included} more instruction file(s) were left out; read them in the folder]`);
    return { text: parts.join("\n"), truncated };
};

export const readInstructions = (workspace: Workspace) => readProjectInstructions(workspace)?.text ?? null;

/**
 * Subfolder instructions, given once per folder when the agent first reads or
 * changes a file there. The folder's own files were given at the start, so
 * only the folders below it are looked at, from the nearest to the root down to
 * the file's own folder. Bounded per folder and in total for the task.
 */
export class NestedInstructions {
    private readonly done = new Set<string>();
    private readonly seen = new Set<string>();
    private used = 0;

    constructor(private readonly workspace: Workspace) {}

    /** After the conversation is compacted the earlier results are gone: every folder may be given again. */
    reset() {
        this.done.clear();
        this.seen.clear();
        this.used = 0;
    }

    /** Instructions of the folders above `path` (a path relative to the workspace root) not given yet; null when there are none. */
    forFile(path: string): { files: string[]; text: string } | null {
        const segments = posix.dirname(path.replaceAll("\\", "/")).split("/").filter((s) => s && s !== ".");
        const found: Piece[] = [];
        let dir = "";
        for (const segment of segments) {
            dir = dir ? `${dir}/${segment}` : segment;
            if (this.done.has(dir)) continue;
            this.done.add(dir);
            if (this.used >= NESTED_TOTAL_LENGTH) continue;
            try {
                if (!lstatSync(this.workspace.resolve(dir, "read").absolute).isDirectory()) continue;
            } catch {
                continue;
            }
            for (const piece of folderPieces(this.workspace, dir, this.seen, NESTED_FOLDER_LENGTH)) {
                const room = NESTED_TOTAL_LENGTH - this.used;
                if (room <= 0) break;
                const text = piece.text.length > room ? `${piece.text.slice(0, room)}\n[${piece.path} continues; read the file for the rest]` : piece.text;
                this.used += text.length;
                found.push({ ...piece, text });
            }
        }
        if (!found.length) return null;
        return { files: found.map((piece) => piece.path), text: found.map((piece) => `--- ${piece.path} ---\n${piece.text}`).join("\n") };
    }
}
