import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { MEMORY_KINDS } from "../../lib/memoryValidatorCore";
import type { RetrievalCase } from "./productRetrieval";
import { QualityStop } from "./runner";
import { digest } from "./schema";

/**
 * Follow-up evaluation bundle: model-visible inputs and the scoring key live in
 * separate files, so a message built for a model can never carry gold, forbidden
 * facts or phenomenon tags. Every derived artifact (answers, blind sheet,
 * verdicts) is bound to the evaluation digest, which covers both files.
 */

export const FOLLOWUP_INPUTS_FORMAT = "memory-followup-inputs-v1";
export const FOLLOWUP_KEY_FORMAT = "memory-followup-key-v1";
export const FOLLOWUP_ANSWERS_FORMAT = "memory-followup-answers-v1";
export const FOLLOWUP_VERDICTS_FORMAT = "memory-followup-verdicts-v1";
/** Search uses at most this many earlier user messages, as `readSources` does. */
export const FOLLOWUP_HISTORY_LIMIT = 2;

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/);
const text = z.string().min(1).max(8000);
const isoDate = z.string().datetime().nullable();

export const FOLLOWUP_PHENOMENA = [
  "project_omission", "project_switch", "latest_correction", "partial_mixing", "legitimate_comparison",
  "irrelevant_history", "no_lexical_overlap", "ambiguous_reference", "candidate_absent", "evidence_absent",
  "copied_material", "assistant_reference", "long_middle", "always_on_style",
] as const;

const memory = z.object({ id, kind: z.enum(MEMORY_KINDS), statement: text }).strict();
const turn = z.object({ role: z.enum(["user", "assistant"]), content: text }).strict();
const variant = z.object({
  variantId: id,
  /** What this variant changes against its sibling; author-facing, never sent to a model. */
  contrast: text,
  conversation: z.array(turn).max(20),
  currentQuery: text,
  /** Replaces the scenario pool for this variant (for example, the needed memory is absent). */
  pool: z.array(memory).max(50).optional(),
}).strict();
const scenario = z.object({
  scenarioId: id, originalLanguage: z.enum(["ko", "en"]),
  /** Non-null marks a name swap or translation of another scenario; it is not an independent sample. */
  derivedFrom: id.nullable(),
  pool: z.array(memory).max(50),
  variants: z.array(variant).min(1).max(4),
}).strict();
export const followupInputsSchema = z.object({
  format: z.literal(FOLLOWUP_INPUTS_FORMAT), bundleId: id,
  status: z.enum(["development", "candidate", "frozen"]),
  provenance: z.object({
    authoredBy: text, authoredAt: z.string().datetime(), independentAuthor: z.boolean(),
    goldReviewedBy: text.nullable(), goldReviewedAt: isoDate,
    frozenBeforeResults: z.boolean(), frozenAt: isoDate, notes: text,
  }).strict(),
  scenarios: z.array(scenario).min(1).max(200),
}).strict();

const keyCase = z.object({
  phenomena: z.array(z.enum(FOLLOWUP_PHENOMENA)).min(1),
  expectedBehavior: z.enum(["answer", "compare", "clarify", "insufficient"]),
  /** Where the needed fact lives; a history-only answer is not credited to Memory. */
  evidenceSource: z.enum(["memory_only", "history_only", "both", "unavailable"]),
  activeProject: text.nullable(),
  latestCorrection: z.boolean(),
  goldMemoryIds: z.array(id).max(50),
  /** Other-project facts that must not be asserted for the active project. */
  distractorMemoryIds: z.array(id).max(50),
  requiredFacts: z.array(text).max(12),
  acceptableVariants: z.array(text).max(12),
  forbiddenFacts: z.array(text).max(12),
  notes: text,
}).strict();
export const followupKeySchema = z.object({
  format: z.literal(FOLLOWUP_KEY_FORMAT), bundleId: id, annotationVersion: id,
  cases: z.record(z.string(), keyCase),
}).strict();

export type FollowupInputs = z.infer<typeof followupInputsSchema>;
export type FollowupKey = z.infer<typeof followupKeySchema>;
export type FollowupKeyCase = z.infer<typeof keyCase>;
export type FollowupTurn = z.infer<typeof turn>;

export type FollowupCase = {
  caseId: string; scenarioId: string; variantId: string; language: "ko" | "en";
  bundleStatus: FollowupInputs["status"]; independent: boolean;
  conversation: FollowupTurn[]; currentQuery: string; pool: z.infer<typeof memory>[];
  /** The earlier user messages search may read, oldest first. */
  searchHistory: string[];
  key: FollowupKeyCase; caseDigest: string;
};

export const followupCaseId = (scenarioId: string, variantId: string) => `${scenarioId}__${variantId}`;

/** Exactly what `readSources` reads: the latest non-empty user messages, oldest first. */
export const followupSearchHistory = (conversation: readonly FollowupTurn[]) =>
  conversation.filter(row => row.role === "user" && row.content.trim()).slice(-FOLLOWUP_HISTORY_LIMIT)
    .map(row => row.content);

export type FollowupBundle = {
  bundleId: string; status: FollowupInputs["status"]; provenance: FollowupInputs["provenance"];
  annotationVersion: string; evalDigest: string; inputsDigest: string; keyDigest: string;
  scenarios: { scenarioId: string; language: "ko" | "en"; independent: boolean; variants: string[] }[];
  cases: FollowupCase[];
};

/** Validate both files together; any dangling or missing reference refuses the whole bundle. */
export function buildFollowupBundle(rawInputs: unknown, rawKey: unknown): FollowupBundle {
  const inputs = followupInputsSchema.safeParse(rawInputs);
  if (!inputs.success) throw new QualityStop("followup_inputs_invalid");
  const key = followupKeySchema.safeParse(rawKey);
  if (!key.success) throw new QualityStop("followup_key_invalid");
  if (inputs.data.bundleId !== key.data.bundleId) throw new QualityStop("followup_bundle_mismatch");
  const scenarioIds = inputs.data.scenarios.map(row => row.scenarioId);
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new QualityStop("followup_duplicate_scenario");
  const cases: FollowupCase[] = [];
  for (const row of inputs.data.scenarios) {
    if (row.derivedFrom !== null && !scenarioIds.includes(row.derivedFrom)) throw new QualityStop("followup_unknown_derivation");
    const variantIds = row.variants.map(item => item.variantId);
    if (new Set(variantIds).size !== variantIds.length) throw new QualityStop("followup_duplicate_variant");
    for (const item of row.variants) {
      const caseId = followupCaseId(row.scenarioId, item.variantId);
      const caseKey = key.data.cases[caseId];
      if (!caseKey) throw new QualityStop("followup_key_missing_case");
      const pool = item.pool ?? row.pool;
      const memoryIds = pool.map(entry => entry.id);
      if (new Set(memoryIds).size !== memoryIds.length) throw new QualityStop("followup_duplicate_memory");
      if ([...caseKey.goldMemoryIds, ...caseKey.distractorMemoryIds].some(ref => !memoryIds.includes(ref))) {
        throw new QualityStop("followup_key_unknown_memory");
      }
      if (caseKey.goldMemoryIds.some(ref => caseKey.distractorMemoryIds.includes(ref))) {
        throw new QualityStop("followup_key_gold_is_distractor");
      }
      const conversation = item.conversation.map(entry => ({ role: entry.role, content: entry.content.normalize("NFC") }));
      const currentQuery = item.currentQuery.normalize("NFC");
      cases.push({
        caseId, scenarioId: row.scenarioId, variantId: item.variantId, language: row.originalLanguage,
        bundleStatus: inputs.data.status, independent: row.derivedFrom === null,
        conversation, currentQuery, pool, searchHistory: followupSearchHistory(conversation), key: caseKey,
        caseDigest: digest({ caseId, language: row.originalLanguage, conversation, currentQuery, pool,
          annotationVersion: key.data.annotationVersion, key: caseKey }),
      });
    }
  }
  if (Object.keys(key.data.cases).some(caseId => !cases.some(row => row.caseId === caseId))) {
    throw new QualityStop("followup_key_unknown_case");
  }
  const inputsDigest = digest(inputs.data), keyDigest = digest(key.data);
  return {
    bundleId: inputs.data.bundleId, status: inputs.data.status, provenance: inputs.data.provenance,
    annotationVersion: key.data.annotationVersion, inputsDigest, keyDigest,
    // Separate from the search request hashes: this binds conversation, gold and annotation together.
    evalDigest: digest({ inputs: FOLLOWUP_INPUTS_FORMAT, key: FOLLOWUP_KEY_FORMAT, bundleId: inputs.data.bundleId,
      status: inputs.data.status, provenance: inputs.data.provenance, cases: cases.map(row => row.caseDigest) }),
    scenarios: inputs.data.scenarios.map(row => ({ scenarioId: row.scenarioId, language: row.originalLanguage,
      independent: row.derivedFrom === null, variants: row.variants.map(item => item.variantId) })),
    cases,
  };
}

/** The product retrieval input for one case: current query, user-only history, one account pool. */
export const followupRetrievalCases = (bundle: FollowupBundle): RetrievalCase[] => bundle.cases.map(row => ({
  id: row.caseId, language: row.language, tag: row.key.phenomena[0],
  retrieval: {
    query: row.currentQuery, history: row.searchHistory,
    pool: row.pool.map(entry => ({ id: entry.id, statement: entry.statement, status: "active" as const,
      forbidden: false, kind: entry.kind })),
    relevantIds: row.key.goldMemoryIds,
  },
}));

const json = async (file: string, code: string) => {
  try {
    return JSON.parse(await readFile(resolve(file), "utf8")) as unknown;
  } catch {
    throw new QualityStop(code);
  }
};

export async function loadFollowupBundle(inputsFile: string, keyFile: string) {
  return buildFollowupBundle(await json(inputsFile, "followup_inputs_invalid"), await json(keyFile, "followup_key_invalid"));
}

export const FOLLOWUP_CONDITIONS = ["lexical", "full-query", "full-query+history", "no-memory"] as const;
export type FollowupCondition = (typeof FOLLOWUP_CONDITIONS)[number];

const settingsValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const followupAnswersSchema = z.object({
  format: z.literal(FOLLOWUP_ANSWERS_FORMAT), bundleId: id, evalDigest: z.string(),
  generator: z.object({
    kind: z.enum(["provider", "mock", "oracle", "unknown"]),
    provider: text, model: text, collectedAt: z.string().datetime(),
    settings: z.record(z.string(), settingsValue),
  }).strict(),
  answers: z.array(z.object({
    caseId: z.string(), condition: z.enum(FOLLOWUP_CONDITIONS),
    messagesDigest: z.string(), promptVersion: z.string(), text: z.string().max(20000),
  }).strict()).max(5000),
}).strict();
export type FollowupAnswers = z.infer<typeof followupAnswersSchema>;

export const followupVerdictsSchema = z.object({
  format: z.literal(FOLLOWUP_VERDICTS_FORMAT), bundleId: id, sheetDigest: z.string(),
  judge: text, frozenAt: z.string().datetime(),
  verdicts: z.array(z.object({
    caseId: z.string(), label: z.string().regex(/^[A-Z]{1,2}$/),
    /** The whole answer is acceptable: paraphrase and correct two-project comparison count as correct. */
    correct: z.boolean(),
    /** Null only when the key marks no correction in this case. */
    followedLatestCorrection: z.boolean().nullable(),
    /** Another project's fact stated as true for the active project (not a comparison, quote or negation). */
    crossProjectAssertion: z.boolean(),
    askedClarification: z.boolean(),
    /** A fact stated as certain with support in neither the conversation nor the account memory. */
    unsupportedAssertion: z.boolean(),
    evidence: text,
  }).strict()).max(20000),
}).strict();
export type FollowupVerdicts = z.infer<typeof followupVerdictsSchema>;

export async function loadFollowupJson<T>(file: string, schema: z.ZodType<T>, code: string): Promise<T> {
  const parsed = schema.safeParse(await json(file, code));
  if (!parsed.success) throw new QualityStop(code);
  return parsed.data;
}
