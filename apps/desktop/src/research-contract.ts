import { z } from "zod";
import { researchBriefSchema, researchSourceSelectionSchema } from "../../../lib/researchEngineContract";
import type { ResearchPreviewRunDto } from "../../../lib/researchPreviewRunTypes";
import type { ResearchRunView } from "../../../packages/chat-core/src/research";

/**
 * Desktop Research IPC: the Research engine (v2) and Research Preview. Typed actions only; the main
 * process maps each to one workspace API call on the account session. Starting a run is paid work,
 * so every start carries the maximum credits the person confirmed in the renderer.
 */

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const messageId = z.uuid();
const profile = z.enum(["standard", "deep"]);

export const researchCreateInput = z.object({
  conversationId: id.optional(),
  userMessageId: messageId,
  assistantMessageId: messageId,
  brief: researchBriefSchema,
  sources: z.array(researchSourceSelectionSchema).max(50).default([]),
  profile: profile.default("standard"),
  approvedCredits: z.number().int().min(1).max(100_000),
  autoStart: z.boolean().default(false),
  locale: z.string().trim().min(2).max(35).optional(),
}).strict();

/** The run actions the Desktop workspace offers; plan editing as raw JSON is not one of them. */
export const researchStep = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), expectedPlanRevision: z.number().int().min(0), feedback: z.string().trim().max(4_000).optional() }).strict(),
  z.object({ kind: z.literal("approve"), planRevision: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal("pause") }).strict(),
  z.object({ kind: z.literal("resume") }).strict(),
  z.object({ kind: z.literal("cancel") }).strict(),
  z.object({ kind: z.literal("finish") }).strict(),
  z.object({ kind: z.literal("budget"), expectedApprovedCredits: z.number().int().min(0), approvedCredits: z.number().int().min(1).max(100_000) }).strict(),
  z.object({ kind: z.literal("scope"), expectedInputRevision: z.number().int().min(0), addQuestions: z.array(z.string().trim().min(1).max(2_000)).max(10) }).strict(),
  z.object({
    kind: z.literal("revisions"), expectedReportRevision: z.number().int().min(1),
    revisionKind: z.enum(["format", "conditions", "refresh", "redact_public"]), instruction: z.string().trim().max(4_000).optional(),
  }).strict(),
]);
export type ResearchStep = z.infer<typeof researchStep>;

export const researchExportFormat = z.enum(["md", "pdf", "docx", "csv", "xlsx"]);

export const desktopResearchInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("offer"), profile }).strict(),
  z.object({ action: z.literal("create"), payload: researchCreateInput }).strict(),
  z.object({ action: z.literal("runs"), conversationId: id }).strict(),
  z.object({ action: z.literal("read"), runId: id }).strict(),
  z.object({ action: z.literal("act"), runId: id, step: researchStep }).strict(),
  z.object({ action: z.literal("sources"), runId: id, cursor: id.optional() }).strict(),
  z.object({ action: z.literal("evidence"), runId: id, chunkId: id, start: z.number().int().min(0).optional(), end: z.number().int().min(1).optional() }).strict(),
  z.object({ action: z.literal("report"), runId: id, revision: z.number().int().min(1).optional() }).strict(),
  z.object({ action: z.literal("export"), runId: id, format: researchExportFormat, revision: z.number().int().min(1).optional() }).strict(),
  z.object({ action: z.literal("remove"), runId: id }).strict(),
  z.object({
    action: z.literal("previewOffer"),
    input: z.object({ conversationId: id.optional(), modelId: z.string().min(1).max(100), question: z.string().trim().min(1).max(4_000) }).strict(),
  }).strict(),
  z.object({
    action: z.literal("previewStart"),
    input: z.object({
      conversationId: id.optional(), requestId: messageId, modelId: z.string().min(1).max(100),
      question: z.string().trim().min(1).max(4_000), locale: z.string().trim().min(2).max(16).optional(),
    }).strict(),
  }).strict(),
  z.object({ action: z.literal("previewRead"), runId: id }).strict(),
  z.object({ action: z.literal("previewAct"), runId: id, step: z.enum(["resume", "cancel"]) }).strict(),
]);
export type DesktopResearchInput = z.infer<typeof desktopResearchInput>;
export type DesktopResearchAction = DesktopResearchInput["action"];

export type ResearchEngineOffer = {
  offered: boolean; reason?: string;
  features?: { enabled?: boolean; defaultEntry: boolean; privateSources: boolean; projectSources: boolean; maxApprovedCredits: number };
  estimate?: { lowCredits: number; highCredits: number; perCallCredits: number };
};
export type ResearchPreviewOffer = {
  offered: boolean; reason?: string; estimatedCredits?: number; features?: { pageReading: boolean; durableRuns: boolean };
};
export type DesktopResearchRun = ResearchPreviewRunDto;

export type ResearchSource = { id: string; sourceKey: string; title?: string | null; url?: string | null; visibility?: string; duplicateOf?: string | null;
  versions?: Array<{ readStatus: string }> };
export type ResearchClaim = { claimKey: string; text: string; verification: string;
  evidence: Array<{ sourceKey: string; chunkId?: string; level: string; start: number; end: number }> };
export type ResearchReport = { markdown: string; revision: number; revisions: Array<{ revision: number; author: string }>; containsPrivate: boolean; claims?: ResearchClaim[] };
export type ResearchEvidence = { text: string; sourceKey: string; highlight: { start: number; end: number }; url: string | null };

export type DesktopResearchValue = {
  offer: ResearchEngineOffer;
  create: ResearchRunView;
  runs: DesktopResearchRun[];
  read: ResearchRunView;
  /** `run` is null when neither the action nor the read-back could reach the server. */
  act: { run: ResearchRunView | null; readback: boolean; error?: { status: number; code: string } };
  sources: { sources: ResearchSource[]; nextCursor?: string | null };
  evidence: ResearchEvidence;
  report: ResearchReport;
  /** True once the file was saved; false when the save dialog was cancelled. */
  export: boolean;
  remove: unknown;
  previewOffer: ResearchPreviewOffer;
  previewStart: { run: DesktopResearchRun; conversationId: string };
  previewRead: DesktopResearchRun;
  previewAct: DesktopResearchRun;
};

export type DesktopResearchOutcome<Action extends DesktopResearchAction = DesktopResearchAction> =
  | { ok: true; value: DesktopResearchValue[Action] }
  /** `conversationId` is set when a start saved its question before it failed, so the chat can still be opened. */
  | { ok: false; status: number; code: string; conversationId?: string };
