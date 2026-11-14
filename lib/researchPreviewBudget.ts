import {
  createChatBudget,
  type AccessKind,
  type ChatBudget,
} from "./chatSecurity";
import type { AiModel } from "./models";
import type { TokenEstimateBreakdown } from "./chatTokenEstimate";
import { APP_MANAGED_SEARCH_LIMITS } from "./webSearchBackends";
import { reserveTurnSearchCost } from "./webSearchNativeCostReservation";
import { researchPreviewReportSchema } from "./researchPreviewReport";
import { z } from "zod";
import {
  RESEARCH_PREVIEW_MAX_STEPS,
  RESEARCH_PREVIEW_MAX_TOTAL_OUTPUT_TOKENS,
} from "./researchPreviewAdmission";

// The result field cap does not include the batch/query/notice/sourceId JSON
// wrappers. Size those separately from the bounded variable fields.
export const RESEARCH_PREVIEW_MAX_SERIALIZED_EVIDENCE_CHARACTERS =
  APP_MANAGED_SEARCH_LIMITS.maxQueriesPerRequest *
    APP_MANAGED_SEARCH_LIMITS.maxResultPayloadCharacters +
  APP_MANAGED_SEARCH_LIMITS.maxQueriesPerRequest *
    APP_MANAGED_SEARCH_LIMITS.maxQueryCharacters +
  10_000;

// One token per serialized byte is a provider-independent ceiling. JSON may
// escape an unpaired UTF-16 code unit as six ASCII bytes, which is larger than
// valid UTF-8; use that worst case for every variable field. The fixed wrapper
// is already ASCII.
const VARIABLE_EVIDENCE_CHARACTERS =
  APP_MANAGED_SEARCH_LIMITS.maxQueriesPerRequest *
  (APP_MANAGED_SEARCH_LIMITS.maxResultPayloadCharacters +
    APP_MANAGED_SEARCH_LIMITS.maxQueryCharacters);
const FIXED_EVIDENCE_WRAPPER_CHARACTERS = 10_000;
export const RESEARCH_PREVIEW_EVIDENCE_INPUT_TOKENS =
  VARIABLE_EVIDENCE_CHARACTERS * 6 + FIXED_EVIDENCE_WRAPPER_CHARACTERS;

const reportToolSchemaJson = JSON.stringify(
  z.toJSONSchema(researchPreviewReportSchema)
);
export const RESEARCH_PREVIEW_REPORT_TOOL_INPUT_TOKENS =
  Buffer.byteLength(reportToolSchemaJson, "utf8");

type SearchReservation = Extract<
  ReturnType<typeof reserveTurnSearchCost>,
  { ok: true }
>;

export function createResearchPreviewBudget(input: {
  accessKind: AccessKind;
  model: AiModel;
  input: TokenEstimateBreakdown;
  webSearchSurchargeCredits: number;
  searchReservation: SearchReservation;
}): ChatBudget {
  return createChatBudget(input.accessKind, input.model, input.input, {
    webSearchSurchargeCredits: input.webSearchSurchargeCredits,
    appManagedSearchEnabled: true,
    searchBackend: input.searchReservation.searchBackend,
    toolInputPasses: RESEARCH_PREVIEW_MAX_STEPS,
    toolInputAboveAuthoredLimit: true,
    additionalToolInputTokens:
      RESEARCH_PREVIEW_EVIDENCE_INPUT_TOKENS +
      RESEARCH_PREVIEW_REPORT_TOOL_INPUT_TOKENS,
    totalOutputTokenCap: RESEARCH_PREVIEW_MAX_TOTAL_OUTPUT_TOKENS,
  });
}
