"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useRef, useState } from "react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminDateTimeLabel } from "@/lib/adminDateTime";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import {
  ADMIN_SECURITY_NETWORK_FAILURE_MESSAGE,
  ADMIN_SECURITY_REASON_MIN_LENGTH,
  ADMIN_SECURITY_TICKET_MIN_LENGTH,
  adminSecurityActionPendingLabel,
  adminSecurityActionSuccessMessage,
  buildAdminSecurityActionPayload,
  describeAdminSecurityFailure,
  hasAdminSecurityFieldErrors,
  validateAdminSecurityAction,
  type AdminSecurityAction,
  type AdminSecurityActionInput,
  type AdminSecurityFailure,
  type AdminSecurityFieldErrors,
} from "@/lib/adminUserSecurityCore";

export type AdminSecurityUser = {
  id: string;
  accountStatus: string;
  accountSuspendedUntil: string | null;
  accountSuspensionReason: string | null;
  accountDeletionRequestedAt: string | null;
  accountDeletionScheduledFor: string | null;
  aiUsageRestricted: boolean;
  aiUsageRestrictedUntil: string | null;
  aiUsageRestrictionReason: string | null;
  securityIncidentNote: string | null;
  lastLoginAt: string | null;
  accounts: Array<{ provider: string; providerAccountId: string }>;
  sessionCount: number;
  timeZone: string;
};

/**
 * Narrows the full customer-detail payload to what the security controls need.
 * Shared so the panel and its regression harness read the same fields, and so
 * a field added to the detail API only has to be wired in once.
 */
export const toAdminSecurityUser = (user: {
  id: string;
  accountStatus: string;
  accountDeletionRequestedAt: string | null;
  accountDeletionScheduledFor: string | null;
  accountSuspendedUntil: string | null;
  accountSuspensionReason: string | null;
  aiUsageRestricted: boolean;
  aiUsageRestrictedUntil: string | null;
  aiUsageRestrictionReason: string | null;
  securityIncidentNote: string | null;
  lastLoginAt: string | null;
  accounts: Array<{ provider: string; providerAccountId: string }>;
  _count: { sessions: number };
  usage: { timeZone: string };
}): AdminSecurityUser => ({
  id: user.id,
  accountStatus: user.accountStatus,
  accountDeletionRequestedAt: user.accountDeletionRequestedAt,
  accountDeletionScheduledFor: user.accountDeletionScheduledFor,
  accountSuspendedUntil: user.accountSuspendedUntil,
  accountSuspensionReason: user.accountSuspensionReason,
  aiUsageRestricted: user.aiUsageRestricted,
  aiUsageRestrictedUntil: user.aiUsageRestrictedUntil,
  aiUsageRestrictionReason: user.aiUsageRestrictionReason,
  securityIncidentNote: user.securityIncidentNote,
  lastLoginAt: user.lastLoginAt,
  accounts: user.accounts.map((account) => ({
    provider: account.provider,
    providerAccountId: account.providerAccountId,
  })),
  sessionCount: user._count.sessions,
  timeZone: user.usage.timeZone,
});

type Props = {
  user: AdminSecurityUser;
  /** True while another panel action holds the console's single action slot. */
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  /** Reloads the customer detail so the new account state is on screen. */
  onApplied: () => Promise<void> | void;
};

const fieldClass = (invalid: boolean) =>
  `h-11 w-full rounded-xl border bg-zinc-950 px-3 text-sm text-white outline-none transition focus:ring-4 ${
    invalid
      ? "border-red-500/70 focus:border-red-400 focus:ring-red-500/10"
      : "border-zinc-700 focus:border-blue-400 focus:ring-blue-500/10"
  }`;

export function AdminUserSecurityControls({
  user,
  busy,
  onBusyChange,
  onApplied,
}: Props) {
  const pathname = usePathname();
  const fieldId = useId();
  const reasonRef = useRef<HTMLInputElement | null>(null);
  const ticketRef = useRef<HTMLInputElement | null>(null);
  const untilRef = useRef<HTMLInputElement | null>(null);

  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [incidentNote, setIncidentNote] = useState("");
  const [supportTicketReference, setSupportTicketReference] = useState("");
  const [fieldErrors, setFieldErrors] = useState<AdminSecurityFieldErrors>({});
  const [failure, setFailure] = useState<AdminSecurityFailure | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const ids = {
    reason: `${fieldId}-reason`,
    reasonHint: `${fieldId}-reason-hint`,
    reasonError: `${fieldId}-reason-error`,
    until: `${fieldId}-until`,
    untilHint: `${fieldId}-until-hint`,
    untilError: `${fieldId}-until-error`,
    note: `${fieldId}-note`,
    noteHint: `${fieldId}-note-hint`,
    ticket: `${fieldId}-ticket`,
    ticketHint: `${fieldId}-ticket-hint`,
    ticketError: `${fieldId}-ticket-error`,
  };

  const pendingDeletion = user.accountStatus === "pending_deletion";
  const suspended = user.accountStatus === "suspended";
  const disabled = busy || Boolean(pendingAction);

  const describedBy = (hint: string, error?: string) =>
    [hint, error].filter(Boolean).join(" ");

  const applyAction = async (
    action: AdminSecurityAction,
    provider?: string
  ) => {
    if (disabled) return;

    const input: AdminSecurityActionInput = {
      action,
      reason,
      until,
      incidentNote,
      provider,
      supportTicketReference,
    };
    const errors = validateAdminSecurityAction(input);
    setFieldErrors(errors);
    setFailure(null);

    if (hasAdminSecurityFieldErrors(errors)) {
      // The toast alone was the whole error channel before, and on the admin
      // console nothing rendered it. The inline message is the primary report;
      // the toast only mirrors it.
      const first =
        errors.reason || errors.supportTicketReference || errors.until || "";
      dispatchAppToast(first, "error");
      if (errors.reason) reasonRef.current?.focus();
      else if (errors.supportTicketReference) ticketRef.current?.focus();
      else untilRef.current?.focus();
      return;
    }

    const token = provider ? `${action}:${provider}` : action;
    setPendingAction(token);
    onBusyChange(true);
    try {
      const response = await fetch(
        `/api/admin/users/${encodeURIComponent(user.id)}/security`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildAdminSecurityActionPayload(input)),
        }
      );
      const data = (await response.json().catch(() => null)) as
        | {
            user?: unknown;
            error?: string;
            code?: string;
            approvalId?: string;
            alreadyRestored?: boolean;
          }
        | null;

      if (!response.ok || !data?.user) {
        const described = describeAdminSecurityFailure({
          status: response.status,
          error: data?.error,
          code: data?.code,
          approvalId: data?.approvalId,
        });
        setFailure(described);
        // An approval-pending 409 is the policy working, so it is announced as
        // information rather than as a failure the operator should retry.
        dispatchAppToast(described.message, described.tone);
        return;
      }

      await onApplied();
      setReason("");
      setUntil("");
      setIncidentNote("");
      setSupportTicketReference("");
      setFieldErrors({});
      const alreadyRestored = Boolean(data.alreadyRestored);
      dispatchAppToast(
        adminSecurityActionSuccessMessage(action, { alreadyRestored }),
        alreadyRestored ? "info" : "success"
      );
    } catch {
      setFailure({
        message: ADMIN_SECURITY_NETWORK_FAILURE_MESSAGE,
        tone: "error",
        requiresReauthentication: false,
        approvalId: null,
      });
      dispatchAppToast(ADMIN_SECURITY_NETWORK_FAILURE_MESSAGE, "error");
    } finally {
      setPendingAction(null);
      onBusyChange(false);
    }
  };

  const actionLabel = (
    action: AdminSecurityAction,
    idleLabel: string,
    provider?: string
  ) =>
    pendingAction === (provider ? `${action}:${provider}` : action)
      ? adminSecurityActionPendingLabel(action)
      : idleLabel;

  return (
    <section
      data-testid="admin-user-security-controls"
      // `min-w-0` because this section is a grid item, and a grid item's
      // default `min-width: auto` refuses to shrink below the intrinsic width
      // of `<input type="datetime-local">`, which overflows a 320px viewport.
      className={`min-w-0 rounded-2xl border p-4 lg:col-span-2 ${
        suspended || user.aiUsageRestricted || pendingDeletion
          ? "border-amber-500/30 bg-amber-500/10"
          : "border-zinc-800 bg-zinc-900/60"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-black text-white">Account security controls</h4>
          <p className="mt-1 text-xs text-zinc-400">
            Last login: {adminDateTimeLabel(user.lastLoginAt, user.timeZone)} · Active sessions: {user.sessionCount}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-bold">
          <span
            data-testid="admin-security-account-status"
            className={`rounded-full border px-2.5 py-1 ${
              suspended || pendingDeletion
                ? "border-red-500/30 bg-red-500/10 text-red-200"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
            }`}
          >
            Account {user.accountStatus}
          </span>
          <span
            data-testid="admin-security-ai-status"
            className={`rounded-full border px-2.5 py-1 ${
              user.aiUsageRestricted
                ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                : "border-zinc-700 text-zinc-300"
            }`}
          >
            AI {user.aiUsageRestricted ? "restricted" : "allowed"}
          </span>
        </div>
      </div>

      {user.accountDeletionScheduledFor || user.accountDeletionRequestedAt ? (
        <p
          data-testid="admin-security-deletion-schedule"
          className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs font-bold text-red-100"
        >
          Deletion requested {adminDateTimeLabel(user.accountDeletionRequestedAt, user.timeZone)} · scheduled for {adminDateTimeLabel(user.accountDeletionScheduledFor, user.timeZone)}
        </p>
      ) : null}

      {user.accountSuspensionReason || user.aiUsageRestrictionReason ? (
        <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
          {user.accountSuspensionReason ? (
            <p>
              Suspension: {user.accountSuspensionReason} · until {adminDateTimeLabel(user.accountSuspendedUntil, user.timeZone)}
            </p>
          ) : null}
          {user.aiUsageRestrictionReason ? (
            <p>
              AI restriction: {user.aiUsageRestrictionReason} · until {adminDateTimeLabel(user.aiUsageRestrictedUntil, user.timeZone)}
            </p>
          ) : null}
          {user.securityIncidentNote ? (
            <p className="mt-1 text-zinc-300">Incident note: {user.securityIncidentNote}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <label
            htmlFor={ids.reason}
            className="block text-xs font-bold text-zinc-200"
          >
            Audit reason <span className="text-red-300">(required)</span>
          </label>
          <p id={ids.reasonHint} className="mt-1 text-[11px] leading-4 text-zinc-500">
            At least {ADMIN_SECURITY_REASON_MIN_LENGTH} characters. Applies to every control below and is stored in the admin audit log.
          </p>
          <input
            id={ids.reason}
            ref={reasonRef}
            data-testid="admin-security-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-required="true"
            aria-invalid={Boolean(fieldErrors.reason)}
            aria-describedby={describedBy(
              ids.reasonHint,
              fieldErrors.reason ? ids.reasonError : undefined
            )}
            className={`mt-2 ${fieldClass(Boolean(fieldErrors.reason))}`}
          />
          {fieldErrors.reason ? (
            <p
              id={ids.reasonError}
              data-testid="admin-security-reason-error"
              className="mt-1.5 text-xs font-bold text-red-300"
            >
              {fieldErrors.reason}
            </p>
          ) : null}
        </div>

        <div>
          <label
            htmlFor={ids.note}
            className="block text-xs font-bold text-zinc-200"
          >
            Security incident note <span className="text-zinc-500">(optional)</span>
          </label>
          <p id={ids.noteHint} className="mt-1 text-[11px] leading-4 text-zinc-500">
            Free-text context kept on the account. Leave out anything the audit log does not need.
          </p>
          <input
            id={ids.note}
            data-testid="admin-security-incident-note"
            value={incidentNote}
            onChange={(event) => setIncidentNote(event.target.value)}
            aria-describedby={ids.noteHint}
            className={`mt-2 ${fieldClass(false)}`}
          />
        </div>
      </div>

      {pendingDeletion ? (
        <div
          data-testid="admin-security-restore-group"
          className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4"
        >
          <h5 className="text-sm font-black text-emerald-100">Cancel scheduled deletion</h5>
          <p className="mt-1 text-xs text-emerald-100/80">
            Restores the account to active and clears the deletion schedule. A control expiry does not apply here, and automatic subscription renewal is not switched back on.
          </p>
          <div className="mt-3 max-w-md">
            <label
              htmlFor={ids.ticket}
              className="block text-xs font-bold text-zinc-200"
            >
              Support ticket reference <span className="text-red-300">(required to restore)</span>
            </label>
            <p id={ids.ticketHint} className="mt-1 text-[11px] leading-4 text-zinc-400">
              At least {ADMIN_SECURITY_TICKET_MIN_LENGTH} characters. Links this restoration to the customer request that authorised it.
            </p>
            <input
              id={ids.ticket}
              ref={ticketRef}
              data-testid="admin-security-ticket"
              value={supportTicketReference}
              onChange={(event) => setSupportTicketReference(event.target.value)}
              aria-required="true"
              aria-invalid={Boolean(fieldErrors.supportTicketReference)}
              aria-describedby={describedBy(
                ids.ticketHint,
                fieldErrors.supportTicketReference ? ids.ticketError : undefined
              )}
              className={`mt-2 ${fieldClass(Boolean(fieldErrors.supportTicketReference))}`}
            />
            {fieldErrors.supportTicketReference ? (
              <p
                id={ids.ticketError}
                data-testid="admin-security-ticket-error"
                className="mt-1.5 text-xs font-bold text-red-300"
              >
                {fieldErrors.supportTicketReference}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="admin-security-restore"
            onClick={() => void applyAction("restore_account")}
            disabled={disabled}
            className="mt-3 cursor-pointer rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {actionLabel("restore_account", "Cancel deletion & restore account")}
          </button>
        </div>
      ) : null}

      <div
        data-testid="admin-security-restriction-group"
        className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4"
      >
        <h5 className="text-sm font-black text-white">Access restrictions</h5>
        <div className="mt-3 max-w-md">
          <label
            htmlFor={ids.until}
            className="block text-xs font-bold text-zinc-200"
          >
            Control expiry <span className="text-zinc-500">(optional)</span>
          </label>
          <p id={ids.untilHint} className="mt-1 text-[11px] leading-4 text-zinc-500">
            Applies only to <strong className="text-zinc-300">Suspend account</strong> and <strong className="text-zinc-300">Restrict AI usage</strong>. The restriction lifts automatically at this time. Entered in this browser&apos;s local time. It is not sent for session revocation, unlinking a login, or cancelling a scheduled deletion.
          </p>
          <input
            id={ids.until}
            ref={untilRef}
            type="datetime-local"
            data-testid="admin-security-until"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
            aria-invalid={Boolean(fieldErrors.until)}
            aria-describedby={describedBy(
              ids.untilHint,
              fieldErrors.until ? ids.untilError : undefined
            )}
            className={`mt-2 ${fieldClass(Boolean(fieldErrors.until))}`}
          />
          {fieldErrors.until ? (
            <p
              id={ids.untilError}
              data-testid="admin-security-until-error"
              className="mt-1.5 text-xs font-bold text-red-300"
            >
              {fieldErrors.until}
            </p>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {pendingDeletion ? null : (
            <button
              type="button"
              data-testid="admin-security-suspend"
              onClick={() =>
                void applyAction(suspended ? "unsuspend" : "suspend")
              }
              disabled={disabled}
              className="cursor-pointer rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-100 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {suspended
                ? actionLabel("unsuspend", "Unsuspend account")
                : actionLabel("suspend", "Suspend account")}
            </button>
          )}
          <button
            type="button"
            data-testid="admin-security-toggle-ai"
            onClick={() =>
              void applyAction(
                user.aiUsageRestricted ? "unrestrict_ai" : "restrict_ai"
              )
            }
            disabled={disabled}
            className="cursor-pointer rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-100 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {user.aiUsageRestricted
              ? actionLabel("unrestrict_ai", "Restore AI usage")
              : actionLabel("restrict_ai", "Restrict AI usage")}
          </button>
          <button
            type="button"
            data-testid="admin-security-revoke-sessions"
            onClick={() => void applyAction("revoke_sessions")}
            disabled={disabled}
            className="cursor-pointer rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs font-bold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {actionLabel("revoke_sessions", "Revoke all sessions")}
          </button>
        </div>
      </div>

      {user.accounts.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
          <span className="text-xs font-bold text-zinc-500">
            Unlink OAuth (owner + two-person approval):
          </span>
          {user.accounts.map((account) => (
            <button
              key={`unlink-${account.provider}-${account.providerAccountId}`}
              type="button"
              data-testid={`admin-security-unlink-${account.provider}`}
              onClick={() => void applyAction("unlink_oauth", account.provider)}
              disabled={disabled}
              className="cursor-pointer rounded-lg border border-red-500/30 px-2.5 py-1.5 text-xs font-bold text-red-200 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {actionLabel(
                "unlink_oauth",
                `Unlink ${account.provider}`,
                account.provider
              )}
            </button>
          ))}
        </div>
      ) : null}

      {failure ? (
        <div
          role={failure.tone === "error" ? "alert" : "status"}
          aria-live={failure.tone === "error" ? "assertive" : "polite"}
          data-testid="admin-security-request-error"
          data-tone={failure.tone}
          className={`mt-4 rounded-xl border p-3 text-xs font-bold ${
            failure.tone === "error"
              ? "border-red-500/40 bg-red-500/10 text-red-100"
              : "border-amber-500/40 bg-amber-500/10 text-amber-100"
          }`}
        >
          <p>{failure.message}</p>
          {failure.requiresReauthentication ? (
            <Link
              // The step-up URL, not the console-session one: the console
              // session is still valid here, and the plain reauthentication
              // page answers that by redirecting straight back to this screen.
              href={adminRecentAuthenticationHref(pathname)}
              data-testid="admin-security-reauthenticate-link"
              className="mt-2 inline-flex cursor-pointer items-center rounded-lg border border-red-400/50 px-2.5 py-1.5 font-bold text-red-50 underline-offset-4 transition hover:bg-red-500/20 hover:underline"
            >
              Sign in again to continue
            </Link>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-xs text-zinc-500">
        High-risk controls require a recent administrator login. Sign in again if the console requests reauthentication.
      </p>
    </section>
  );
}
