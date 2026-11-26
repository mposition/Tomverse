/**
 * Small, dependency-free readers for the file formats of other coding tools: the YAML front matter of a SKILL.md / command / agent
 * file, the TOML of a Codex agent or config.toml, and the argument placeholders of a command. They read the documented subset and say
 * so when a file uses something else; they never run or fetch anything the text names.
 */

/* ---------------------------------------------------------------- front matter */

export type FrontMatterValue = string | string[];
/** `raw` keeps a one-line value as written (`argument-hint: [service] [env]` is text, not a list); `data` reads `[a, b]` as a list. */
export type FrontMatter = { data: Record<string, FrontMatterValue>; raw: Record<string, string>; body: string; present: boolean };

const splitInline = (text: string): string[] => {
    const out: string[] = [];
    let current = "";
    let quote = "";
    for (const ch of text) {
        if (quote) {
            current += ch;
            if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
        } else if (ch === ",") {
            out.push(current);
            current = "";
        } else current += ch;
    }
    out.push(current);
    return out.map((item) => unquote(item)).filter((item) => item !== "");
};

const unquote = (raw: string): string => {
    const text = raw.trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        try {
            return JSON.parse(text) as string;
        } catch {
            return text.slice(1, -1);
        }
    }
    if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
    return text.replace(/\s+#.*$/, "");
};

/** Booleans the way the docs accept them: true/false, yes/no, on/off, 1/0, in any case. Undefined when it is neither. */
export const frontMatterBoolean = (value: FrontMatterValue | undefined): boolean | undefined => {
    if (typeof value !== "string") return undefined;
    const text = value.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(text)) return true;
    if (["false", "no", "off", "0"].includes(text)) return false;
    return undefined;
};

/** A string or a list, as a list: a comma/space separated string (`tools: Read, Grep` or `allowed-tools: Read Edit`) or a YAML list. */
export const frontMatterList = (value: FrontMatterValue | undefined, separator: RegExp = /[\s,]+/): string[] => {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
    return value.split(separator).map((item) => item.trim()).filter(Boolean);
};

/**
 * The `---` block at the very top of a Markdown file. Understands `key: value`, quoted values, inline lists, `- item` lists and
 * `|` / `>` block text. A nested mapping (hooks, inline MCP servers) is skipped: its key is present with an empty value. A file
 * whose block is not closed has no front matter, as in Claude Code.
 */
export const parseFrontMatter = (text: string): FrontMatter => {
    const source = text.replace(/^﻿/, "");
    const lines = source.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return { data: {}, raw: {}, body: source, present: false };
    const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
    if (end < 0) return { data: {}, raw: {}, body: source, present: false };
    const block = lines.slice(1, end);
    const data: Record<string, FrontMatterValue> = Object.create(null);
    const raw: Record<string, string> = Object.create(null);
    for (let i = 0; i < block.length; i += 1) {
        const line = block[i]!;
        const match = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/.exec(line);
        if (!match) continue;
        const key = match[1]!;
        const rest = (match[2] ?? "").trim();
        const following: string[] = [];
        let j = i + 1;
        while (j < block.length && (block[j]!.trim() === "" || /^[ \t]/.test(block[j]!) || (rest === "" && /^-[ \t]/.test(block[j]!)))) {
            following.push(block[j]!);
            j += 1;
        }
        if (rest === "" || /^[|>][+-]?$/.test(rest)) {
            const used = following;
            if (rest === "") {
                const filled = used.filter((l) => l.trim() !== "");
                data[key] = filled.length && filled.every((l) => /^\s*-\s+/.test(l)) ? filled.map((l) => unquote(l.replace(/^\s*-\s+/, ""))) : "";
            } else {
                const indent = Math.min(...used.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0].length), Infinity);
                const dedented = used.map((l) => (indent === Infinity ? "" : l.slice(indent)));
                while (dedented.length && dedented.at(-1)!.trim() === "") dedented.pop();
                data[key] = rest.startsWith(">")
                    ? dedented.join("\n").replace(/([^\n])\n(?!\n)/g, "$1 ").replace(/\n\n/g, "\n")
                    : dedented.join("\n");
            }
            i = j - 1;
            continue;
        }
        raw[key] = unquote(rest);
        data[key] = rest.startsWith("[") && rest.endsWith("]") ? splitInline(rest.slice(1, -1)) : unquote(rest);
    }
    return { data, raw, body: lines.slice(end + 1).join("\n").replace(/^\n/, ""), present: true };
};

/** One string field of the front matter (a list becomes its items joined by a space). */
export const frontMatterText = (data: FrontMatter["data"], key: string): string | undefined => {
    const value = data[key];
    if (value === undefined) return undefined;
    const text = Array.isArray(value) ? value.join(" ") : value;
    return text.trim() || undefined;
};

/* ---------------------------------------------------------------------- TOML */

export class TomlError extends Error {}

type TomlObject = Record<string, unknown>;

const BARE_KEY = /[A-Za-z0-9_-]/;

class TomlReader {
    private p = 0;
    constructor(private readonly s: string) {}

    private fail(message: string): never {
        const line = this.s.slice(0, this.p).split("\n").length;
        throw new TomlError(`${message} (line ${line})`);
    }

    private ws() {
        while (this.s[this.p] === " " || this.s[this.p] === "\t") this.p += 1;
    }

    private skipBlank() {
        for (;;) {
            const ch = this.s[this.p];
            if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") this.p += 1;
            else if (ch === "#") while (this.p < this.s.length && this.s[this.p] !== "\n") this.p += 1;
            else return;
        }
    }

    private endOfLine() {
        this.ws();
        if (this.s[this.p] === "#") while (this.p < this.s.length && this.s[this.p] !== "\n") this.p += 1;
        if (this.p < this.s.length && this.s[this.p] !== "\n" && this.s[this.p] !== "\r") this.fail("Unexpected text after a value");
    }

    private keyPart(): string {
        const ch = this.s[this.p];
        if (ch === '"') return this.basicString();
        if (ch === "'") return this.literalString();
        const start = this.p;
        while (this.p < this.s.length && BARE_KEY.test(this.s[this.p]!)) this.p += 1;
        if (start === this.p) this.fail("Expected a key");
        return this.s.slice(start, this.p);
    }

    private keyPath(): string[] {
        const parts: string[] = [];
        for (;;) {
            this.ws();
            parts.push(this.keyPart());
            this.ws();
            if (this.s[this.p] !== ".") return parts;
            this.p += 1;
        }
    }

    private escape(): string {
        const ch = this.s[this.p++];
        switch (ch) {
            case "b": return "\b";
            case "t": return "\t";
            case "n": return "\n";
            case "f": return "\f";
            case "r": return "\r";
            case '"': return '"';
            case "\\": return "\\";
            case "u":
            case "U": {
                const size = ch === "u" ? 4 : 8;
                const hex = this.s.slice(this.p, this.p + size);
                if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== size) this.fail("Bad unicode escape");
                this.p += size;
                return String.fromCodePoint(parseInt(hex, 16));
            }
            default: return this.fail("Bad escape");
        }
    }

    private basicString(): string {
        if (this.s.startsWith('"""', this.p)) {
            this.p += 3;
            if (this.s[this.p] === "\r") this.p += 1;
            if (this.s[this.p] === "\n") this.p += 1;
            let out = "";
            for (;;) {
                if (this.p >= this.s.length) this.fail("Unterminated string");
                if (this.s.startsWith('"""', this.p)) {
                    this.p += 3;
                    return out;
                }
                const ch = this.s[this.p++]!;
                if (ch === "\\") {
                    if (/^[ \t]*\r?\n/.test(this.s.slice(this.p, this.p + 40))) {
                        while (/[ \t\r\n]/.test(this.s[this.p] ?? "x")) this.p += 1;
                    } else out += this.escape();
                } else out += ch;
            }
        }
        this.p += 1;
        let out = "";
        for (;;) {
            const ch = this.s[this.p++];
            if (ch === undefined || ch === "\n") this.fail("Unterminated string");
            if (ch === '"') return out;
            out += ch === "\\" ? this.escape() : ch;
        }
    }

    private literalString(): string {
        if (this.s.startsWith("'''", this.p)) {
            this.p += 3;
            if (this.s[this.p] === "\r") this.p += 1;
            if (this.s[this.p] === "\n") this.p += 1;
            const end = this.s.indexOf("'''", this.p);
            if (end < 0) this.fail("Unterminated string");
            const out = this.s.slice(this.p, end);
            this.p = end + 3;
            return out;
        }
        const end = this.s.indexOf("'", this.p + 1);
        const newline = this.s.indexOf("\n", this.p);
        if (end < 0 || (newline >= 0 && newline < end)) this.fail("Unterminated string");
        const out = this.s.slice(this.p + 1, end);
        this.p = end + 1;
        return out;
    }

    private array(): unknown[] {
        this.p += 1;
        const out: unknown[] = [];
        for (;;) {
            this.skipBlank();
            if (this.s[this.p] === "]") {
                this.p += 1;
                return out;
            }
            out.push(this.value());
            this.skipBlank();
            if (this.s[this.p] === ",") this.p += 1;
            else if (this.s[this.p] !== "]") this.fail("Expected , or ] in an array");
        }
    }

    private inlineTable(): TomlObject {
        this.p += 1;
        const out: TomlObject = Object.create(null);
        this.ws();
        if (this.s[this.p] === "}") {
            this.p += 1;
            return out;
        }
        for (;;) {
            const path = this.keyPath();
            this.ws();
            if (this.s[this.p] !== "=") this.fail("Expected =");
            this.p += 1;
            this.ws();
            assign(out, path, this.value());
            this.ws();
            if (this.s[this.p] === ",") {
                this.p += 1;
                this.ws();
            } else if (this.s[this.p] === "}") {
                this.p += 1;
                return out;
            } else this.fail("Expected , or } in an inline table");
        }
    }

    private value(): unknown {
        const ch = this.s[this.p];
        if (ch === '"') return this.basicString();
        if (ch === "'") return this.literalString();
        if (ch === "[") return this.array();
        if (ch === "{") return this.inlineTable();
        const match = /^[A-Za-z0-9_+\-.:]+(?: [0-9:.]+Z?)?/.exec(this.s.slice(this.p, this.p + 64));
        if (!match) return this.fail("Expected a value");
        const token = match[0]!;
        this.p += token.length;
        if (token === "true") return true;
        if (token === "false") return false;
        if (/^[+-]?(inf|nan)$/.test(token)) return Number(token.replace("inf", "Infinity").replace("nan", "NaN"));
        if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(token) || /^0[xob][0-9a-fA-F_]+$/.test(token)) {
            return Number(token.replaceAll("_", ""));
        }
        // dates and times are kept as text: nothing here reads them
        if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(token)) return token;
        return this.fail("Unknown value");
    }

    read(): TomlObject {
        const root: TomlObject = Object.create(null);
        let current = root;
        for (;;) {
            this.skipBlank();
            if (this.p >= this.s.length) return root;
            if (this.s[this.p] === "[") {
                const array = this.s[this.p + 1] === "[";
                this.p += array ? 2 : 1;
                const path = this.keyPath();
                this.ws();
                if (this.s.slice(this.p, this.p + (array ? 2 : 1)) !== (array ? "]]" : "]")) this.fail("Unclosed table header");
                this.p += array ? 2 : 1;
                this.endOfLine();
                current = array ? appendTable(root, path) : ensureTable(root, path);
                continue;
            }
            const path = this.keyPath();
            this.ws();
            if (this.s[this.p] !== "=") this.fail("Expected =");
            this.p += 1;
            this.ws();
            assign(current, path, this.value());
            this.endOfLine();
        }
    }
}

const ensureTable = (root: TomlObject, path: string[]): TomlObject => {
    let node = root;
    for (const part of path) {
        let next = node[part];
        if (Array.isArray(next)) next = next.at(-1);
        if (next === undefined) {
            next = Object.create(null) as TomlObject;
            node[part] = next;
        }
        if (typeof next !== "object" || next === null) throw new TomlError(`The key ${part} is not a table`);
        node = next as TomlObject;
    }
    return node;
};

const appendTable = (root: TomlObject, path: string[]): TomlObject => {
    const parent = ensureTable(root, path.slice(0, -1));
    const last = path.at(-1)!;
    const list = (parent[last] ??= []) as unknown;
    if (!Array.isArray(list)) throw new TomlError(`The key ${last} is not an array of tables`);
    const entry: TomlObject = Object.create(null);
    list.push(entry);
    return entry;
};

const assign = (target: TomlObject, path: string[], value: unknown) => {
    const table = ensureTable(target, path.slice(0, -1));
    const last = path.at(-1)!;
    if (last in table) throw new TomlError(`The key ${last} is set twice`);
    table[last] = value;
};

/** The TOML subset configuration files use: tables, arrays of tables, dotted keys, strings (also multi-line), numbers, booleans, arrays, inline tables. */
export const parseToml = (text: string): TomlObject => new TomlReader(text.replace(/^﻿/, "")).read();

/* ------------------------------------------------------------------ arguments */

/** Splits arguments the way a shell would: whitespace separates, quotes group (and are removed), a backslash escapes inside double quotes. */
export const splitArguments = (text: string): string[] => {
    const out: string[] = [];
    let current = "";
    let quote = "";
    let started = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]!;
        if (quote) {
            if (ch === quote) quote = "";
            else if (ch === "\\" && quote === '"' && (text[i + 1] === '"' || text[i + 1] === "\\")) current += text[++i]!;
            else current += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
        } else if (/\s/.test(ch)) {
            if (started || current) out.push(current);
            current = "";
            started = false;
        } else {
            current += ch;
            started = true;
        }
    }
    if (started || current) out.push(current);
    return out;
};

export type ClaudeArgumentContext = { names?: string[]; skillDir?: string; projectDir?: string; sessionId?: string; effort?: string; pluginRoot?: string };

/**
 * Claude Code's placeholders: `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` (0-based), `$name` for a name in the `arguments` list,
 * `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, and `\$` for a literal dollar sign. A
 * placeholder with no value stays as written (an unfilled named one becomes empty); argument values are never expanded again.
 * When nothing received the arguments they are appended as `ARGUMENTS: ...`.
 */
export const expandClaudeArguments = (body: string, rawArguments: string, context: ClaudeArgumentContext = {}): string => {
    const args = splitArguments(rawArguments);
    const names = context.names ?? [];
    let used = false;
    const expanded = body.replace(
        /\\\$|\$\{(CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_EFFORT|CLAUDE_PLUGIN_ROOT)\}|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (whole, variable: string | undefined, bracket: string | undefined, index: string | undefined, name: string | undefined) => {
            if (whole === "\\$") return "$";
            if (variable) {
                const value = variable === "CLAUDE_SKILL_DIR" ? context.skillDir : variable === "CLAUDE_PROJECT_DIR" ? context.projectDir
                    : variable === "CLAUDE_SESSION_ID" ? context.sessionId : variable === "CLAUDE_PLUGIN_ROOT" ? context.pluginRoot : context.effort;
                return value ?? whole;
            }
            if (whole === "$ARGUMENTS") {
                used = true;
                return rawArguments;
            }
            const position = bracket ?? index;
            if (position !== undefined) {
                const value = args[Number(position)];
                if (value === undefined) return whole;
                used = true;
                return value;
            }
            const at = names.indexOf(name!);
            if (at < 0) return whole;
            used = true;
            return args[at] ?? "";
        },
    );
    return !used && rawArguments.trim() ? `${expanded.replace(/\s+$/, "")}\n\nARGUMENTS: ${rawArguments.trim()}` : expanded;
};

/**
 * Codex custom prompts: `$1`..`$9` positional values, `$ARGUMENTS` all of them, `$NAME` (upper case) for a `NAME=value` argument and
 * `$$` for a literal dollar sign. `KEY=value` arguments are named; the rest are positional. A name nobody gave stays as written.
 */
export const expandCodexPrompt = (body: string, rawArguments: string): string => {
    const named: Record<string, string> = Object.create(null);
    const positional: string[] = [];
    for (const token of splitArguments(rawArguments)) {
        const match = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/.exec(token);
        if (match) named[match[1]!] = match[2]!;
        else positional.push(token);
    }
    return body.replace(/\$\$|\$ARGUMENTS|\$([1-9])|\$([A-Z][A-Z0-9_]*)/g, (whole, digit: string | undefined, name: string | undefined) => {
        if (whole === "$$") return "$";
        if (whole === "$ARGUMENTS") return rawArguments;
        if (digit) return positional[Number(digit) - 1] ?? "";
        return name !== undefined && name in named ? named[name]! : whole;
    });
};
