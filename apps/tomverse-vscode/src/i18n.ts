import * as vscode from "vscode";
import { messages, type MessageKey, localeFor } from "./translations.js";
export const labels = () => messages[localeFor(vscode.env.language)];
export const t = (key: MessageKey) => labels()[key];
