import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalBenchmarkJson, parseBenchmarkJson } from "./routerDevelopmentBenchmark";
import { validatePromptRefinerVnextSourceText } from "./promptRefinerQualityEvaluationVnextCore";
import {
  CHAT_UNIFIED_ROUTER_REFINER_SCHEMA_VERSION,
  validateChatUnifiedRouterRefinerOutput,
  type ChatUnifiedRouterRefinerOutput,
} from "./chatUnifiedRouterRefinerCore";
import {
  CHAT_UNIFIED_ROUTER_REFINER_PROMPT_VERSION,
  CHAT_UNIFIED_ROUTER_REFINER_SYSTEM_INSTRUCTION,
  CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE,
  chatUnifiedRouterRefinerMessages,
} from "./chatUnifiedRouterRefinerPrompt";
import {
  CHAT_UNIFIED_ROUTER_REFINER_ADAPTER_CONFIG_DIGEST,
  CHAT_UNIFIED_ROUTER_REFINER_CANDIDATE_DIGEST,
} from "./chatUnifiedRouterRefinerContract";
import { PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST } from "./promptRefinerProductContract";
import type { PromptRefinerRequest } from "./promptRefinerSuggestion";

export const CHAT_UNIFIED_OPTIMIZER_CANDIDATE_VERSION = "chat-unified-optimizer-candidate-v1" as const;
export const CHAT_UNIFIED_OPTIMIZER_BUNDLE_VERSION = "chat-unified-optimizer-bundle-v1" as const;
export const CHAT_UNIFIED_OPTIMIZER_CANDIDATE_MAX_BYTES = 256 * 1024;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);
const guidanceMarker = JSON.stringify({ taskGuidance: CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE });
const fixedParts = CHAT_UNIFIED_ROUTER_REFINER_SYSTEM_INSTRUCTION.split(guidanceMarker);
if (fixedParts.length !== 2) throw new Error("optimizer_fixed_wrapper_drift");

// The only editable bytes are a quoted task payload and declared public examples.
// Neither a proposal nor an evidence reference is release or dispatch authority.
export const CHAT_UNIFIED_OPTIMIZER_CONTROLS = Object.freeze({
  schemaVersion: CHAT_UNIFIED_ROUTER_REFINER_SCHEMA_VERSION,
  promptVersion: CHAT_UNIFIED_ROUTER_REFINER_PROMPT_VERSION,
  stageCandidateDigest: CHAT_UNIFIED_ROUTER_REFINER_CANDIDATE_DIGEST,
  adapterConfigDigest: CHAT_UNIFIED_ROUTER_REFINER_ADAPTER_CONFIG_DIGEST,
  pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
  fixedWrapperDigest: hash(canonicalBenchmarkJson(fixedParts)),
});
export const CHAT_UNIFIED_OPTIMIZER_CONTROLS_DIGEST =
  hash(canonicalBenchmarkJson(CHAT_UNIFIED_OPTIMIZER_CONTROLS));

const exampleSchema = z.object({
  fixtureRef: ref.refine(value => /^public:[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value)),
  sourceText: z.string().min(1).max(16_000),
  output: z.unknown(),
}).strict();
const proposalSchema = z.object({
  taskGuidance: z.string().trim().min(1).max(32_768),
  publicExamples: z.array(exampleSchema).max(64),
}).strict();
const evidenceReferenceSchema = z.object({
  evidenceRef: ref,
  payloadDigest: digest,
  candidateDigest: digest,
  schemaVersion: z.literal(CHAT_UNIFIED_ROUTER_REFINER_SCHEMA_VERSION),
  promptVersion: z.literal(CHAT_UNIFIED_ROUTER_REFINER_PROMPT_VERSION),
  pricePinDigest: z.literal(PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST),
  modelCatalogueDigest: digest,
  calibrationVersion: ref,
  protocolVersion: ref,
}).strict();

type PublicExample = Readonly<{
  fixtureRef: string;
  sourceText: string;
  output: ChatUnifiedRouterRefinerOutput;
}>;
type CandidatePayload = Readonly<{
  version: typeof CHAT_UNIFIED_OPTIMIZER_CANDIDATE_VERSION;
  controlsDigest: string;
  taskGuidance: string;
  publicExamples: readonly PublicExample[];
}>;
export type ChatUnifiedOptimizerCandidateBundle = Readonly<{
  version: typeof CHAT_UNIFIED_OPTIMIZER_BUNDLE_VERSION;
  candidateDigest: string;
  bundleDigest: string;
  candidate: CandidatePayload;
  routerEvidence: Readonly<z.infer<typeof evidenceReferenceSchema>> | null;
  runtimeAuthorized: false;
}>;

const fail = (): never => { throw new Error("optimizer_candidate_invalid"); };
function boundedJson(text: unknown): unknown {
  if (typeof text !== "string" || !text ||
      Buffer.byteLength(text, "utf8") > CHAT_UNIFIED_OPTIMIZER_CANDIDATE_MAX_BYTES) return fail();
  try { return parseBenchmarkJson(text, CHAT_UNIFIED_OPTIMIZER_CANDIDATE_MAX_BYTES); }
  catch { return fail(); }
}
function payloadFrom(proposal: unknown): CandidatePayload {
  const parsed = proposalSchema.parse(proposal);
  if (Buffer.byteLength(parsed.taskGuidance, "utf8") > 32_768) return fail();
  const seen = new Set<string>();
  const examples = parsed.publicExamples.map(example => {
    if (seen.has(example.fixtureRef)) return fail();
    seen.add(example.fixtureRef);
    return Object.freeze({
      fixtureRef: example.fixtureRef,
      sourceText: validatePromptRefinerVnextSourceText(example.sourceText),
      output: validateChatUnifiedRouterRefinerOutput(example.output, example.sourceText),
    });
  });
  return Object.freeze({
    version: CHAT_UNIFIED_OPTIMIZER_CANDIDATE_VERSION,
    controlsDigest: CHAT_UNIFIED_OPTIMIZER_CONTROLS_DIGEST,
    taskGuidance: parsed.taskGuidance,
    publicExamples: Object.freeze(examples),
  });
}
function bundleFor(candidate: CandidatePayload,
  evidence: z.infer<typeof evidenceReferenceSchema> | null): ChatUnifiedOptimizerCandidateBundle {
  // Evidence is attached after candidate freeze; excluding it from candidateDigest
  // avoids a candidate -> evidence -> candidate hash cycle. bundleDigest binds both.
  const candidateDigest = hash(canonicalBenchmarkJson(candidate));
  if (evidence && evidence.candidateDigest !== candidateDigest) return fail();
  const payload = {
    version: CHAT_UNIFIED_OPTIMIZER_BUNDLE_VERSION,
    candidateDigest,
    candidate,
    routerEvidence: evidence === null ? null : Object.freeze({ ...evidence }),
    runtimeAuthorized: false as const,
  };
  const json = canonicalBenchmarkJson(payload);
  const bundle = Object.freeze({ ...payload, bundleDigest: hash(json) });
  if (Buffer.byteLength(canonicalBenchmarkJson(bundle), "utf8") >
      CHAT_UNIFIED_OPTIMIZER_CANDIDATE_MAX_BYTES) return fail();
  return bundle;
}

/** Offline proposal only. Public provenance is verified by the U21 app writer. */
export function createChatUnifiedOptimizerCandidate(proposalJson: string): ChatUnifiedOptimizerCandidateBundle {
  return bundleFor(payloadFrom(boundedJson(proposalJson)), null);
}

/**
 * Strict readback against an independently stored immutable digest. A reference
 * only declares compatibility; U09 still must verify its signature and approval.
 */
export function readChatUnifiedOptimizerCandidateBundle(
  bundleJson: string, expectedBundleDigest: string,
): ChatUnifiedOptimizerCandidateBundle {
  const value = z.object({
    version: z.literal(CHAT_UNIFIED_OPTIMIZER_BUNDLE_VERSION),
    candidateDigest: digest, bundleDigest: digest,
    candidate: z.object({
      version: z.literal(CHAT_UNIFIED_OPTIMIZER_CANDIDATE_VERSION),
      controlsDigest: z.literal(CHAT_UNIFIED_OPTIMIZER_CONTROLS_DIGEST),
      taskGuidance: proposalSchema.shape.taskGuidance,
      publicExamples: proposalSchema.shape.publicExamples,
    }).strict(),
    routerEvidence: evidenceReferenceSchema.nullable(),
    runtimeAuthorized: z.literal(false),
  }).strict().parse(boundedJson(bundleJson));
  const bundle = bundleFor(payloadFrom({ taskGuidance: value.candidate.taskGuidance,
    publicExamples: value.candidate.publicExamples }), value.routerEvidence);
  if (bundle.candidateDigest !== value.candidateDigest ||
      bundle.bundleDigest !== value.bundleDigest ||
      bundle.bundleDigest !== expectedBundleDigest) return fail();
  return bundle;
}

export function attachChatUnifiedOptimizerEvidenceReference(
  bundleJson: string, expectedBundleDigest: string, evidenceReferenceJson: string,
): ChatUnifiedOptimizerCandidateBundle {
  const bundle = readChatUnifiedOptimizerCandidateBundle(bundleJson, expectedBundleDigest);
  const evidence = evidenceReferenceSchema.parse(boundedJson(evidenceReferenceJson));
  return bundleFor(bundle.candidate, evidence);
}

/** Provider-free evaluation builder; product runtime remains on its fixed pin. */
export function chatUnifiedOptimizerCandidateMessages(
  bundleJson: string, expectedBundleDigest: string, request: PromptRefinerRequest,
) {
  const bundle = readChatUnifiedOptimizerCandidateBundle(bundleJson, expectedBundleDigest);
  const messages = chatUnifiedRouterRefinerMessages(request);
  const taskPayload = { taskGuidance: bundle.candidate.taskGuidance,
    publicExamples: bundle.candidate.publicExamples };
  const system = fixedParts[0] + JSON.stringify(taskPayload) + fixedParts[1];
  return Object.freeze([
    Object.freeze({ role: "system" as const, content: system }), messages[1],
  ] as const);
}
