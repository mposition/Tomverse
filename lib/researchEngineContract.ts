import { z } from "zod";

/**
 * Research engine v2 contract: the closed vocabularies the database checks,
 * the bounded shapes that enter durable rows, and the structured outputs each
 * model role must return. Framework-neutral and server-safe; no I/O.
 *
 * Product limits here are configuration defaults for one run, not financial
 * authority. Money is bounded by the run's approved credits and the existing
 * Chat reservation contract (lib/researchEngineFunding.ts).
 */

export const RESEARCH_ENGINE_VERSION = 2 as const;

export const RESEARCH_WORK_ITEM_KINDS = [
  "plan", "investigate", "search", "read", "analyze_private", "coordinate",
  "verify", "write_section", "synthesize",
] as const;
export const RESEARCH_WORK_ITEM_STATUSES = [
  "queued", "running", "completed", "failed", "cancelled", "attention", "superseded", "blocked",
] as const;
export const RESEARCH_FUNDING_SEGMENT_PURPOSES = ["plan", "work", "finalization"] as const;
export const RESEARCH_FUNDING_SEGMENT_STATUSES = ["reserving", "reserved", "settled", "released", "unknown"] as const;
export const RESEARCH_SOURCE_ORIGINS = [
  "web_search", "user_url", "discovered_link", "attachment", "conversation", "memory", "knowledge", "project",
] as const;
export const RESEARCH_PUBLIC_ORIGINS = ["web_search", "user_url", "discovered_link"] as const;
export const RESEARCH_PRIVATE_ORIGINS = ["attachment", "conversation", "memory", "knowledge", "project"] as const;
export const RESEARCH_SOURCE_VISIBILITIES = ["public", "private"] as const;
export const RESEARCH_SOURCE_STATUSES = ["active", "revoked", "excluded"] as const;
export const RESEARCH_READ_STATUSES = ["snippet_only", "read", "unavailable"] as const;
export const RESEARCH_EXTRACTION_METHODS = [
  "search_snippet", "html_text", "plain_text", "pdf_text", "office_text", "sheet_rows", "csv_rows",
  "conversation_messages", "memory_item", "knowledge_chunks", "project_material", "none",
] as const;
export const RESEARCH_CLAIM_KINDS = ["fact", "inference", "uncertain"] as const;
export const RESEARCH_CLAIM_VERIFICATIONS = ["supported", "partial", "conflicting", "unverified", "unsupported"] as const;
export const RESEARCH_QUALITY_STATUSES = ["complete", "partial", "insufficient_evidence"] as const;
export const RESEARCH_REPORT_AUTHORS = ["model", "user_edit", "follow_up", "redaction"] as const;
export const RESEARCH_REPORT_VISIBILITIES = ["owner", "public"] as const;
export const RESEARCH_PLAN_AUTHORS = ["model", "user"] as const;
export const RESEARCH_DISPATCH_KINDS = ["model", "search", "read"] as const;
export const RESEARCH_MODEL_ROLES = ["planner", "researcher", "analyst", "coordinator", "verifier", "writer"] as const;
export const RESEARCH_CLEANUP_REASONS = [
  "run_deleted", "conversation_deleted", "account_deleted", "source_revoked", "superseded", "write_pending", "write_abandoned",
] as const;

export type ResearchWorkItemKind = (typeof RESEARCH_WORK_ITEM_KINDS)[number];
export type ResearchWorkItemStatus = (typeof RESEARCH_WORK_ITEM_STATUSES)[number];
export type ResearchSourceOrigin = (typeof RESEARCH_SOURCE_ORIGINS)[number];
export type ResearchModelRole = (typeof RESEARCH_MODEL_ROLES)[number];
export type ResearchQualityStatus = (typeof RESEARCH_QUALITY_STATUSES)[number];
export type ResearchClaimVerification = (typeof RESEARCH_CLAIM_VERIFICATIONS)[number];

/** Which model role a work item dispatches, if any. Search and read are not model calls. */
export const RESEARCH_ITEM_ROLE: Record<ResearchWorkItemKind, ResearchModelRole | null> = {
  plan: "planner", investigate: "researcher", analyze_private: "analyst", coordinate: "coordinator",
  verify: "verifier", write_section: "writer", synthesize: "writer", search: null, read: null,
};

/** Roles that may see private material. None of them is given a search or fetch tool. */
export const RESEARCH_PRIVATE_ROLES: ReadonlySet<ResearchModelRole> = new Set(["analyst", "verifier", "writer"]);
/** Roles that may cause public web traffic. They are only ever given public context. */
export const RESEARCH_PUBLIC_TRAFFIC_ROLES: ReadonlySet<ResearchModelRole> = new Set(["planner", "researcher", "coordinator"]);

/** Run profiles describe intensity, never a promise of source counts. */
export const RESEARCH_PROFILES = {
  standard: { maxSubquestions: 6, maxInvestigateTurnsPerQuestion: 4, maxCoordinatorRounds: 2,
    maxReadsPerTurn: 6, maxSearchesPerTurn: 5, maxSections: 8, maxRepairAttempts: 2, runDeadlineMinutes: 120 },
  deep: { maxSubquestions: 12, maxInvestigateTurnsPerQuestion: 6, maxCoordinatorRounds: 4,
    maxReadsPerTurn: 10, maxSearchesPerTurn: 5, maxSections: 14, maxRepairAttempts: 2, runDeadlineMinutes: 360 },
} as const;
export type ResearchProfileName = keyof typeof RESEARCH_PROFILES;
export type ResearchProfile = (typeof RESEARCH_PROFILES)[ResearchProfileName];

/** Resource bounds that exist for safety (request size, memory), not as Preview product caps. */
export const RESEARCH_RESOURCE_LIMITS = {
  maxBriefCharacters: 60_000,
  maxObjectiveCharacters: 4_000,
  maxManifestEntries: 50,
  maxUserUrls: 30,
  maxDomainFilters: 30,
  maxReadBytes: 8 * 1024 * 1024,
  maxExtractedCharacters: 2_000_000,
  chunkCharacters: 4_000,
  chunkOverlapCharacters: 200,
  maxChunksPerPromptRead: 6,
  maxPromptEvidenceCharacters: 48_000,
  maxDiscoveredLinksPerPage: 40,
  maxSourcesPerRun: 5_000,
  maxClaimsPerRevision: 600,
  maxSectionBlocks: 60,
  maxStoredPerRunBytes: 512 * 1024 * 1024,
} as const;

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const locale = z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
const domain = z.string().trim().toLowerCase().max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);
export const researchSourceKeySchema = z.string().regex(/^(?:W|P)[1-9]\d{0,4}$/);
export const researchClaimKeySchema = z.string().regex(/^C[1-9]\d{0,3}$/);
export const researchSectionKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const cuid = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

/** What the user asked for. The question is the user's own text and can be long. */
export const researchBriefSchema = z.object({
  question: trimmed(RESEARCH_RESOURCE_LIMITS.maxBriefCharacters),
  objective: trimmed(RESEARCH_RESOURCE_LIMITS.maxObjectiveCharacters).optional(),
  deliverable: z.enum(["report", "comparison", "brief", "literature_review", "timeline"]).default("report"),
  outputLanguage: locale.optional(),
  searchLanguages: z.array(locale).max(6).default([]),
  regions: z.array(z.string().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase())).max(6).default([]),
  period: z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict().optional(),
  freshness: z.enum(["day", "week", "month", "year"]).optional(),
  includeDomains: z.array(domain).max(RESEARCH_RESOURCE_LIMITS.maxDomainFilters).default([]),
  excludeDomains: z.array(domain).max(RESEARCH_RESOURCE_LIMITS.maxDomainFilters).default([]),
  constraints: z.array(trimmed(500)).max(20).default([]),
}).strict();
export type ResearchBrief = z.infer<typeof researchBriefSchema>;

/** A user's selection of a private source, as the client may name it. Resolved server-side. */
export const researchSourceSelectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), url: z.string().trim().min(8).max(2048) }).strict(),
  z.object({ type: z.literal("attachment"), attachmentId: cuid }).strict(),
  z.object({ type: z.literal("conversation"), conversationId: cuid,
    fromMessageId: z.string().min(1).max(64).optional(), toMessageId: z.string().min(1).max(64).optional() }).strict(),
  z.object({ type: z.literal("memory"), memoryItemId: cuid }).strict(),
  z.object({ type: z.literal("knowledge"), knowledgeFileId: cuid }).strict(),
  z.object({ type: z.literal("project"), projectId: cuid, materialId: cuid.optional() }).strict(),
]);
export type ResearchSourceSelection = z.infer<typeof researchSourceSelectionSchema>;

/** One server-resolved manifest entry. `revision` is a digest of what made the grant valid. */
export const researchManifestEntrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), key: researchSourceKeySchema, url: z.string().url().max(2048) }).strict(),
  z.object({ type: z.literal("attachment"), key: researchSourceKeySchema, attachmentId: cuid, conversationId: cuid,
    revision: z.string().max(128), label: z.string().max(200) }).strict(),
  z.object({ type: z.literal("conversation"), key: researchSourceKeySchema, conversationId: cuid,
    messageIds: z.array(z.string().max(64)).min(1).max(400), passwordVersion: z.number().int().nullable(),
    revision: z.string().max(128), label: z.string().max(200) }).strict(),
  z.object({ type: z.literal("memory"), key: researchSourceKeySchema, memoryItemId: cuid,
    revision: z.string().max(128), label: z.string().max(200) }).strict(),
  z.object({ type: z.literal("knowledge"), key: researchSourceKeySchema, knowledgeFileId: cuid,
    revision: z.string().max(128), label: z.string().max(200) }).strict(),
  z.object({ type: z.literal("project"), key: researchSourceKeySchema, projectId: cuid, materialId: cuid.optional(),
    revision: z.string().max(128), label: z.string().max(200) }).strict(),
]);
export type ResearchManifestEntry = z.infer<typeof researchManifestEntrySchema>;
export type ResearchPrivateManifestEntry = Exclude<ResearchManifestEntry, { type: "url" }>;

export const researchInputManifestSchema = z.object({
  version: z.literal(1),
  brief: researchBriefSchema,
  /** The text the user agreed may be sent to public search. Defaults to the question only. */
  publicBrief: trimmed(RESEARCH_RESOURCE_LIMITS.maxBriefCharacters),
  entries: z.array(researchManifestEntrySchema).max(RESEARCH_RESOURCE_LIMITS.maxManifestEntries),
  profile: z.enum(["standard", "deep"]),
  locale,
  currentDate: isoDate,
  /** Scope edits after the start; each applies to items created after its inputRevision. */
  amendments: z.array(z.object({
    inputRevision: z.number().int().min(1),
    addQuestions: z.array(trimmed(2_000)).max(10).default([]),
    excludeSourceKeys: z.array(researchSourceKeySchema).max(100).default([]),
    excludeDomains: z.array(domain).max(30).default([]),
    priorityNote: trimmed(1_000).optional(),
  }).strict()).max(50).default([]),
  /** Start research as soon as a non-blocking plan exists, without a separate approval step. */
  autoStart: z.boolean().default(false),
  /** Report changes requested after a report exists. Each becomes one new revision. */
  revisionRequests: z.array(researchRevisionRequestSchema()).max(50).default([]),
}).strict();
export type ResearchInputManifest = z.infer<typeof researchInputManifestSchema>;

function researchRevisionRequestSchema() {
  return z.object({
    inputRevision: z.number().int().min(1),
    parentRevision: z.number().int().min(1),
    kind: z.enum(["format", "section_research", "conditions", "refresh", "redact_public"]),
    sectionKeys: z.array(researchSectionKeySchema).max(20).default([]),
    instruction: z.string().trim().max(4_000).optional(),
  }).strict();
}
export type ResearchRevisionRequest = ResearchInputManifest["revisionRequests"][number];

/** Planner output. Parsed strictly; code then checks it against the profile. */
export const researchPlanSchema = z.object({
  objective: trimmed(2_000),
  assumptions: z.array(trimmed(500)).max(10),
  clarifications: z.array(z.object({
    question: trimmed(500),
    why: trimmed(500),
    blocking: z.boolean(),
  }).strict()).max(5),
  subquestions: z.array(z.object({
    key: researchSectionKeySchema,
    question: trimmed(1_000),
    rationale: trimmed(600),
    queries: z.array(trimmed(400)).min(1).max(8),
    searchLanguages: z.array(locale).max(4).default([]),
    sourceStrategy: trimmed(400),
  }).strict()).min(1).max(20),
  completionCriteria: z.array(trimmed(400)).min(1).max(12),
  outline: z.array(z.object({
    key: researchSectionKeySchema,
    heading: trimmed(160),
    purpose: trimmed(400),
    subquestionKeys: z.array(researchSectionKeySchema).max(20),
    table: z.boolean().default(false),
  }).strict()).min(1).max(20),
}).strict();
export type ResearchPlan = z.infer<typeof researchPlanSchema>;

const evidenceRefSchema = z.object({
  sourceKey: researchSourceKeySchema,
  /** A short verbatim quote from text the model received. Checked deterministically. */
  quote: trimmed(600),
}).strict();

export const researchFindingSchema = z.object({
  text: trimmed(1_200),
  kind: z.enum(RESEARCH_CLAIM_KINDS),
  evidence: z.array(evidenceRefSchema).max(6),
  asOf: isoDate.optional(),
}).strict();
export type ResearchFinding = z.infer<typeof researchFindingSchema>;

/** One researcher turn: ask for tool work or record findings. Never both unbounded. */
export const researchInvestigateTurnSchema = z.object({
  searches: z.array(z.object({
    query: trimmed(400),
    searchLanguage: locale.optional(),
    country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    freshness: z.enum(["day", "week", "month", "year"]).optional(),
  }).strict()).max(5),
  reads: z.array(z.object({
    sourceKey: researchSourceKeySchema,
    /** Which chunk range to read next for long documents; 0-based. */
    fromChunk: z.number().int().min(0).max(10_000).default(0),
  }).strict()).max(10),
  findings: z.array(researchFindingSchema).max(20),
  openQuestions: z.array(trimmed(400)).max(8),
  done: z.boolean(),
}).strict();
export type ResearchInvestigateTurn = z.infer<typeof researchInvestigateTurnSchema>;

export const researchPrivateAnalysisSchema = z.object({
  findings: z.array(researchFindingSchema).max(30),
  limitations: z.array(trimmed(400)).max(6),
}).strict();

export const researchCoordinatorSchema = z.object({
  decision: z.enum(["continue", "finish"]),
  newSubquestions: z.array(z.object({
    key: researchSectionKeySchema, question: trimmed(1_000), queries: z.array(trimmed(400)).min(1).max(6),
  }).strict()).max(6),
  coverage: z.array(z.object({ criterion: trimmed(400), met: z.boolean(), note: trimmed(400) }).strict()).max(12),
}).strict();

export const researchVerificationSchema = z.object({
  verdicts: z.array(z.object({
    claimKey: researchClaimKeySchema,
    verification: z.enum(RESEARCH_CLAIM_VERIFICATIONS),
    /** Numbers, dates and units in the claim compared with the quoted evidence. */
    numericCheck: z.enum(["consistent", "mismatch", "not_applicable"]),
    revisedText: trimmed(1_200).optional(),
    note: trimmed(400).optional(),
  }).strict()).max(60),
}).strict();

const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: trimmed(4_000), claimKeys: z.array(researchClaimKeySchema).max(20) }).strict(),
  z.object({ type: z.literal("table"), caption: trimmed(300), columns: z.array(trimmed(120)).min(1).max(12),
    rows: z.array(z.array(z.string().max(500)).min(1).max(12)).min(1).max(200),
    claimKeys: z.array(researchClaimKeySchema).max(60) }).strict(),
]);
export const researchSectionDraftSchema = z.object({
  heading: trimmed(160),
  blocks: z.array(blockSchema).min(1).max(RESEARCH_RESOURCE_LIMITS.maxSectionBlocks),
}).strict();
export type ResearchSectionDraft = z.infer<typeof researchSectionDraftSchema>;

export const researchSynthesisSchema = z.object({
  title: trimmed(200),
  summary: trimmed(6_000),
  scopeNote: trimmed(2_000),
  conflicts: z.array(z.object({ text: trimmed(1_200), claimKeys: z.array(researchClaimKeySchema).min(1).max(10) }).strict()).max(20),
  limitations: z.array(trimmed(600)).min(1).max(20),
  nextQuestions: z.array(trimmed(400)).max(10),
  criteria: z.array(z.object({ criterion: trimmed(400), met: z.boolean() }).strict()).max(12),
}).strict();

/** A stored report document. Rendering and exports read only this. */
export const researchReportDocumentSchema = z.object({
  version: z.literal(1),
  title: trimmed(200),
  summary: trimmed(6_000),
  scope: z.object({
    question: trimmed(RESEARCH_RESOURCE_LIMITS.maxBriefCharacters),
    assumptions: z.array(trimmed(500)).max(10),
    note: z.string().max(2_000),
    currentDate: isoDate,
  }).strict(),
  sections: z.array(z.object({ key: researchSectionKeySchema, heading: trimmed(160),
    blocks: z.array(blockSchema).max(RESEARCH_RESOURCE_LIMITS.maxSectionBlocks),
    status: z.enum(["written", "missing"]) }).strict()).max(30),
  conflicts: z.array(z.object({ text: trimmed(1_200), claimKeys: z.array(researchClaimKeySchema).max(10) }).strict()).max(20),
  limitations: z.array(trimmed(600)).max(30),
  nextQuestions: z.array(trimmed(400)).max(10),
  criteria: z.array(z.object({ criterion: trimmed(400), met: z.boolean() }).strict()).max(12),
  bibliography: z.array(z.object({
    n: z.number().int().min(1),
    sourceKey: researchSourceKeySchema,
    versionId: cuid,
    title: z.string().max(300),
    url: z.string().max(2048).optional(),
    private: z.boolean(),
    readStatus: z.enum(RESEARCH_READ_STATUSES),
    retrievedAt: z.string().datetime({ offset: true }),
    publishedAt: z.string().datetime({ offset: true }).optional(),
    duplicateOf: researchSourceKeySchema.optional(),
  }).strict()).max(2_000),
}).strict();
export type ResearchReportDocument = z.infer<typeof researchReportDocumentSchema>;

/**
 * Where a claim's quote was found. `text` = in stored page/document/private
 * text at a chunk range; `snippet` = only in a search snippet, which is never
 * presented as an original-text read.
 */
export const researchClaimEvidenceSchema = z.array(z.object({
  sourceKey: researchSourceKeySchema,
  versionId: cuid.optional(),
  chunkId: cuid.optional(),
  level: z.enum(["text", "snippet"]),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  quoteDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict().refine((value) => value.level === "snippet" || (value.versionId && value.chunkId))).max(12);
export type ResearchClaimEvidence = z.infer<typeof researchClaimEvidenceSchema>;

/** Bounded work item payloads. They name refs; content is read from stores. */
export const researchWorkPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), feedback: z.string().max(4_000).optional() }).strict(),
  z.object({ kind: z.literal("investigate"), questionKey: researchSectionKeySchema, question: trimmed(1_000),
    queries: z.array(trimmed(400)).max(8), turn: z.number().int().min(1).max(50),
    sectionScope: researchSectionKeySchema.optional(), requestRevision: z.number().int().min(1).optional() }).strict(),
  z.object({ kind: z.literal("search"), parentItemId: cuid, query: trimmed(400), searchLanguage: locale.optional(),
    country: z.string().max(2).optional(), freshness: z.enum(["day", "week", "month", "year"]).optional(),
    fundingSegmentId: cuid, questionKey: researchSectionKeySchema.optional() }).strict(),
  z.object({ kind: z.literal("read"), parentItemId: cuid.optional(), sourceKey: researchSourceKeySchema,
    refresh: z.boolean().default(false), requestRevision: z.number().int().min(1).optional() }).strict(),
  z.object({ kind: z.literal("analyze_private"), sourceKey: researchSourceKeySchema, fromChunk: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("coordinate"), round: z.number().int().min(1).max(20) }).strict(),
  z.object({ kind: z.literal("verify"), batch: z.number().int().min(0), claimKeys: z.array(researchClaimKeySchema).min(1).max(60) }).strict(),
  z.object({ kind: z.literal("write_section"), sectionKey: researchSectionKeySchema, attempt: z.number().int().min(1).max(5),
    feedback: z.string().max(4_000).optional(), instruction: z.string().max(4_000).optional() }).strict(),
  z.object({ kind: z.literal("synthesize"), reportRevision: z.number().int().min(1),
    author: z.enum(RESEARCH_REPORT_AUTHORS), instruction: z.string().max(4_000).optional() }).strict(),
]);
export type ResearchWorkPayload = z.infer<typeof researchWorkPayloadSchema>;

export const researchExecutionProfileSchema = z.object({
  version: z.literal(1),
  profile: z.enum(["standard", "deep"]),
  roles: z.record(z.enum(RESEARCH_MODEL_ROLES), z.object({
    modelId: z.string().min(1).max(100),
    provider: z.string().min(1).max(40),
    apiModel: z.string().min(1).max(200),
    reasoning: z.string().min(1).max(40),
    pricingVersion: z.string().min(1).max(120),
  }).strict()),
  pinnedAt: z.string().datetime({ offset: true }),
}).strict();
export type ResearchExecutionProfile = z.infer<typeof researchExecutionProfileSchema>;

/** Public run DTO. Never carries private text, internal costs or provider identity beyond the model id. */
export type ResearchRunV2Dto = {
  id: string;
  engineVersion: 2;
  conversationId: string;
  assistantMessageId: string;
  status: string;
  stopReason?: string;
  eventSequence: number;
  inputRevision: number;
  planRevision: number;
  approvedPlanRevision: number | null;
  qualityStatus: ResearchQualityStatus | null;
  currentReportRevision: number;
  pauseRequested: boolean;
  cancelRequested: boolean;
  plan?: { revision: number; author: string; plan: ResearchPlan };
  progress: {
    /** Counts of real work items by state; no time-based percentage. */
    items: Record<"queued" | "running" | "completed" | "failed" | "attention" | "blocked" | "cancelled", number>;
    questions: Array<{ key: string; question: string; state: "pending" | "active" | "done" | "attention"; findings: number }>;
    sourcesSeen: number;
    sourcesRead: number;
    privateSources: number;
    openQuestions: string[];
  };
  money: {
    approvedCredits: number;
    settledCredits: number;
    reservedCredits: number;
    unknownCredits: number;
    finalizationReserveCredits: number;
    /** Settlement state is separate from run and report state. */
    settlement: "settled" | "pending" | "unknown";
  };
  actions: { canPause: boolean; canResume: boolean; canCancel: boolean; canExtendBudget: boolean;
    canApprovePlan: boolean; canEditPlan: boolean; canRevise: boolean; canDelete: boolean; canFinish: boolean };
  /** Research stopped at the approved total and waits for the user: add credits or finish now. */
  budgetReached: boolean;
  createdAt: string;
  updatedAt: string;
};

export const RESEARCH_RUN_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "attention"]);
