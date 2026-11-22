import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Dialogs } from "./dialogs.js";
import { EditorContext } from "./editorContext.js";
import { Approvals } from "./approvals.js";
import { join } from "node:path";
import { Credentials } from "./credentials.js";
import { digest, environmentProblem, namespace, parseMessage, redact, redactJson } from "./security.js";
import { labels, t } from "./i18n.js";
import { effortLevels, type Effort } from "./effort.js";
import {
    Gateway,
    GatewayError,
    Journal,
    Runner,
    Workspace,
    normalizeRoot,
    readInstructions,
    sessionCost,
    writeFileAtomic,
    DEFAULTS,
    createSession,
    listSessions,
    deleteSession,
    validateSession,
    reconcile,
    viewChanges,
    undoChange,
    type CatalogModel,
    type Output,
    type ApprovalView,
} from "../../tomverse-cli/src/runtime.js";

export class SessionController implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private channel = randomUUID();
    private epoch = randomUUID();
    private run = "";
    private busy = false;
    private operation = false;
    private revision = 0;
    private updateTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;
    private state = "idle";
    private transcript: Array<{ role: string; text: string }> = [];
    private notice = "";
    private lastError = "";
    private root?: string;
    private key?: string;
    private catalog: CatalogModel[] = [];
    private effort: Effort = "default";
    private appliedEffort: Effort | undefined;
    private effortModel = "";
    private runner?: Runner;
    private journal?: Journal;
    private gateway?: Gateway;
    private task?: Promise<void>;
    private stopped = false;
    private credentialInvalidated = false;
    private home?: string;
    readonly dialogs = new Dialogs();
    readonly editor: EditorContext;
    readonly approvals: Approvals;
    private cost?: Awaited<ReturnType<typeof sessionCost>>;
    readonly credentials: Credentials;
    readonly output = vscode.window.createOutputChannel("Tomverse");
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);

    constructor(readonly context: vscode.ExtensionContext) {
        this.credentials = new Credentials(context);
        this.editor = new EditorContext(
            context,
            () => this.workspace(),
            () => this.assertAllowed(),
            this.dialogs,
        );
        this.approvals = new Approvals(
            this.editor,
            () => this.run,
            () => this.update(),
            () => this.assertAllowed(),
            () => Boolean(this.view?.visible),
            this.dialogs,
        );
        context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("tomverse-review", this.approvals));
        context.subscriptions.push(
            context.secrets.onDidChange(() => {
                if (this.busy) {
                    this.credentialInvalidated = true;
                    this.stop();
                }
            }),
        );
        this.status.command = "tomverse.open";
        this.status.text = "Tomverse";
        this.status.show();
        context.subscriptions.push(this.output, this.status);
    }

    problem() {
        return environmentProblem({
            trusted: vscode.workspace.isTrusted,
            remote: vscode.env.remoteName,
            web: vscode.env.uiKind === vscode.UIKind.Web,
            schemes: (vscode.workspace.workspaceFolders ?? []).map((f) => (f.uri.authority ? "network" : f.uri.scheme)),
            platform: process.platform,
            arch: process.arch,
        });
    }
    private workspace() {
        if (!this.root) throw new Error(t("chooseRoot"));
        return new Workspace(this.root, [this.context.globalStorageUri.fsPath]);
    }
    assertAllowed() {
        if (this.busy && (this.stopped || this.credentialInvalidated)) throw new Error("Run cancelled or credentials changed.");
        const problem = this.problem();
        if (problem) throw new Error(t(problem));
        if (this.root && !(vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme === "file" && normalizeRoot(f.uri.fsPath) === this.root))
            throw new Error(t("chooseRoot"));
        if (this.gateway && this.credentials.endpoint().base !== this.gateway.endpoint.base) throw new Error("Endpoint changed. Start a new session.");
    }
    private idle() {
        if (this.busy) throw new Error(t("busy"));
    }
    private clean(value: string) {
        return redact(value, this.key);
    }
    private log(value: string) {
        this.output.appendLine(this.clean(value));
    }
    snapshot() {
        return {
            type: "state",
            revision: this.revision,
            channel: this.channel,
            run: this.run,
            epoch: this.epoch,
            labels: labels(),
            busy: this.busy,
            state: this.state,
            receipts: this.journal?.state.generations.map((g) => ({
                seq: g.seq,
                requestId: g.requestId,
                purpose: g.purpose,
                status: g.receipt?.status ?? "unknown",
                charged: g.receipt?.chargedCredits,
                held: g.receipt?.heldCredits,
            })),
            toolResults: this.journal?.state.tools.map((tool) => ({ tool: tool.toolName, state: tool.state, output: tool.output })).slice(-8),
            problem: this.problem(),
            root: this.root ?? "",
            connected: Boolean(this.key),
            models: this.catalog,
            transcript: this.transcript.slice(-40).map((entry) => ({ ...entry, text: entry.text.slice(-12_000), truncated: entry.text.length > 12_000 })),
            notice: [...new Set([this.notice, this.lastError].filter(Boolean))].join("\n"),
            cost: this.cost,
            session: this.journal?.state.id ?? "",
            model: this.journal?.state.model ?? null,
            effort: { level: this.appliedEffort ?? this.effort, requested: this.effort, model: this.effortModel, locked: this.effortLocked() },
            readOnly: this.journal?.state.readOnly,
            attachments: this.editor.attachments.map(({ id, uri, path, kind, range, version, dirty, bytes, truncated }) =>
                ({ id, uri, path, kind, range, version, dirty, bytes, truncated })),
            approval: this.approvals.snapshot(),
            permissions: this.approvals.memory.describe(),
            changes: this.journal ? viewChanges(this.journal).map(({ changeId, path, kind, current }) => ({ changeId, path, kind, current })) : [],
            persist: vscode.workspace.getConfiguration("tomverse").inspect<boolean>("persistSessions")?.globalValue !== false,
            storage: this.context.globalStorageUri.fsPath,
        };
    }
    update() {
        if (this.busy && !this.stopped && this.approvals.snapshot()) this.state = "awaiting";
        if (this.updateTimer || this.disposed) return;
        this.updateTimer = setTimeout(() => {
            this.updateTimer = undefined;
            if (this.disposed) return;
            this.revision += 1;
            if (this.view) void this.view.webview.postMessage(JSON.parse(redactJson(this.snapshot(), this.key)));
            this.status.text = `$(comment-discussion) Tomverse: ${labels()[this.state as keyof ReturnType<typeof labels>] ?? this.state}`;
            this.status.command = this.busy ? "tomverse.stop" : "tomverse.open";
        }, 40);
    }
    resolveWebviewView(view: vscode.WebviewView) {
        this.view = view;
        this.channel = randomUUID();
        view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
        const nonce = randomUUID().replaceAll("-", "");
        const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media/sidebar.js"));
        const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media/sidebar.css"));
        view.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource};"><link rel="stylesheet" href="${style}"></head><body data-channel="${this.channel}"><main id="app"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
        view.webview.onDidReceiveMessage(
            (message: unknown) => {
                void this.receive(message).catch((error: unknown) => this.report(error));
            },
            undefined,
            this.context.subscriptions,
        );
        view.onDidDispose(() => {
            if (this.view === view) this.view = undefined;
        });
        this.update();
    }
    report(error: unknown) {
        this.notice = this.clean(
            error instanceof GatewayError
                ? `[${error.extra.status ?? error.kind}${error.extra.code ? ` ${error.extra.code}` : ""}] ${error.message}`
                : error instanceof Error
                  ? error.message
                  : String(error),
        );
        this.log(this.notice);
        this.update();
    }

    async receive(value: unknown) {
        const message = parseMessage(value);
        if (!message || message.channel !== this.channel) return false;
        if (message.type === "ready") {
            this.update();
            return true;
        }
        // Stop only reduces authority; an old run envelope must still stop the
        // active task before the debounced state reaches the view.
        if (message.type === "action" && message.action === "stop") {
            this.stop();
            return true;
        }
        if (message.run !== this.run) return false;
        if (message.type === "send") {
            if (message.epoch !== this.epoch || this.busy || this.operation) return false;
            this.task = this.send(message.prompt, message.mode, message.model);
            await this.task;
            return true;
        }
        if (message.type === "approve") return this.approvals.answer(message.id, message.decision);
        if (message.type === "diff") return this.approvals.openDiff(message.id, message.index, message.details);
        if (message.type === "removeContext") {
            this.idle();
            const index = this.editor.attachments.findIndex((a) => a.id === message.id);
            if (index >= 0) this.editor.attachments.splice(index, 1);
            this.update();
            return index >= 0;
        }
        if (message.type === "undo") {
            await this.exclusive(() => this.undo(message.id));
            return true;
        }
        if (message.type === "chooseEffort") {
            await this.exclusive(() => this.chooseEffort(message.model));
            return true;
        }
        if (message.type === "action") {
            await this.action(message.action);
            return true;
        }
        return false;
    }
    async selectRoot() {
        this.idle();
        this.assertAllowed();
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (!folders.length) throw new Error(t("chooseRoot"));
        const folder =
            folders.length === 1
                ? folders[0]
                : await vscode.window
                      .showQuickPick(
                          folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
                          { title: t("selectRoot") },
                      )
                      .then((p) => p?.folder);
        if (!folder) return;
        this.closeSession();
        this.root = normalizeRoot(folder.uri.fsPath);
        this.update();
    }
    private closeSession() {
        this.approvals.cancel();
        this.editor.clear();
        this.home = undefined;
        this.journal?.release();
        this.journal = undefined;
        this.runner = undefined;
        this.gateway = undefined;
        this.cost = undefined;
        this.transcript = [];
        this.run = "";
        this.epoch = randomUUID();
        this.state = "idle";
        this.lastError = "";
        this.effort = "default";
        this.appliedEffort = undefined;
        this.effortModel = "";
    }
    private effortLocked() {
        return this.busy || Boolean(this.journal?.state.tasks.length && this.journal.state.status !== "completed");
    }
    private async chooseEffort(modelId: string) {
        this.idle();
        this.assertAllowed();
        if (this.effortLocked()) throw new Error(t("effortLocked"));
        const effectiveId = this.journal?.state.model.pinned ?? modelId;
        const model = this.catalog.find((model) => model.id === effectiveId);
        if (!model || (this.journal && this.journal.state.model.requested !== modelId)) throw new Error("Model not offered. Refresh models.");
        const levels = effortLevels(model);
        const epoch = this.epoch;
        const selected = await this.dialogs.pick(
            levels.map((level) => ({
                label: t(`effort_${level}`),
                description: t(level === "default" ? "effortDefault" : level === "low" ? "effortLow" : "effortHigh"),
                level,
            })),
            { title: t("effort"), placeHolder: levels.length === 1 ? t("effortUnavailable") : model.name },
        );
        if (!selected || epoch !== this.epoch || this.effortLocked()) return;
        this.effort = selected.level;
        this.appliedEffort = undefined;
        this.effortModel = modelId;
        this.update();
    }
    async refresh() {
        this.idle();
        this.key = await this.credentials.get();
        this.catalog = [];
        if (!this.key) {
            this.update();
            return;
        }
        const gateway = new Gateway(this.credentials.endpoint(), this.key, undefined, `tomverse-vscode/${this.context.extension.packageJSON.version}`);
        this.catalog = (await gateway.models()).filter((m) => m.tools && m.protocols.includes("chat_completions"));
        this.notice = "";
        this.update();
    }
    private async exclusive<T>(work: () => Promise<T>): Promise<T> {
        if (this.operation) throw new Error(t("busy"));
        this.operation = true;
        try {
            return await work();
        } finally {
            this.operation = false;
        }
    }
    async action(action: string, uri?: vscode.Uri) {
        if (action === "stop") {
            this.stop();
            return;
        }
        if (action === "logs") {
            this.output.show();
            return;
        }
        if (action === "keys") {
            await vscode.env.openExternal(vscode.Uri.parse("https://tomverse.app/settings/api"));
            return;
        }
        if (action === "clear") {
            this.approvals.clear();
            return;
        }
        return this.exclusive(() => this.idleAction(action, uri));
    }
    private async idleAction(action: string, uri?: vscode.Uri) {
        this.idle();
        if (action === "connect") {
            this.closeSession();
            if (await this.credentials.connect()) await this.refresh();
        } else if (action === "disconnect") {
            this.closeSession();
            await this.credentials.disconnect();
            this.key = undefined;
            this.catalog = [];
        } else if (action === "refresh") await this.refresh();
        else if (action === "root") await this.selectRoot();
        else if (action === "new") this.closeSession();
        else if (["file", "selection", "diagnostics"].includes(action)) await this.attach(action as "file" | "selection" | "diagnostics", uri);
        else if (action === "sessions") await this.chooseSession();
        else if (action === "delete") await this.deleteCurrent();
        else if (action === "export") await this.exportDiagnostics();
        else if (action === "recover") {
            this.task = this.recover();
            await this.task;
        }
        this.update();
    }
    private async send(prompt: string, mode: "ask" | "agent", modelId: string) {
        this.idle();
        this.assertAllowed();
        this.busy = true;
        this.stopped = false;
        this.credentialInvalidated = false;
        this.approvals.begin();
        this.state = "running";
        this.lastError = "";
        this.epoch = randomUUID();
        this.run = randomUUID();
        this.notice = "";
        this.update();
        try {
            if (!this.root) {
                const folders = vscode.workspace.workspaceFolders ?? [];
                if (folders.length !== 1 || !folders[0]) throw new Error(t("selectRoot"));
                this.root = normalizeRoot(folders[0].uri.fsPath);
            }
            const key = await this.credentials.get();
            if (!key) throw new Error(t("connectFirst"));
            this.key = key;
            const endpoint = this.credentials.endpoint();
            const gateway = new Gateway(endpoint, key, undefined, `tomverse-vscode/${this.context.extension.packageJSON.version}`);
            const catalog = (await gateway.models()).filter((m) => m.tools && m.protocols.includes("chat_completions"));
            const model = catalog.find((m) => m.id === modelId);
            if (!model) throw new Error("Model not offered. Refresh models.");
            this.catalog = catalog;
            this.gateway = gateway;
            const effort = this.effortModel === modelId ? this.effort : "default";
            const persist = vscode.workspace.getConfiguration("tomverse").inspect<boolean>("persistSessions")?.globalValue !== false;
            const home = join(this.context.globalStorageUri.fsPath, namespace(this.root, endpoint.base, key));
            if (this.journal && (this.journal.state.readOnly !== (mode === "ask") || this.journal.state.model.requested !== model.id))
                throw new Error("Choose New session to change mode or model.");
            if (
                this.journal &&
                (this.journal.unresolvedGenerations().length ||
                    this.journal.state.pendingApprovals.length ||
                    ["running", "needs_approval", "unknown_outcome", "error", "cancelled", "limit_reached"].includes(this.journal.state.status))
            )
                throw new Error("Review recovery before sending another task, or start a new session.");
            if (this.journal) validateSession(this.journal, endpoint, gateway.keyPrefix, catalog);
            if (this.journal?.state.keyIdentity && this.journal.state.keyIdentity !== digest(key))
                throw new Error("Credential identity changed. Start a new session.");
            this.home = home;
            this.assertAllowed();
            const journal =
                this.journal ??
                createSession(
                    persist ? home : null,
                    {
                        root: this.root,
                        endpoint,
                        keyPrefix: gateway.keyPrefix,
                        keyIdentity: digest(key),
                        readOnly: mode === "ask",
                        model,
                        limits: {
                            maxRequests: DEFAULTS.maxRequests,
                            timeoutMs: DEFAULTS.timeoutMinutes * 60_000,
                            commandTimeoutMs: DEFAULTS.commandTimeoutSeconds * 1000,
                        },
                    },
                    this.journalIo(key),
                );
            this.journal = journal;
            this.runner = this.createRunner(gateway, journal, catalog);
            this.runner.assertEffort(effort);
            this.effort = effort;
            this.appliedEffort = undefined;
            this.effortModel = modelId;
            const contextText = this.editor.snapshotPrompt(mode);
            this.editor.attachments.length = 0;
            this.transcript.push({ role: "user", text: this.clean(prompt) }, { role: "assistant", text: "" });
            const result = await this.runner.runTask(this.clean(prompt + contextText), effort);
            this.state = this.outcome(result);
            this.cost = await sessionCost(gateway, journal);
        } catch (error) {
            this.state = "error";
            this.report(error);
        } finally {
            if (this.stopped) this.state = this.outcome("cancelled");
            this.approvals.clear();
            this.busy = false;
            this.epoch = randomUUID();
            this.update();
        }
    }
    private outcome(result: string) {
        const journal = this.journal;
        const uncertain = journal?.state.tools.some((tool) => {
            const output = tool.output as { processTreeChecked?: boolean; residualProcesses?: number[] } | undefined;
            return tool.state === "started" || output?.processTreeChecked === false || Boolean(output?.residualProcesses?.length);
        });
        if (uncertain)
            this.notice = "A command or file operation has an unknown outcome; some processes may still be running. Review tool results before continuing.";
        return journal?.unresolvedGenerations().length || uncertain ? "unknown_outcome" : result === "success" ? "completed" : result;
    }
    private journalIo(key: string) {
        return {
            writeFileAtomic: (path: string, data: string | Buffer) => {
                if (Buffer.isBuffer(data) && data.includes(Buffer.from(key))) throw new Error("Refused to persist credential bytes.");
                writeFileAtomic(path, typeof data === "string" ? redactJson(JSON.parse(data), key) : data);
            },
        };
    }
    private createRunner(gateway: Gateway, journal: Journal, catalog: CatalogModel[]) {
        const output: Output = {
            json: false,
            info: (text) => {
                this.log(text);
                this.notice = this.clean(text);
                this.update();
            },
            stream: (text) => {
                this.state = "streaming";
                const last = this.transcript.at(-1);
                if (last?.role === "assistant") last.text = this.clean((last.text + text).slice(-250_000));
                else this.transcript.push({ role: "assistant", text: this.clean(text) });
                this.update();
            },
            event: (event) => {
                this.log(redactJson(event, this.key));
                if (event.type === "response" && ["low", "default", "high"].includes(String(event.applied_effort))) {
                    this.appliedEffort = event.applied_effort as Effort;
                }
                if (event.type === "error") this.lastError = this.clean(`${event.code ?? "error"}: ${event.message ?? ""}`);
                if (event.type === "tool_result" || event.type === "command_output") this.state = "running";
                this.update();
            },
        };
        return new Runner({
            gateway,
            journal,
            workspace: this.workspace(),
            output,
            prompter: {
                approve: (view: ApprovalView) => {
                    if (this.key && JSON.stringify(view).includes(this.key))
                        return Promise.resolve({ approved: false, reason: "Credential detected in proposal; refused." });
                    return this.approvals.approve(view);
                },
                confirm: (question) => this.approvals.confirm(this.clean(question)),
            },
            catalog,
            commandEnv: [],
            instructions: this.clean(readInstructions(this.workspace()) ?? ""),
            productName: "Tomverse for VS Code",
            assertAllowed: () => this.assertAllowed(),
            redactText: (text) => this.clean(text),
            beforeWrite: (edit, tool) => {
                if (this.key && (edit.beforeText?.includes(this.key) || edit.afterText?.includes(this.key)))
                    throw new Error("Refused credential in file contents.");
                this.editor.checkWrite(edit, tool);
            },
            beforeCommand: (plan, tool) => {
                if (this.key && JSON.stringify(plan).includes(this.key)) throw new Error("Refused credential in command.");
                this.editor.checkCommand(tool);
            },
        });
    }
    async attach(kind: "file" | "selection" | "diagnostics", uri?: vscode.Uri) {
        this.idle();
        this.assertAllowed();
        if (!this.root) await this.selectRoot();
        if (!this.root) return;
        await this.editor.attach(kind, uri);
        this.update();
        await vscode.commands.executeCommand("tomverse.sidebar.focus");
    }
    async chooseSession(id?: string) {
        this.idle();
        this.assertAllowed();
        if (!this.root) await this.selectRoot();
        if (!this.root) return;
        const key = await this.credentials.get();
        if (!key) throw new Error(t("connectFirst"));
        const endpoint = this.credentials.endpoint();
        const home = join(this.context.globalStorageUri.fsPath, namespace(this.root, endpoint.base, key));
        const sessions = listSessions(home);
        const selected = id
            ? sessions.find((s) => s.id === id)
            : await vscode.window
                  .showQuickPick(
                      sessions.map((s) => ({ label: s.id, description: `${s.status} · ${s.model}`, session: s })),
                      { title: t("sessions") },
                  )
                  .then((p) => p?.session);
        if (!selected) return;
        this.closeSession();
        const journal = Journal.open(home, selected.id, this.journalIo(key));
        try {
            this.key = key;
            const gateway = new Gateway(endpoint, key, undefined, `tomverse-vscode/${this.context.extension.packageJSON.version}`);
            const catalog = (await gateway.models()).filter((m) => m.tools && m.protocols.includes("chat_completions"));
            validateSession(journal, endpoint, gateway.keyPrefix, catalog);
            if (journal.state.keyIdentity !== digest(key)) throw new Error("Credential identity mismatch.");
            this.journal = journal;
            this.gateway = gateway;
            this.catalog = catalog;
            this.home = home;
            this.root = journal.state.workspace.root;
            this.effort = journal.state.tasks.at(-1)?.effort ?? "default";
            this.appliedEffort = journal.state.generations.at(-1)?.appliedEffort;
            this.effortModel = journal.state.model.requested;
            this.run = randomUUID();
            this.notice = reconcile(journal).join("\n");
            // Decisions not yet executed expire with their run. The model must propose again.
            const expired = new Set(
                journal.state.approvals
                    .filter((a) => a.decision === "approved" && !journal.state.tools.some((tool) => tool.toolCallId === a.toolCallId))
                    .map((a) => a.approvalId),
            );
            for (const approval of journal.state.approvals) if (expired.has(approval.approvalId)) approval.decision = "denied";
            for (const message of journal.state.messages)
                if (Array.isArray(message.content))
                    for (const part of message.content) {
                        if (part.type === "tool-approval-response" && expired.has(part.approvalId)) {
                            part.approved = false;
                            part.reason = "Previous run approval expired. Propose again for review.";
                        }
                    }
            journal.commit();
            this.transcript = journal.state.messages
                .flatMap((m) =>
                    typeof m.content === "string"
                        ? [{ role: m.role, text: this.clean(m.content) }]
                        : m.content.filter((p) => p.type === "text").map((p) => ({ role: m.role, text: this.clean(p.text) })),
                )
                .slice(-100);
            this.state =
                journal.unresolvedGenerations().length || journal.state.tools.some((tool) => tool.state === "started")
                    ? "unknown_outcome"
                    : journal.state.status;
            this.cost = await sessionCost(gateway, journal);
            this.notice += "\nSession loaded. No generation, command or patch was restarted. Review recovery to continue.";
        } catch (error) {
            journal.release();
            this.journal = undefined;
            throw error;
        }
        this.update();
    }
    private async recover() {
        this.idle();
        this.assertAllowed();
        if (!this.journal || !this.gateway) return;
        this.busy = true;
        this.stopped = false;
        this.credentialInvalidated = false;
        this.run = randomUUID();
        this.approvals.begin();
        const journal = this.journal;
        try {
            const key = await this.credentials.get();
            if (!key || digest(key) !== journal.state.keyIdentity) throw new Error("Reconnect the original key.");
            const catalog = (await this.gateway.models()).filter((m) => m.tools && m.protocols.includes("chat_completions"));
            validateSession(journal, this.gateway.endpoint, this.gateway.keyPrefix, catalog);
            this.runner = this.createRunner(this.gateway, journal, catalog);
            const unresolved = journal.unresolvedGenerations();
            for (const record of unresolved) {
                await this.runner.lookUp(record);
                this.log(this.runner.unknownReport(record));
            }
            const notes = reconcile(journal);
            this.notice = [...unresolved.map((r) => this.runner!.unknownReport(r)), ...notes].join("\n");
            this.update();
            if (
                !(await this.approvals.confirm(
                    `${this.notice}\nContinue with a new model request? It can be charged again. Pending tools are never automatically replayed.`,
                ))
            ) {
                this.state = this.outcome(journal.state.status);
                return;
            }
            journal.closeGenerations(unresolved);
            if (notes.length) journal.state.messages.push({ role: "user", content: `Previous run stopped unexpectedly. ${notes.join(" ")}` });
            journal.commit();
            if (journal.state.pendingApprovals.length) await this.runner.answerApprovals(journal.state.pendingApprovals);
            if (journal.state.tasks.length && !this.stopped) {
                const result = await this.runner.loop();
                this.state = this.outcome(result);
            }
            if (this.stopped) this.state = this.outcome("cancelled");
            this.cost = await sessionCost(this.gateway, journal);
        } catch (error) {
            this.state = journal.unresolvedGenerations().length ? "unknown_outcome" : "error";
            this.report(error);
        } finally {
            if (this.stopped) this.state = this.outcome("cancelled");
            this.approvals.clear();
            this.busy = false;
            this.epoch = randomUUID();
            this.update();
        }
    }
    private async undo(id: string) {
        this.idle();
        this.assertAllowed();
        const journal = this.journal;
        const change = journal?.state.changes.find((c) => c.changeId === id);
        if (!journal || !change) return;
        const absolute = this.workspace().resolve(change.path, "write").absolute;
        const saved = await this.editor.saveDirty([absolute]);
        if (!saved.allowed) return;
        this.editor.capture(`undo:${id}`, [absolute]);
        if ((await this.dialogs.choose(`${t("undo")}: ${change.path} (${id})`, { modal: true }, t("undo"), t("cancel"))) !== t("undo")) return;
        this.assertAllowed();
        undoChange(journal, id, () => this.editor.check(`undo:${id}`, absolute));
        this.update();
    }
    private async deleteCurrent() {
        this.idle();
        if (!this.journal || !this.home) return;
        const persisted = this.journal.dir !== null;
        const id = this.journal.state.id,
            home = this.home;
        if (
            (await this.dialogs.choose(
                `${t("delete")}: ${id}`,
                { modal: true, detail: "Deletes this local conversation, request records and Undo backups. Workspace files and server receipts are kept." },
                t("delete"),
                t("cancel"),
            )) !== t("delete")
        )
            return;
        this.idle();
        this.closeSession();
        if (persisted) deleteSession(home, id);
        this.update();
    }
    private async exportDiagnostics() {
        this.idle();
        const journal = this.journal;
        const data = {
            version: this.context.extension.packageJSON.version,
            vscode: vscode.version,
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
            status: this.state,
            session: journal?.state.id,
            model: journal?.state.model,
            cost: this.cost,
            requests: journal?.state.generations.map((g) => ({
                seq: g.seq,
                purpose: g.purpose,
                requestId: g.requestId,
                state: g.state,
                lookup: g.lookup,
                receipt: g.receipt,
            })),
            tools: journal?.state.tools.map((tool) => ({ name: tool.toolName, state: tool.state })),
            changes: journal?.state.changes.map((c) => ({ id: c.changeId, state: c.state, kind: c.kind })),
        };
        const uri = await vscode.window.showSaveDialog({
            title: t("exportDiagnostics"),
            defaultUri: vscode.Uri.file(join(this.context.globalStorageUri.fsPath, "tomverse-diagnostics.json")),
            filters: { JSON: ["json"] },
        });
        if (uri?.scheme === "file") writeFileSync(uri.fsPath, redactJson(data, this.key), { mode: 0o600 });
    }
    stop() {
        if (!this.busy) return;
        this.stopped = true;
        this.state = "cancelling";
        this.approvals.cancel();
        this.runner?.cancel();
        this.update();
    }
    async dispose() {
        this.stop();
        await this.task?.catch(() => undefined);
        this.journal?.release();
        this.disposed = true;
        if (this.updateTimer) clearTimeout(this.updateTimer);
    }
}
