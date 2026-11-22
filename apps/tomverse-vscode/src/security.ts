import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveEndpoint } from "../../tomverse-cli/src/runtime.js";

const id = z.string().min(1).max(150);
const envelope = { channel: id, run: z.string().max(150) };
export const messageSchema = z.discriminatedUnion("type", [
    z.object({ ...envelope, type: z.literal("ready") }).strict(),
    z
        .object({ ...envelope, type: z.literal("send"), epoch: id, prompt: z.string().trim().min(1).max(32_000), mode: z.enum(["ask", "agent"]), model: id })
        .strict(),
    z.object({ ...envelope, type: z.literal("approve"), id, decision: z.enum(["once", "run", "deny"]) }).strict(),
    z.object({ ...envelope, type: z.literal("diff"), id, index: z.number().int().min(0).max(100), details: z.boolean() }).strict(),
    z.object({ ...envelope, type: z.literal("removeContext"), id }).strict(),
    z.object({ ...envelope, type: z.literal("undo"), id }).strict(),
    z
        .object({
            ...envelope,
            type: z.literal("action"),
            action: z.enum([
                "connect",
                "disconnect",
                "refresh",
                "root",
                "file",
                "selection",
                "diagnostics",
                "stop",
                "new",
                "sessions",
                "delete",
                "clear",
                "export",
                "keys",
                "logs",
                "recover",
            ]),
        })
        .strict(),
]);
export type ClientMessage = z.infer<typeof messageSchema>;
export const parseMessage = (value: unknown) => {
    try {
        if (JSON.stringify(value).length > 40_000) return null;
    } catch {
        return null;
    }
    const parsed = messageSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
};
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const namespace = (root: string, base: string, key: string) => digest(JSON.stringify(["vscode", root, base, digest(key)]));
export const endpointFromUser = (endpoint?: string, allowInsecureLocalhost = false) => resolveEndpoint({ endpoint, allowInsecureLocalhost }, {});
export const redact = (text: string, key?: string) => {
    if (key) text = text.split(key).join("[redacted]");
    return text.replace(/\btvk?_[A-Za-z0-9_-]{12,}\b/g, "[redacted]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
};
/** Redact string values before serialization, never the JSON syntax itself. */
export const redactJson = (value: unknown, key?: string) => {
    const visit = (value: unknown): unknown => {
        if (typeof value === "string") return redact(value, key);
        if (Array.isArray(value)) return value.map(visit);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name, key), visit(item)]));
        return value;
    };
    return JSON.stringify(visit(value));
};
export const environmentProblem = (env: { trusted: boolean; remote?: string; web: boolean; schemes: string[]; platform: string; arch: string }) => {
    if (env.web || env.remote || env.schemes.some((s) => s !== "file")) return "unsupported";
    if (!(
        (env.platform === "win32" && env.arch === "x64") ||
        (env.platform === "linux" && env.arch === "x64") ||
        (env.platform === "darwin" && env.arch === "arm64")
    ))
        return "unsupported";
    if (!env.trusted) return "restricted";
    return null;
};
