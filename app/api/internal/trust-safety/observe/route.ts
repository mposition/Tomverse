export const dynamic = "force-dynamic";
// Longer than the round's own budget `B`, because the hard limit belongs to the
// cron service: its supervisor SIGKILLs the child at the deadline (§4). This
// route claims no hard timeout -- a Next handler cannot end itself, and it
// cannot take back a COMMIT it already sent.
export const maxDuration = 120;

import { createHash, timingSafeEqual } from "node:crypto";

import { runTrustSafetyObservation } from "@/lib/trustSafetyObserverRound";

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
// Nothing is turned on by this file. Until an operator writes the config row
// through E3, every round answers `disabled` and writes nothing.

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

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
    const result = await runTrustSafetyObservation({ env: process.env });
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
    return json({ outcome: result.outcome }, result.outcome === "failed" ? 500 : 200);
  } catch (error) {
    // The error's name and a code-shaped code, never a message and never the
    // query: a refusal from the arming function or a late COMMIT arrives here
    // with the row already absent, and there is nothing to clean up (§5.5).
    const code = (error as { code?: unknown })?.code;
    console.error(
      JSON.stringify({
        event: "trust_safety_observation_failed",
        errorName: error instanceof Error ? error.name : "unknown",
        errorCode: typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null,
      }),
    );
    return json({ outcome: "failed" }, 500);
  }
}
