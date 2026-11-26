import { escapeHtml } from "./escape.js";
import { lookup } from "./lookup.js";

const show = (value) => (value === undefined || value === null ? "" : String(value));

export function render(template, data = {}) {
    return template
        .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, path) => show(lookup(data, path)))
        .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => escapeHtml(show(lookup(data, path))));
}
