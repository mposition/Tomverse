/** Headless entry: no CLI main, terminal input, config or environment reads on import. */
import { viewChanges } from "./changes.js";
import { Journal, type JournalIo, type SessionState } from "./session.js";
import { Gateway, type Receipt, type CatalogModel } from "./gateway.js";
import { normalizeRoot, same } from "./workspace.js";
import { catalogProviderFor } from "./transmission.js";
import type { Endpoint } from "./config.js";
export { Runner, SMART_ADAPTIVE, EXIT_CODES, VIEW_IMAGE_MARK } from "./agent.js";
export type { ApprovalView, ApprovalDecision, Prompter, RunnerOptions, Outcome } from "./agent.js";
export { Gateway, GatewayError } from "./gateway.js";
export type { CatalogModel, Receipt } from "./gateway.js";
export { ProjectMemory, memoryFileFor } from "./memory.js";
export type { MemoryEntry } from "./memory.js";
export { Journal, listSessions, deleteSession, canonicalDigest, sha256, writeFileAtomic } from "./session.js";
export type { JournalIo, SessionState } from "./session.js";
export { Workspace, normalizeRoot, same, isSecretPath, withWorkspaceReferences } from "./workspace.js";
export type { WorkspaceReference } from "./workspace.js";
export { resolveEndpoint, DEFAULT_ENDPOINT } from "./config.js";
export type { Endpoint } from "./config.js";
export { ApprovalMemory } from "./approvals.js";
export { viewChange, viewChanges, renderChange, undoChange, canUndoChange, UndoError } from "./changes.js";
export { safeText, safeLine } from "./display.js";
export type { Output } from "./display.js";
export { planPatchCall } from "./tools.js";
export { currentDigest } from "./patch.js";
export type { PlannedEdit } from "./patch.js";
export { estimateTokens } from "./agent.js";
export const DEFAULTS = { maxRequests: 20, timeoutMinutes: 15, commandTimeoutSeconds: 120 } as const;

/**
 * Named limit sets for one task. standard is the long-standing default.
 * unlimited has no request count or time limit of its own: the user stopping
 * it, the server refusing (key cap, quota), or the model finishing ends it.
 */
export type LimitProfile = NonNullable<SessionState["limits"]["profile"]>;
export const LIMIT_PROFILES = ["standard", "extended", "unlimited"] as const satisfies readonly LimitProfile[];
export const isLimitProfile = (value: unknown): value is LimitProfile => LIMIT_PROFILES.includes(value as LimitProfile);
/** Stands for "no limit" in a saved task: far above any real count or duration, and still plain JSON. */
export const NO_LIMIT = Number.MAX_SAFE_INTEGER;
const PROFILE_LIMITS = {
    standard: { maxRequests: DEFAULTS.maxRequests, timeoutMs: DEFAULTS.timeoutMinutes * 60_000 },
    extended: { maxRequests: 200, timeoutMs: 120 * 60_000 },
    unlimited: { maxRequests: NO_LIMIT, timeoutMs: NO_LIMIT },
} as const satisfies Record<LimitProfile, { maxRequests: number; timeoutMs: number }>;
/** A profile with the more specific numbers (a flag such as --max-requests) laid over it. */
export const resolveLimits = (
    profile: LimitProfile = "standard",
    overrides: { maxRequests?: number; timeoutMs?: number; commandTimeoutMs?: number } = {},
): SessionState["limits"] => ({
    maxRequests: overrides.maxRequests ?? PROFILE_LIMITS[profile].maxRequests,
    timeoutMs: overrides.timeoutMs ?? PROFILE_LIMITS[profile].timeoutMs,
    commandTimeoutMs: overrides.commandTimeoutMs ?? DEFAULTS.commandTimeoutSeconds * 1000,
    profile,
});
/** Goal mode: automatic continuations in a row before it stops and says so. */
export const GOAL_MAX_CONTINUATIONS = 10;
export const createSession = (
    home: string | null,
    options: {
        root: string;
        endpoint: Endpoint;
        keyPrefix: string;
        keyIdentity?: string;
        model: CatalogModel;
        readOnly: boolean;
        limits: SessionState["limits"];
        goal?: SessionState["goal"];
        sessionId?: string;
        codeContinuation?: SessionState["codeContinuation"];
        codeMode?: SessionState["codeMode"];
        codePermission?: SessionState["codePermission"];
    },
    io?: JournalIo,
) =>
    Journal.create(
        home,
        {
            workspace: { root: options.root },
            endpointOrigin: options.endpoint.origin,
            endpointBase: options.endpoint.base,
            keyPrefix: options.keyPrefix,
            ...(options.keyIdentity ? { keyIdentity: options.keyIdentity } : {}),
            ...(options.codeContinuation ? { codeContinuation: options.codeContinuation } : {}),
            ...(options.codeMode ? { codeMode: options.codeMode } : {}),
            ...(options.codePermission ? { codePermission: options.codePermission } : {}),
            readOnly: options.readOnly,
            model: {
                requested: options.model.id,
                pinned: options.model.id === "smart-adaptive" ? null : options.model.id,
                pinnedFrom: options.model.id === "smart-adaptive" ? null : "user",
                contextWindowTokens: options.model.contextWindowTokens,
                maxOutputTokens: options.model.maxOutputTokens,
            },
            limits: options.limits,
            ...(options.goal ? { goal: options.goal } : {}),
        },
        io,
        options.sessionId,
    );
export const validateSession = (journal: Journal, endpoint: Endpoint, keyPrefix: string, catalog?: CatalogModel[]) => {
    const state = journal.state;
    const root = normalizeRoot(state.workspace.root);
    if (!same(root, state.workspace.root)) throw new Error("The session root now resolves elsewhere.");
    if (endpoint.origin !== state.endpointOrigin || (state.endpointBase && endpoint.base !== state.endpointBase))
        throw new Error("This session belongs to a different API endpoint.");
    if (state.keyPrefix !== keyPrefix)
        throw new Error(`This session belongs to key ${state.keyPrefix}; you are using ${keyPrefix}. Resume it with that key, or start a new session.`);
    const model = state.model.pinned ?? state.model.requested;
    if (catalog && !catalog.some((m) => m.id === model)) throw new Error(`${model} is no longer offered; start a new session.`);
    return root;
};
/** This session's own receipts, summed. Never the key's total before and after. */
export const sessionCost = async (gateway: Gateway, journal: Journal, catalog?: CatalogModel[]) => {
    const generations = journal.state.generations;
    const byId = new Map<string, Receipt>();
    try {
        for (const receipt of (await gateway.usage(100)).requests) byId.set(receipt.requestId, receipt);
    } catch {
        // fall back to one lookup per request below
    }
    // Another key cannot see this session's requests; nothing it answers is recorded.
    if (gateway.keyPrefix !== journal.state.keyPrefix) {
        const unknown = generations.filter((g) => !(g.receipt && g.receipt.status !== "held")).map((g) => g.seq);
        const charged = generations.reduce(
            (sum, g) => sum + (g.receipt && g.receipt.status !== "held" && typeof g.receipt.chargedCredits === "number" ? g.receipt.chargedCredits : 0),
            0,
        );
        return { requests: generations.length, charged, held: 0, unknown };
    }
    // Every receipt /usage returned is applied first, whatever its position.
    for (const g of generations) {
        if (g.requestId && byId.has(g.requestId)) {
            g.receipt = byId.get(g.requestId)!;
            g.lookup = "found";
        }
    }
    // Then single lookups for what is still open, the least recently checked
    // first, so repeated runs reach every request rather than the same 40.
    const open = generations
        .filter((g) => !(g.receipt && g.receipt.status !== "held") && !(g.requestId && byId.has(g.requestId)))
        .sort((x, y) => (x.lookupAt ?? "").localeCompare(y.lookupAt ?? ""))
        .slice(0, 40);
    for (const g of open) {
        g.lookup = undefined;
        try {
            const found = await gateway.requestStatus(g.requestId ? { requestId: g.requestId } : { idempotencyKey: g.idempotencyKey });
            if (!found.found || !g.requestId || found.receipt.requestId === g.requestId) {
                g.lookup = found.found ? "found" : "not_found";
                g.receipt = found.found ? found.receipt : null;
                if (found.found) g.requestId = found.receipt.requestId;
            }
        } catch {
            // left as it was: unknown
        }
        g.lookupAt = new Date().toISOString();
    }
    try {
        if (catalog) for (const generation of generations) {
            if (generation.state === "complete") generation.catalogProvider = catalogProviderFor(generation, catalog);
        }
        journal.commit();
    } catch {
        // the totals below are still right for this process
    }
    let charged = 0;
    let held = 0;
    const unknown: number[] = [];
    for (const g of generations) {
        if (g.receipt && g.receipt.status !== "held" && typeof g.receipt.chargedCredits === "number") charged += g.receipt.chargedCredits;
        else if (g.receipt?.status === "held") held += g.receipt.heldCredits;
        else unknown.push(g.seq);
    }
    return { requests: generations.length, charged, held, unknown };
};

export { readProjectInstructions, readInstructions, NestedInstructions } from "./instructions.js";

/**
 * After a crash: what the journal says was under way. A write whose end was
 * not recorded is checked against the file; a command that started and never
 * finished is reported as unknown and is never run again.
 */
export const reconcile = (journal: Journal) => {
    const notes: string[] = [];
    for (const change of journal.state.changes.filter((c) => c.state === "writing")) {
        const view = viewChanges({ ...journal, state: { ...journal.state, changes: [{ ...change, state: "applied" }] } } as Journal)[0];
        change.state = view?.current === "as_written" ? "applied" : "failed";
        notes.push(`A write of ${change.path} was under way: it is ${change.state === "applied" ? "complete" : "not complete (the file was left as it is)"}.`);
    }
    for (const record of (journal.state.background ?? []).filter((b) => b.state === "running")) {
        // The CLI that started it is gone: it was ended with its task if that ended cleanly, otherwise it is no longer tracked.
        record.state = "exited";
        record.endReason ??= "task_ended";
        record.endedAt ??= new Date().toISOString();
        notes.push(`Background command ${record.handle} (${record.display.slice(0, 80)}) was running when the CLI stopped; it is no longer tracked.`);
    }
    for (const tool of journal.state.tools.filter((t) => t.state === "started")) {
        notes.push(`${tool.toolName} (${tool.toolCallId}) had started and its outcome is unknown; it was not run again.`);
    }
    if (notes.length) journal.commit();
    return notes;
};

/** A known exit code does not settle a command with an unconfirmed process tree. */
export function hasUnconfirmedToolOutcome(tool: SessionState["tools"][number]): boolean {
    const result = tool.output as { processTreeChecked?: boolean; residualProcesses?: number[] } | undefined;
    return tool.state === "started" || result?.processTreeChecked === false || Boolean(result?.residualProcesses?.length);
}
