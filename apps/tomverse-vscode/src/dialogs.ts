import * as vscode from "vscode";
/** Native user decisions. Tests can supply deterministic choices without changing production settings. */
export class Dialogs {
    choose(message: string, options: vscode.MessageOptions, ...items: string[]): Thenable<string | undefined> {
        return vscode.window.showWarningMessage(message, options, ...items);
    }
}
