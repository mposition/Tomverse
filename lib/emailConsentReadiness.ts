import { readConsentKeyring } from "@/lib/emailConsentToken";
import { marketingSendingConfigured } from "@/lib/emailUnsubscribeReadiness";

/**
 * Whether the consent confirmation keyring has to work here, and whether it does.
 *
 * Contract: docs/policy/email-double-opt-in.md §11 item 10.
 *
 * Conditional in exactly the shape of `lib/emailUnsubscribeReadiness.ts`, and on
 * the same signal: once `MARKETING_EMAIL_FROM` is set, a deployment without
 * `EMAIL_CONSENT_KEYS` answers ready while no person can confirm a marketing
 * consent -- so no marketing can ever be sent, and nothing says why. Before that
 * a missing key is a warning. A keyring that is present and unparseable is an
 * error either way, because somebody set it meaning it to work.
 */

export type ConsentReadinessProblem = {
  severity: "error" | "warning";
  code: string;
  message: string;
};

export const consentKeyringProblems = (
  env: Record<string, string | undefined>
): ConsentReadinessProblem[] => {
  const raw = env.EMAIL_CONSENT_KEYS?.trim();
  const required = marketingSendingConfigured(env);

  if (!raw) {
    return [
      {
        severity: required ? "error" : "warning",
        code: "EMAIL_CONSENT_KEYS_MISSING",
        message: required
          ? "MARKETING_EMAIL_FROM is set but EMAIL_CONSENT_KEYS is not, so no marketing consent can be confirmed and no marketing can be sent."
          : "EMAIL_CONSENT_KEYS is unset. Harmless while MARKETING_EMAIL_FROM is also unset, and required before it is set.",
      },
    ];
  }

  let keyring: ReturnType<typeof readConsentKeyring>;
  try {
    keyring = readConsentKeyring(env as NodeJS.ProcessEnv);
  } catch (error) {
    return [
      {
        severity: "error",
        code: "EMAIL_CONSENT_KEYS_INVALID",
        message:
          error instanceof Error ? error.message : "EMAIL_CONSENT_KEYS could not be read.",
      },
    ];
  }
  if (!keyring) {
    return [
      {
        severity: "error",
        code: "EMAIL_CONSENT_KEYS_INVALID",
        message: "EMAIL_CONSENT_KEYS is set but holds no usable version:secret pair.",
      },
    ];
  }

  const versions = Object.keys(keyring.secrets);
  if (versions.length > 1 && !env.EMAIL_CONSENT_KEY_VERSION?.trim()) {
    return [
      {
        severity: "warning",
        code: "EMAIL_CONSENT_ACTIVE_VERSION_UNPINNED",
        message: `EMAIL_CONSENT_KEYS holds ${versions.length} versions and EMAIL_CONSENT_KEY_VERSION is unset, so new tokens are signed under whichever pair is listed first.`,
      },
    ];
  }
  return [];
};

export const consentKeyringReadiness = (
  env: Record<string, string | undefined> = process.env
) => {
  const problems = consentKeyringProblems(env);
  const errors = problems.filter((problem) => problem.severity === "error");
  return {
    ready: errors.length === 0,
    required: marketingSendingConfigured(env),
    errors,
    warnings: problems.filter((problem) => problem.severity === "warning"),
  };
};
