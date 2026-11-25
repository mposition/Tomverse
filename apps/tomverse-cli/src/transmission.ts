import { isExplicitEffort, type Effort } from "./effort.js";
import type { CatalogModel } from "./gateway.js";
import type { GenerationRecord } from "./session.js";

export function reportedGenerationModel(generation: GenerationRecord) {
    const receipt = generation.receipt;
    return generation.routedModel || (receipt && generation.requestId && receipt.requestId === generation.requestId ? receipt.modelId : undefined);
}

export function catalogProviderFor(generation: GenerationRecord, catalog: CatalogModel[]) {
    const id = reportedGenerationModel(generation);
    const provider = id && catalog.find((model) => model.id === id)?.provider;
    return provider && provider !== "unknown" && /^[a-z0-9-]{1,40}$/i.test(provider) ? provider : undefined;
}

export type RequestTransmission = {
    model?: string;
    effort?: Exclude<Effort, "default">;
    projectInstructions: boolean;
    projectInstructionsTruncated?: boolean;
    messageCount: number;
    toolResultCount: number;
    commandOutput?: { results: number; truncated: number };
    listedPathCount: number;
    truncatedListingCount: number;
    fileReads: Array<{ path: string; truncated: boolean }>;
    moreFileReads: number;
    /** Public web pages whose text was part of the request, by address. */
    webReads?: Array<{ url: string; truncated: boolean }>;
    moreWebReads?: number;
};

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(value: unknown): unknown {
    if (typeof value !== "string") return null;
    try { return JSON.parse(value); } catch { return null; }
}

/** Project the actual Chat Completions payload into metadata without retaining its text or credentials. */
export function requestTransmission(body: unknown, redact: (text: string) => string): RequestTransmission | undefined {
    const request = record(parseJson(body));
    if (!request || !Array.isArray(request.messages)) return undefined;
    const tools = new Map<string, string>();
    const evidence: RequestTransmission = {
        model: typeof request.model === "string" ? redact(request.model).slice(0, 160) : undefined,
        ...(isExplicitEffort(request.tomverse_effort) ? { effort: request.tomverse_effort } : {}),
        projectInstructions: false,
        messageCount: request.messages.length,
        toolResultCount: 0,
        listedPathCount: 0,
        truncatedListingCount: 0,
        fileReads: [],
        moreFileReads: 0,
    };
    for (const value of request.messages) {
        const message = record(value);
        if (!message) continue;
        if (message.role === "system" && typeof message.content === "string" && message.content.includes("\n<project-instructions>\n")) {
            evidence.projectInstructions = true;
        }
        if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
            for (const value of message.tool_calls) {
                const call = record(value);
                const tool = record(call?.function);
                if (typeof call?.id === "string" && typeof tool?.name === "string") tools.set(call.id, tool.name);
            }
        }
        if (message.role !== "tool") continue;
        evidence.toolResultCount += 1;
        if (typeof message.tool_call_id !== "string") continue;
        const name = tools.get(message.tool_call_id);
        if (name !== "read_file" && name !== "list_files" && name !== "run_command" && name !== "web_fetch") continue;
        const output = record(parseJson(message.content));
        if (name === "run_command") {
            const omitted = record(output?.omittedBytes);
            const truncated = [omitted?.stdout, omitted?.stderr].some((bytes) => typeof bytes === "number" && bytes > 0);
            const includesText = [output?.stdout, output?.stderr].some((value) => typeof value === "string" && value.length > 0);
            if (includesText || truncated) {
                const counts = evidence.commandOutput ??= { results: 0, truncated: 0 };
                counts.results += 1;
                if (truncated) counts.truncated += 1;
            }
            continue;
        }
        if (output?.status !== "ok") continue;
        if (name === "web_fetch") {
            if (typeof output.url !== "string") continue;
            const reads = evidence.webReads ??= [];
            if (reads.length < 24) reads.push({ url: redact(output.url).slice(0, 500), truncated: output.truncated === true });
            else evidence.moreWebReads = (evidence.moreWebReads ?? 0) + 1;
            continue;
        }
        if (name === "list_files") {
            evidence.listedPathCount += Array.isArray(output.files) ? output.files.filter((file) => typeof file === "string").length : 0;
            if (output.truncated === true) evidence.truncatedListingCount += 1;
            continue;
        }
        if (typeof output.path !== "string" || typeof output.text !== "string") continue;
        if (evidence.fileReads.length < 24) {
            evidence.fileReads.push({ path: redact(output.path).slice(0, 300), truncated: output.truncated === true });
        } else {
            evidence.moreFileReads += 1;
        }
    }
    return evidence;
}
