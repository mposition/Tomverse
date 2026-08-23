/**
 * How a reader treats `Conversation.productKey = NULL`, and when it must stop.
 *
 * Product boundary decision record v1.2, §2.
 *
 * ## Two modes, and the second is the destination
 *
 *   legacy_fallback  NULL reads as `review`, temporarily;
 *   strict           NULL is a data defect and is reported as one.
 *
 * `legacy_fallback` is what makes the expand phase survivable -- rows written
 * before the column existed still open. It is also the mode that quietly
 * becomes permanent if nothing forces the question, which is what the expiry
 * is for.
 *
 * ## Why the expiry has three separate refusals
 *
 * A missing value makes `legacy_fallback` a terminal state: "until the
 * designated release or the expiry date" is the *shape* of an expiry rule, not
 * an expiry. A date already in the past is a value that was set and then
 * forgotten. And a date further out than the policy allows is the one an
 * operator reaches for when the transition is inconvenient -- without the
 * third refusal, 2099-01-01 passes every check and the policy has no teeth.
 *
 * ## The maximum lifetime, and why it needs an anchor
 *
 * The decision record fixes the limit relative to deployment, not absolutely:
 *
 *   strict within 30 days of the expand deploying, or two production
 *   releases, whichever comes first.
 *
 * The repository cannot know when the expand deployed. So the anchor is an
 * environment variable the deploy sets, and its absence is itself a refusal
 * rather than a reason to skip the third check -- a limit that silently stops
 * applying when its input is missing is not a limit.
 *
 * The "two production releases" half cannot be computed here at all: this code
 * has no release counter. It is a runbook obligation
 * (docs/ops/product-key-transition.md), and the date is the half that can be
 * mechanised.
 *
 * Pure, so it can be tested without an environment.
 */

export const PRODUCT_KEY_READ_MODES = ["legacy_fallback", "strict"] as const;

export type ProductKeyReadMode = (typeof PRODUCT_KEY_READ_MODES)[number];

export const PRODUCT_KEY_READ_MODE_ENV = "PRODUCT_KEY_READ_MODE";
export const PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT_ENV =
  "PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT";
export const PRODUCT_KEY_EXPAND_DEPLOYED_AT_ENV = "PRODUCT_KEY_EXPAND_DEPLOYED_AT";

/** Decision record §2: 30 days from the expand deploying. */
export const LEGACY_FALLBACK_MAX_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ProductKeyReadModeProblem = {
  code:
    | "unknown_mode"
    | "missing_expiry"
    | "expiry_not_rfc3339"
    | "expiry_in_the_past"
    | "missing_expand_anchor"
    | "expand_anchor_not_rfc3339"
    | "expiry_beyond_maximum_lifetime";
  message: string;
};

/**
 * RFC 3339, not "anything `Date` will swallow".
 *
 * `new Date("2026-13-01")` is Invalid Date, but `new Date("2026")` is a valid
 * instant and `new Date("next tuesday")` is not -- the point is that a
 * timestamp an operator half-typed must be refused rather than interpreted.
 * The offset is required: an expiry without one means a different instant
 * depending on which machine reads it, which is exactly the ambiguity a
 * deadline cannot have.
 */
const RFC_3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export const parseRfc3339 = (value: string): Date | null => {
  if (!RFC_3339.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export type ProductKeyReadModeInput = {
  /** Raw environment values, so the caller decides where they come from. */
  mode: string | undefined;
  expiresAt: string | undefined;
  expandDeployedAt: string | undefined;
  now: Date;
};

export type ProductKeyReadModeResolution = {
  /**
   * The mode a reader should use, or null when the configuration is refused.
   *
   * Null rather than a fallback: a resolver that answered `legacy_fallback` on
   * a broken configuration would turn every refusal below into a silent
   * extension of the transition.
   */
  mode: ProductKeyReadMode | null;
  problems: ProductKeyReadModeProblem[];
  /** Present when the expiry parsed, whether or not it was accepted. */
  expiresAt: Date | null;
};

/**
 * `legacy_fallback` when unset.
 *
 * The transition's own state, so an expand deploy that has not yet been told
 * about the variable still reads old rows. It does not weaken the expiry: an
 * unset mode still has to carry one, which is what stops "we never set the
 * variable" from becoming the permanent configuration.
 */
export const DEFAULT_PRODUCT_KEY_READ_MODE: ProductKeyReadMode = "legacy_fallback";

export const resolveProductKeyReadMode = (
  input: ProductKeyReadModeInput
): ProductKeyReadModeResolution => {
  const problems: ProductKeyReadModeProblem[] = [];
  const raw = input.mode?.trim() || "";
  const mode = raw === "" ? DEFAULT_PRODUCT_KEY_READ_MODE : raw;

  if (!(PRODUCT_KEY_READ_MODES as readonly string[]).includes(mode)) {
    return {
      mode: null,
      expiresAt: null,
      problems: [
        {
          code: "unknown_mode",
          message:
            `${PRODUCT_KEY_READ_MODE_ENV}="${raw}" is not a read mode. ` +
            `Expected one of: ${PRODUCT_KEY_READ_MODES.join(", ")}.`,
        },
      ],
    };
  }

  // Strict needs no expiry: there is nothing left to expire. Checking one
  // anyway would make the final state harder to configure than the temporary
  // one, which is backwards.
  if (mode === "strict") {
    return { mode: "strict", expiresAt: null, problems: [] };
  }

  const rawExpiry = input.expiresAt?.trim() || "";
  if (rawExpiry === "") {
    problems.push({
      code: "missing_expiry",
      message:
        `${PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT_ENV} is required while ` +
        `${PRODUCT_KEY_READ_MODE_ENV} is legacy_fallback. Without it the ` +
        "fallback is the terminal state rather than a transition.",
    });
    return { mode: null, expiresAt: null, problems };
  }

  const expiresAt = parseRfc3339(rawExpiry);
  if (!expiresAt) {
    problems.push({
      code: "expiry_not_rfc3339",
      message:
        `${PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT_ENV}="${rawExpiry}" is not an ` +
        "RFC 3339 timestamp with an offset (for example 2026-09-15T00:00:00Z).",
    });
    return { mode: null, expiresAt: null, problems };
  }

  if (expiresAt.getTime() <= input.now.getTime()) {
    problems.push({
      code: "expiry_in_the_past",
      message:
        `${PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT_ENV}=${expiresAt.toISOString()} ` +
        "has already passed. The transition was supposed to end; extend it " +
        "deliberately or move to strict.",
    });
  }

  const rawAnchor = input.expandDeployedAt?.trim() || "";
  if (rawAnchor === "") {
    // Not a reason to skip the maximum-lifetime check: a limit that stops
    // applying when its input is missing is not a limit.
    problems.push({
      code: "missing_expand_anchor",
      message:
        `${PRODUCT_KEY_EXPAND_DEPLOYED_AT_ENV} is required to check the ` +
        `${LEGACY_FALLBACK_MAX_DAYS}-day maximum lifetime. Set it to when the ` +
        "expand migration reached production.",
    });
    return { mode: null, expiresAt, problems };
  }

  const expandDeployedAt = parseRfc3339(rawAnchor);
  if (!expandDeployedAt) {
    problems.push({
      code: "expand_anchor_not_rfc3339",
      message:
        `${PRODUCT_KEY_EXPAND_DEPLOYED_AT_ENV}="${rawAnchor}" is not an RFC 3339 ` +
        "timestamp with an offset.",
    });
    return { mode: null, expiresAt, problems };
  }

  const latestAllowed = new Date(
    expandDeployedAt.getTime() + LEGACY_FALLBACK_MAX_DAYS * DAY_MS
  );
  if (expiresAt.getTime() > latestAllowed.getTime()) {
    problems.push({
      code: "expiry_beyond_maximum_lifetime",
      message:
        `${PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT_ENV}=${expiresAt.toISOString()} ` +
        `is beyond ${LEGACY_FALLBACK_MAX_DAYS} days from the expand deploy ` +
        `(${expandDeployedAt.toISOString()}); the latest allowed is ` +
        `${latestAllowed.toISOString()}.`,
    });
  }

  return {
    mode: problems.length === 0 ? "legacy_fallback" : null,
    expiresAt,
    problems,
  };
};

/**
 * What a reader does with a NULL productKey.
 *
 * `strict` returns null and names the row a defect rather than throwing: the
 * caller decides whether a defect is fatal for its own path, and a reader that
 * threw would take down a screen over a row it could have reported.
 */
export const readProductKey = (
  stored: string | null,
  mode: ProductKeyReadMode
): { productKey: string | null; defect: boolean } => {
  if (stored !== null) return { productKey: stored, defect: false };
  return mode === "legacy_fallback"
    ? { productKey: "review", defect: false }
    : { productKey: null, defect: true };
};
