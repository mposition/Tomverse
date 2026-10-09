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

import {
  OBSERVATION_FAILURE_STAGES,
  OBSERVATION_ROW_LIMIT,
  OBSERVATION_SCHEMA_VERSION,
  observationPayloadDigest,
  validateObservationPayload,
} from "./productResearchObservationCore.mjs";
import { detectSecrets } from "./engineeringAgentSecretPatterns";
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
  "secret_detected",
];

export type ObservationRowInput = {
  id: string;
  slot: Date;
  outcome: "ok" | "failed";
  failureStage: string | null;
  schemaVersion: number;
  developSha: string | null;
  mainSha: string | null;
  issueCount: number | null;
  payload: unknown;
  payloadDigest: string | null;
};

/** A payload that has already been through `validateObservationPayload()`. */
type ValidatedPayload = {
  schemaVersion: number;
  issues: { id: string; title: string }[];
  counts: unknown;
  blindSpots: unknown;
};

export type SubmissionDecision =
  | { accepted: false; code: string; detail: string | null }
  | { accepted: true; row: ObservationRowInput };
const refuse = (code: string, detail: string | null = null): SubmissionDecision => ({
  accepted: false,
  code,
  detail,
});

// Re-exported rather than redefined: the runner imports it from the core, and
// one digest is the whole point of comparing them.
export { observationPayloadDigest };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether this body may become a row, and what the row would be.
 *
 * `now` is passed in rather than read: the route reads the clock once, and a
 * module that read it itself could not be tested across a slot boundary. The
 * window is still the database's to enforce -- this refusal is so a submitter
 * answering for the wrong slot is told which rule it broke instead of seeing a
 * constraint name.
 */
export const admitObservationSubmission = (
  body: unknown,
  { now, id }: { now: number; id: unknown },
): SubmissionDecision => {
  if (!isPlainObject(body)) return refuse("invalid_request", "body is not an object");
  const fields = body;
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

  if (fields.schemaVersion !== OBSERVATION_SCHEMA_VERSION) {
    return refuse("unknown_schema_version");
  }

  if (typeof fields.slot !== "string" || !SLOT_PATTERN.test(fields.slot)) {
    return refuse("slot_not_canonical");
  }
  const slotMs = Date.parse(fields.slot);
  if (!Number.isFinite(slotMs)) return refuse("slot_not_canonical");
  // The slot a run of this moment answers for. A submitter that named another
  // one is either answering for a slot it missed or reserving a future one.
  if (fields.slot !== slotForInstant(now)) return refuse("slot_not_current");

  if (fields.outcome === "failed") {
    if (
      fields.payload !== undefined ||
      fields.developSha !== undefined ||
      fields.mainSha !== undefined
    ) {
      // A failure carrying content is the defect the shape CHECK exists for;
      // refusing it here means the submitter is told why.
      return refuse("outcome_shape_invalid", "a failed slot carries no content");
    }
    const stage = fields.failureStage;
    if (typeof stage !== "string" || !OBSERVATION_FAILURE_STAGES.includes(stage)) {
      return refuse("unknown_failure_stage");
    }
    return {
      accepted: true,
      row: {
        id,
        slot: new Date(slotMs),
        outcome: "failed",
        failureStage: stage,
        schemaVersion: OBSERVATION_SCHEMA_VERSION,
        developSha: null,
        mainSha: null,
        issueCount: null,
        payload: null,
        payloadDigest: null,
      },
    };
  }

  if (fields.outcome !== "ok") return refuse("outcome_shape_invalid", "unknown outcome");
  if (fields.failureStage !== undefined) {
    return refuse("outcome_shape_invalid", "a successful slot has no failure stage");
  }
  if (typeof fields.developSha !== "string" || !SHA_PATTERN.test(fields.developSha)) {
    return refuse("outcome_shape_invalid", "developSha is not a commit");
  }
  if (typeof fields.mainSha !== "string" || !SHA_PATTERN.test(fields.mainSha)) {
    return refuse("outcome_shape_invalid", "mainSha is not a commit");
  }

  // The payload is judged by the module that built it: the counts are
  // recomputed from the rows and compared, so a submitted count that nobody
  // can rederive is refused rather than stored.
  const { problems = [] } = validateObservationPayload(fields.payload);
  if (problems.length > 0) return refuse("payload_invalid", problems[0]);

  // Public issue titles are external text, and the policy scans them before
  // they are stored (docs/policy/product-research-agent.md §2, condition 7). The agent
  // reads whatever anyone opened an issue about; a title holding a token is
  // unlikely and the cost of storing one is a credential sitting in a table
  // an operator reads every morning.
  //
  // The whole slot is refused rather than the row dropped: dropping it would
  // make the stored observation disagree with the backlog it claims to
  // describe, and nothing on the screen would say a row was missing. Only the
  // rule ids are reported -- a record about a secret that quotes the secret
  // has leaked it.
  const payload = fields.payload as ValidatedPayload;
  const hits = new Set<string>();
  for (const issue of payload.issues) {
    for (const ruleId of detectSecrets(issue.title)) hits.add(ruleId);
  }
  if (hits.size > 0) return refuse("secret_detected", [...hits].sort().join(","));
  if (payload.issues.length > OBSERVATION_ROW_LIMIT) return refuse("row_count_exceeded");

  return {
    accepted: true,
    row: {
      id,
      slot: new Date(slotMs),
      outcome: "ok",
      failureStage: null,
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      developSha: fields.developSha,
      mainSha: fields.mainSha,
      issueCount: payload.issues.length,
      payload,
      // Computed here from the payload that is about to be stored, never read
      // from the body.
      payloadDigest: observationPayloadDigest(payload),
    },
  };
};
