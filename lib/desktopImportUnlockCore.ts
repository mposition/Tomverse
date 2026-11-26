/**
 * Unlocking a password-locked imported original from the Desktop app.
 *
 * The lock grant is issued by exactly one route, `POST
 * /api/external-conversations/{id}/lock/verify`; nothing here mints one. What
 * this adds is only that the Desktop app can learn which snapshot to ask that
 * route about: the locked timeline answer names it, to the signed-in owner,
 * on a Desktop request, while this switch is on.
 */

/** Default off: with it unset the locked answer is exactly `{ status: "locked" }`. */
export const desktopImportUnlockEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.TOMVERSE_DESKTOP_IMPORT_UNLOCK_ENABLED === "true";

export type LockedContinuationSource = { status: "locked"; externalConversationId?: string };

/**
 * `snapshotId` must come from a row already read with `userId` in its filter;
 * `desktopRequest` is the Desktop app's bearer origin. Any other asker, or the
 * switch being off, gets the answer without an id.
 */
export function lockedContinuationSource(input: {
  snapshotId: string;
  enabled: boolean;
  desktopRequest: boolean;
}): LockedContinuationSource {
  return input.enabled && input.desktopRequest
    ? { status: "locked", externalConversationId: input.snapshotId }
    : { status: "locked" };
}
