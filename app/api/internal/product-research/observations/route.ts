export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { randomUUID } from "node:crypto";

import { ApiSecurityError, readLimitedText } from "@/lib/apiSecurity";
import {
  isProductResearchRouteAuthorized,
  isProductResearchRouteEnabled,
  productResearchInternalError,
  productResearchJson,
  productResearchNotFound,
  productResearchUnauthorized,
} from "@/lib/productResearchObservationRouteAuth";
import {
  SUBMISSION_MAX_BYTES,
  admitObservationSubmission,
} from "@/lib/productResearchObservationSubmission";
import {
  ProductResearchObservationRefusedError,
  recordProductResearchObservation,
} from "@/lib/productResearchObservationStore";

// The product-research agent's one way of changing product state
// (docs/policy/product-research-agent.md §3, §4). It inserts one row for one
// scheduled slot and answers what it did.
//
// Four things in order, and the order matters: the app switch (off means this
// path does not exist), the secret, the body, then the row. Nothing before the
// secret reads the body, so an unauthenticated caller cannot make the server
// parse half a megabyte of its choosing.
//
// The id is minted here rather than taken from the caller: it is the row's
// primary key, and a caller choosing it could collide with another slot's row
// and get a refusal that says nothing about the slot it was answering for. The
// slot itself is the idempotency key, and it is the database's unique
// constraint that enforces it.

/** The row id, from the slot, so a log line names the slot it belongs to. */
const observationId = (slot: string) =>
  `obs-${slot.slice(0, 10)}-${randomUUID().slice(0, 8)}`;

export async function POST(request: Request) {
  if (!isProductResearchRouteEnabled()) return productResearchNotFound();
  if (!isProductResearchRouteAuthorized(request)) return productResearchUnauthorized();

  let body: unknown;
  try {
    body = JSON.parse(await readLimitedText(request, SUBMISSION_MAX_BYTES));
  } catch (error) {
    if (error instanceof ApiSecurityError) {
      // A body over the ceiling is refused whole. A truncated observation is a
      // wrong one, and the run that sent it should fail its slot rather than
      // have part of it stored.
      return productResearchJson(
        { refused: error.code === "REQUEST_BODY_TOO_LARGE" ? "body_too_large" : "invalid_request" },
        error.code === "REQUEST_BODY_TOO_LARGE" ? 413 : 400,
      );
    }
    return productResearchJson({ refused: "invalid_request" }, 400);
  }

  // One clock read for the whole request: the slot the submission claims is
  // compared against the slot a run of this moment answers for, and reading
  // the clock twice could straddle a boundary.
  const now = Date.now();
  const slot = typeof (body as { slot?: unknown })?.slot === "string"
    ? (body as { slot: string }).slot
    : "0000-00-00";
  const admission = admitObservationSubmission(body, { now, id: observationId(slot) });
  if (!admission.accepted) {
    return productResearchJson({ refused: admission.code }, 400);
  }

  try {
    const recorded = await recordProductResearchObservation(admission.row);
    return productResearchJson({
      recorded: true,
      slot: admission.row.slot.toISOString(),
      outcome: admission.row.outcome,
      // The server's digest, so the run can compare it with its own and report
      // a mismatch rather than believing the row holds what it sent.
      payloadDigest: admission.row.payloadDigest,
      observationId: recorded.id,
    });
  } catch (error) {
    if (error instanceof ProductResearchObservationRefusedError) {
      // 409: the slot has an answer, or the database refused the row. Either
      // way the caller must not retry -- a second answer for one slot is worse
      // than none.
      return productResearchJson({ refused: error.code }, 409);
    }
    return productResearchInternalError("record_observation", error);
  }
}
