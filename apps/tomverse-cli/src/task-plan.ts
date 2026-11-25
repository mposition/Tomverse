import { z } from "zod";

const itemId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const callId = z.string().min(1).max(160).regex(/^[\w.:-]+$/);
const title = z.string().trim().min(1).max(160);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const item = z.object({ id: itemId, title }).strict();
const analysisText = z.string().trim().min(1).max(480);
export const taskAnalysisSchema = z.object({
    objective: analysisText,
    verifiedFacts: z.array(analysisText).max(6),
    assumptions: z.array(analysisText).max(6),
    scope: analysisText,
    verification: analysisText,
    completion: analysisText,
}).strict();
export type TaskAnalysis = z.infer<typeof taskAnalysisSchema>;

export function parseTaskAnalysis(value: unknown): TaskAnalysis | undefined {
    if (typeof value !== "string" || value.length > 12_000) return undefined;
    try { return taskAnalysisSchema.safeParse(JSON.parse(value)).data; }
    catch { return undefined; }
}

export const taskPlanInput = z.object({
    revision,
    items: z.array(item).max(12),
    activeId: itemId.nullable(),
    completeId: itemId.optional(),
    analysis: taskAnalysisSchema.optional(),
    clarification: analysisText.optional(),
}).strict();

const tool = z.enum(["list_files", "search_text", "read_file", "apply_patch", "run_command"]);
const evidenceState = z.enum(["running", "approval", "succeeded", "failed", "denied", "unconfirmed"]);
const assignmentSchema = z.object({ model: z.string().min(1).max(160), requestSeq: z.number().int().positive() }).strict();
const evidenceSchema = z.object({ callId, tool, state: evidenceState, assignment: assignmentSchema.optional() }).strict();
const itemState = item.extend({
    complete: z.boolean(),
    cancelled: z.boolean(),
    evidence: z.array(evidenceSchema).max(32),
    evidenceStart: z.number().int().nonnegative().max(32).optional(),
}).refine((row) => (row.evidenceStart ?? 0) <= row.evidence.length);
export const taskPlanSchema = z.object({
    revision, firstCallId: callId, activeId: itemId.nullable(), items: z.array(itemState).max(12),
    analysis: taskAnalysisSchema.optional(),
    clarification: analysisText.optional(),
}).strict().refine((plan) => {
    const ids = new Set(plan.items.map((row) => row.id));
    const calls = plan.items.flatMap((row) => row.evidence.map((entry) => entry.callId));
    return ids.size === plan.items.length && new Set(calls).size === calls.length && (plan.activeId === null || ids.has(plan.activeId)) &&
        (!plan.clarification || plan.activeId === null && !!plan.analysis);
});
export type TaskPlan = z.infer<typeof taskPlanSchema>;
export type TaskPlanEvidence = z.infer<typeof evidenceSchema>;

export const taskPlanAssignmentsSchema = z.object({
    revision,
    rows: z.array(item.extend({ assignment: assignmentSchema })).max(12),
}).strict().refine(({ rows }) => new Set(rows.map(({ id }) => id)).size === rows.length);
export type TaskPlanAssignments = z.infer<typeof taskPlanAssignmentsSchema>;

export function updatePlanAssignments(current: TaskPlan | undefined, recorded: TaskPlanAssignments | undefined,
    plan: TaskPlan, assignment: TaskPlanEvidence["assignment"]): TaskPlanAssignments | undefined {
    const parsed = taskPlanAssignmentsSchema.safeParse(recorded).data;
    const previous = new Map(parsed?.revision === current?.revision ? parsed?.rows.map((row) => [row.id, row]) : []);
    const rows: TaskPlanAssignments["rows"] = [];
    for (const { id, title } of plan.items) {
        const earlier = previous.get(id);
        if (earlier?.title === title && (id !== plan.activeId || id === current?.activeId)) rows.push(earlier);
        else if (id === plan.activeId && assignment) rows.push({ id, title, assignment });
    }
    if (rows.length) return { revision: plan.revision, rows };
}

export function updateTaskPlan(current: TaskPlan | undefined, update: z.infer<typeof taskPlanInput>, toolCallId: string) {
    const revision = current?.revision ?? 0;
    const proposals = update.clarification && update.items.length === 0 && current ? current.items : update.items;
    const nextIds = new Set(proposals.map(({ id }) => id));
    if (update.revision !== revision) return { error: "The plan revision changed.", revision };
    if (current?.clarification) return { error: "Wait for the user's answer before revising this plan.", revision };
    if (update.clarification ? update.activeId !== null || update.completeId !== undefined || !update.analysis
        : update.items.length === 0) return { error: "A clarification requires fresh analysis and no active or completed item. Otherwise provide work items.", revision };
    if (!callId.safeParse(toolCallId).success || nextIds.size !== proposals.length ||
        (update.activeId !== null && !nextIds.has(update.activeId))) return { error: "Invalid or duplicate plan items.", revision };

    const previous = new Map(current?.items.map((row) => [row.id, row]));
    const complete = update.completeId && previous.get(update.completeId);
    if (update.completeId && (!complete || current?.activeId !== complete.id || complete.complete || !canComplete(complete.evidence, complete.evidenceStart))) {
        return { error: "Completion requires successful recorded work for the active item.", revision };
    }
    if (update.activeId && (previous.get(update.activeId)?.complete || previous.get(update.activeId)?.cancelled ||
        update.activeId === update.completeId)) return { error: "Choose an open item as active.", revision };

    const items: TaskPlan["items"] = [];
    for (const proposal of proposals) {
        const existing = previous.get(proposal.id);
        if (existing && (existing.complete || existing.cancelled || complete && existing.id === complete.id) && existing.title !== proposal.title) {
            return { error: "Keep the title of a finished item.", revision };
        }
        const evidenceStart = existing && existing.title !== proposal.title ? existing.evidence.length : existing?.evidenceStart;
        items.push({ id: proposal.id, title: proposal.title, complete: existing?.complete === true || !!complete && proposal.id === complete.id,
            cancelled: existing?.cancelled === true, evidence: existing?.evidence ?? [], ...(evidenceStart ? { evidenceStart } : {}) });
    }
    // Preserve evidence and terminal rows when a plan is shortened.
    for (const row of previous.values()) {
        if (!nextIds.has(row.id)) {
            const finished = row.complete || !!complete && row.id === complete.id;
            items.push({ ...row, complete: finished, cancelled: !finished });
        }
    }
    if (items.length > 12) return { error: "The plan already contains twelve items.", revision };
    const analysis = update.analysis ?? current?.analysis;
    if (analysis && !taskAnalysisSchema.safeParse(analysis).success) return { error: "The public analysis is invalid.", revision };
    return { plan: { revision: revision + 1, firstCallId: current?.items.length ? current.firstCallId : toolCallId, activeId: update.activeId, items,
        ...(analysis ? { analysis } : {}), ...(update.clarification ? { clarification: update.clarification } : {}) } };
}

export function resetActivePlanEvidence(plan: TaskPlan) {
    plan.activeId = null;
    delete plan.analysis;
    delete plan.clarification;
    for (const row of plan.items) {
        if (!row.complete && !row.cancelled) row.evidenceStart = row.evidence.length;
    }
}

export function canComplete(evidence: TaskPlanEvidence[], evidenceStart = 0) {
    if (evidence.some(({ state }) => state === "running" || state === "approval" || state === "unconfirmed")) return false;
    const latestByTool = new Map(evidence.slice(evidenceStart).map((entry) => [entry.tool, entry.state]));
    return latestByTool.size > 0 && [...latestByTool.values()].every((state) => state === "succeeded");
}

export function startPlanEvidence(plan: TaskPlan, call: string, name: string, state: "running" | "approval", assignment?: TaskPlanEvidence["assignment"]) {
    const row = plan.items.find((item) => item.id === plan.activeId);
    if (!row || row.complete || row.cancelled || row.evidence.length >= 32 ||
        plan.items.some((item) => item.evidence.some((entry) => entry.callId === call))) return false;
    const parsed = evidenceSchema.safeParse({ callId: call, tool: name, state, assignment });
    if (!parsed.success) return false;
    row.evidence.push(parsed.data);
    return true;
}

export function settlePlanEvidence(plan: TaskPlan, call: string, state: TaskPlanEvidence["state"]) {
    const entry = plan.items.flatMap((item) => item.evidence).find((item) => item.callId === call);
    if (!entry || entry.state === state || (entry.state !== "running" && entry.state !== "approval")) return false;
    entry.state = state;
    return true;
}

export function toolPlanOutcome(name: string, output: unknown): TaskPlanEvidence["state"] {
    if (typeof output !== "object" || output === null) return "failed";
    const result = output as Record<string, unknown>;
    if (result.processTreeChecked === false || (Array.isArray(result.residualProcesses) && result.residualProcesses.length > 0)) return "unconfirmed";
    return result.status === "ok" && (name !== "run_command" || result.exitCode === 0) ? "succeeded" : "failed";
}
