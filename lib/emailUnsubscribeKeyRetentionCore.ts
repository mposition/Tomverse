import {
  createUnsubscribeToken,
  readUnsubscribeToken,
  type UnsubscribeKeyring,
} from "@/lib/unsubscribeToken";

/**
 * Whether every unsubscribe key a recent message depends on still opens its
 * links.
 *
 * Contract: docs/policy/email-notifications.md §11.4.
 *
 * Pure: the caller supplies the canaries, the last send per version and the
 * clock. This is a keyring check and nothing more -- it decrypts, it does not
 * call the endpoint, touch a rate limit or write a preference. Whether the
 * endpoint itself works end to end is a separate check.
 */

/** CAN-SPAM's floor for how long an opt-out mechanism must keep working. */
export const UNSUBSCRIBE_KEY_RETENTION_DAYS = 30;
const RETENTION_MS = UNSUBSCRIBE_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

/** The subject and purpose of a canary. Neither is an account id or a purpose. */
export const CANARY_SUBJECT = "keyring-canary";
export const CANARY_PURPOSE = "__keyring_canary__";

export const mintUnsubscribeKeyCanary = (keyring: UnsubscribeKeyring) =>
  createUnsubscribeToken({ userId: CANARY_SUBJECT, purpose: CANARY_PURPOSE }, keyring);

export type KeyRetentionProblem = {
  severity: "error" | "warning";
  code:
    | "EMAIL_UNSUBSCRIBE_KEY_RETIRED_TOO_EARLY"
    | "EMAIL_UNSUBSCRIBE_KEY_CHANGED"
    | "EMAIL_UNSUBSCRIBE_KEYRING_ABSENT_WITH_RECENT_MAIL"
    | "EMAIL_UNSUBSCRIBE_UNATTRIBUTED_MAIL_UNPROTECTED";
  keyVersion: string;
  message: string;
};

export type KeyRetentionInput = {
  keyring: UnsubscribeKeyring | null;
  canaries: Array<{ keyVersion: string; token: string }>;
  /** Most recent `sentAt` per key version; absent means never sent. */
  lastSentAt: Record<string, Date | null | undefined>;
  /**
   * Most recent send of a message that carried an unsubscribe link but records
   * no key version -- everything sent before versions were recorded. Nobody can
   * say which version signed it, so it holds *every* canaried version until it
   * ages out of the window.
   */
  unattributedLastSentAt?: Date | null;
  now: Date;
};

export type KeyRetentionVerdict = {
  ready: boolean;
  errors: KeyRetentionProblem[];
  warnings: KeyRetentionProblem[];
  /** Versions no message sent in the retention window depends on. */
  retirable: string[];
};

export const unsubscribeKeyRetentionVerdict = (
  input: KeyRetentionInput
): KeyRetentionVerdict => {
  const errors: KeyRetentionProblem[] = [];
  const warnings: KeyRetentionProblem[] = [];
  const retirable: string[] = [];
  const unattributed = input.unattributedLastSentAt ?? null;
  const unattributedRequired =
    unattributed !== null && input.now.getTime() < unattributed.getTime() + RETENTION_MS;

  // Mail that depends on a key nobody recorded, with nothing standing guard over
  // any key. Fail closed: whatever the keyring looks like, it cannot be shown
  // to still open those links.
  if (unattributed && unattributedRequired && (input.canaries.length === 0 || !input.keyring)) {
    const until = new Date(unattributed.getTime() + RETENTION_MS).toISOString();
    errors.push({
      severity: "error",
      code: input.keyring
        ? "EMAIL_UNSUBSCRIBE_UNATTRIBUTED_MAIL_UNPROTECTED"
        : "EMAIL_UNSUBSCRIBE_KEYRING_ABSENT_WITH_RECENT_MAIL",
      keyVersion: "unattributed",
      message: input.keyring
        ? `Mail with unsubscribe links sent before key versions were recorded (last ${unattributed.toISOString()}) has no canary guarding its key. Keep every current version until ${until}.`
        : `EMAIL_UNSUBSCRIBE_KEYS is unset, but mail with unsubscribe links was sent within ${UNSUBSCRIBE_KEY_RETENTION_DAYS} days; its links are dead until ${until}.`,
    });
  }

  for (const canary of [...input.canaries].sort((a, b) =>
    a.keyVersion.localeCompare(b.keyVersion)
  )) {
    const own = input.lastSentAt[canary.keyVersion] ?? null;
    const lastSent =
      own && unattributed
        ? new Date(Math.max(own.getTime(), unattributed.getTime()))
        : (own ?? unattributed);
    const retainUntil = lastSent ? new Date(lastSent.getTime() + RETENTION_MS) : null;
    const required = retainUntil !== null && input.now < retainUntil;
    const until = retainUntil?.toISOString() ?? "";

    if (!input.keyring) {
      if (required) {
        errors.push({
          severity: "error",
          code: "EMAIL_UNSUBSCRIBE_KEYRING_ABSENT_WITH_RECENT_MAIL",
          keyVersion: canary.keyVersion,
          message: `EMAIL_UNSUBSCRIBE_KEYS is unset, but mail signed with version "${canary.keyVersion}" was sent within ${UNSUBSCRIBE_KEY_RETENTION_DAYS} days; its unsubscribe links are dead until ${until}.`,
        });
      } else {
        retirable.push(canary.keyVersion);
      }
      continue;
    }

    const read = readUnsubscribeToken(canary.token, input.keyring);
    const opens =
      read.valid &&
      read.payload.userId === CANARY_SUBJECT &&
      read.payload.purpose === CANARY_PURPOSE;
    if (opens) {
      if (!required) retirable.push(canary.keyVersion);
      continue;
    }

    if (read.valid === false && read.reason === "unknown_key") {
      if (required) {
        errors.push({
          severity: "error",
          code: "EMAIL_UNSUBSCRIBE_KEY_RETIRED_TOO_EARLY",
          keyVersion: canary.keyVersion,
          message: `Unsubscribe key version "${canary.keyVersion}" was removed, but mail signed with it was sent within ${UNSUBSCRIBE_KEY_RETENTION_DAYS} days. Restore it; it can be removed after ${until}.`,
        });
      } else {
        retirable.push(canary.keyVersion);
      }
      continue;
    }

    // Listed, but it no longer opens what it signed: the secret behind the
    // version name was replaced. Every link of that vintage is dead just as if
    // the version were gone, and a rename of the version is the only safe way
    // to rotate.
    const problem: KeyRetentionProblem = {
      severity: required ? "error" : "warning",
      code: "EMAIL_UNSUBSCRIBE_KEY_CHANGED",
      keyVersion: canary.keyVersion,
      message: `Unsubscribe key version "${canary.keyVersion}" is listed but no longer opens tokens it signed; its secret was changed. Rotate by adding a new version, not by editing an existing one.`,
    };
    (required ? errors : warnings).push(problem);
  }

  return { ready: errors.length === 0, errors, warnings, retirable };
};
