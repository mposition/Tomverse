import { escapeHtml } from "./escape.js";
import { lookup } from "./lookup.js";

const show = (value) => (value === undefined || value === null ? "" : String(value));
const TAG = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([^}]+?)\s*\}\}/g;

function tokenize(template) {
    const tokens = [];
    let last = 0;
    TAG.lastIndex = 0;
    for (let m = TAG.exec(template); m; m = TAG.exec(template)) {
        if (m.index > last) tokens.push({ type: "text", value: template.slice(last, m.index) });
        last = m.index + m[0].length;
        if (m[1] !== undefined) {
            tokens.push({ type: "raw", path: m[1] });
            continue;
        }
        const tag = m[2];
        if (tag.startsWith("#each ")) tokens.push({ type: "open", kind: "each", path: tag.slice(6).trim() });
        else if (tag.startsWith("#if ")) tokens.push({ type: "open", kind: "if", path: tag.slice(4).trim() });
        else if (tag === "/each") tokens.push({ type: "close", kind: "each" });
        else if (tag === "/if") tokens.push({ type: "close", kind: "if" });
        else if (tag === "else") tokens.push({ type: "else" });
        else tokens.push({ type: "var", path: tag });
    }
    if (last < template.length) tokens.push({ type: "text", value: template.slice(last) });
    return tokens;
}

function parse(tokens) {
    const root = { children: [] };
    const stack = [{ node: root, branch: root.children }];
    for (const token of tokens) {
        const top = stack[stack.length - 1];
        if (token.type === "open") {
            const node = { kind: token.kind, path: token.path, children: [], otherwise: [] };
            top.branch.push(node);
            stack.push({ node, branch: node.children });
        } else if (token.type === "else") {
            if (stack.length === 1 || top.node.kind !== "if") throw new Error("unexpected {{else}}");
            top.branch = top.node.otherwise;
        } else if (token.type === "close") {
            if (stack.length === 1 || top.node.kind !== token.kind) throw new Error(`unexpected {{/${token.kind}}}`);
            stack.pop();
        } else {
            top.branch.push(token);
        }
    }
    if (stack.length > 1) throw new Error(`unclosed {{#${stack[stack.length - 1].node.kind}}} block`);
    return root.children;
}

const truthy = (value) => !(value === false || value === null || value === undefined || value === 0 || value === "" || (Array.isArray(value) && value.length === 0));

function resolve(scopes, path) {
    if (path === "this") return scopes[0].item;
    if (path === "@index") {
        const loop = scopes.find((s) => s.index !== undefined);
        return loop ? loop.index : undefined;
    }
    for (const scope of scopes) {
        const value = lookup(scope.item, path);
        if (value !== undefined) return value;
    }
    return undefined;
}

function run(nodes, scopes) {
    let out = "";
    for (const node of nodes) {
        if (node.type === "text") out += node.value;
        else if (node.type === "raw") out += show(resolve(scopes, node.path));
        else if (node.type === "var") out += escapeHtml(show(resolve(scopes, node.path)));
        else if (node.kind === "if") out += run(truthy(resolve(scopes, node.path)) ? node.children : node.otherwise, scopes);
        else if (node.kind === "each") {
            const list = resolve(scopes, node.path);
            if (!Array.isArray(list)) continue;
            list.forEach((item, index) => {
                out += run(node.children, [{ item, index }, ...scopes]);
            });
        }
    }
    return out;
}

export function render(template, data = {}) {
    return run(parse(tokenize(template)), [{ item: data }]);
}
