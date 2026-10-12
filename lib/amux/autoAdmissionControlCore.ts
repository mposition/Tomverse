import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import { AMUX_V22_GRADUATION_EXCEPTION_ID } from "@/lib/amux/v22AutoPromotionCore";

export type AmuxAutoAdmissionControl = {
  codeLatch: boolean;
  environmentEnabled: boolean;
  active: boolean;
  authorizationAuditLogId: string | null;
  graduation: { ok: boolean; count: number; spanMs: number };
  graduationExceptionId: string;
  graduationExceptionAvailable: boolean;
  graduationExceptionApplied: boolean;
};

export type AmuxAutoAdmissionNotice =
  | "load_failed" | "saved" | "saved_unread" | "conflict"
  | "outcome_unknown" | "outcome_unknown_unread" | null;
export type AmuxAutoAdmissionPending = "reading" | "activating" | "stopping" | null;
export type AmuxAutoAdmissionUpdate = Partial<{
  control: AmuxAutoAdmissionControl | null;
  notice: AmuxAutoAdmissionNotice;
  pending: AmuxAutoAdmissionPending;
  failure: AdminApiFailure | null;
  confirmed: boolean;
}>;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const auditId = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length > 0 && value.length <= 128);

/** Unreadable fields never become a guessed off state or a fabricated count. */
export function parseAmuxAutoAdmissionControl(body: unknown): AmuxAutoAdmissionControl | null {
  const value = record(body);
  const graduation = record(value?.graduation);
  if (!value || !graduation ||
      typeof value.codeLatch !== "boolean" ||
      typeof value.environmentEnabled !== "boolean" ||
      typeof value.active !== "boolean" || !auditId(value.authorizationAuditLogId) ||
      typeof graduation.ok !== "boolean" ||
      !Number.isSafeInteger(graduation.count) || (graduation.count as number) < 0 ||
      typeof graduation.spanMs !== "number" || !Number.isFinite(graduation.spanMs) ||
      graduation.spanMs < 0 ||
      value.graduationExceptionId !== AMUX_V22_GRADUATION_EXCEPTION_ID ||
      typeof value.graduationExceptionAvailable !== "boolean" ||
      typeof value.graduationExceptionApplied !== "boolean") return null;
  return {
    codeLatch: value.codeLatch, environmentEnabled: value.environmentEnabled,
    active: value.active, authorizationAuditLogId: value.authorizationAuditLogId,
    graduation: { ok: graduation.ok, count: graduation.count as number,
      spanMs: graduation.spanMs },
    graduationExceptionId: value.graduationExceptionId,
    graduationExceptionAvailable: value.graduationExceptionAvailable,
    graduationExceptionApplied: value.graduationExceptionApplied,
  };
}

export const amuxAutoAdmissionCanActivate = (control: AmuxAutoAdmissionControl) =>
  control.codeLatch && control.environmentEnabled &&
  (control.graduation.ok || control.graduationExceptionAvailable);

export const amuxAutoAdmissionNeedsApproval = (control: AmuxAutoAdmissionControl) =>
  !control.active || (control.graduationExceptionAvailable &&
    !control.graduationExceptionApplied && !control.graduation.ok);

export const amuxAutoAdmissionWriteLocked = (notice: AmuxAutoAdmissionNotice) =>
  notice === "outcome_unknown" || notice === "outcome_unknown_unread";

/** Keep the existing CAS and bootstrap exception contract exactly. */
export const amuxAutoAdmissionChangeBody = (active: boolean, control: AmuxAutoAdmissionControl) => ({
  policyVersion: 22, active, expectedAuditLogId: control.authorizationAuditLogId,
  ...(active && control.graduationExceptionAvailable
    ? { graduationExceptionId: control.graduationExceptionId } : {}),
});

export type AmuxAutoAdmissionIo = {
  post: (body: ReturnType<typeof amuxAutoAdmissionChangeBody>) => Promise<Response>;
  read: () => Promise<{ control: AmuxAutoAdmissionControl | null; failure: AdminApiFailure | null }>;
  failureOf: (response: Response) => Promise<AdminApiFailure>;
  networkFailure: () => AdminApiFailure;
};

// The route answers these before starting its control transaction.
const NO_WRITE_STATUSES = new Set([400, 403, 404, 413, 428, 429]);
const KNOWN_REFUSALS = new Set([
  "forbidden", "origin_refused", "graduation_exception_unavailable", "apply_disabled",
  "legacy_auto_promotion_enabled", "graduation_unmet", "auto_halted", "capacity_unconfigured",
]);

/** A safe GET can restore current state; it can never resolve an unknown write. */
export async function runAmuxAutoAdmissionRead(
  io: Pick<AmuxAutoAdmissionIo, "read" | "networkFailure">,
  update: (change: AmuxAutoAdmissionUpdate) => void,
  previousNotice: AmuxAutoAdmissionNotice = null,
) {
  update({ pending: "reading", failure: null, confirmed: false });
  try {
    let result: Awaited<ReturnType<AmuxAutoAdmissionIo["read"]>>;
    try { result = await io.read(); }
    catch { result = { control: null, failure: io.networkFailure() }; }
    const unknown = amuxAutoAdmissionWriteLocked(previousNotice);
    const saved = previousNotice === "saved" || previousNotice === "saved_unread";
    update({ ...result, notice: unknown
      ? result.control ? "outcome_unknown" : "outcome_unknown_unread"
      : saved ? result.control ? "saved" : "saved_unread"
      : result.control ? null : previousNotice === "conflict" ? "conflict" : "load_failed" });
  } finally { update({ pending: null }); }
}

/** Exactly one POST. An uncertain answer locks writes for this mounted view. */
export async function runAmuxAutoAdmissionChange(
  input: { active: boolean; control: AmuxAutoAdmissionControl | null;
    confirmed: boolean; notice: AmuxAutoAdmissionNotice; pending: AmuxAutoAdmissionPending },
  io: AmuxAutoAdmissionIo,
  update: (change: AmuxAutoAdmissionUpdate) => void,
) {
  const { active, control } = input;
  if (!control || input.pending || amuxAutoAdmissionWriteLocked(input.notice) ||
      (active && (!input.confirmed || !amuxAutoAdmissionCanActivate(control)))) return;
  update({ pending: active ? "activating" : "stopping", notice: null,
    failure: null, confirmed: false });
  try {
    let response: Response;
    try { response = await io.post(amuxAutoAdmissionChangeBody(active, control)); }
    catch {
      update({ control: null, notice: "outcome_unknown_unread" });
      return;
    }
    const body = record(await response.clone().json().catch(() => null));
    if (!response.ok) {
      if (NO_WRITE_STATUSES.has(response.status)) {
        update({ failure: await io.failureOf(response) });
      } else if (response.status === 409 && body?.error === "conflict") {
        update({ control: null, notice: "conflict" });
      } else if (response.status === 409 && typeof body?.error === "string" &&
          KNOWN_REFUSALS.has(body.error)) {
        update({ failure: await io.failureOf(response) });
      } else {
        update({ control: null, notice: "outcome_unknown_unread" });
      }
      return;
    }
    if (!body || body.active !== active || !auditId(body.authorizationAuditLogId)) {
      update({ control: null, notice: "outcome_unknown_unread" });
      return;
    }
    // A failed read-back cannot turn this acknowledged write into a failed write.
    update({ control: null, notice: "saved", pending: "reading" });
    await runAmuxAutoAdmissionRead(io, update, "saved");
  } finally { update({ pending: null }); }
}
