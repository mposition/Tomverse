import * as vscode from "vscode";
import { endpointFromUser, digest } from "./security.js";
import { t } from "./i18n.js";

/** No workspace values or process.env overrides are consulted. Keys are bound to the entire API base. */
export class Credentials {
    constructor(private readonly context: vscode.ExtensionContext) {}
    endpoint() {
        const config = vscode.workspace.getConfiguration("tomverse");
        return endpointFromUser(config.inspect<string>("endpoint")?.globalValue, config.inspect<boolean>("allowInsecureLocalhost")?.globalValue);
    }
    private name() {
        return `key:${digest(this.endpoint().base)}`;
    }
    get() {
        return this.context.secrets.get(this.name());
    }
    async connect() {
        const base = this.endpoint().base;
        const key = await vscode.window.showInputBox({
            title: t("connect"),
            prompt: `${t("keyPrompt")} ${base}`,
            password: true,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim().length < 16 || /\s/.test(v.trim()) ? t("invalidKey") : undefined),
        });
        if (!key) return false;
        if (this.endpoint().base !== base) throw new Error("Endpoint changed while entering the key. Connect again.");
        await this.context.secrets.store(`key:${digest(base)}`, key.trim());
        return true;
    }
    async disconnect() {
        await this.context.secrets.delete(this.name());
    }
}
