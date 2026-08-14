/**
 * Deliberate provider failures, for the fallback drill.
 *
 * Step 4 of `docs/ops/tomverse-chat-auto-router-rollout.md` §9.1: before the
 * fallback is enabled, a staging run has to make the first provider fail and
 * show, in the database and the logs, that one run produced one reservation,
 * two attempts, one settlement and one lease release. Waiting for a real
 * provider outage to check that is not a plan -- outages arrive without a
 * prepared observer, and the one thing that must not happen on the first real
 * one is discovering the accounting was wrong.
 *
 * ## The three locks, and why three
 *
 * A switch that makes provider calls fail is a denial-of-service lever. It is
 * off unless all three of these hold, and each one alone would be a bad idea:
 *
 * 1. **Not production.** Resolved by `lib/deploymentEnvironment.ts`, which
 *    fails closed: an unlabelled deployment reads as production and injects
 *    nothing. A deployment gets to inject faults only by *saying* it is not
 *    production.
 * 2. **A secret is configured.** No `ROUTING_FAULT_INJECTION_SECRET`, no
 *    injector -- so a staging box that nobody set up for a drill cannot be
 *    driven into one by a passer-by.
 * 3. **The request asks, and proves it may.** Per request, never ambient. A
 *    percentage-of-traffic injector would break QA sessions that had nothing
 *    to do with the drill, and "why did staging start failing" is a question
 *    nobody should have to answer twice.
 *
 * The secret is compared in constant time. Not because a staging secret is
 * precious, but because the alternative teaches the wrong habit in a file
 * whose whole subject is a switch that breaks things.
 */

import { timingSafeEqual } from "node:crypto";

import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";

export const FAULT_INJECTION_SECRET_ENV = "ROUTING_FAULT_INJECTION_SECRET";
export const FAULT_INJECTION_HEADER = "x-tomverse-fault-injection";

/**
 * The faults a drill can ask for.
 *
 * Deliberately few, and each one is a step of §9.1's order rather than a
 * general-purpose chaos vocabulary. Adding one is a decision about what the
 * drill is for.
 */
export const INJECTABLE_FAULTS = [
  /** Step 4: the first provider fails before its first chunk. */
  "attempt_0_pre_token",
  /** Step 5: the fallback fails too, so the turn must end without a third. */
  "attempt_1_pre_token",
  /** Step 5's control: a failure the policy must refuse to route around. */
  "attempt_0_post_token",
] as const;

export type InjectableFault = (typeof INJECTABLE_FAULTS)[number];

export type FaultInjectionRefusal =
  | "not_configured"
  | "production"
  | "no_header"
  | "malformed_header"
  | "bad_secret"
  | "unknown_fault";

export type FaultInjectionDecision =
  | { inject: true; fault: InjectableFault }
  | { inject: false; reason: FaultInjectionRefusal };

/** The error a drill sees, so a real outage is never confused with a drill. */
export class InjectedProviderFault extends Error {
  constructor(readonly fault: InjectableFault) {
    super(`Injected provider fault for the fallback drill: ${fault}`);
    this.name = "InjectedProviderFault";
  }
}

const secretMatches = (supplied: string, configured: string): boolean => {
  const a = Buffer.from(supplied);
  const b = Buffer.from(configured);
  // Length is compared first because timingSafeEqual throws on a mismatch.
  // The length of a secret is not the secret.
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Whether this request asked for a fault, and may have one.
 *
 * Header shape: `X-Tomverse-Fault-Injection: <secret>:<fault>`. Every refusal
 * is named because a drill that silently does not inject looks exactly like a
 * fallback that silently did not happen, and those are the two outcomes the
 * drill exists to tell apart.
 */
export const decideFaultInjection = (
  headerValue: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env
): FaultInjectionDecision => {
  const configured = environment[FAULT_INJECTION_SECRET_ENV] ?? "";
  if (configured.length < 16) {
    // Includes unset. A short secret is not a secret, and treating one as
    // configured would make the third lock the only real one.
    return { inject: false, reason: "not_configured" };
  }
  if (resolveDeploymentEnvironment(environment) === "production") {
    return { inject: false, reason: "production" };
  }
  if (!headerValue) return { inject: false, reason: "no_header" };

  const separator = headerValue.lastIndexOf(":");
  if (separator <= 0) return { inject: false, reason: "malformed_header" };
  const supplied = headerValue.slice(0, separator);
  const fault = headerValue.slice(separator + 1);

  if (!secretMatches(supplied, configured)) {
    return { inject: false, reason: "bad_secret" };
  }
  if (!(INJECTABLE_FAULTS as readonly string[]).includes(fault)) {
    // Checked after the secret on purpose: an unauthenticated caller must not
    // be able to enumerate the fault vocabulary from the refusal it gets.
    return { inject: false, reason: "unknown_fault" };
  }
  return { inject: true, fault: fault as InjectableFault };
};

export type AttemptFaultPoint = "pre_token" | "post_token";

/**
 * Whether the named fault fires for this attempt at this point.
 *
 * The attempt index is part of the fault rather than a separate setting, so a
 * drill cannot ask for "fail the provider" and get an unspecified attempt.
 */
export const faultApplies = (
  fault: InjectableFault | null,
  attemptIndex: number,
  point: AttemptFaultPoint
): boolean => {
  if (!fault) return false;
  switch (fault) {
    case "attempt_0_pre_token":
      return attemptIndex === 0 && point === "pre_token";
    case "attempt_1_pre_token":
      return attemptIndex === 1 && point === "pre_token";
    case "attempt_0_post_token":
      return attemptIndex === 0 && point === "post_token";
  }
};

/**
 * A text-stream reader, in the platform's own result type.
 *
 * `ReadableStreamReadResult<string>` rather than a hand-written
 * `{ done: boolean; value?: string }`, because the chat route narrows on
 * `done` to get a defined `value`. A looser shape written for the convenience
 * of this seam would make `value` possibly-undefined at every read in the
 * route -- a type-level guarantee moved out of the way to accommodate a test
 * hook, which is the wrong direction.
 */
export type FaultedReader = {
  read(): Promise<ReadableStreamReadResult<string>>;
  cancel(reason?: unknown): Promise<void>;
};

/**
 * Wraps a real provider reader so it fails where the drill says.
 *
 * The provider call has already been made and the dispatch already recorded --
 * that is the point. A fault injected before the call would exercise a
 * different path than the one a real outage takes, and the drill would confirm
 * accounting that never runs.
 *
 * `post_token` lets one chunk through first, because §7's rule about visible
 * tokens is the invariant the drill's control case checks: after a token, no
 * substitution, whatever the failure looks like.
 */
export const faultedReader = <T extends FaultedReader>(
  reader: T,
  fault: InjectableFault | null,
  attemptIndex: number
): T | FaultedReader => {
  if (!fault) return reader;
  const preToken = faultApplies(fault, attemptIndex, "pre_token");
  const postToken = faultApplies(fault, attemptIndex, "post_token");
  if (!preToken && !postToken) return reader;

  let delivered = 0;
  const wrapped: FaultedReader = {
    async read() {
      if (preToken) throw new InjectedProviderFault(fault);
      const chunk = await reader.read();
      if (chunk.done) return chunk;
      delivered += 1;
      if (postToken && delivered > 1) throw new InjectedProviderFault(fault);
      return chunk;
    },
    cancel: (reason?: unknown) => reader.cancel(reason),
  };
  return wrapped;
};
