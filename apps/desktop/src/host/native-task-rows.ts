import { z } from "zod";
import { safeLine } from "../../../tomverse-cli/src/display.js";
import { sha256 } from "../../../tomverse-cli/src/session.js";
import { taskAnalysisSchema, type TaskAnalysis } from "../../../tomverse-cli/src/task-plan.js";
import { asProposedCodePlan, type CodeNativeAssignment, type CodeTaskPlan } from "../contract";

export const nativePlanPhase = z.enum(["pending", "in_progress", "completed"]);
export const maxNativePlanItems = 24;
export type NativePlanItem = { id?: string; content: string; status: z.infer<typeof nativePlanPhase> };
export type NativeRow = CodeTaskPlan["items"][number];
export type NativeAnalysis = { rowId: string; content: string; summary: TaskAnalysis };

const analyzedEntry = z.object({ title: z.string().trim().min(1).max(160), turnId: z.uuid(), analysis: taskAnalysisSchema }).strict();
export const nativeAnalysisInstruction = (turnId: string) =>
  `Inspect relevant project files read-only first. If inspection leaves the requested outcome or change scope unclear, ask a focused question and wait. To publish the analysis, use the native task list tool with this JSON string in the first work item's title or content, replacing the examples with actual analysis: {"title":"Short task title","turnId":"${turnId}","analysis":{"objective":"Goal","verifiedFacts":[],"assumptions":[],"scope":"Scope","verification":"Verification","completion":"Done when"}}. Keep the JSON under 1500 characters.`;
function readAnalyzedEntry(content: string) {
  if (content.startsWith("{")) {
    try {
      const parsed = analyzedEntry.safeParse(JSON.parse(content));
      if (parsed.success) return parsed.data;
    } catch { /* Plain task titles do not carry analysis. */ }
  }
}

export function completedNativeRow(row: NativeRow) {
  const current = row.evidence.slice(row.evidenceStart ?? 0);
  return !row.cancelled && row.nativeStatus === "completed" && current.length > 0 &&
    current.every(({ state }) => state === "succeeded") &&
    !row.evidence.some(({ state }) => state === "running" || state === "unconfirmed");
}

export function snapshotNativePlan(rows: ReadonlyMap<string, NativeRow>, input: {
  activeId: string | null; analysis?: TaskAnalysis; streaming: boolean; stopped: boolean; planOnly: boolean;
}): CodeTaskPlan | undefined {
  if (!rows.size) return;
  const plan: CodeTaskPlan = { activeId: input.activeId, analysis: input.analysis, items: [...rows.values()].map((row) => {
    const complete = completedNativeRow(row);
    return { ...row, complete, cancelled: row.cancelled || (input.stopped && (input.planOnly || row.nativeStatus !== "completed")),
      completionUnverified: row.nativeStatus === "completed" && !complete,
      evidence: row.evidence.map((record) => !input.streaming && record.state === "running" ? { ...record, state: "unconfirmed" } : { ...record }) };
  }) };
  return input.planOnly ? asProposedCodePlan(plan) : plan;
}

export function reconcileNativeRows(
  rows: Map<string, NativeRow>,
  entries: NativePlanItem[],
  session: CodeNativeAssignment,
  provider: { prefix: string; titleKey: boolean; planOnly: boolean },
) {
  if (entries.filter(({ status }) => status === "in_progress").length > 1) return;
  const updated = new Map<string, NativeRow>();
  let firstAnalysis: TaskAnalysis | undefined;
  let currentAnalysis: NativeAnalysis | undefined;
  for (const { content, status, id: nativeId } of entries) {
    const analyzed = readAnalyzedEntry(content);
    const label = analyzed?.title ?? content;
    const rowKey = provider.titleKey ? sha256(label).slice(0, 32) : nativeId;
    const id = `${provider.prefix}-${rowKey ?? ""}`;
    const title = safeLine(label).trim();
    if (!title || !rowKey || updated.has(id)) return;
    const previous = rows.get(id);
    const freshAnalysis = analyzed?.turnId === session.turnId;
    const currentAssignment = previous?.nativeAssignment?.turnId === session.turnId;
    const reopeningSavedRow = status === "in_progress" && freshAnalysis && !currentAssignment;
    if (previous?.nativeStatus === "completed" && !previous.cancelled && previous.title === title &&
        status !== "completed" && !reopeningSavedRow) {
      updated.set(id, previous);
      continue;
    }
    if (freshAnalysis) {
      firstAnalysis ??= analyzed.analysis;
      if (status === "in_progress") currentAnalysis = { rowId: id, content, summary: analyzed.analysis };
    }
    const evidence = previous?.evidence ?? [];
    const freshWork = previous && (previous.cancelled || previous.title !== title ||
      (status === "in_progress" && (!currentAssignment || previous.nativeStatus === "completed")) ||
      (status === "pending" && previous.nativeStatus === "in_progress"));
    updated.set(id, { id, title, segmentId: session.threadId, nativeStatus: status, evidence,
      nativeAssignment: status === "in_progress" ? session : !freshWork ? previous?.nativeAssignment : undefined,
      evidenceStart: freshWork ? evidence.length : previous?.evidenceStart, complete: false, cancelled: false });
  }
  for (const [id, row] of rows) {
    if (!updated.has(id)) updated.set(id, { ...row, cancelled: provider.planOnly || !completedNativeRow(row) });
  }
  if (updated.size > maxNativePlanItems) return;
  return { rows: updated, currentAnalysis, firstAnalysis };
}
