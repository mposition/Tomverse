#!/usr/bin/env node
// The trust-safety observer service's child: one request, and nothing else
// (docs/policy/trust-safety-compliance-agent.md §4).
//
// §4 calls this service a clock and an HTTP client. It holds no database
// credential and no ping URL, so there is nothing here to get wrong about the
// observation itself: it calls the internal route with its bearer secret and
// reports what came back as an exit code.
//
// The request carries no body and no query, because the route reads neither
// (§4). The response is the closed enum, and the child does not interpret it
// beyond "the route answered" -- the round's own record is the row it wrote,
// and the dead-man monitor, not this process, is what notices silence (§8).

import { CHILD_TIMEOUT_MS } from "./timing-core.mjs";

const OBSERVE_PATH = "/api/internal/trust-safety/observe";

/** Exit codes the supervisor turns into the service's own. */
export const EXIT = Object.freeze({
  ok: 0,
  configError: 2,
  requestFailed: 3,
  routeRefused: 4,
});

/**
 * Make the one request. Pure in its inputs: the caller passes the environment
 * and the fetch implementation, so a test needs neither a network nor a clock.
 */
export async function observeOnce({ env, fetchImpl = fetch, log = console.log }) {
  const base = env.TRUST_SAFETY_OBSERVER_URL;
  const secret = env.TRUST_SAFETY_OBSERVER_SECRET;
  if (!base || !secret) {
    // Names only: a missing value is reported without printing what is set.
    log(
      JSON.stringify({
        event: "trust_safety_child_config_error",
        missing: [
          base ? null : "TRUST_SAFETY_OBSERVER_URL",
          secret ? null : "TRUST_SAFETY_OBSERVER_SECRET",
        ].filter(Boolean),
      }),
    );
    return EXIT.configError;
  }

  let response;
  try {
    response = await fetchImpl(`${base.replace(/\/+$/, "")}${OBSERVE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(CHILD_TIMEOUT_MS),
    });
  } catch (error) {
    // The name only. A message could carry the URL, and the URL is the
    // service's own variable rather than a secret -- but a log line is read by
    // whoever has the deploy, so it says as little as it can.
    log(
      JSON.stringify({
        event: "trust_safety_child_request_failed",
        errorName: error instanceof Error ? error.name : "unknown",
      }),
    );
    return EXIT.requestFailed;
  }

  // The body is read only for the enum, and only to log it. `outcome` is one
  // of `ran`, `disabled` and `failed`; anything else is reported as unknown
  // rather than parsed further.
  let outcome = "unknown";
  try {
    const body = await response.json();
    if (body && typeof body.outcome === "string") outcome = body.outcome;
  } catch {
    outcome = "unreadable";
  }
  log(
    JSON.stringify({
      event: "trust_safety_child_answered",
      status: response.status,
      outcome,
    }),
  );
  if (!response.ok) return EXIT.routeRefused;
  return EXIT.ok;
}

// Entry point. `process.exitCode` rather than `process.exit`, so the log line
// above is flushed.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await observeOnce({ env: process.env });
}
