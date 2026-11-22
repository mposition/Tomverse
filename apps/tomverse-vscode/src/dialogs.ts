import * as vscode from "vscode";
import { t } from "./i18n.js";

/** Native user decisions. Tests can supply deterministic choices without changing production settings. */
export class Dialogs {
    pick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions): Thenable<T | undefined> {
        return vscode.window.showQuickPick(items, options);
    }
    choose(message: string, options: vscode.MessageOptions, ...items: string[]): Thenable<string | undefined> {
        const choices: vscode.MessageItem[] = items.map((title) => ({ title, isCloseAffordance: options.modal === true && title === t("cancel") }));
        return vscode.window.showWarningMessage(message, options, ...choices).then((item) => item?.title);
    }
}
