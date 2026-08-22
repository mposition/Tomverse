/**
 * Which recording mode the routing dispatch instrumentation is in.
 *
 * Its own module, and a pure one, because two very different callers need the
 * same answer: the request path in `lib/routingDispatchInstrumentation.ts`,
 * which is `server-only` and pulls in Next's request scope, and
 * `scripts/report-routing-dispatch-readiness.mjs`, which is a plain Node
 * script an operator runs against a database. Re-deriving `"observe" or
 * "enforce", otherwise off` in the second would be a second copy of the rule
 * that decides whether anything is recorded at all -- and the copy would be
 * the one nobody updated.
 */

export type DispatchInstrumentationMode = "off" | "observe" | "enforce";

export const ROUTING_DISPATCH_INSTRUMENTATION_ENV =
  "ROUTING_DISPATCH_INSTRUMENTATION";

/**
 * Anything that is not one of the two recording modes is off.
 *
 * Deliberately not a truthiness check: `ROUTING_DISPATCH_INSTRUMENTATION=true`
 * is somebody expecting recording to happen, and reading it as `observe` would
 * silently grant that. An unrecognised value records nothing, which is the
 * same thing the variable being unset does.
 */
export const dispatchInstrumentationMode = (
  environment: Record<string, string | undefined> = process.env
): DispatchInstrumentationMode => {
  const raw = environment[ROUTING_DISPATCH_INSTRUMENTATION_ENV];
  return raw === "observe" || raw === "enforce" ? raw : "off";
};
