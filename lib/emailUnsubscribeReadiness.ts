import { readUnsubscribeKeyring } from "@/lib/unsubscribeToken";

/**
 * Whether the unsubscribe keyring has to work here, and whether it does.
 *
 * Contract: docs/policy/email-notifications.md §11.3,
 * .github/audits/model-lifecycle-email-2026-08-22.md EM-10.
 *
 * ## Why this is conditional and the other two are not
 *
 * The sending identity and the snapshot keyring are unconditional because the
 * standard lane is live wherever this code is: every receipt and deletion
 * notice needs them. Unsubscribe keys are needed only by marketing, and gating
 * readiness on them unconditionally would refuse today's deployment in order to
 * announce a capability nobody has turned on.
 *
 * ## What "marketing is on" is read from
 *
 * `MARKETING_EMAIL_FROM`. There is no `feature.emailMarketingEnabled` in this
 * codebase -- §15.2 names one and nothing implements it -- so the honest signal
 * is the one structural thing that has to be true before a marketing message
 * can leave: its own sending identity. A deployment that sets that address and
 * not the keys is exactly the state EM-10 describes, where `/api/ready` answers
 * yes while every marketing send is refused.
 *
 * ## Why a broken keyring is an error either way
 *
 * A keyring that is present and unparseable was set by somebody who meant it to
 * work. Reporting that as "not required yet" would hide a typo until the day
 * marketing is switched on, which is the worst possible day to find it.
 */

export type UnsubscribeReadinessProblem = {
  severity: "error" | "warning";
  code: string;
  message: string;
};

export type UnsubscribeReadinessEnv = {
  EMAIL_UNSUBSCRIBE_KEYS?: string | undefined;
  EMAIL_UNSUBSCRIBE_KEY_VERSION?: string | undefined;
  MARKETING_EMAIL_FROM?: string | undefined;
  /**
   * Widened so `process.env` satisfies it. A closed shape would be tighter but
   * would also mean this could never be called with the real environment.
   */
  [key: string]: string | undefined;
};

/**
 * True when a marketing message could actually be sent from this deployment.
 *
 * Deliberately not "a marketing template exists": templates are registered by
 * code and exist in every environment, so that test would make the keys
 * mandatory everywhere the moment one was written -- which is what happened
 * when `model_launch` was added.
 */
export const marketingSendingConfigured = (env: UnsubscribeReadinessEnv) =>
  Boolean(env.MARKETING_EMAIL_FROM?.trim());

export const unsubscribeKeyringProblems = (
  env: UnsubscribeReadinessEnv
): UnsubscribeReadinessProblem[] => {
  const problems: UnsubscribeReadinessProblem[] = [];
  const raw = env.EMAIL_UNSUBSCRIBE_KEYS?.trim();
  const required = marketingSendingConfigured(env);

  if (!raw) {
    problems.push({
      severity: required ? "error" : "warning",
      code: "EMAIL_UNSUBSCRIBE_KEYS_MISSING",
      message: required
        ? "MARKETING_EMAIL_FROM is set but EMAIL_UNSUBSCRIBE_KEYS is not, so every marketing message will be refused for having no one-click unsubscribe link."
        : "EMAIL_UNSUBSCRIBE_KEYS is unset. Harmless while MARKETING_EMAIL_FROM is also unset, and required before it is set.",
    });
    return problems;
  }

  // Parsed rather than pattern-matched, so this reports what the sender will
  // actually get rather than what the string looks like.
  let keyring: ReturnType<typeof readUnsubscribeKeyring>;
  try {
    keyring = readUnsubscribeKeyring(env as NodeJS.ProcessEnv);
  } catch (error) {
    problems.push({
      severity: "error",
      code: "EMAIL_UNSUBSCRIBE_KEYS_INVALID",
      message:
        error instanceof Error
          ? error.message
          : "EMAIL_UNSUBSCRIBE_KEYS could not be read.",
    });
    return problems;
  }

  if (!keyring) {
    problems.push({
      severity: "error",
      code: "EMAIL_UNSUBSCRIBE_KEYS_INVALID",
      message:
        "EMAIL_UNSUBSCRIBE_KEYS is set but holds no usable version:secret pair.",
    });
    return problems;
  }

  const versions = Object.keys(keyring.secrets);
  if (versions.length > 1 && !env.EMAIL_UNSUBSCRIBE_KEY_VERSION?.trim()) {
    // The same drift the snapshot keyring warns about: with no pin, which key
    // signs new tokens is decided by the order the pairs happen to appear in,
    // so a rotation that adds a key before pinning it moves the active version
    // without anybody choosing to.
    problems.push({
      severity: "warning",
      code: "EMAIL_UNSUBSCRIBE_ACTIVE_VERSION_UNPINNED",
      message: `EMAIL_UNSUBSCRIBE_KEYS holds ${versions.length} versions and EMAIL_UNSUBSCRIBE_KEY_VERSION is unset, so new tokens are signed under whichever pair is listed first rather than one that was chosen.`,
    });
  }

  return problems;
};

/** What a health check reports about the unsubscribe keyring. */
export const unsubscribeKeyringReadiness = (
  env: UnsubscribeReadinessEnv = process.env
) => {
  const problems = unsubscribeKeyringProblems(env);
  const errors = problems.filter((problem) => problem.severity === "error");
  return {
    ready: errors.length === 0,
    /** Whether this deployment is one the keys are mandatory for. */
    required: marketingSendingConfigured(env),
    errors,
    warnings: problems.filter((problem) => problem.severity === "warning"),
  };
};
