import {
  createUnsubscribeToken,
  readUnsubscribeToken,
  type UnsubscribeKeyring,
} from "@/lib/unsubscribeToken";

/**
 * Whether every unsubscribe key recent mail depends on still opens its links.
 *
 * Contract: docs/policy/email-notifications.md §11.4.
 *
 * Pure: the caller supplies the canaries, the sends and the clock. This is a
 * keyring check and nothing more -- it decrypts, it does not call the endpoint,
 * touch a rate limit or write a preference. Whether the endpoint itself works
 * end to end is a separate check.
 */

/**
 * How long a key version stays required after the last message signed with it.
 *
 * The approved contract keeps previous versions verifiable for a year after
 * rotation (§11.4), well past CAN-SPAM's thirty-day floor: tokens never expire,
 * people unsubscribe from old mail, and a secret deleted too early cannot be
 * brought back.
 */
export const UNSUBSCRIBE_KEY_RETENTION_DAYS = 365;
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
    | "EMAIL_UNSUBSCRIBE_KEY_CANARY_MISSING"
    | "EMAIL_UNSUBSCRIBE_UNATTRIBUTED_MAIL_UNADOPTED";
  keyVersion: string;
  message: string;
};

export type KeyRetentionInput = {
  keyring: UnsubscribeKeyring | null;
  canaries: Array<{ keyVersion: string; token: string }>;
  /** Most recent `sentAt` per recorded key version; absent means never sent. */
  lastSentAt: Record<string, Date | null | undefined>;
  /**
   * Most recent send of a message that carried an unsubscribe link but records
   * no key version -- everything sent before versions were recorded.
   */
  unattributedLastSentAt?: Date | null;
  /**
   * The versions adopted as the guard for that mail, or null if no adoption has
   * happened. Adoption is done once by the drain, never by this check.
   */
  adoptedKeyVersions?: string[] | null;
  now: Date;
};

export type KeyRetentionVerdict = {
  ready: boolean;
  errors: KeyRetentionProblem[];
  warnings: KeyRetentionProblem[];
  /** Versions no mail in the retention window depends on. */
  retirable: string[];
};

const retainUntil = (sentAt: Date | null) =>
  sentAt ? new Date(sentAt.getTime() + RETENTION_MS) : null;

export const unsubscribeKeyRetentionVerdict = (
  input: KeyRetentionInput
): KeyRetentionVerdict => {
  const errors: KeyRetentionProblem[] = [];
  const warnings: KeyRetentionProblem[] = [];
  const retirable: string[] = [];

  const unattributed = input.unattributedLastSentAt ?? null;
  const unattributedUntil = retainUntil(unattributed);
  const unattributedRequired = unattributedUntil !== null && input.now < unattributedUntil;
  const adopted = new Set(input.adoptedKeyVersions ?? []);
  const canaryVersions = new Set(input.canaries.map((canary) => canary.keyVersion));

  // Mail sent before versions were recorded, not yet adopted. A warning and not
  // an error, deliberately: nothing that happened before this code shipped can
  // be verified by any mechanism, the first drain after deploy adopts the
  // keyring, and refusing readiness here would refuse the very deployment that
  // starts recording. It is reported so it is not mistaken for verified.
  if (unattributed && unattributedRequired && input.adoptedKeyVersions == null) {
    warnings.push({
      severity: "warning",
      code: "EMAIL_UNSUBSCRIBE_UNATTRIBUTED_MAIL_UNADOPTED",
      keyVersion: "unattributed",
      message: `Mail with unsubscribe links was sent before key versions were recorded (last ${unattributed.toISOString()}) and the keyring has not been adopted as its guard yet. Do not remove or edit any key version until the next email drain has run.`,
    });
  }

  // A version recent mail was recorded under must have a canary. Without one the
  // check below has nothing to decrypt, and silence would read as verified.
  for (const [keyVersion, sentAt] of Object.entries(input.lastSentAt).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const until = retainUntil(sentAt ?? null);
    if (until && input.now < until && !canaryVersions.has(keyVersion)) {
      errors.push({
        severity: "error",
        code: "EMAIL_UNSUBSCRIBE_KEY_CANARY_MISSING",
        keyVersion,
        message: `Mail signed with unsubscribe key version "${keyVersion}" was sent within ${UNSUBSCRIBE_KEY_RETENTION_DAYS} days, but no canary exists for it, so nothing proves the version still opens its links.`,
      });
    }
  }

  for (const canary of [...input.canaries].sort((a, b) =>
    a.keyVersion.localeCompare(b.keyVersion)
  )) {
    const own = input.lastSentAt[canary.keyVersion] ?? null;
    // Unattributed mail holds only the versions adopted for it.
    const inherited = adopted.has(canary.keyVersion) ? unattributed : null;
    const lastSent =
      own && inherited
        ? new Date(Math.max(own.getTime(), inherited.getTime()))
        : (own ?? inherited);
    const until = retainUntil(lastSent);
    const required = until !== null && input.now < until;
    const untilText = until?.toISOString() ?? "";

    if (!input.keyring) {
      if (required) {
        errors.push({
          severity: "error",
          code: "EMAIL_UNSUBSCRIBE_KEYRING_ABSENT_WITH_RECENT_MAIL",
          keyVersion: canary.keyVersion,
          message: `EMAIL_UNSUBSCRIBE_KEYS is unset, but mail depending on version "${canary.keyVersion}" was sent within ${UNSUBSCRIBE_KEY_RETENTION_DAYS} days; its unsubscribe links are dead until the version is restored.`,
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
          message: `Unsubscribe key version "${canary.keyVersion}" was removed, but mail depending on it was sent within ${UNSUBSCRIBE_KEY_RETENTION_DAYS} days. Restore it; it can be removed after ${untilText}.`,
        });
      } else {
        retirable.push(canary.keyVersion);
      }
      continue;
    }

    // Listed, but it no longer opens what it signed: the secret behind the
    // version name was replaced. Every link of that vintage is dead just as if
    // the version were gone; rotate by adding a version, never by editing one.
    const problem: KeyRetentionProblem = {
      severity: required ? "error" : "warning",
      code: "EMAIL_UNSUBSCRIBE_KEY_CHANGED",
      keyVersion: canary.keyVersion,
      message: `Unsubscribe key version "${canary.keyVersion}" is listed but no longer opens tokens it signed; its secret was changed. Rotate by adding a new version, not by editing an existing one.`,
    };
    (required ? errors : warnings).push(problem);
  }

  // Without a keyring and without canaries there is nothing to decrypt, but
  // unattributed mail still needs a key.
  if (unattributed && unattributedRequired && !input.keyring && input.canaries.length === 0) {
    errors.push({
      severity: "error",
      code: "EMAIL_UNSUBSCRIBE_KEYRING_ABSENT_WITH_RECENT_MAIL",
      keyVersion: "unattributed",
      message: `EMAIL_UNSUBSCRIBE_KEYS is unset, but mail with unsubscribe links was sent within ${UNSUBSCRIBE_KEY_RETENTION_DAYS} days; its links are dead.`,
    });
  }

  return { ready: errors.length === 0, errors, warnings, retirable };
};
