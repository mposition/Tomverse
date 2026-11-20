import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { sha256 } from "./session.js";
import type { Workspace } from "./workspace.js";

/**
 * File edits as exact replacements. A replacement's `old` text must occur
 * exactly once in the file at the time of the edit; anything else is refused
 * rather than guessed. A byte-order mark and CRLF line endings are kept: the
 * edit is matched and applied on the text without them and they are put back.
 * A file with mixed line endings is matched as-is.
 */

export type PatchEdit = {
    path: string;
    action: "create" | "update" | "delete";
    content?: string;
    replacements?: Array<{ old: string; new: string }>;
};

export type PlannedEdit = {
    path: string;
    absolute: string;
    action: PatchEdit["action"];
    /** sha256 of the bytes now on disk, or null if the file does not exist. */
    preimage: string | null;
    beforeText: string | null;
    afterText: string | null;
    afterBytes: Buffer | null;
    postimage: string | null;
    eol: "lf" | "crlf" | "mixed" | "none";
    bom: boolean;
};

export class PatchError extends Error {}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const decoder = new TextDecoder("utf-8", { fatal: true });

const decode = (bytes: Buffer, path: string) => {
    const bom = bytes.subarray(0, 3).equals(BOM);
    const body = bom ? bytes.subarray(3) : bytes;
    if (body.subarray(0, 8192).includes(0)) throw new PatchError(`${path} looks binary; the CLI edits text files only.`);
    let text: string;
    try {
        text = decoder.decode(body);
    } catch {
        throw new PatchError(`${path} is not valid UTF-8; the CLI does not rewrite it.`);
    }
    const crlf = text.includes("\r\n");
    const loneLf = /(^|[^\r])\n/.test(text);
    const eol: PlannedEdit["eol"] = crlf && loneLf ? "mixed" : crlf ? "crlf" : loneLf ? "lf" : "none";
    return { text, bom, eol };
};

const encode = (text: string, bom: boolean) => (bom ? Buffer.concat([BOM, Buffer.from(text, "utf8")]) : Buffer.from(text, "utf8"));

/**
 * What the approval screen cannot show as it is: control and bidi characters
 * (displayed escaped) never enter a file through a patch, so the diff a person
 * approves is exactly the text that is written. Tab, LF and the CR of a
 * consistent CRLF file are the only exceptions; see crRule below.
 */
const UNSHOWABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/;

const assertShowable = (text: string, what: string) => {
    if (UNSHOWABLE.test(text)) {
        throw new PatchError(`${what} contains control or bidi characters, which the approval screen can only show escaped, so the CLI does not write them.`);
    }
};

/** True when every LF is part of CRLF and every CR is followed by LF. */
const consistentCrlf = (text: string) => !/\r(?!\n)/.test(text) && !/(^|[^\r])\n/.test(text);

const countOccurrences = (haystack: string, needle: string) => {
    let count = 0;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
    return count;
};

/** Reads current file state and computes every edit, writing nothing. */
export const planPatch = (workspace: Workspace, edits: PatchEdit[]): PlannedEdit[] => {
    if (!Array.isArray(edits) || edits.length === 0) throw new PatchError("A patch needs at least one edit.");
    if (edits.length > 50) throw new PatchError("At most 50 files per patch.");
    const seen = new Set<string>();
    return edits.map((edit) => {
        const resolved = workspace.resolve(edit.path, "write");
        const key = process.platform === "win32" || process.platform === "darwin" ? resolved.absolute.toLowerCase() : resolved.absolute;
        if (seen.has(key)) throw new PatchError(`${resolved.relative} appears twice in one patch; combine the edits.`);
        seen.add(key);
        const exists = resolved.exists;
        if (exists && !statSync(resolved.absolute).isFile()) throw new PatchError(`${resolved.relative} is not a regular file.`);
        const bytes = exists ? readFileSync(resolved.absolute) : null;
        const preimage = bytes ? sha256(bytes) : null;
        if (edit.action === "create") {
            if (exists) throw new PatchError(`${resolved.relative} already exists; use an update.`);
            if (typeof edit.content !== "string") throw new PatchError(`Creating ${resolved.relative} needs content.`);
            assertShowable(edit.content, `The content of ${resolved.relative}`);
            // CR only as consistent CRLF line endings, which the approval states.
            const crlf = edit.content.includes("\r");
            if (crlf && !consistentCrlf(edit.content)) {
                throw new PatchError(`The content of ${resolved.relative} mixes CR with LF line endings; use LF, or CRLF on every line.`);
            }
            const afterBytes = Buffer.from(edit.content, "utf8");
            return { path: resolved.relative, absolute: resolved.absolute, action: "create", preimage, beforeText: null, afterText: edit.content, afterBytes, postimage: sha256(afterBytes), eol: crlf ? "crlf" : "none", bom: false };
        }
        if (!exists || !bytes) throw new PatchError(`${resolved.relative} does not exist.`);
        const { text, bom, eol } = decode(bytes, resolved.relative);
        if (edit.action === "delete") {
            return { path: resolved.relative, absolute: resolved.absolute, action: "delete", preimage, beforeText: text, afterText: null, afterBytes: null, postimage: null, eol, bom };
        }
        if (edit.action !== "update") throw new PatchError(`Unknown action for ${resolved.relative}.`);
        if (!Array.isArray(edit.replacements) || edit.replacements.length === 0) {
            throw new PatchError(`Updating ${resolved.relative} needs replacements.`);
        }
        const normalize = eol === "crlf";
        let working = normalize ? text.replaceAll("\r\n", "\n") : text;
        for (const [index, replacement] of edit.replacements.entries()) {
            if (typeof replacement.old !== "string" || typeof replacement.new !== "string" || replacement.old.length === 0) {
                throw new PatchError(`Replacement ${index + 1} for ${resolved.relative} needs non-empty old text and new text.`);
            }
            assertShowable(replacement.new, `Replacement ${index + 1} for ${resolved.relative}`);
            // A CR is never added or removed on its own: in a CRLF file the
            // endings are the file's, elsewhere an edit cannot carry a CR.
            const carriesCr = (normalize ? replacement.new.replaceAll("\r\n", "\n") : replacement.new).includes("\r") || (!normalize && replacement.old.includes("\r"));
            if (carriesCr) {
                throw new PatchError(
                    `Replacement ${index + 1} for ${resolved.relative} contains a carriage return; ${eol === "mixed" ? "this file mixes line endings, so" : "in this file"} an edit cannot add or remove CR characters. Leave line endings out of old and new text.`
                );
            }
            const oldText = normalize ? replacement.old.replaceAll("\r\n", "\n") : replacement.old;
            const newText = normalize ? replacement.new.replaceAll("\r\n", "\n") : replacement.new;
            const count = countOccurrences(working, oldText);
            if (count === 0) throw new PatchError(`Replacement ${index + 1}: the old text was not found in ${resolved.relative}. Read the file again.`);
            if (count > 1) throw new PatchError(`Replacement ${index + 1}: the old text occurs ${count} times in ${resolved.relative}; include more context so it is unique.`);
            working = working.replace(oldText, () => newText);
        }
        const afterText = normalize ? working.replaceAll("\n", "\r\n") : working;
        if (afterText === text) throw new PatchError(`The replacements leave ${resolved.relative} unchanged.`);
        const afterBytes = encode(afterText, bom);
        return { path: resolved.relative, absolute: resolved.absolute, action: "update", preimage, beforeText: text, afterText, afterBytes, postimage: sha256(afterBytes), eol, bom };
    });
};

export const currentDigest = (absolute: string) => {
    if (!existsSync(absolute)) return null;
    return sha256(readFileSync(absolute));
};

/** Writes one file so a reader sees the old or the new bytes, keeping its mode. */
export const writeFileReplacing = (absolute: string, bytes: Buffer, restoreMode?: number) => {
    mkdirSync(dirname(absolute), { recursive: true });
    // The folder must really be where it was resolved: a link swapped into a
    // part of the path after the check is not followed.
    const realDir = realpathSync.native(dirname(absolute));
    const expected = dirname(absolute);
    const caseless = process.platform === "win32" || process.platform === "darwin";
    if (caseless ? realDir.toLowerCase() !== expected.toLowerCase() : realDir !== expected) {
        throw new PatchError(`The folder of ${absolute} changed (a link?); nothing was written.`);
    }
    const tmp = join(dirname(absolute), `.${randomBytes(6).toString("hex")}.tomverse-tmp`);
    const mode = restoreMode ?? (existsSync(absolute) ? statSync(absolute).mode & 0o7777 : undefined);
    const fd = openSync(tmp, "wx", mode ?? 0o644);
    try {
        writeSync(fd, bytes);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    try {
        if (mode !== undefined && process.platform !== "win32") chmodSync(tmp, mode);
        renameSync(tmp, absolute);
    } catch (error) {
        try {
            unlinkSync(tmp);
        } catch {
            // best effort
        }
        throw error;
    }
};

export const removeFile = (absolute: string) => {
    if (lstatSync(absolute).isSymbolicLink()) throw new PatchError("Refusing to delete through a link.");
    unlinkSync(absolute);
};
