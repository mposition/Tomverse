import * as vscode from "vscode";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { FakeGateway, TEST_KEY, DEFAULT_MODELS, lastUserText, toolResultsSinceUser, type ScriptedReply } from "../../../tomverse-cli/tests/fakeGateway.js";
import { Journal } from "../../../tomverse-cli/src/runtime.js";
import { t } from "../../src/i18n.js";
import { digest, namespace } from "../../src/security.js";
import type { SessionController } from "../../src/sessionController.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (condition: () => boolean, name: string, timeout = 15000) => {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeout) throw new Error(`Timeout: ${name}`);
        await sleep(20);
    }
};
export async function run() {
    const evidence: Array<{ name: string; status: string; detail?: unknown }> = [];
    const artifacts = process.env.TOMVERSE_TEST_ARTIFACTS!;
    const restricted = process.env.TOMVERSE_TEST_PROFILE === "restricted";
    const record = (name: string, detail?: unknown) => {
        evidence.push({ name, status: "PASS", detail });
        console.log(`PASS ${name}`);
    };
    const extension = vscode.extensions.getExtension("tomverse.tomverse-vscode")!;
    assert.ok(extension);
    const { controller, context } = (await extension.activate()) as { controller: SessionController; context: vscode.ExtensionContext };
    let replies: ScriptedReply[] = [];
    const fake = await new FakeGateway({ script: () => replies.shift() ?? { text: "Done." }, routedModel: "fake-coder" }).start();
    const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const envelope = () => {
        const state = controller.snapshot();
        return { channel: state.channel, run: state.run };
    };
    const send = (prompt = "test", mode: "ask" | "agent" = "agent", model = "fake-coder") =>
        controller.receive({ ...envelope(), type: "send", epoch: controller.snapshot().epoch, prompt, mode, model });
    const action = (action: string) => controller.receive({ ...envelope(), type: "action", action });
    const approval = async () => {
        await until(() => Boolean(controller.snapshot().approval), "approval");
        return controller.snapshot().approval!;
    };
    const approve = (id: string, decision = "once") => controller.receive({ ...envelope(), type: "approve", id, decision });
    const fresh = async () => {
        await action("new");
    };
    try {
        assert.equal(vscode.workspace.isTrusted, !restricted, "actual Workspace Trust state");
        if (restricted) {
            assert.equal(controller.problem(), "restricted");
            await assert.rejects(controller.attach("file", vscode.Uri.file(join(root, "sum.js"))), /Restricted Mode/);
            await assert.rejects(send("no generation", "ask"), /Restricted Mode/);
            assert.equal(fake.completions.length, 0);
            assert.equal(controller.editor.attachments.length, 0);
            record("restricted actual host blocks context and generation; setup remains active");
            return;
        }
        await vscode.workspace.getConfiguration("tomverse").update("endpoint", fake.base, vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration("tomverse").update("allowInsecureLocalhost", true, vscode.ConfigurationTarget.Global);
        await context.secrets.store(`key:${digest(fake.base)}`, TEST_KEY);
        await controller.refresh();
        assert.equal(fake.completions.length, 0);
        record("SecretStorage connection refresh only fetches models");
        writeFileSync(join(root, "한글 file.txt"), "selected context\n" + "large ".repeat(6000));
        await controller.action("file", vscode.Uri.file(join(root, "한글 file.txt")));
        assert.equal(controller.snapshot().attachments.length, 1);
        assert.equal(controller.snapshot().attachments[0]!.truncated, true);
        assert.equal(controller.snapshot().attachments[0]!.path, "한글 file.txt");
        const attachment = controller.snapshot().attachments[0]!;
        await controller.receive({ ...envelope(), type: "removeContext", id: attachment.id });
        assert.equal(controller.snapshot().attachments.length, 0);
        writeFileSync(join(root, ".env"), "fixture only");
        writeFileSync(join(root, "binary.dat"), Buffer.from([1, 0, 2]));
        await assert.rejects(controller.action("file", vscode.Uri.file(join(root, ".env"))), /credentials/);
        await assert.rejects(controller.action("file", vscode.Uri.file(join(root, "binary.dat"))), /Binary/);
        const contextDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, "한글 file.txt")));
        const contextEditor = await vscode.window.showTextDocument(contextDoc);
        contextEditor.selection = new vscode.Selection(0, 0, 0, 8);
        await controller.action("selection");
        assert.deepEqual(controller.snapshot().attachments[0]!.range, [0, 0, 0, 8]);
        const collection = vscode.languages.createDiagnosticCollection("tomverse-fixture");
        collection.set(contextDoc.uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 8), "fixture diagnostic", vscode.DiagnosticSeverity.Warning)]);
        await controller.action("diagnostics");
        assert.equal(controller.snapshot().attachments.length, 2);
        collection.dispose();
        record("explicit file/selection/diagnostics context, Korean path, truncation/removal and credential/binary exclusion");

        await vscode.commands.executeCommand("tomverse.sidebar.focus");
        await sleep(750);
        replies = [{ text: "Tomverse sidebar Ask stream — local fake gateway. No paid request was sent." }];
        const oldEnvelope = envelope();
        const oldEpoch = controller.snapshot().epoch;
        const ask = send("Say hello from this local fixture.", "ask");
        assert.equal(await controller.receive({ ...oldEnvelope, type: "send", epoch: oldEpoch, prompt: "duplicate", mode: "ask", model: "fake-coder" }), false);
        await ask;
        assert.equal(controller.snapshot().state, "completed");
        assert.match(controller.snapshot().transcript.at(-1)!.text, /Tomverse sidebar Ask stream/);
        assert.equal(fake.completions.length, 1);
        assert.match(JSON.stringify(fake.completions[0]!.body), /fixture diagnostic/);
        assert.equal(controller.snapshot().cost?.charged, 3);
        assert.equal(fake.completions[0]!.headers["user-agent"], "tomverse-vscode/0.1.0");
        assert.equal(JSON.stringify(fake.completions[0]!.body.tools).includes("apply_patch"), false);
        assert.equal(JSON.stringify(controller.snapshot()).includes(TEST_KEY), false);
        record("sidebar Ask stream, read-only tools, duplicate send refusal, own receipt", controller.snapshot().cost);
        if (process.env.TOMVERSE_TEST_DEMO === "1") await sleep(45_000);
        await fresh();
        const patch = { name: "apply_patch", args: { edits: [{ path: "sum.js", action: "update", replacements: [{ old: "a - b", new: "a + b" }] }] } };
        replies = [{ toolCalls: [patch] }, { text: "Patch done." }];
        const run = send();
        const p = await approval();
        const beforeHydration = fake.completions.length;
        assert.equal(await controller.receive({ channel: controller.snapshot().channel, run: "", type: "ready" }), true);
        await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
        await vscode.commands.executeCommand("tomverse.sidebar.focus");
        assert.equal(controller.snapshot().approval?.id, p.id);
        assert.equal(fake.completions.length, beforeHydration);
        record("sidebar hide/show and ready rehydration preserve one pending approval without inference");
        assert.equal(readFileSync(join(root, "sum.js"), "utf8").includes("a - b"), true);
        assert.equal(await approve("forged-id"), false);
        assert.equal(await controller.receive({ ...envelope(), type: "approve", id: p.id, decision: "once", input: { command: "malicious" } }), false);
        assert.equal(await controller.receive({ ...envelope(), type: "diff", id: p.id, index: 0, details: false }), true);
        assert.equal(await controller.receive({ ...envelope(), type: "diff", id: p.id, index: 0, details: true }), true);
        assert.ok(vscode.workspace.textDocuments.some((doc) => doc.uri.scheme === "tomverse-review"));
        assert.equal(await approve(p.id), true);
        assert.equal(await approve(p.id), false);
        await run;
        assert.match(readFileSync(join(root, "sum.js"), "utf8"), /a \+ b/);
        record("native full diff and character document; exact approve writes disk once; forged/replayed denied");
        const session = controller.snapshot().session;
        const sessionHome = join(context.globalStorageUri.fsPath, namespace(controller.snapshot().root, fake.base, TEST_KEY));
        assert.throws(() => Journal.open(sessionHome, session), /open in another/);
        record("session lock rejects a second owner");
        const beforeResume = fake.completions.length;
        await controller.chooseSession(session);
        assert.equal(fake.completions.length, beforeResume);
        assert.equal(controller.snapshot().permissions.length, 0);
        record("session reopening restores history without inference or remembered permission");
        // After a review snapshot, a real dirty TextDocument invalidates that approval.
        await fresh();
        writeFileSync(join(root, "conflict.txt"), "before\n");
        const conflictDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, "conflict.txt")));
        replies = [
            {
                toolCalls: [
                    { name: "apply_patch", args: { edits: [{ path: "conflict.txt", action: "update", replacements: [{ old: "before", new: "after" }] }] } },
                ],
            },
            { text: "Conflict preserved." },
        ];
        const conflicting = send();
        const cp = await approval();
        const edit = new vscode.WorkspaceEdit();
        edit.insert(conflictDoc.uri, new vscode.Position(0, 0), "user ");
        await vscode.workspace.applyEdit(edit);
        assert.equal(conflictDoc.isDirty, true);
        assert.equal(await approve(cp.id), false);
        await conflicting;
        assert.equal(conflictDoc.getText(), "user before\n");
        assert.equal(readFileSync(join(root, "conflict.txt"), "utf8"), "before\n");
        await conflictDoc.save();
        record("typing after diff invalidates approval and preserves dirty buffer");
        await fresh();
        writeFileSync(join(root, "rename.txt"), "before");
        replies = [
            {
                toolCalls: [
                    { name: "apply_patch", args: { edits: [{ path: "rename.txt", action: "update", replacements: [{ old: "before", new: "after" }] }] } },
                ],
            },
            { text: "rename conflict" },
        ];
        const renameRun = send();
        const renameApproval = await approval();
        const rename = new vscode.WorkspaceEdit();
        rename.renameFile(vscode.Uri.file(join(root, "rename.txt")), vscode.Uri.file(join(root, "renamed.txt")));
        await vscode.workspace.applyEdit(rename);
        assert.equal(await approve(renameApproval.id), false);
        await renameRun;
        assert.equal(readFileSync(join(root, "renamed.txt"), "utf8"), "before");
        record("native workspace rename after review invalidates patch");
        await fresh();
        mkdirSync(join(root, "real-parent"));
        symlinkSync(join(root, "real-parent"), join(root, "alias-parent"), process.platform === "win32" ? "junction" : "dir");
        writeFileSync(join(root, "real-parent/linked.txt"), "before");
        const aliasDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, "alias-parent/linked.txt")));
        const aliasEdit = new vscode.WorkspaceEdit();
        aliasEdit.insert(aliasDoc.uri, new vscode.Position(0, 0), "user ");
        await vscode.workspace.applyEdit(aliasEdit);
        const originalChoose = controller.dialogs.choose.bind(controller.dialogs);
        let dirtyChoices = 0;
        controller.dialogs.choose = async () => {
            dirtyChoices++;
            return t("cancel");
        };
        replies = [
            {
                toolCalls: [
                    {
                        name: "apply_patch",
                        args: { edits: [{ path: "real-parent/linked.txt", action: "update", replacements: [{ old: "before", new: "after" }] }] },
                    },
                ],
            },
            { text: "preserved" },
        ];
        await send();
        assert.equal(dirtyChoices, 1);
        assert.equal(aliasDoc.getText(), "user before");
        assert.equal(readFileSync(join(root, "real-parent/linked.txt"), "utf8"), "before");
        controller.dialogs.choose = originalChoose;
        await aliasDoc.save();
        record("actual junction alias dirty buffer is detected for a canonical model path");
        await fresh();
        replies = [{ text: 'Bearer "quoted" and backslash \\"quoted\\"' }];
        await send('Explain Bearer "quoted" syntax', "ask");
        const quotedSession = controller.snapshot().session;
        assert.ok(Journal.read(join(sessionHome, "sessions", quotedSession)).messages.length);
        await controller.chooseSession(quotedSession);
        assert.ok(controller.snapshot().transcript.length);
        record("quoted Bearer model text survives checkpoint serialization and session reopening");
        await fresh();
        const originalCheck = controller.editor.checkWrite.bind(controller.editor);
        let collided = false;
        controller.editor.checkWrite = (edit, tool) => {
            if (edit.path === "partial-b.txt" && !collided) {
                collided = true;
                writeFileSync(edit.absolute, "user content");
            }
            originalCheck(edit, tool);
        };
        replies = [
            {
                toolCalls: [
                    {
                        name: "apply_patch",
                        args: {
                            edits: [
                                { path: "partial-a.txt", action: "create", content: "generated" },
                                { path: "partial-b.txt", action: "create", content: "generated" },
                                { path: "partial-c.txt", action: "create", content: "not attempted" },
                            ],
                        },
                    },
                ],
            },
            { text: "partial result" },
        ];
        const partialRun = send();
        const partialApproval = await approval();
        assert.equal(partialApproval.files.length, 3);
        await approve(partialApproval.id);
        await partialRun;
        controller.editor.checkWrite = originalCheck;
        const partialResult = controller.snapshot().toolResults?.[0]?.output as { status: string; files: Array<{ status: string }> };
        assert.equal(partialResult.status, "partial");
        assert.deepEqual(
            partialResult.files.map((f) => f.status),
            ["applied", "failed", "not_attempted"],
        );
        assert.equal(readFileSync(join(root, "partial-b.txt"), "utf8"), "user content");
        assert.equal(existsSync(join(root, "partial-c.txt")), false);
        record("actual writer reports partial per-file results and preserves concurrent contents (fault injected at second file guard)");
        await fresh();
        replies = [
            { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "denied.txt", action: "create", content: "must not exist" }] } }] },
            { text: "Denied." },
        ];
        const denied = send();
        const dp = await approval();
        await approve(dp.id, "deny");
        await denied;
        assert.equal(existsSync(join(root, "denied.txt")), false);
        record("denied patch never writes");
        await fresh();
        replies = [{ toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "stopped.txt", action: "create", content: "must not exist" }] } }] }];
        const stopped = send();
        const sp = await approval();
        controller.stop();
        assert.equal(await approve(sp.id), false);
        await stopped;
        assert.equal(existsSync(join(root, "stopped.txt")), false);
        record("Stop during approval invalidates late approval");
        // A command is approved through the same host message boundary and the actual OS runner.
        await fresh();
        const command =
            process.platform === "win32"
                ? { command: "Write-Output 'command-output'; if ($env:TOMVERSE_API_KEY) { exit 9 }; exit 7" }
                : { argv: ["/bin/sh", "-c", 'echo command-output; test -z "$TOMVERSE_API_KEY" || exit 9; exit 7'] };
        replies = [{ toolCalls: [{ name: "run_command", args: command }] }, { text: "Command failed with exit 7." }];
        const commandRun = send();
        const commandApproval = await approval();
        assert.ok(commandApproval.command?.envNames);
        await approve(commandApproval.id);
        await commandRun;
        const commandState = Journal.read(join(sessionHome, "sessions", controller.snapshot().session));
        const commandResult = commandState.tools.at(-1)?.output as { exitCode: number; stdout: string };
        assert.equal(commandResult.exitCode, 7);
        assert.match(commandResult.stdout, /command-output/);
        record("approved actual command output and nonzero exit; no key in child environment", commandResult);
        await fresh();
        const exactCommand = process.platform === "win32" ? { command: "Write-Output 'exact command'" } : { argv: ["/bin/echo", "exact command"] };
        replies = [
            { toolCalls: [{ name: "run_command", args: exactCommand }] },
            { toolCalls: [{ name: "run_command", args: exactCommand }] },
            { toolCalls: [{ name: "run_command", args: { ...exactCommand, timeoutSeconds: 5 } }] },
            { toolCalls: [{ name: "run_command", args: exactCommand }] },
            { text: "done" },
        ];
        const exactRun = send();
        const exactApproval = await approval();
        await approve(exactApproval.id, "run");
        await until(() => Boolean(controller.snapshot().approval && controller.snapshot().approval!.id !== exactApproval.id), "changed timeout asks again");
        assert.equal(controller.snapshot().toolResults?.length, 2);
        assert.equal(controller.snapshot().approval!.command?.timeoutMs, 5000);
        const changedCommandId = controller.snapshot().approval!.id;
        await action("clear");
        await approve(changedCommandId, "deny");
        await until(
            () => Boolean(controller.snapshot().approval && controller.snapshot().approval!.id !== changedCommandId),
            "cleared exact command asks again",
        );
        await approve(controller.snapshot().approval!.id, "deny");
        await exactRun;
        record("exact command remembered only within run; timeout change and explicit clear ask again");
        await fresh();
        replies = [
            { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "run-a.txt", action: "create", content: "a" }] } }] },
            { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "run-b.txt", action: "create", content: "b" }] } }] },
            { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "run-a.txt", action: "delete" }] } }] },
            { text: "Deletion declined." },
        ];
        const remembered = send();
        const rp = await approval();
        await approve(rp.id, "run");
        await until(() => controller.snapshot().approval?.id !== rp.id && Boolean(controller.snapshot().approval), "delete still asks");
        const deletion = controller.snapshot().approval!;
        assert.equal(deletion.canRemember, false);
        assert.equal(existsSync(join(root, "run-b.txt")), true);
        assert.equal(await approve(deletion.id, "run"), false);
        await approve(deletion.id, "deny");
        await remembered;
        assert.equal(controller.snapshot().permissions.length, 0);
        record("current-run file permission skips only creates/updates; delete always asks; permission expires");
        replies = [
            { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "new-task.txt", action: "create", content: "new" }] } }] },
            { text: "next task" },
        ];
        const nextTask = send();
        const nextP = await approval();
        await approve(nextP.id, "deny");
        await nextTask;
        record("new task in same session asks again");
        // Real editor Save events and buffers, with the native choice scripted by the test adapter.
        await fresh();
        writeFileSync(join(root, "dirty-save.txt"), "before\n");
        const dirtyDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, "dirty-save.txt")));
        const dirtyEdit = new vscode.WorkspaceEdit();
        dirtyEdit.insert(dirtyDoc.uri, new vscode.Position(0, 0), "unsaved ");
        await vscode.workspace.applyEdit(dirtyEdit);
        const nativeChoose = controller.dialogs.choose.bind(controller.dialogs);
        controller.dialogs.choose = async () => t("cancel");
        replies = [
            {
                toolCalls: [
                    { name: "apply_patch", args: { edits: [{ path: "dirty-save.txt", action: "update", replacements: [{ old: "before", new: "after" }] }] } },
                ],
            },
            { text: "cancelled" },
        ];
        await send();
        assert.equal(dirtyDoc.isDirty, true);
        assert.equal(readFileSync(join(root, "dirty-save.txt"), "utf8"), "before\n");
        await fresh();
        controller.dialogs.choose = async () => t("save");
        const formatter = vscode.workspace.onWillSaveTextDocument((event) => {
            if (event.document === dirtyDoc) event.waitUntil(Promise.resolve([vscode.TextEdit.replace(new vscode.Range(0, 0, 1, 0), "formatted before\n")]));
        });
        replies = [
            {
                toolCalls: [
                    { name: "apply_patch", args: { edits: [{ path: "dirty-save.txt", action: "update", replacements: [{ old: "before", new: "after" }] }] } },
                ],
            },
            { text: "replan" },
        ];
        await send();
        formatter.dispose();
        controller.dialogs.choose = nativeChoose;
        assert.equal(dirtyDoc.isDirty, false);
        assert.equal(readFileSync(join(root, "dirty-save.txt"), "utf8"), "formatted before\n");
        record("dirty Save/Cancel and actual save formatter preserve buffer; old patch is rejected (scripted dialog choices)");
        await fresh();
        replies = [
            { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "undo.txt", action: "create", content: "generated" }] } }] },
            { text: "created" },
        ];
        const undoRun = send();
        await approve((await approval()).id);
        await undoRun;
        const change = controller.snapshot().changes[0]!;
        controller.dialogs.choose = async () => t("undo");
        writeFileSync(join(root, "undo.txt"), "user changed");
        await assert.rejects(controller.receive({ ...envelope(), type: "undo", id: change.changeId }), /not what the CLI left/);
        assert.equal(readFileSync(join(root, "undo.txt"), "utf8"), "user changed");
        writeFileSync(join(root, "undo.txt"), "generated");
        await controller.receive({ ...envelope(), type: "undo", id: change.changeId });
        assert.equal(existsSync(join(root, "undo.txt")), false);
        controller.dialogs.choose = nativeChoose;
        record("Undo preserves later user changes, then restores only matching postimage (scripted confirmation)");
        // Process-tree cancellation uses the shared OS runner, never a mocked child process.
        await fresh();
        const slow =
            process.platform === "win32"
                ? {
                      command:
                          "$p=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Write-Output ('child:'+$p.Id); Start-Sleep -Seconds 60",
                  }
                : { argv: ["/bin/sh", "-c", "sleep 60 & echo child:$!; wait"] };
        replies = [{ toolCalls: [{ name: "run_command", args: slow }] }];
        const slowRun = send();
        await approve((await approval()).id);
        await until(() => /child:\d+/.test(controller.snapshot().notice), "child process starts", 30000);
        const pid = Number(controller.snapshot().notice.match(/child:(\d+)/)![1]);
        let stopTicks = 0;
        const heartbeat = setInterval(() => stopTicks++, 10);
        controller.stop();
        assert.equal(controller.snapshot().busy, true);
        await slowRun;
        clearInterval(heartbeat);
        assert.ok(stopTicks > 2, "host remains responsive during process-tree verification");
        assert.equal(controller.snapshot().toolResults?.[0]?.state, "completed", "run waits for command cleanup journal");
        await until(
            () => {
                try {
                    process.kill(pid, 0);
                    return false;
                } catch {
                    return true;
                }
            },
            "child process terminated",
            10000,
        );
        record("Stop terminates an actual command child process tree", { pid, status: controller.snapshot().state, tools: controller.snapshot().toolResults });
        await fresh();
        replies = [{ fault: "hang" }];
        const hangCount = fake.completions.length;
        const staleStop = envelope();
        const hang = send("hang", "ask");
        await until(() => fake.completions.length === hangCount + 1, "stream started");
        await sleep(150);
        assert.equal(await controller.receive({ ...staleStop, type: "action", action: "stop" }), true);
        await hang;
        assert.equal(controller.snapshot().state, "unknown_outcome");
        record("cancelled stream records unknown and never auto retries", controller.snapshot().cost);
        await fresh();
        replies = [{ fault: "drop_unrecorded" }];
        const originalConfirm = controller.approvals.confirm.bind(controller.approvals);
        controller.approvals.confirm = async () => false;
        const count = fake.completions.length;
        await send("unknown", "ask");
        controller.approvals.confirm = originalConfirm;
        assert.equal(fake.completions.length, count + 1);
        assert.equal(controller.snapshot().state, "unknown_outcome");
        assert.ok(controller.snapshot().cost!.unknown.length);
        record("lost unrecorded request remains unknown; no automatic retry");
        await fresh();
        replies = [{ text: "Adaptive response." }];
        await send("pin", "ask", "smart-adaptive");
        assert.equal(controller.snapshot().model?.pinned, "fake-coder");
        record("Smart Adaptive routed model pinned in journal");
        const savedSession = controller.snapshot().session;
        await fresh();
        fake.options.models = DEFAULT_MODELS.filter((m) => m.id !== "fake-coder");
        const beforeMissingModel = fake.completions.length;
        await assert.rejects(controller.chooseSession(savedSession), /no longer offered/);
        assert.equal(fake.completions.length, beforeMissingModel);
        fake.options.models = undefined;
        record("removed pinned model refuses resume without substitution or inference");
        await fresh();
        await vscode.workspace.getConfiguration("tomverse").update("persistSessions", false, vscode.ConfigurationTarget.Global);
        replies = [{ text: "memory only" }];
        await send("memory", "ask");
        assert.equal(existsSync(join(sessionHome, "sessions", controller.snapshot().session)), false);
        await vscode.workspace.getConfiguration("tomverse").update("persistSessions", true, vscode.ConfigurationTarget.Global);
        record("no-persist creates no session directory");
        controller.dialogs.choose = async () => t("delete");
        await action("delete");
        assert.equal(controller.snapshot().session, "");
        controller.dialogs.choose = nativeChoose;
        record("deleting a memory-only session clears it without a missing-directory error");
        await fresh();
        await controller.chooseSession(savedSession);
        const loadedCount = fake.completions.length;
        controller.dialogs.choose = async () => t("cancel");
        await action("recover");
        assert.equal(fake.completions.length, loadedCount);
        controller.dialogs.choose = nativeChoose;
        record("recovery cancellation sends no new model request");
        const sessionToDelete = controller.snapshot().session;
        controller.dialogs.choose = async () => t("cancel");
        await action("delete");
        assert.ok(existsSync(join(sessionHome, "sessions", sessionToDelete)));
        controller.dialogs.choose = async () => t("delete");
        await action("delete");
        assert.equal(existsSync(join(sessionHome, "sessions", sessionToDelete)), false);
        assert.ok(existsSync(join(root, "sum.js")));
        controller.dialogs.choose = nativeChoose;
        record("local session deletion requires confirmation and preserves workspace (scripted dialog choices)");
        await fresh();
        fake.revoked = true;
        const beforeRevoked = fake.completions.length;
        await controller.refresh().catch((error) => controller.report(error));
        assert.equal(controller.snapshot().models.length, 0);
        assert.match(controller.snapshot().notice, /401 invalid_api_key/);
        assert.equal(fake.completions.length, beforeRevoked);
        fake.revoked = false;
        await controller.refresh();
        for (const [status, code] of [
            [403, "api_key_not_eligible"],
            [429, "key_cap_exceeded"],
            [402, "insufficient_credits"],
            [503, "feature_unavailable"],
            [404, "not_found"],
        ] as const) {
            await fresh();
            replies = [{ fault: "http", status, code, message: code }];
            const before = fake.completions.length;
            controller.approvals.confirm = async () => false;
            await send("account fault", "ask");
            controller.approvals.confirm = originalConfirm;
            assert.equal(fake.completions.length, before + 1);
            assert.notEqual(controller.snapshot().state, "completed");
            assert.match(controller.snapshot().notice, new RegExp(code));
        }
        record("revoked key disables catalog; eligibility, cap, credits, feature and undeployed API errors remain distinct without fallback/retry");
        assert.ok(fake.requests.every((r) => r.url.startsWith("/api/code/v1/")));
        record("all metadata, inference and receipts stay on coding API");
        await fresh();
        const originalScript = fake.options.script;
        writeFileSync(join(root, "compact.txt"), "가나다 const value = 1; ".repeat(200));
        fake.options.script = (body) =>
            /Summarize this session so far/.test(lastUserText(body))
                ? { text: "SUMMARY: read compact.txt." }
                : toolResultsSinceUser(body).length < 3
                  ? { toolCalls: [{ name: "read_file", args: { path: "compact.txt" } }] }
                  : { text: "done" };
        fake.options.models = DEFAULT_MODELS.map((m) =>
            m.id === "fake-small" ? { ...m, tomverse: { ...m.tomverse, context_window_tokens: 9000, reasoning_efforts: ["high"] } } : m,
        );
        await controller.refresh();
        const originalPick = controller.dialogs.pick.bind(controller.dialogs);
        controller.dialogs.pick = async (items) => items.find((item) => item.label === t("effort_high"));
        await controller.receive({ ...envelope(), type: "chooseEffort", model: "fake-small" });
        controller.dialogs.pick = originalPick;
        const beforeCompact = fake.completions.length;
        await send("Read compact.txt a few times", "ask", "fake-small");
        const compactState = Journal.read(join(sessionHome, "sessions", controller.snapshot().session));
        assert.ok(compactState.generations.some((g) => g.purpose === "compact"));
        assert.equal(compactState.tasks[0]!.requests, compactState.generations.length);
        assert.equal(controller.snapshot().cost?.requests, compactState.generations.length);
        assert.equal(controller.snapshot().cost?.charged, compactState.generations.length);
        assert.equal(controller.snapshot().state, "completed");
        assert.ok(fake.completions.slice(beforeCompact).every((request) => request.body.tomverse_effort === "high"));
        fake.options.script = originalScript;
        fake.options.models = undefined;
        record("compaction in actual extension preserves effort and counts requests and receipts at pinned model", controller.snapshot().cost);
        await fresh();
        const nativePick = controller.dialogs.pick.bind(controller.dialogs);
        const chooseEffort = (model = "fake-coder") => controller.receive({ ...envelope(), type: "chooseEffort", model });
        controller.dialogs.pick = async (items) => {
            assert.deepEqual(
                items.map((item) => item.label),
                [t("effort_default")],
            );
            return undefined;
        };
        await chooseEffort();
        assert.equal(controller.snapshot().effort.level, "default");
        fake.options.models = DEFAULT_MODELS.map((model) => ({ ...model, tomverse: { ...model.tomverse, reasoning_efforts: ["low", "high", "invalid"] } }));
        await controller.refresh();
        controller.dialogs.pick = async (items) => {
            assert.deepEqual(
                items.map((item) => item.label),
                [t("effort_low"), t("effort_default"), t("effort_high")],
            );
            return items.find((item) => item.label === t("effort_high"));
        };
        await chooseEffort();
        assert.equal(controller.snapshot().effort.level, "high");
        assert.equal(await controller.receive({ ...envelope(), type: "chooseEffort", model: "fake-coder", level: "low" }), false);
        replies = [{ text: "Effort high" }];
        await send("Explain with the chosen effort", "ask");
        assert.equal(fake.completions.at(-1)!.body.tomverse_effort, "high");
        assert.equal(Journal.read(join(sessionHome, "sessions", controller.snapshot().session)).tasks.at(-1)!.effort, "high");
        assert.equal(JSON.stringify(fake.completions.at(-1)!.body.tools).includes("apply_patch"), false);
        controller.dialogs.pick = async (items) => items.find((item) => item.label === t("effort_default"));
        await chooseEffort();
        replies = [{ text: "Model defaults" }];
        await send("Use defaults for the next task", "ask");
        assert.equal(fake.completions.at(-1)!.body.tomverse_effort, undefined);
        record("native effort picker follows catalog, rejects webview level injection, preserves Ask and omits default wire override");
        await fresh();
        controller.dialogs.pick = async (items) => items.find((item) => item.label === t("effort_high"));
        await chooseEffort("smart-adaptive");
        replies = [
            { toolCalls: [{ name: "apply_patch", args: { edits: [{ path: "effort.txt", action: "create", content: "fixture" }] } }] },
            { text: "Denied" },
        ];
        const effortRun = send("Effort stays fixed through approval", "agent", "smart-adaptive");
        const effortApproval = await approval();
        assert.equal(controller.snapshot().effort.locked, true);
        await assert.rejects(chooseEffort("smart-adaptive"), /Stop the active run/);
        await approve(effortApproval.id, "deny");
        await effortRun;
        const effortSession = controller.snapshot().session;
        assert.equal(controller.snapshot().model?.pinned, "fake-coder");
        assert.equal(fake.completions.at(-1)!.body.model, "fake-coder");
        assert.equal(fake.completions.at(-1)!.body.tomverse_effort, "high");
        await fresh();
        await controller.chooseSession(effortSession);
        assert.equal(controller.snapshot().effort.level, "high");
        const beforeUnavailable = fake.completions.length;
        fake.options.models = DEFAULT_MODELS;
        await send("Use the routed model defaults", "agent", "smart-adaptive");
        assert.equal(fake.completions.length, beforeUnavailable + 1);
        assert.equal(fake.completions.at(-1)!.body.model, "fake-coder");
        assert.equal(fake.completions.at(-1)!.body.tomverse_effort, undefined);
        assert.equal(controller.snapshot().effort.level, "default");
        assert.equal(controller.snapshot().effort.requested, "high");
        controller.dialogs.pick = nativePick;
        fake.options.models = undefined;
        record("effort is fixed through Agent approval and reload; removed capability uses Default without changing the pinned model");
        await fresh();
        fake.options.models = DEFAULT_MODELS.map((model) => ({ ...model, tomverse: { ...model.tomverse, reasoning_efforts: ["high"] } }));
        await controller.refresh();
        controller.dialogs.pick = async (items) => items.find((item) => item.label === t("effort_high"));
        await chooseEffort();
        replies = [{ fault: "hang" }];
        const beforeInterrupted = fake.completions.length;
        const interrupted = send("Recover with the original effort", "ask");
        await until(() => fake.completions.length > beforeInterrupted, "effort request started");
        await action("stop");
        await interrupted;
        const resumeSession = controller.snapshot().session;
        const nativeDecision = controller.dialogs.choose.bind(controller.dialogs);
        controller.dialogs.choose = async () => t("confirm");
        replies = [{ text: "Resumed with high effort" }];
        await action("recover");
        assert.equal(fake.completions.length, beforeInterrupted + 2);
        assert.equal(fake.completions.at(-1)!.body.tomverse_effort, "high");
        assert.equal(controller.snapshot().state, "completed");
        await fresh();
        fake.options.models = DEFAULT_MODELS;
        await controller.chooseSession(resumeSession);
        const beforeRemovedResume = fake.completions.length;
        await action("recover");
        assert.equal(fake.completions.length, beforeRemovedResume + 1);
        assert.equal(fake.completions.at(-1)!.body.tomverse_effort, undefined);
        assert.equal(Journal.read(join(sessionHome, "sessions", resumeSession)).status, "completed");
        assert.equal(controller.snapshot().effort.level, "default");
        await fresh();
        await controller.chooseSession(resumeSession);
        assert.equal(controller.snapshot().effort.level, "default");
        assert.equal(controller.snapshot().effort.requested, "high");
        controller.dialogs.choose = nativeDecision;
        controller.dialogs.pick = nativePick;
        fake.options.models = undefined;
        record("confirmed recovery preserves the requested effort and records Default fallback across reload when capability is removed");
        await fresh();
        fake.options.models = DEFAULT_MODELS.map((model) => ({ ...model, tomverse: { ...model.tomverse, reasoning_efforts: ["high"] } }));
        await controller.refresh();
        controller.dialogs.pick = async (items) => items.find((item) => item.label === t("effort_high"));
        await chooseEffort();
        fake.options.models = DEFAULT_MODELS;
        const beforeRefusal = fake.completions.length;
        await send("Capability disappeared before starting", "ask");
        assert.equal(fake.completions.length, beforeRefusal + 1);
        assert.equal(fake.completions.at(-1)!.body.tomverse_effort, undefined);
        assert.equal(controller.snapshot().effort.level, "default");
        assert.equal(controller.snapshot().state, "completed");
        controller.dialogs.pick = nativePick;
        fake.options.models = undefined;
        record("removed capability uses model defaults for a new task without rejecting the task");
    } catch (error) {
        evidence.push({ name: "suite", status: "FAIL", detail: (error as Error).stack });
        throw error;
    } finally {
        writeFileSync(
            join(artifacts, `extension-host-${restricted ? "restricted" : "trusted"}.json`),
            JSON.stringify(
                {
                    host: vscode.version,
                    node: process.versions.node,
                    platform: process.platform,
                    arch: process.arch,
                    trusted: vscode.workspace.isTrusted,
                    extensionPath: extension.extensionPath,
                    evidence,
                },
                null,
                2,
            ),
        );
        controller.stop();
        await controller.dispose();
        await fake.stop();
    }
}
