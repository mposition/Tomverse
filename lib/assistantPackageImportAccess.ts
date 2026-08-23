/**
 * The rollout flag for importing an assistant package (Slice 4).
 *
 * docs/policy/assistant-package-import.md §11.
 *
 * Default off, enabled only by an explicit `AppSetting` row, and missing or
 * unreadable configuration reads as off. The same shape as the flags in
 * `lib/memoryAccess.ts`, for the same reason: a rollout flag whose default is
 * "on unless told otherwise" turns every configuration mistake into an
 * unannounced launch.
 *
 * The flag exists now, ahead of the feature being complete, so the day it is
 * turned on is a settings change against a path that has already been reviewed
 * -- not a deploy. Turning it on is a human decision with its own
 * preconditions, and none of them are met yet.
 *
 * Pure: no Prisma, no clock, no network. The reader that touches the database
 * is `isAssistantPackageImportEnabled()` in `lib/appSettings.ts`.
 */

export const ASSISTANT_PACKAGE_IMPORT_FLAG_KEY =
    "feature.assistantPackageImportEnabled";

/**
 * Exactly `"true"` and nothing else.
 *
 * Not `Boolean(value)`, not a case-insensitive match, not `"1"`. A flag that
 * accepts several spellings is a flag whose off state depends on which
 * spelling somebody typed, and the off state is the one that has to be
 * reliable.
 */
export function assistantPackageImportEnabledFromValue(
    value: string | null | undefined
): boolean {
    return value === "true";
}
