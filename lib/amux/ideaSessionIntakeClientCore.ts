import { randomUUID } from "node:crypto";

import { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";
import {
  inspectAmuxIdeaSessionSubmission,
  type AmuxIdeaSessionSubmissionInspection,
} from "./ideaSessionSubmissionCore.ts";

export const AMUX_SESSION_INTAKE_ORIGIN_ENV =
  "TOMVERSE_AMUX_SESSION_INTAKE_ORIGIN";
export const AMUX_SESSION_INTAKE_ROUTE =
  "/api/internal/amux/ideas/session-intake";
const CLIENT_SECRET = /^[A-Za-z0-9_-]{32,256}$/;

const CLOSED_REFUSALS = new Map<string, number>([
  ["Unauthorized", 401],
  ["submission_disabled", 503],
  ["content_type_refused", 415],
  ["schema_rejected", 400],
  ["content_refused", 400],
  ["metadata_incomplete", 400],
  ["audit_unavailable", 503],
  ["scope_unavailable", 409],
  ["outside_scope", 409],
  ["model_not_approved", 409],
  ["key_store_unavailable", 503],
]);

type JsonRecord = Record<string, unknown>;

export type AmuxSessionIntakeCommitted = {
  state: "committed";
  requestId: string;
  ideaId: string;
  reservationId: string;
  hasExternalSources: boolean;
  adminPath: string;
  recoveredByReadback: boolean;
};

export type AmuxSessionIntakeClientResult =
  | AmuxSessionIntakeCommitted
  | { state: "refused"; requestId: string; code: string;
      httpStatus: number; retryWrite: false }
  | { state: "outcome_unknown"; requestId: string;
      observation: "absent" | "partial" | "unavailable" | "invalid_response";
      ideaId?: string; retryWrite: false };

export type AmuxSessionIntakeClientTransport = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;

const exactKeys = (value: JsonRecord, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const closedJson = async (response: Response): Promise<JsonRecord | null> => {
  try {
    return record(await response.json());
  } catch {
    return null;
  }
};

export function amuxSessionIntakeEndpoint(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("origin_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("origin_invalid");
  }
  return new URL(AMUX_SESSION_INTAKE_ROUTE, parsed).toString();
}

const verifiedEndpoint = (endpoint: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("origin_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.pathname !== AMUX_SESSION_INTAKE_ROUTE || parsed.search || parsed.hash) {
    throw new Error("origin_invalid");
  }
  return parsed.toString();
};

const verifiedSecret = (secret: string): string => {
  if (!CLIENT_SECRET.test(secret)) throw new Error("credential_unavailable");
  return secret;
};

export function prepareAmuxSessionIntakeSubmission(
  value: unknown,
  createRequestId: () => string = randomUUID,
): Extract<AmuxIdeaSessionSubmissionInspection, { ok: true }> {
  const requestId = createRequestId();
  const candidate = record(value);
  if (!isAmuxIdeaRequestId(requestId) || !candidate ||
      !exactKeys(candidate, ["version", "input", "source"])) {
    throw new Error("schema_rejected");
  }
  const inspected = inspectAmuxIdeaSessionSubmission({
    ...candidate,
    requestId,
  });
  if (!inspected.ok) throw new Error(inspected.code);
  return inspected;
}

const committed = (
  body: JsonRecord | null,
  requestId: string,
  recoveredByReadback: boolean,
): AmuxSessionIntakeCommitted | null => {
  if (!body || body.status !== "committed" || body.requestId !== requestId ||
      typeof body.ideaId !== "string" || !isAmuxIdeaRequestId(body.ideaId) ||
      typeof body.reservationId !== "string" ||
      !isAmuxIdeaRequestId(body.reservationId) ||
      typeof body.hasExternalSources !== "boolean" ||
      body.adminPath !== `/admin/amux-backlog?tab=ideas&idea=${encodeURIComponent(requestId)}`) {
    return null;
  }
  return {
    state: "committed",
    requestId,
    ideaId: body.ideaId,
    reservationId: body.reservationId,
    hasExternalSources: body.hasExternalSources,
    adminPath: body.adminPath,
    recoveredByReadback,
  };
};

export async function readAmuxSessionIntakeClientRequest(input: {
  endpoint: string;
  secret: string;
  requestId: string;
  fetcher?: AmuxSessionIntakeClientTransport;
}): Promise<AmuxSessionIntakeClientResult> {
  if (!isAmuxIdeaRequestId(input.requestId)) throw new Error("request_id_invalid");
  const fetcher = input.fetcher ?? fetch;
  const endpoint = verifiedEndpoint(input.endpoint);
  const secret = verifiedSecret(input.secret);
  let response: Response;
  try {
    const url = new URL(endpoint);
    url.searchParams.set("requestId", input.requestId);
    response = await fetcher(url.toString(), {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
    });
  } catch {
    return { state: "outcome_unknown", requestId: input.requestId,
      observation: "unavailable", retryWrite: false };
  }
  const body = await closedJson(response);
  const found = response.status === 200
    ? committed(body, input.requestId, true)
    : null;
  if (found) return found;
  if (response.status === 404 && body?.status === "absent" &&
      body.requestId === input.requestId && body.retryWrite === false) {
    return { state: "outcome_unknown", requestId: input.requestId,
      observation: "absent", retryWrite: false };
  }
  if (response.status === 409 && body?.status === "partial" &&
      body.requestId === input.requestId && typeof body.ideaId === "string" &&
      isAmuxIdeaRequestId(body.ideaId) && body.retryWrite === false) {
    return { state: "outcome_unknown", requestId: input.requestId,
      observation: "partial", ideaId: body.ideaId, retryWrite: false };
  }
  if (response.status === 503 &&
      body?.error === "session_intake_readback_unavailable" &&
      body.retryWrite === false) {
    return { state: "outcome_unknown", requestId: input.requestId,
      observation: "unavailable", retryWrite: false };
  }
  return { state: "outcome_unknown", requestId: input.requestId,
    observation: "invalid_response", retryWrite: false };
}

/** Send one POST. Every ambiguous result is followed only by the exact-ID GET;
 * this function never repeats a write. */
export async function submitAmuxSessionIntakeClientRequest(input: {
  endpoint: string;
  secret: string;
  inspected: Extract<AmuxIdeaSessionSubmissionInspection, { ok: true }>;
  fetcher?: AmuxSessionIntakeClientTransport;
}): Promise<AmuxSessionIntakeClientResult> {
  const fetcher = input.fetcher ?? fetch;
  const requestId = input.inspected.requestId;
  const endpoint = verifiedEndpoint(input.endpoint);
  const secret = verifiedSecret(input.secret);
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secret}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        requestId,
        input: input.inspected.input,
        source: input.inspected.source,
      }),
    });
  } catch {
    return readAmuxSessionIntakeClientRequest({ ...input, requestId, fetcher });
  }
  const body = await closedJson(response);
  const created = response.status === 201 ? committed(body, requestId, false) : null;
  if (created) return created;

  const error = typeof body?.error === "string" ? body.error : null;
  const closedBeforeWrite = error === "Unauthorized" && response.status === 401;
  if (error && CLOSED_REFUSALS.get(error) === response.status &&
      (body?.retryWrite === false || closedBeforeWrite)) {
    return { state: "refused", requestId, code: error,
      httpStatus: response.status, retryWrite: false };
  }
  return readAmuxSessionIntakeClientRequest({ ...input, requestId, fetcher });
}
