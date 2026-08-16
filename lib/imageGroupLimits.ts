/**
 * How many models one image comparison request may fan out to.
 *
 * Extracted from `lib/imageGenerationService.ts` so the value can be resolved
 * without pulling Prisma, the R2 client and the provider adapters in behind
 * it. The server's admission check and the page that hands the composer its
 * starting state now read the *same* function, which is the point: a composer
 * that offers three models while admission allows two is not a cosmetic
 * mismatch, it is a request the UI presented as valid and the server can only
 * refuse.
 *
 * **This is not `IMAGE_INLINE_MODEL_DISCOVERY_LIMIT`.** That one decides how
 * many enabled models are discoverable without opening a picker -- an
 * information-density decision about one row of UI. This one decides how much
 * provider work a single request may start. They are the same number today by
 * coincidence and must not be folded together: conflating them would let an
 * execution limit restyle the composer, or a layout decision authorise
 * provider spend.
 *
 * Server-side only by convention rather than by `server-only`: the module is
 * imported by a Server Component that passes the resolved number down as a
 * prop, and nothing in it would work in a browser anyway (`process.env` is
 * build-time-substituted there, which is exactly the staleness this exists to
 * avoid). A client must receive the value, never resolve it.
 */

/**
 * The accepted range, stated as the parser actually behaves rather than as the
 * operational guidance reads.
 *
 * `max` is enforced; `min` is **documentation**, not a floor. The original
 * parser accepted any positive safe integer up to `max`, so
 * `IMAGE_GROUP_MAX_MODELS=1` resolves to 1 and pins the deployment to
 * single-model requests. That is a legal configuration -- a one-model request
 * is a one-target group -- and changing it here would silently alter admission
 * for any deployment already relying on it. Recorded so the next reader does
 * not mistake the guidance for a guarantee.
 */
export const IMAGE_GROUP_MAX_MODELS_BOUNDS = {
  /** Operational guidance floor. Not enforced by the parser; see above. */
  min: 2,
  /** Enforced ceiling: a larger value falls back rather than being clamped. */
  max: 4,
  /** Applied to an absent, malformed, non-integer, zero, negative or too-large value. */
  fallback: 2,
} as const;

/**
 * Resolve the limit from one raw environment value.
 *
 * Kept byte-for-byte equivalent to the `boundedEnvInt` call it replaces: a
 * value outside the accepted range falls back to 2 rather than being clamped
 * to the nearest bound, because a deployment that set 9 meant something the
 * ceiling cannot honour and quietly running at 4 would hide that.
 */
export const resolveImageGroupMaxModels = (raw: string | undefined): number => {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= IMAGE_GROUP_MAX_MODELS_BOUNDS.max
    ? parsed
    : IMAGE_GROUP_MAX_MODELS_BOUNDS.fallback;
};

/**
 * The limit this process is running with, read at call time.
 *
 * Read per request rather than captured at module load, so a deployment that
 * changes the variable takes effect on its next boot without a stale copy
 * surviving in a closure.
 */
export const imageGroupMaxModels = (
  env: Record<string, string | undefined> = process.env
): number => resolveImageGroupMaxModels(env.IMAGE_GROUP_MAX_MODELS);
