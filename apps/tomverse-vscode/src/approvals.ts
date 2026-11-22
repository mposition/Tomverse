import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { ApprovalMemory, canonicalDigest, safeText, type ApprovalView, type ApprovalDecision } from "../../tomverse-cli/src/runtime.js";
import type { EditorContext } from "./editorContext.js";
import { t } from "./i18n.js";
import type { Dialogs } from "./dialogs.js";

type Pending = { id: string; run: string; binding: string; view: ApprovalView; resolve: (value: ApprovalDecision) => void };
export class Approvals implements vscode.TextDocumentContentProvider {
    private pending?: Pending;
    readonly memory = new ApprovalMemory();
    private readonly documents = new Map<string, string>();
    private stopped = false;
    private readonly cancelledChoices = new Set<() => void>();
    private readonly rememberedCommands = new Set<string>();
    constructor(
        private readonly editor: EditorContext,
        private readonly run: () => string,
        private readonly update: () => void,
        private readonly assertAllowed: () => void,
        private readonly visible: () => boolean,
        private readonly dialogs: Dialogs,
    ) {}
    provideTextDocumentContent(uri: vscode.Uri) {
        return this.documents.get(uri.toString()) ?? "Review expired.";
    }
    begin() {
        this.cancel();
        this.stopped = false;
        this.memory.clear();
        this.rememberedCommands.clear();
        this.editor.clearApprovals();
    }
    clear() {
        this.memory.clear();
        this.rememberedCommands.clear();
        this.update();
    }
    cancel() {
        this.stopped = true;
        for (const cancel of this.cancelledChoices) cancel();
        this.cancelledChoices.clear();
        const pending = this.pending;
        this.pending = undefined;
        pending?.resolve({ approved: false, reason: "The user stopped this run." });
        this.memory.clear();
        this.rememberedCommands.clear();
        this.update();
    }
    snapshot() {
        const p = this.pending;
        if (!p) return null;
        return {
            id: p.id,
            run: p.run,
            tool: p.view.toolName,
            canRemember: this.memory.canRemember(p.view),
            explanation: p.view.explanation ?? "",
            command: p.view.command ?? null,
            files:
                p.view.patch?.map((e) => ({
                    path: e.path,
                    action: e.action,
                    eol: e.eol,
                    bom: e.bom,
                    beforeBytes: Buffer.byteLength(e.beforeText ?? ""),
                    afterBytes: e.afterBytes?.length ?? 0,
                })) ?? [],
        };
    }
    private binding(view: ApprovalView) {
        return canonicalDigest({
            run: this.run(),
            root: view.root,
            tool: view.toolName,
            toolCallId: view.toolCallId,
            input: view.input,
            files: view.patch?.map((p) => ({ path: p.path, preimage: p.preimage, postimage: p.postimage })),
            command: view.command,
        });
    }
    private async whileActive<T>(promise: PromiseLike<T>, fallback: T): Promise<T> {
        if (this.stopped) return fallback;
        let cancel!: () => void;
        const stopped = new Promise<T>((resolve) => {
            cancel = () => resolve(fallback);
            this.cancelledChoices.add(cancel);
        });
        try {
            return await Promise.race([promise, stopped]);
        } finally {
            this.cancelledChoices.delete(cancel);
        }
    }
    async approve(view: ApprovalView): Promise<ApprovalDecision> {
        this.assertAllowed();
        if (this.stopped) return { approved: false };
        const run = this.run();
        const saved = await this.whileActive(
            this.editor.saveDirty(
                view.patch?.map((p) => p.absolute),
                () => !this.stopped && this.run() === run,
            ),
            { allowed: false, saved: false },
        );
        if (!saved.allowed || this.stopped) return { approved: false, reason: "Unsaved files were not saved. The action was cancelled." };
        if (saved.saved && view.patch)
            return { approved: false, reason: "Files were saved (possibly formatted). Read the new contents and propose a new patch for review." };
        this.assertAllowed();
        this.editor.capture(view.toolCallId, view.patch?.map((p) => p.absolute) ?? this.editor.commandPaths());
        const remembered = this.memory.match(view);
        if (remembered && (remembered !== "same_command" || this.rememberedCommands.has(canonicalDigest(view.command)))) return { approved: true, remembered };
        const response = new Promise<ApprovalDecision>((resolve) => {
            this.pending = { id: randomUUID(), run: this.run(), binding: this.binding(view), view, resolve };
        });
        this.update();
        if (!this.visible())
            void vscode.window.showInformationMessage(t("awaiting"), t("open")).then((answer) => {
                if (answer === t("open")) void vscode.commands.executeCommand("tomverse.sidebar.focus");
            });
        return response;
    }
    answer(id: string, decision: "once" | "run" | "deny") {
        const p = this.pending;
        if (!p || p.id !== id || p.run !== this.run() || this.stopped || this.binding(p.view) !== p.binding) return false;
        if (decision === "run" && !this.memory.canRemember(p.view)) return false;
        if (decision !== "deny") {
            try {
                this.assertAllowed();
                this.editor.check(p.view.toolCallId);
            } catch (error) {
                this.pending = undefined;
                p.resolve({ approved: false, reason: (error as Error).message });
                this.update();
                return false;
            }
        }
        this.pending = undefined;
        const remember = decision === "run" ? this.memory.remember(p.view) : null;
        if (remember === "same_command") this.rememberedCommands.add(canonicalDigest(p.view.command));
        p.resolve({ approved: decision !== "deny", ...(remember ? { remember } : {}) });
        this.update();
        return true;
    }
    async openDiff(id: string, index: number, details: boolean) {
        const p = this.pending;
        const edit = p?.view.patch?.[index];
        if (!p || p.id !== id || p.run !== this.run() || !edit) return false;
        this.assertAllowed();
        const before = vscode.Uri.from({ scheme: "tomverse-review", path: `/${p.id}/${index}/before/${encodeURIComponent(edit.path)}` });
        const after = vscode.Uri.from({ scheme: "tomverse-review", path: `/${p.id}/${index}/after/${encodeURIComponent(edit.path)}` });
        const visible = (text: string | null) =>
            safeText(text ?? "[absent]")
                .replace(/\t/g, "\\t")
                .replace(/\n/g, "\\n\n");
        if (details) {
            const uri = vscode.Uri.from({ scheme: "tomverse-review", path: `/${p.id}/${index}/characters.txt` });
            this.documents.set(
                uri.toString(),
                `Path: ${safeText(edit.path)}\nAction: ${edit.action}\nEOL: ${edit.eol}; BOM: ${edit.bom}\nPreimage: ${edit.preimage}\nPostimage: ${edit.postimage}\n\nBEFORE (all characters; controls escaped)\n${visible(edit.beforeText)}\n\nAFTER\n${visible(edit.afterText)}`,
            );
            await vscode.window.showTextDocument(uri, { preview: true });
        } else {
            this.documents.set(before.toString(), edit.beforeText ?? "");
            this.documents.set(after.toString(), edit.afterText ?? "");
            await vscode.commands.executeCommand("vscode.diff", before, after, `${edit.path} — Tomverse (${edit.action})`, { preview: true });
        }
        return true;
    }
    async confirm(question: string) {
        if (this.stopped) return false;
        const run = this.run();
        const answer = await this.whileActive(this.dialogs.choose(question, { modal: true }, t("confirm"), t("cancel")), undefined);
        if (this.stopped || run !== this.run()) return false;
        this.assertAllowed();
        return !this.stopped && run === this.run() && answer === t("confirm");
    }
}
