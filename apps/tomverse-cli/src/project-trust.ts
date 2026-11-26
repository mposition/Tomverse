import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./session.js";
import { tomverseHome } from "./config.js";

/**
 * What the person has said about the extensions a folder brings along: which MCP servers and hooks defined INSIDE the folder
 * (`.mcp.json`, `.claude/settings.json`, ...) may run, and which extensions are switched off. A repository cannot approve
 * itself: this file lives in the CLI's user folder, is written only by the person's own action (a prompt in a terminal,
 * a button in Desktop), and an approval is bound to the hash of the exact definition, so a changed definition asks again.
 * Definitions the person wrote in their own user files are trusted and need no entry.
 */

type RootEntry = {
    mcpApproved: string[];
    hooksApproved: string[];
    mcpDisabled: string[];
    hooksDisabled: string[];
};

type TrustFile = { version: 1; roots: Record<string, RootEntry> };

const emptyEntry = (): RootEntry => ({ mcpApproved: [], hooksApproved: [], mcpDisabled: [], hooksDisabled: [] });

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 2000) : []);

/** Case-insensitive paths on Windows and macOS compare equal, as `same` does. */
const rootKey = (root: string) => (process.platform === "win32" || process.platform === "darwin" ? root.toLowerCase() : root);

export const trustFile = (home: string = tomverseHome()) => join(home, "project-trust.json");

const readAll = (home: string): TrustFile => {
    const path = trustFile(home);
    if (!existsSync(path)) return { version: 1, roots: {} };
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { roots?: Record<string, Partial<RootEntry>> };
        const roots: Record<string, RootEntry> = {};
        for (const [key, entry] of Object.entries(parsed.roots ?? {})) {
            roots[key] = { mcpApproved: strings(entry?.mcpApproved), hooksApproved: strings(entry?.hooksApproved),
                mcpDisabled: strings(entry?.mcpDisabled), hooksDisabled: strings(entry?.hooksDisabled) };
        }
        return { version: 1, roots };
    } catch {
        // An unreadable file approves nothing; the next write replaces it.
        return { version: 1, roots: {} };
    }
};

export type ProjectTrust = ReturnType<typeof openProjectTrust>;

/** The trust record of one folder. Every question reads the file again, so another process's answer counts at once. */
export const openProjectTrust = (root: string, home: string = tomverseHome()) => {
    const key = rootKey(root);
    const entry = () => readAll(home).roots[key] ?? emptyEntry();
    const update = (change: (entry: RootEntry) => void) => {
        const file = readAll(home);
        const current = file.roots[key] ?? emptyEntry();
        change(current);
        file.roots[key] = current;
        mkdirSync(home, { recursive: true, mode: 0o700 });
        writeFileAtomic(trustFile(home), `${JSON.stringify(file, null, 2)}\n`);
    };
    const toggle = (list: "mcpDisabled" | "hooksDisabled", id: string, enabled: boolean) => update((e) => {
        const rest = e[list].filter((v) => v !== id);
        e[list] = enabled ? rest : [...rest, id];
    });
    const add = (list: "mcpApproved" | "hooksApproved", hash: string) => update((e) => {
        if (!e[list].includes(hash)) e[list] = [...e[list], hash].slice(-500);
    });
    return {
        /** A user-scope definition is always trusted; a project one only when its exact hash was approved. */
        mcpApproved: (def: { scope: "user" | "project"; hash: string }) => def.scope === "user" || entry().mcpApproved.includes(def.hash),
        approveMcp: (def: { hash: string }) => add("mcpApproved", def.hash),
        mcpEnabled: (def: { name: string }) => !entry().mcpDisabled.includes(def.name),
        setMcpEnabled: (def: { name: string }, enabled: boolean) => toggle("mcpDisabled", def.name, enabled),
        hookApproved: (def: { scope: "user" | "project"; hash: string }) => def.scope === "user" || entry().hooksApproved.includes(def.hash),
        approveHook: (def: { hash: string }) => add("hooksApproved", def.hash),
        hookEnabled: (def: { hash: string }) => !entry().hooksDisabled.includes(def.hash),
        setHookEnabled: (def: { hash: string }, enabled: boolean) => toggle("hooksDisabled", def.hash, enabled),
    };
};

/** What may start for each MCP server: a project server waits for approval of its exact definition, then obeys the on/off switch. */
export const mcpGate = (trust: ProjectTrust) => (def: { scope: "user" | "project"; hash: string; name: string }): "yes" | "pending_approval" | "disabled" =>
    !trust.mcpApproved(def) ? "pending_approval" : !trust.mcpEnabled(def) ? "disabled" : "yes";

/** A hook runs when it is the person's own or approved by hash, and not switched off. */
export const hookGate = (trust: ProjectTrust) => (def: { scope: "user" | "project"; hash: string }) =>
    trust.hookApproved(def) && trust.hookEnabled(def);
