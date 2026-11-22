import * as vscode from "vscode";
import { SessionController } from "./sessionController.js";
let controller: SessionController | undefined;
export async function activate(context: vscode.ExtensionContext) {
    controller = new SessionController(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("tomverse.sidebar", controller));
    const actions: Record<string, string> = {
        connect: "connect",
        disconnect: "disconnect",
        selectRoot: "root",
        stop: "stop",
        sessions: "sessions",
        newSession: "new",
        clearApprovals: "clear",
        exportDiagnostics: "export",
        attachFile: "file",
        attachSelection: "selection",
        attachDiagnostics: "diagnostics",
    };
    context.subscriptions.push(vscode.commands.registerCommand("tomverse.open", () => vscode.commands.executeCommand("tomverse.sidebar.focus")));
    for (const [name, action] of Object.entries(actions))
        context.subscriptions.push(
            vscode.commands.registerCommand(`tomverse.${name}`, (uri?: vscode.Uri) =>
                controller!.action(action, uri).catch((error: unknown) => controller!.report(error)),
            ),
        );
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => controller?.update()));
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            controller?.stop();
            controller?.update();
        }),
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("tomverse")) {
                controller?.stop();
                controller?.update();
            }
        }),
    );
    await controller.action("refresh").catch((error: unknown) => controller!.report(error));
    // Only the Extension Development Host test runner receives internal handles.
    if (context.extensionMode === vscode.ExtensionMode.Test) return { controller, context };
}
export async function deactivate() {
    await controller?.dispose();
    controller = undefined;
}
