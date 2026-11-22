import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { statSync, readFileSync, realpathSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { currentDigest, Workspace, isSecretPath, type PlannedEdit } from "../../tomverse-cli/src/runtime.js";
import { t } from "./i18n.js";
import type { Dialogs } from "./dialogs.js";

export type Attachment = {
    id: string;
    uri: string;
    path: string;
    kind: string;
    range?: [number, number, number, number];
    version: number;
    dirty: boolean;
    bytes: number;
    truncated: boolean;
    text: string;
};
type FileStamp = { absolute: string; revision: number; versions: string; preimage: string | null };
const key = (path: string) => {
    let existing = resolve(path);
    const missing: string[] = [];
    for (;;) {
        try {
            existing = join(realpathSync.native(existing), ...missing);
            break;
        } catch {
            const parent = dirname(existing);
            if (parent === existing) break;
            missing.unshift(basename(existing));
            existing = parent;
        }
    }
    return process.platform === "win32" || process.platform === "darwin" ? existing.toLowerCase() : existing;
};

export class EditorContext {
    readonly attachments: Attachment[] = [];
    private readonly aliases = new Map<string, string>();
    private readonly revisions = new Map<string, number>();
    private readonly approved = new Map<string, FileStamp[]>();
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly workspace: () => Workspace,
        private readonly assertAllowed: () => void,
        private readonly dialogs: Dialogs,
    ) {
        const changed = (uri: vscode.Uri) => {
            if (uri.scheme !== "file") return;
            const previous = this.aliases.get(uri.toString());
            const current = this.identity(uri);
            for (const name of new Set([previous, current])) if (name) this.revisions.set(name, (this.revisions.get(name) ?? 0) + 1);
        };
        context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => changed(e.document.uri)));
        context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => changed(doc.uri)));
        context.subscriptions.push(
            vscode.workspace.onDidRenameFiles((e) =>
                e.files.forEach((f) => {
                    changed(f.oldUri);
                    changed(f.newUri);
                }),
            ),
        );
        context.subscriptions.push(vscode.workspace.onDidDeleteFiles((e) => e.files.forEach(changed)));
    }
    clear() {
        this.attachments.length = 0;
        this.approved.clear();
    }
    clearApprovals() {
        this.approved.clear();
    }
    private identity(uri: vscode.Uri) {
        const name = key(uri.fsPath);
        this.aliases.set(uri.toString(), name);
        return name;
    }
    private stamp(absolute: string): FileStamp {
        const name = key(absolute);
        const docs = vscode.workspace.textDocuments.filter((doc) => doc.uri.scheme === "file" && this.identity(doc.uri) === name);
        if (docs.some((doc) => doc.isDirty)) throw new Error(`${absolute}: unsaved changes; approval is no longer valid.`);
        return {
            absolute,
            revision: this.revisions.get(name) ?? 0,
            versions: JSON.stringify(docs.map((doc) => [doc.uri.toString(), doc.version]).sort()),
            preimage: currentDigest(absolute),
        };
    }
    capture(toolId: string, paths: string[]) {
        this.approved.set(
            toolId,
            paths.map((path) => this.stamp(path)),
        );
    }
    check(toolId: string, absolute?: string) {
        this.assertAllowed();
        const stamps = this.approved.get(toolId);
        if (!stamps) throw new Error("No editor approval snapshot. Review the action again.");
        for (const stamp of stamps.filter((s) => !absolute || key(s.absolute) === key(absolute))) this.checkStamp(stamp);
        if (absolute && !stamps.some((s) => key(s.absolute) === key(absolute))) throw new Error("File not included in the editor approval.");
    }
    private checkStamp(stamp: FileStamp) {
        const now = this.stamp(stamp.absolute);
        if (now.revision !== stamp.revision || now.versions !== stamp.versions || now.preimage !== stamp.preimage)
            throw new Error(`${stamp.absolute} changed after review. Read it and propose a new patch.`);
    }
    checkWrite(edit: PlannedEdit, toolId: string) {
        this.check(toolId, edit.absolute);
    }
    dirtyDocuments(paths?: string[]) {
        return vscode.workspace.textDocuments.filter((doc) => {
            if (!doc.isDirty || doc.uri.scheme !== "file") return false;
            try {
                this.workspace().resolve(this.identity(doc.uri), "read");
            } catch {
                return false;
            }
            return !paths || paths.some((path) => key(path) === this.identity(doc.uri));
        });
    }
    async saveDirty(paths?: string[], active: () => boolean = () => true) {
        const dirty = this.dirtyDocuments(paths);
        if (!dirty.length) return { allowed: true, saved: false };
        const response = await this.dialogs.choose(t("dirty"), { modal: true, detail: dirty.map((d) => d.uri.fsPath).join("\n") }, t("save"), t("cancel"));
        if (!active() || response !== t("save")) return { allowed: false, saved: false };
        for (const doc of dirty) {
            if (!active()) return { allowed: false, saved: false };
            this.assertAllowed();
            if (!(await doc.save()) || doc.isDirty) return { allowed: false, saved: true };
        }
        return { allowed: true, saved: true };
    }
    checkCommand(toolId: string) {
        this.check(toolId);
        if (this.dirtyDocuments().length) throw new Error("A workspace file became dirty after command approval.");
    }
    commandPaths() {
        return vscode.workspace.textDocuments
            .filter((d) => d.uri.scheme === "file")
            .flatMap((d) => {
                try {
                    return [this.workspace().resolve(this.identity(d.uri), "read").absolute];
                } catch {
                    return [];
                }
            });
    }

    async attach(kind: "file" | "selection" | "diagnostics", uri?: vscode.Uri) {
        this.assertAllowed();
        const active = vscode.window.activeTextEditor;
        const target = uri ?? active?.document.uri;
        if (!target) throw new Error("Open or select a file to attach.");
        if (this.attachments.length >= 8) throw new Error("Context limit: eight attachments. Remove one first.");
        let path: string;
        if (target.scheme === "untitled" && kind === "selection") path = "[untitled: unsaved snapshot, Ask only]";
        else {
            if (target.scheme !== "file" || target.authority) throw new Error(t("unsupported"));
            if (isSecretPath(target.fsPath)) throw new Error("Context path can contain credentials.");
            const resolved = this.workspace().resolve(this.identity(target), "read");
            const stat = statSync(resolved.absolute);
            if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Context file must be text and at most 2 MiB. Select a smaller file.");
            if (readFileSync(resolved.absolute).subarray(0, 8192).includes(0)) throw new Error("Binary context is not supported.");
            path = resolved.relative;
        }
        const doc = await vscode.workspace.openTextDocument(target);
        const range = kind === "selection" && active?.document === doc ? active.selection : undefined;
        if (kind === "selection" && (!range || range.isEmpty)) throw new Error("Select text first.");
        let text =
            kind === "diagnostics"
                ? JSON.stringify(
                      vscode.languages
                          .getDiagnostics(target)
                          .map((d) => ({ line: d.range.start.line + 1, column: d.range.start.character + 1, severity: d.severity, message: d.message })),
                      null,
                      2,
                  )
                : doc.getText(range);
        if (text.includes("\0")) throw new Error("Binary context is not supported.");
        const original = Buffer.byteLength(text);
        const remaining = Math.min(24_000, 64_000 - this.attachments.reduce((sum, a) => sum + a.bytes, 0));
        if (remaining <= 0) throw new Error("Context limit: 64 KiB per task.");
        const bytes = Buffer.from(text);
        let end = Math.min(bytes.length, remaining);
        while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
        text = bytes.subarray(0, end).toString("utf8");
        this.attachments.push({
            id: randomUUID(),
            uri: target.toString(),
            path,
            kind,
            ...(range ? { range: [range.start.line, range.start.character, range.end.line, range.end.character] as [number, number, number, number] } : {}),
            version: doc.version,
            dirty: doc.isDirty,
            bytes: Buffer.byteLength(text),
            truncated: original > remaining,
            text,
        });
    }
    snapshotPrompt(mode: "ask" | "agent") {
        this.assertAllowed();
        for (const attachment of this.attachments) {
            const uri = vscode.Uri.parse(attachment.uri);
            if (uri.scheme === "untitled") {
                if (mode !== "ask") throw new Error("Save the untitled file inside the root before using Agent.");
            } else {
                this.workspace().resolve(this.identity(uri), "read");
                const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === attachment.uri);
                if (doc && doc.version !== attachment.version) throw new Error(`${attachment.path} changed since attachment. Remove and attach it again.`);
            }
        }
        return this.attachments
            .map(({ text, ...meta }) => `\n<user-selected-context metadata=${JSON.stringify(meta)}>\n${text}\n</user-selected-context>`)
            .join("\n");
    }
}
