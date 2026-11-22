import * as vscode from "vscode";
/** Native user decisions. Tests can supply deterministic choices without changing production settings. */
export class Dialogs {
    pick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions): Thenable<T | undefined> {
        return vscode.window.showQuickPick(items, options);
    }
    choose(message: string, options: vscode.MessageOptions, ...items: string[]): Thenable<string | undefined> {
        return vscode.window.showWarningMessage(message, options, ...items);
    }
}
