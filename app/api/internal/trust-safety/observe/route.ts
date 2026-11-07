export const dynamic = "force-dynamic";
// Above the round's own budget `B` and above the supervisor's kill, so the
// limit that ends a run is the service's and not the platform's (§4). The
// platform will cut the handler here, but §4's point stands: *this route*
// claims no hard timeout of its own -- a Next handler cannot end itself, and
// neither it nor the platform can take back a COMMIT already sent.
export const maxDuration = 120;

import { createHash, timingSafeEqual } from "node:crypto";

import { runTrustSafetyObservation } from "@/lib/trustSafetyObserverRound";
import { TrustSafetyRoundRefused, isBudgetInsufficient } from "@/lib/trustSafetyTransaction";

// E1, the trust-safety observer's only entry point into product state
// (docs/policy/trust-safety-compliance-agent.md §4, §5.6).
//
// The Railway cron service calls this on the declared period with a bearer
// secret and nothing else. That service holds two variables -- this secret and
// this URL -- and no database credential, no platform token, no LLM key and
// not the ping URL. It is a clock; the judgement is here.
//
// **The route reads neither the request body nor its query.** §4 states it as
// a property of the design, not an omission: no value from the request may
// choose what is judged, what it is judged about, or what is reported. So
// there is no schema to parse and no parameter to validate -- the only thing
// read from the request is the authorization header.
//
// The response is §4's closed enum and carries no DSR value, no count and no
// ping URL. A round that could not judge activation answers `failed`, one that
// found the switch off answers `disabled`, and one that observed and recorded
// answers `ran` -- including when §6's sixth fault withheld the ping, because
// the round did run and the monitor's silence after `W` is the consequence.
//
// Nothing is turned on by this file, and before activation the answer is
// `failed`, not `disabled`: with no config row §6's first check is a fault
// that stops counting, and the section keeps a fault apart from a switch
// someone deliberately turned off. `disabled` begins once a person has written
// the row through E3 and set it to `off`. Either way nothing is written and no
// ping goes out.
//
// That pre-activation `failed` answers 202, not 500. The body is still the
// enum's `failed` -- §6 keeps the missing row a fault -- but the status lets
// the child exit 0 for this one case, so a cron service deployed ahead of the
// owner's activation does not show CRASHED every period and bury a real
// failure under them (owner direction 2026-11-07). Every other `failed` --
// another fault, a thrown round, a refusal -- stays non-2xx.

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

/** The status of the one `failed` the child treats as success: no config row yet. */
const NOT_ACTIVATED_STATUS = 202;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });

/**
 * Only `TRUST_SAFETY_OBSERVER_SECRET`, at 32 characters or more, compared as
 * SHA-256 digests in constant time (§4).
 *
 * Not `MAINTENANCE_SECRET` as a fallback, the way older internal routes do:
 * this route reads personal data, and a secret shared with the cleanup cron is
 * a secret whose leak reaches that.
 */
const authorized = (request: Request): boolean => {
  const secret = process.env.TRUST_SAFETY_OBSERVER_SECRET;
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(secret).digest(),
    createHash("sha256").update(provided).digest(),
  );
};

export async function POST(request: Request) {
  if (!authorized(request)) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    const result = await runTrustSafetyObservation();
    // Structured and value-free: the outcome, the fault §6 named and what
    // happened to the ping. Never the ping URL, never a count, never a request
    // id of a person's.
    console.info(
      JSON.stringify({
        event: "trust_safety_observation",
        outcome: result.outcome,
        mode: result.activation.mode,
        fault: result.activation.fault,
        ping: result.ping,
      }),
    );
    const notActivated =
      result.outcome === "failed" && result.activation.fault === "config_row_missing";
    const status = result.outcome !== "failed" ? 200 : notActivated ? NOT_ACTIVATED_STATUS : 500;
    return json({ outcome: result.outcome }, status);
  } catch (error) {
    // The error's name and a code-shaped code, never a message and never the
    // query: a refusal from the arming function or a late COMMIT arrives here
    // with the row already absent, and there is nothing to clean up (§5.5).
    const code = (error as { code?: unknown })?.code;
    // A refusal the design expects -- too little budget to start a transaction
    // in (the arming function's OB001, recognised by SQLSTATE through either
    // error shape) or one of the wrapper's own refusals -- is a round that did
    // not run, not a broken app. It answers `failed` either way, and the
    // status says which it was so an operator is not sent looking for a fault.
    //
    // 409 rather than 200: the child turns a non-2xx into a non-zero exit, so
    // a run where no round happened does not read as a service-level success.
    // Independent review found that it did.
    const expected = isBudgetInsufficient(error) || error instanceof TrustSafetyRoundRefused;
    console.error(
      JSON.stringify({
        event: "trust_safety_observation_failed",
        expected,
        errorName: error instanceof Error ? error.name : "unknown",
        errorCode: typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null,
      }),
    );
    return json({ outcome: "failed" }, expected ? 409 : 500);
  }
}
