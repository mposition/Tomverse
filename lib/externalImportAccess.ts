/**
 * Pure flag semantics for external conversation import (Release A).
 *
 * Like image generation — and unlike the default-on operational kill
 * switches in OPERATIONAL_FLAG_KEYS — this is a rollout flag: default OFF,
 * enabled only by an explicit AppSetting opt-in row, and missing
 * configuration must fail closed (policy §15). Kept pure so the semantics
 * are testable without a database.
 */

export const EXTERNAL_IMPORT_FLAG_KEY =
    "feature.externalConversationImportEnabled";

export function externalImportEnabledFromValue(
    value: string | null | undefined
): boolean {
    return value === "true";
}
