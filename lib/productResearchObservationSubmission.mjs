// What the submission route accepts, and what it refuses.
//
// Separated from the route so it can be judged without a request, a database
// or a clock. The route's own job is three things this module does not do:
// authenticate the caller, open the transaction, and let the database decide
// the slot's uniqueness and its window.
//
// The digest is here too, because the one rule about it is that the server
// computes it from what it stored. A submitter that sent its own digest would
// be attesting to its own payload, which attests to nothing.

import { createHash } from "node:crypto";

import {
  OBSERVATION_FAILURE_STAGES,
  OBSERVATION_ROW_LIMIT,
  OBSERVATION_SCHEMA_VERSION,
  validateObservationPayload,
} from "./productResearchObservationCore.mjs";
import { slotForInstant } from "./productResearchObservationRunnerCore.mjs";

/**
 * The largest body the route reads.
 *
 * 200 rows, each with a title of up to 256 code points and six signal states.
 * A title in a Korean issue is three bytes a character and JSON escapes make
 * it more, so the cap is the row limit against a generous per-row figure
 * rather than a measurement of today's issues -- a body over it is refused
 * whole, because a truncated observation is a wrong one.
 */
export const SUBMISSION_MAX_BYTES = 512 * 1024;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SLOT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
const ID_PATTERN = /^[0-9a-z_-]{1,64}$/;

/** Why a submission was refused. Each is an enum the caller logs, not prose. */
export const SUBMISSION_REFUSALS = [
  "invalid_request",
  "unknown_schema_version",
  "slot_not_canonical",
  "slot_not_current",
  "outcome_shape_invalid",
  "unknown_failure_stage",
  "payload_invalid",
  "row_count_exceeded",
];

/**
 * The two answers, as a discriminated union.
 *
 * Written out in JSDoc because TypeScript reads this module from a .mjs file
 * and would otherwise infer `accepted: boolean`, which narrows nothing -- the
 * route would then be free to read `.row` off a refusal.
 *
 * @typedef {{
 *   id: string,
 *   slot: Date,
 *   outcome: "ok" | "failed",
 *   failureStage: string | null,
 *   schemaVersion: number,
 *   developSha: string | null,
 *   mainSha: string | null,
 *   issueCount: number | null,
 *   payload: unknown,
 *   payloadDigest: string | null,
 * }} ObservationRowInput
 *
 * @typedef {{accepted: false, code: string, detail: string | null}} SubmissionRefused
 * @typedef {{accepted: true, row: ObservationRowInput}} SubmissionAdmitted
 * @typedef {SubmissionRefused | SubmissionAdmitted} SubmissionDecision
 */

/** @returns {SubmissionRefused} */
const refuse = (code, detail = null) => ({ accepted: false, code, detail });

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** sha256 of the payload, serialised with its object keys in sorted order. */
export const observationPayloadDigest = (payload) => {
  // Canonical, so the same observation submitted twice digests the same whatever
  // order the runner happened to build its objects in. Arrays keep their order,
  // because the row order is part of what was observed.
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])])
      );
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(payload)), "utf8").digest("hex");
};

/**
 * Whether this body may become a row, and what the row would be.
 *
 * `now` is passed in rather than read: the route reads the clock once, and a
 * module that read it itself could not be tested across a slot boundary. The
 * window is still the database's to enforce -- this refusal is so a submitter
 * answering for the wrong slot is told which rule it broke instead of seeing a
 * constraint name.
 *
 * @param {unknown} body
 * @param {{now: number, id: unknown}} options
 * @returns {SubmissionDecision}
 */
export const admitObservationSubmission = (body, { now, id }) => {
  if (!isPlainObject(body)) return refuse("invalid_request", "body is not an object");
  // Not coerced: coercion is how a caller's wrong type becomes a plausible id,
  // and the id is the row's primary key.
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    return refuse("invalid_request", "id is not usable");
  }

  const allowed = new Set([
    "schemaVersion",
    "slot",
    "outcome",
    "failureStage",
    "developSha",
    "mainSha",
    "payload",
  ]);
  for (const key of Object.keys(body)) {
    // Strict: a key the route does not know is a submitter sending something
    // this contract never agreed to store, and silently dropping it would make
    // the stored row disagree with what was sent.
    if (!allowed.has(key)) return refuse("invalid_request", `unknown key ${key}`);
  }

  if (body.schemaVersion !== OBSERVATION_SCHEMA_VERSION) {
    return refuse("unknown_schema_version");
  }

  if (typeof body.slot !== "string" || !SLOT_PATTERN.test(body.slot)) {
    return refuse("slot_not_canonical");
  }
  const slotMs = Date.parse(body.slot);
  if (!Number.isFinite(slotMs)) return refuse("slot_not_canonical");
  // The slot a run of this moment answers for. A submitter that named another
  // one is either answering for a slot it missed or reserving a future one.
  if (body.slot !== slotForInstant(now)) return refuse("slot_not_current");

  if (body.outcome === "failed") {
    if (
      body.payload !== undefined ||
      body.developSha !== undefined ||
      body.mainSha !== undefined
    ) {
      // A failure carrying content is the defect the shape CHECK exists for;
      // refusing it here means the submitter is told why.
      return refuse("outcome_shape_invalid", "a failed slot carries no content");
    }
    if (!OBSERVATION_FAILURE_STAGES.includes(body.failureStage)) {
      return refuse("unknown_failure_stage");
    }
    return {
      accepted: /** @type {true} */ (true),
      row: {
        id,
        slot: new Date(slotMs),
        outcome: /** @type {"failed"} */ ("failed"),
        failureStage: body.failureStage,
        schemaVersion: OBSERVATION_SCHEMA_VERSION,
        developSha: null,
        mainSha: null,
        issueCount: null,
        payload: null,
        payloadDigest: null,
      },
    };
  }

  if (body.outcome !== "ok") return refuse("outcome_shape_invalid", "unknown outcome");
  if (body.failureStage !== undefined) {
    return refuse("outcome_shape_invalid", "a successful slot has no failure stage");
  }
  if (typeof body.developSha !== "string" || !SHA_PATTERN.test(body.developSha)) {
    return refuse("outcome_shape_invalid", "developSha is not a commit");
  }
  if (typeof body.mainSha !== "string" || !SHA_PATTERN.test(body.mainSha)) {
    return refuse("outcome_shape_invalid", "mainSha is not a commit");
  }

  // The payload is judged by the module that built it: the counts are
  // recomputed from the rows and compared, so a submitted count that nobody
  // can rederive is refused rather than stored.
  const { problems = [] } = validateObservationPayload(body.payload);
  if (problems.length > 0) return refuse("payload_invalid", problems[0]);
  if (body.payload.issues.length > OBSERVATION_ROW_LIMIT) return refuse("row_count_exceeded");

  return {
    accepted: /** @type {true} */ (true),
    row: {
      id,
      slot: new Date(slotMs),
      outcome: /** @type {"ok"} */ ("ok"),
      failureStage: null,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      developSha: body.developSha,
      mainSha: body.mainSha,
      issueCount: body.payload.issues.length,
      payload: body.payload,
      // Computed here from the payload that is about to be stored, never read
      // from the body.
      payloadDigest: observationPayloadDigest(body.payload),
    },
  };
};
