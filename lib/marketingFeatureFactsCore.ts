/**
 * What a marketing ad may say about each Tomverse feature (owner request
 * 2026-11-12): the list the box's Higgsfield image job reads, kept in
 * `MarketingFeatureFact` and edited in Admin › Marketing › Settings › Ad facts.
 * `tools/marketing-video/features.json` was its only copy until then and stays
 * as the job's fallback and the migration's seed.
 *
 * Pure: the schemas, the shape the job reads, and the check on a refresh
 * proposal. The model's proposals are data; only an operator's save writes.
 */
import { z } from "zod";

/** Audit actions of the two writes, their own constants (not MARKETING_S2B1_ACTIONS). */
export const MARKETING_FEATURE_FACT_ACTIONS = Object.freeze({
  create: "marketing_feature_fact.create",
  update: "marketing_feature_fact.update",
} as const);

/** The id the job, the concepts' `factRefs` and the history name a feature by. */
export const MARKETING_FEATURE_FACT_ID = /^[a-z][a-z0-9-]{1,47}$/u;

/**
 * What the job's prompt reads above the list. The rules of the cards
 * themselves are in tools/marketing-video/HIGGSFIELD-GUIDE.md.
 */
export const MARKETING_FEATURE_FACTS_NOTE =
  "What a card may say about Tomverse: facts only from this list. Model and company names are fine (owner 2026-11-07), and model marks come from library/ or public/model-icons/. Owner 2026-11-08: copy may use price, 'free' and bold wording; 'free' always carries its condition ('Free to try within the included credits'), and the Guard judges every word at submission and refuses what it does not allow. Never promise that an answer is correct. Each entry restates what the public FAQ or help centre says. A feature with `hold` is not in the ads yet: no card is made about it and no card mentions it; `hold` says why, and the owner removes it once the feature is live and its copy can be kept. `copy` is a wording rule the card keeps, and `disclosure` is a line the card shows word for word. Kept in Admin › Marketing › Settings › Ad facts.";

const text = (max: number) => z.string().trim().min(1).max(max);
/** Empty means none: a cleared field in the form is a removed rule or hold. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value));

/**
 * The fields an operator edits. `realExample` (a recorded analysis) and
 * `disclosure` (the §17.1 short disclosure, docs/policy/external-conversation-
 * import-and-memory.md) are not among them: neither is a wording choice.
 */
export const marketingFeatureFactFieldsSchema = z
  .object({
    what: text(1500),
    models: z.array(text(60)).max(12),
    copy: optionalText(2000),
    source: text(500),
    hold: optionalText(1000),
  })
  .strict();
export type MarketingFeatureFactFields = z.infer<typeof marketingFeatureFactFieldsSchema>;

export const marketingFeatureFactCreateSchema = marketingFeatureFactFieldsSchema
  .extend({ id: z.string().regex(MARKETING_FEATURE_FACT_ID) })
  .strict();

/** `expectedUpdatedAt` is the row the screen showed: a change made since is refused, not overwritten. */
export const marketingFeatureFactUpdateSchema = marketingFeatureFactFieldsSchema
  .extend({ id: z.string().regex(MARKETING_FEATURE_FACT_ID), expectedUpdatedAt: z.string().datetime() })
  .strict();

/** A refusal of a save, with its HTTP status (the route's `refusal` mapper reads it). */
export class MarketingFeatureFactRefusedError extends Error {
  constructor(
    readonly code: "feature_fact_exists" | "feature_fact_missing" | "feature_fact_conflict",
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type MarketingFeatureFactRow = {
  id: string;
  position: number;
  what: string;
  models: string[];
  realExample: unknown;
  copy: string | null;
  disclosure: unknown;
  source: string;
  hold: string | null;
  updatedAt: Date;
};

/** One entry as features.json writes it: absent fields left out, so the job reads both alike. */
export function marketingFeatureEntry(row: MarketingFeatureFactRow): Record<string, unknown> {
  return {
    id: row.id,
    what: row.what,
    ...(row.models.length > 0 ? { models: row.models } : {}),
    ...(row.realExample != null ? { realExample: row.realExample } : {}),
    source: row.source,
    ...(row.copy ? { copy: row.copy } : {}),
    ...(row.disclosure != null ? { disclosure: row.disclosure } : {}),
    ...(row.hold ? { hold: row.hold } : {}),
  };
}

/** The document the job reads: the same shape as tools/marketing-video/features.json. */
export function marketingFeaturesDocument(rows: readonly MarketingFeatureFactRow[]) {
  const ordered = [...rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  return { note: MARKETING_FEATURE_FACTS_NOTE, features: ordered.map(marketingFeatureEntry) };
}

// ---------------------------------------------------------------------------
// Refresh: one model call proposes, an operator decides.
// ---------------------------------------------------------------------------

export const MARKETING_FEATURE_PROPOSAL_KINDS = ["add", "update", "release_hold"] as const;

/** The structured answer the refresh call must follow (strict JSON schema). */
export const MARKETING_FEATURE_REFRESH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "id", "what", "models", "copy", "source", "hold", "reason"],
        properties: {
          kind: { type: "string", enum: [...MARKETING_FEATURE_PROPOSAL_KINDS] },
          id: { type: "string" },
          what: { type: "string" },
          models: { type: "array", items: { type: "string" } },
          copy: { type: ["string", "null"] },
          source: { type: "string" },
          hold: { type: ["string", "null"] },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

export type MarketingFeatureProposal = MarketingFeatureFactFields & {
  kind: (typeof MARKETING_FEATURE_PROPOSAL_KINDS)[number];
  id: string;
  reason: string;
};

const proposalSchema = marketingFeatureFactFieldsSchema
  .extend({
    kind: z.enum(MARKETING_FEATURE_PROPOSAL_KINDS),
    id: z.string().regex(MARKETING_FEATURE_FACT_ID),
    reason: text(600),
  })
  .strict();

/**
 * The proposals worth showing, and how many were dropped. A proposal is
 * dropped when it breaks the field rules, adds an id that exists, changes one
 * that does not, releases a hold that is not there, still carries a hold it
 * releases, or changes nothing. None of this saves anything.
 */
export function checkMarketingFeatureProposals(
  answer: unknown,
  current: readonly MarketingFeatureFactRow[],
): { proposals: MarketingFeatureProposal[]; dropped: number } {
  const list = (answer as { proposals?: unknown } | null)?.proposals;
  const items = Array.isArray(list) ? list : [];
  const byId = new Map(current.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const proposals: MarketingFeatureProposal[] = [];
  for (const item of items) {
    const parsed = proposalSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const proposal = parsed.data;
    const existing = byId.get(proposal.id);
    if (proposal.kind === "add" && existing) continue;
    if (proposal.kind !== "add" && !existing) continue;
    if (proposal.kind === "release_hold" && (!existing?.hold || proposal.hold !== null)) continue;
    if (
      existing &&
      existing.what === proposal.what &&
      existing.source === proposal.source &&
      existing.copy === proposal.copy &&
      existing.hold === proposal.hold &&
      existing.models.join("\n") === proposal.models.join("\n")
    ) {
      continue;
    }
    seen.add(proposal.id);
    proposals.push(proposal);
  }
  return { proposals, dropped: items.length - proposals.length };
}

/** Bounded text of one input, so a long page cannot crowd out the rest. */
export const boundedInput = (value: unknown, maxChars: number): string => {
  const written = typeof value === "string" ? value : JSON.stringify(value);
  return written.length > maxChars ? `${written.slice(0, maxChars)}…` : written;
};
