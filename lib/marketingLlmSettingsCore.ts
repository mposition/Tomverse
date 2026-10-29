/**
 * What the Admin route for the generator's model and monthly cap names
 * outside its transaction: the audit action and the refusal the writer
 * raises. Kept apart from the writer (lib/marketingLlmSettingsStore.ts) so the
 * route reaches the store only inside the mutation's `run`.
 */

export const MARKETING_LLM_SETTINGS_ACTION = "marketing_setting.llm_changed";

export class MarketingLlmSettingsRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketingLlmSettingsRefusedError";
    this.code = code;
  }
}
