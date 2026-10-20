/**
 * Which GitHub webhook deliveries start a CI admission round, and which pull
 * request (if any) arrives with it (lib/ciAdmissionCore.ts). Pure.
 *
 * Arrival is a pull request asking for CI while ready: becoming ready for
 * review, opened or reopened ready, or new commits pushed to a ready one. Every other pull_request change (draft, close, new commits,
 * base edits) and every completed workflow run can free or take a slot, so it
 * starts a round without an arrival; a requested or in-progress workflow run
 * starts one too, so a run on a draft is cancelled as it starts (a GitHub
 * re-run sends no `requested`, only `in_progress`).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Whether `signature` (the X-Hub-Signature-256 header) signs `body` with `secret`. */
export function verifyCiAdmissionWebhookSignature(body: string, signature: string | null, secret: string | undefined): boolean {
  if (!secret || !signature || !signature.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const ROUND_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "converted_to_draft",
  "closed",
  "synchronize",
  "edited",
]);

export type CiAdmissionWebhookDecision =
  | { kind: "round"; arrival: number | null }
  | { kind: "ignore"; reason: "event" | "action" | "repository" | "shape" };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function ciAdmissionArrival(event: string, payload: unknown, repository: string): CiAdmissionWebhookDecision {
  if (event !== "pull_request" && event !== "workflow_run") return { kind: "ignore", reason: "event" };
  if (!isObject(payload)) return { kind: "ignore", reason: "shape" };
  const repo = payload.repository;
  if (!isObject(repo) || repo.full_name !== repository) return { kind: "ignore", reason: "repository" };
  const action = payload.action;

  if (event === "workflow_run") {
    return action === "completed" || action === "requested" || action === "in_progress"
      ? { kind: "round", arrival: null }
      : { kind: "ignore", reason: "action" };
  }

  if (typeof action !== "string" || !ROUND_PULL_REQUEST_ACTIONS.has(action)) return { kind: "ignore", reason: "action" };
  const pull = payload.pull_request;
  if (!isObject(pull) || typeof pull.number !== "number" || !Number.isInteger(pull.number) || pull.number < 1) {
    return { kind: "ignore", reason: "shape" };
  }
  const arrives =
    action === "ready_for_review" ||
    ((action === "opened" || action === "reopened" || action === "synchronize") && pull.draft === false);
  return { kind: "round", arrival: arrives ? pull.number : null };
}
