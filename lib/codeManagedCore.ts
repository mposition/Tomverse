import { z } from "zod";
import type { CodingCatalogRow } from "@/lib/modelCatalogCore";
// Derived from TomverseCode's bounded verified path: P=3,C=2,S=8,M=1,E=2,F=3,K=2.
// 3*(2*2+1+8)+1+2+3+(3+3)=51 semantic calls; four attempts each; headroom x2.
export const CODE_DERIVED_CALL_CEILING = 51 * 4 * 2;
export const CODE_TASK_TTL_MS = 120000;
export const CODE_HEARTBEAT_INTERVAL_MS = 30000;
export const CODE_PROVIDER_TIMEOUT_MS = 60000;
export const CODE_MAX_BODY_BYTES = 1024 * 1024;
// Code's existing per-call ceiling. Also stays below Google long-decode's
// continuation boundary, so one admitted call cannot fan out inside the SDK.
export const CODE_MAX_OUTPUT_TOKENS = 16000;
const uuid = z.string().uuid();
const reservation = z.string().uuid();
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/);
const base = { reservationId: reservation };
export const codeManagedRequestSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("reserve"), taskId: uuid, catalogVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        contentHash: z.string().min(1).max(128), executorModelId: modelId, reviewerModelId: modelId,
        approvedCredits: z.number().int().positive().max(1000000) }).strict(),
    z.object({ action: z.literal("complete"), ...base, callId: uuid, role: z.enum(["executor", "reviewer"]), modelId,
        prompt: z.object({ system: z.string().min(1).max(65536), user: z.string().min(1).max(786432) }).strict(),
        schema: z.record(z.string(), z.unknown()), maxOutputTokens: z.number().int().positive().max(CODE_MAX_OUTPUT_TOKENS) }).strict(),
    z.object({ action: z.literal("heartbeat"), ...base }).strict(),
    z.object({ action: z.literal("release"), ...base, terminalReason: z.enum(["completed", "rejected", "cancelled", "interrupted", "failed"]) }).strict(),
    z.object({ action: z.literal("status"), ...base, callId: uuid.optional() }).strict(),
]);
export type CodeManagedRequest = z.infer<typeof codeManagedRequestSchema>;
export type CompleteRequest = Extract<CodeManagedRequest, {
    action: "complete";
}>;
export type ReserveRequest = Extract<CodeManagedRequest, {
    action: "reserve";
}>;
const resolutionBase = { callId: uuid, resolutionId: uuid, evidenceRef: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/) };
export const codeManagedReconciliationSchema = z.discriminatedUnion("mode", [
    z.object({ ...resolutionBase, mode: z.literal("no_provider_usage") }).strict(),
    z.object({ ...resolutionBase, mode: z.literal("known_usage"), usage: z.object({
            inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
            cachedInputTokens: z.number().int().nonnegative().optional(), cacheWriteInputTokens: z.number().int().nonnegative().optional(), reasoningTokens: z.number().int().nonnegative().optional(),
        }).strict() }).strict(),
]);
export type CodeManagedReconciliation = z.infer<typeof codeManagedReconciliationSchema>;
export type CodeModelPair = {
    executor: CodingCatalogRow;
    reviewer: CodingCatalogRow;
};
export type CodeBilling = {
    reservedCredits: number;
    settledCredits: number;
    releasedCredits: number;
    heldCredits: number;
    unknownHeldCredits: number;
    availableCredits: number;
};
export const codeManagedEnabled = (env: Record<string, string | undefined> = process.env) => env.CODE_MANAGED_EXECUTION_ENABLED === "true";
export const codeLimit = (name: string, floor: number, env: Record<string, string | undefined> = process.env) => {
    const value = Number(env[name]);
    return Number.isSafeInteger(value) && value > 0 ? Math.max(floor, value) : floor;
};
export const codeCallCeiling = (env: Record<string, string | undefined> = process.env) => codeLimit("CODE_TASK_CALL_CEILING", CODE_DERIVED_CALL_CEILING, env);
export const codeTaskLimit = () => codeLimit("CODE_USER_CONCURRENT_TASKS", 8);
export const codeConcurrentCalls = () => codeLimit("CODE_USER_CONCURRENT_CALLS", 16);
export function codeBilling(input: {
    reservedCredits: number;
    settledCredits: number;
    releasedCredits: number;
}, calls: readonly {
    status: string;
    reservedCredits: number;
}[]): CodeBilling {
    const heldCredits = input.reservedCredits - input.settledCredits - input.releasedCredits;
    const unknownHeldCredits = calls.filter(c => c.status === "outcome_unknown").reduce((s, c) => s + c.reservedCredits, 0);
    const active = calls.filter(c => c.status === "dispatched").reduce((s, c) => s + c.reservedCredits, 0);
    if (heldCredits < 0 || unknownHeldCredits + active > heldCredits)
        throw new Error("Code credit invariant violated");
    return { reservedCredits: input.reservedCredits, settledCredits: input.settledCredits, releasedCredits: input.releasedCredits,
        heldCredits, unknownHeldCredits, availableCredits: heldCredits - unknownHeldCredits - active };
}
export function codeSchemaAndPrompt(request: CompleteRequest, model: CodingCatalogRow) {
    const serialized = JSON.stringify(request.schema);
    if (Buffer.byteLength(serialized) > 64 * 1024 || request.schema.type !== "object")
        throw new Error("Invalid Code output schema");
    let nodes = 0;
    const visit = (value: unknown, depth: number, mode: "schema" | "map" | "literal" = "schema") => {
        if (depth > 32 || ++nodes > 10000)
            throw new Error("Code output schema is too complex");
        if (Array.isArray(value)) {
            for (const item of value)
                visit(item, depth + 1, mode);
        }
        else if (value && typeof value === "object")
            for (const [key, item] of Object.entries(value)) {
                if (mode === "schema" && (key === "pattern" || key === "patternProperties" || key === "format"))
                    throw new Error("Executable schema patterns are not supported");
                if (mode === "schema" && key === "$ref" && (typeof item !== "string" || !item.startsWith("#/")))
                    throw new Error("External schema references are not allowed");
                visit(item, depth + 1, mode === "literal" ? "literal" : mode === "map" ? "schema" :
                    ["properties", "definitions", "$defs", "dependentSchemas"].includes(key) ? "map" :
                        ["const", "enum", "default", "examples", "dependentRequired"].includes(key) ? "literal" : "schema");
            }
    };
    visit(request.schema, 0);
    const bytes = Buffer.byteLength(request.prompt.system) + Buffer.byteLength(request.prompt.user) + Buffer.byteLength(serialized) + 4096;
    if (request.maxOutputTokens > model.capabilities.maxOutputTokens || bytes + request.maxOutputTokens > model.capabilities.maxContextTokens)
        throw new Error("Code request exceeds the selected model's bounds");
    // UTF-8 bytes upper-bound text tokenizer pieces. The framing allowance
    // covers SDK roles/JSON-schema instructions without reserving a whole context.
    return bytes;
}
export function validCodeUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
} | undefined) {
    if (!usage || ![usage.inputTokens, usage.outputTokens].every(v => Number.isSafeInteger(v) && v! >= 0))
        return null;
    const cached = usage.cachedInputTokens ?? 0;
    if (!Number.isSafeInteger(cached) || cached < 0 || cached > usage.inputTokens!)
        return null;
    const written = usage.cacheWriteInputTokens ?? 0, reasoning = usage.reasoningTokens ?? 0;
    if (!Number.isSafeInteger(written) || written < 0 || written + cached > usage.inputTokens! || !Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > usage.outputTokens!)
        return null;
    // AI SDK outputTokens is total text + reasoning, already normalised by each
    // provider (Google convertGoogleUsage adds candidates + thoughts). Do not add twice.
    return { inputTokens: usage.inputTokens!, outputTokens: usage.outputTokens!, cachedInputTokens: cached, cacheWriteInputTokens: written, reasoningTokens: reasoning, reported: true as const };
}
