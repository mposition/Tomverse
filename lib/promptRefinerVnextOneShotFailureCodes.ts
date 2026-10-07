/** Confirmed parser failures from the approved vNext numeric outcome mapping. */
export const PROMPT_REFINER_VNEXT_CONFIRMED_FAILURE_CODES = [
  "vnext_invalid_model_output_structure",
  "vnext_invalid_suggestion_structure",
  "vnext_no_change",
  "vnext_invalid_abstention_structure",
  "vnext_outcome_out_of_enum",
  "vnext_empty_response",
  "vnext_output_byte_limit",
  "vnext_bom_response",
  "vnext_strict_parse_failure",
] as const;

export type PromptRefinerVnextConfirmedFailureCode =
  (typeof PROMPT_REFINER_VNEXT_CONFIRMED_FAILURE_CODES)[number];

export function isPromptRefinerVnextConfirmedFailureCode(
  value: unknown,
): value is PromptRefinerVnextConfirmedFailureCode {
  return typeof value === "string" &&
    (PROMPT_REFINER_VNEXT_CONFIRMED_FAILURE_CODES as readonly string[]).includes(value);
}
