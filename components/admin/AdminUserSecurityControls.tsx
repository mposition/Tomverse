"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useRef, useState } from "react";
import {
  ChevronDown,
  Cpu,
  KeyRound,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Undo2,
} from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminDateTimeLabel } from "@/lib/adminDateTime";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { adminUserSecurityMessages } from "@/lib/adminMessages/userSecurity";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminUserDeleteButton } from "@/components/admin/AdminUserDeleteButton";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminUiMessages } from "@/lib/adminMessages/ui";
import {
  ADMIN_SECURITY_NETWORK_FAILURE_MESSAGE,
  ADMIN_SECURITY_REASON_MIN_LENGTH,
  ADMIN_SECURITY_TICKET_MIN_LENGTH,
  adminSecurityActionAcceptsExpiry,
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
import { adminFetch } from "@/lib/adminFetch";

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
  /** The signed-in operator, so the delete control can refuse their own account. */
  currentUserId?: string;
  /** False draws every action locked, naming the access it needs. The route still decides. */
  canWrite?: boolean;
  /** Unlinking a sign-in is gated apart from the other actions (the owner's `user:delete`). */
  canUnlink?: boolean;
  /** Where a renewed sign-in returns to, including the section (`?tab=security`). */
  returnTo?: string;
};

type CardId = "restore" | "ai" | "suspend" | "sessions" | "unlink" | "delete";

const fieldClass = (invalid: boolean) =>
  `h-11 w-full rounded-xl border bg-zinc-950 px-3 text-sm text-white outline-none transition focus:ring-4 ${
    invalid
      ? "border-red-500/70 focus:border-red-400 focus:ring-red-500/10"
      : "border-zinc-700 focus:border-blue-400 focus:ring-blue-500/10"
  }`;

/**
 * The button that sends an action. A component of its own (not a closure in
 * the card renderer) so the click handler it is given is an event handler, not
 * something the render reads.
 */
function ConfirmButton({
  testId,
  label,
  pendingLabel,
  variant,
  canWrite,
  disabled,
  onConfirm,
}: {
  testId: string;
  label: string;
  /** Set while this very action is in flight; replaces the label. */
  pendingLabel: string | null;
  variant: "primary" | "danger";
  canWrite: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const ui = useAdminMessages(adminUiMessages);
  return (
    <AdminWriteButton
      data-testid={testId}
      variant={variant}
      stepUp
      writable={canWrite}
      requiredRole="support"
      disabled={disabled}
      onClick={onConfirm}
    >
      {pendingLabel ?? ui.stepUpAction(label)}
    </AdminWriteButton>
  );
}

/**
 * Account security: the state the account is in, then the things an operator
 * can do about it, each as a card that says what it will do before it asks
 * for anything.
 *
 * Every request goes to the same route with the same payload, step-up and
 * audit reason as before; only the arrangement is new. One audit reason, one
 * expiry and one note are shared by all cards, so a value typed in one card is
 * still what the next one sends -- which is why the payload builder, not the
 * field, decides whether an expiry is forwarded.
 */
export function AdminUserSecurityControls({
  user,
  busy,
  onBusyChange,
  onApplied,
  currentUserId,
  canWrite = true,
  canUnlink = canWrite,
  returnTo,
}: Props) {
  const pathname = usePathname();
  const m = useAdminMessages(adminUserSecurityMessages);
  const ui = useAdminMessages(adminUiMessages);
  const fieldId = useId();
  const reasonRef = useRef<HTMLInputElement | null>(null);
  const ticketRef = useRef<HTMLInputElement | null>(null);
  const untilRef = useRef<HTMLInputElement | null>(null);

  const pendingDeletion = user.accountStatus === "pending_deletion";
  const suspended = user.accountStatus === "suspended";

  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [incidentNote, setIncidentNote] = useState("");
  const [supportTicketReference, setSupportTicketReference] = useState("");
  const [fieldErrors, setFieldErrors] = useState<AdminSecurityFieldErrors>({});
  const [failure, setFailure] = useState<AdminSecurityFailure | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // The restoration is the one thing a pending deletion is waiting for, so it
  // opens first; every other card starts closed.
  // `undefined` means the operator has not chosen: the restore card is then the
  // open one while a deletion is pending -- including when the account becomes
  // pending after this panel was drawn (the detail reloads in place). A choice,
  // even "none", stands until the next action succeeds.
  const [choice, setChoice] = useState<CardId | "none" | undefined>(undefined);
  const open: CardId | null =
    choice === undefined ? (pendingDeletion ? "restore" : null) : choice === "none" ? null : choice;
  const setOpen = (next: CardId | null) => setChoice(next === null ? "none" : next);

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

  const disabled = busy || Boolean(pendingAction);

  const describedBy = (hint: string, error?: string) =>
    [hint, error].filter(Boolean).join(" ");

  const applyAction = async (action: AdminSecurityAction, provider?: string) => {
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
      const first = errors.reason || errors.supportTicketReference || errors.until || "";
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
      const response = await adminFetch(
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
      setChoice(undefined);
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

  const restricted = suspended || pendingDeletion || user.aiUsageRestricted;
  const pendingFor = (action: AdminSecurityAction) =>
    pendingAction === action ? adminSecurityActionPendingLabel(action) : null;

  /** The reason, optional note and (for the two actions that take one) expiry. */
  const sharedFields = (primary: AdminSecurityAction) => (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="md:col-span-2">
        <label htmlFor={ids.reason} className="block text-xs font-bold text-zinc-200">
          {m.reason.label}
          <span className="text-red-300">{m.reason.required}</span>
        </label>
        <p id={ids.reasonHint} className="mt-1 text-[11px] leading-4 text-zinc-500">
          {m.reason.hint(ADMIN_SECURITY_REASON_MIN_LENGTH)}
        </p>
        <input
          id={ids.reason}
          ref={reasonRef}
          data-testid="admin-security-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-required="true"
          aria-invalid={Boolean(fieldErrors.reason)}
          aria-describedby={describedBy(ids.reasonHint, fieldErrors.reason ? ids.reasonError : undefined)}
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

      {adminSecurityActionAcceptsExpiry(primary) ? (
        <div className="min-w-0">
          <label htmlFor={ids.until} className="block text-xs font-bold text-zinc-200">
            {m.restrictions.expiryLabel}
            <span className="text-zinc-500">{m.restrictions.expiryOptional}</span>
          </label>
          <p id={ids.untilHint} className="mt-1 text-[11px] leading-4 text-zinc-500">
            {m.restrictions.expiryHint.before}
            <strong className="text-zinc-300">{m.restrictions.expiryHint.suspend}</strong>
            {m.restrictions.expiryHint.between}
            <strong className="text-zinc-300">{m.restrictions.expiryHint.restrict}</strong>
            {m.restrictions.expiryHint.after}
          </p>
          <input
            id={ids.until}
            ref={untilRef}
            type="datetime-local"
            data-testid="admin-security-until"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
            aria-invalid={Boolean(fieldErrors.until)}
            aria-describedby={describedBy(ids.untilHint, fieldErrors.until ? ids.untilError : undefined)}
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
      ) : null}

      <div className="min-w-0">
        <label htmlFor={ids.note} className="block text-xs font-bold text-zinc-200">
          {m.note.label}
          <span className="text-zinc-500">{m.note.optional}</span>
        </label>
        <p id={ids.noteHint} className="mt-1 text-[11px] leading-4 text-zinc-500">
          {m.note.hint}
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
  );

  const cancelButton = (
    <button
      type="button"
      onClick={() => setOpen(null)}
      disabled={disabled}
      className="min-h-10 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
    >
      {ui.cancel}
    </button>
  );

  const card = (
    cardId: CardId,
    spec: {
      icon: React.ReactNode;
      title: string;
      description: string;
      tone?: "danger" | "calm" | "ok";
      body: React.ReactNode;
    }
  ) => {
    const expanded = open === cardId;
    const panelId = `${fieldId}-panel-${cardId}`;
    const frame = expanded
      ? spec.tone === "danger"
        ? "border-red-500/50 bg-red-500/5"
        : "border-blue-500/50 bg-zinc-950/40"
      : "border-zinc-800 bg-zinc-900";
    const iconTone =
      spec.tone === "danger"
        ? "bg-red-500/15 text-red-300"
        : spec.tone === "ok"
          ? "bg-emerald-500/15 text-emerald-300"
          : "bg-amber-500/15 text-amber-300";
    return (
      <div
        key={cardId}
        data-testid={`admin-security-card-${cardId}`}
        className={`min-w-0 rounded-2xl border ${frame}`}
      >
        <button
          type="button"
          data-testid={`admin-security-card-${cardId}-toggle`}
          aria-expanded={expanded}
          aria-controls={panelId}
          disabled={disabled}
          onClick={() => setOpen(expanded ? null : cardId)}
          className="flex w-full items-center gap-3 p-4 text-left disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconTone}`}>
            {spec.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-white [overflow-wrap:anywhere]">{spec.title}</span>
            <span className="mt-0.5 block text-xs text-zinc-400 [overflow-wrap:anywhere]">{spec.description}</span>
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${expanded ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>
        {expanded ? (
          <div id={panelId} className="flex flex-col gap-4 border-t border-zinc-800 p-4">
            {spec.body}
          </div>
        ) : null}
      </div>
    );
  };

  const footerButtons = (button: React.ReactNode) => (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      {cancelButton}
      {button}
    </div>
  );

  return (
    <section
      data-testid="admin-user-security-controls"
      // `min-w-0` because this section is a grid item, and a grid item's
      // default `min-width: auto` refuses to shrink below the intrinsic width
      // of `<input type="datetime-local">`, which overflows a 320px viewport.
      className="flex min-w-0 flex-col gap-4"
    >
      <div
        className={`rounded-2xl border p-5 ${
          restricted ? "border-amber-500/40 bg-amber-500/10" : "border-emerald-500/30 bg-emerald-500/10"
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
                restricted ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300"
              }`}
            >
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-white [overflow-wrap:anywhere]">
                {restricted ? m.status.restrictedTitle : m.status.calmTitle}
              </h3>
              <p className="mt-0.5 text-xs text-zinc-400">
                {m.lastLogin(adminDateTimeLabel(user.lastLoginAt, user.timeZone), user.sessionCount)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span data-testid="admin-security-account-status">
              <AdminStatusChip tone={suspended || pendingDeletion ? "bad" : "ok"}>
                {m.accountStatus(user.accountStatus)}
              </AdminStatusChip>
            </span>
            <span data-testid="admin-security-ai-status">
              <AdminStatusChip tone={user.aiUsageRestricted ? "warn" : "idle"}>
                {user.aiUsageRestricted ? m.aiRestricted : m.aiAllowed}
              </AdminStatusChip>
            </span>
          </div>
        </div>

        {user.accountDeletionScheduledFor || user.accountDeletionRequestedAt ? (
          <p
            data-testid="admin-security-deletion-schedule"
            className="mt-3 rounded-xl bg-red-500/10 p-3 text-xs font-bold text-red-200"
          >
            {m.deletionSchedule(
              adminDateTimeLabel(user.accountDeletionRequestedAt, user.timeZone),
              adminDateTimeLabel(user.accountDeletionScheduledFor, user.timeZone)
            )}
          </p>
        ) : null}

        {user.accountSuspensionReason || user.aiUsageRestrictionReason || user.securityIncidentNote ? (
          <div className="mt-3 rounded-xl bg-zinc-950/60 p-3 text-xs text-zinc-400">
            {user.accountSuspensionReason ? (
              <p>
                {m.suspension(user.accountSuspensionReason, adminDateTimeLabel(user.accountSuspendedUntil, user.timeZone))}
              </p>
            ) : null}
            {user.aiUsageRestrictionReason ? (
              <p>
                {m.aiRestriction(user.aiUsageRestrictionReason, adminDateTimeLabel(user.aiUsageRestrictedUntil, user.timeZone))}
              </p>
            ) : null}
            {user.securityIncidentNote ? (
              <p className="mt-1 text-zinc-300">{m.incidentNote(user.securityIncidentNote)}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      <AdminTile title={m.actions.title} description={m.actions.description}>
        <div className="flex flex-col gap-3">
          {pendingDeletion
            ? card("restore", {
                icon: <Undo2 className="h-5 w-5" aria-hidden />,
                title: m.restore.title,
                description: m.restore.description,
                tone: "ok",
                body: (
                  <div data-testid="admin-security-restore-group" className="flex flex-col gap-4">
                    {sharedFields("restore_account")}
                    <div className="max-w-md">
                      <label htmlFor={ids.ticket} className="block text-xs font-bold text-zinc-200">
                        {m.restore.ticketLabel}
                        <span className="text-red-300">{m.restore.ticketRequired}</span>
                      </label>
                      <p id={ids.ticketHint} className="mt-1 text-[11px] leading-4 text-zinc-400">
                        {m.restore.ticketHint(ADMIN_SECURITY_TICKET_MIN_LENGTH)}
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
                    {footerButtons(
                      <ConfirmButton
                        testId="admin-security-restore"
                        label={m.restore.action}
                        pendingLabel={pendingFor("restore_account")}
                        variant="primary"
                        canWrite={canWrite}
                        disabled={disabled}
                        onConfirm={() => void applyAction("restore_account")}
                      />
                    )}
                  </div>
                ),
              })
            : null}

          {card("ai", {
            icon: <Cpu className="h-5 w-5" aria-hidden />,
            title: user.aiUsageRestricted ? m.cards.ai.restoreTitle : m.cards.ai.title,
            description: user.aiUsageRestricted ? m.cards.ai.restoreDescription : m.cards.ai.description,
            body: (
              <>
                {sharedFields(user.aiUsageRestricted ? "unrestrict_ai" : "restrict_ai")}
                {footerButtons(
                  <ConfirmButton
                        testId="admin-security-toggle-ai"
                        label={user.aiUsageRestricted ? m.restrictions.restoreAi : m.restrictions.restrictAi}
                        pendingLabel={pendingFor(user.aiUsageRestricted ? "unrestrict_ai" : "restrict_ai")}
                        variant={user.aiUsageRestricted ? "primary" : "danger"}
                        canWrite={canWrite}
                        disabled={disabled}
                        onConfirm={() => void applyAction(user.aiUsageRestricted ? "unrestrict_ai" : "restrict_ai")}
                      />
                )}
              </>
            ),
          })}

          {pendingDeletion
            ? null
            : card("suspend", {
                icon: <Lock className="h-5 w-5" aria-hidden />,
                title: suspended ? m.cards.suspend.liftTitle : m.cards.suspend.title,
                description: suspended ? m.cards.suspend.liftDescription : m.cards.suspend.description,
                tone: suspended ? "ok" : "danger",
                body: (
                  <>
                    {sharedFields(suspended ? "unsuspend" : "suspend")}
                    {footerButtons(
                      <ConfirmButton
                        testId="admin-security-suspend"
                        label={suspended ? m.restrictions.unsuspend : m.restrictions.suspend}
                        pendingLabel={pendingFor(suspended ? "unsuspend" : "suspend")}
                        variant={suspended ? "primary" : "danger"}
                        canWrite={canWrite}
                        disabled={disabled}
                        onConfirm={() => void applyAction(suspended ? "unsuspend" : "suspend")}
                      />
                    )}
                  </>
                ),
              })}

          {card("sessions", {
            icon: <RefreshCw className="h-5 w-5" aria-hidden />,
            title: m.cards.sessions.title,
            description: m.cards.sessions.description,
            tone: "calm",
            body: (
              <>
                {sharedFields("revoke_sessions")}
                {footerButtons(
                  <ConfirmButton
                        testId="admin-security-revoke-sessions"
                        label={m.restrictions.revokeSessions}
                        pendingLabel={pendingFor("revoke_sessions")}
                        variant="primary"
                        canWrite={canWrite}
                        disabled={disabled}
                        onConfirm={() => void applyAction("revoke_sessions")}
                      />
                )}
              </>
            ),
          })}

          {user.accounts.length > 0
            ? card("unlink", {
                icon: <KeyRound className="h-5 w-5" aria-hidden />,
                title: m.cards.unlink.title,
                description: m.cards.unlink.description,
                tone: "danger",
                body: (
                  <>
                    {sharedFields("unlink_oauth")}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold text-zinc-500">{m.unlinkLabel}</span>
                      {user.accounts.map((account) => (
                        <AdminWriteButton
                          key={`unlink-${account.provider}-${account.providerAccountId}`}
                          data-testid={`admin-security-unlink-${account.provider}`}
                          variant="danger"
                          size="sm"
                          stepUp
                          writable={canUnlink}
                          requiredRole="owner"
                          disabled={disabled}
                          onClick={() => void applyAction("unlink_oauth", account.provider)}
                        >
                          {pendingAction === `unlink_oauth:${account.provider}`
                            ? adminSecurityActionPendingLabel("unlink_oauth")
                            : m.unlink(account.provider)}
                        </AdminWriteButton>
                      ))}
                    </div>
                  </>
                ),
              })
            : null}

          {card("delete", {
            icon: <Trash2 className="h-5 w-5" aria-hidden />,
            title: m.cards.delete.title,
            description: m.cards.delete.description,
            tone: "danger",
            body: (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-zinc-400">{m.cards.delete.detail}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <AdminUserDeleteButton userId={user.id} currentUserId={currentUserId} />
                </div>
              </div>
            ),
          })}
        </div>

        {failure ? (
          <div
            role={failure.tone === "error" ? "alert" : "status"}
            aria-live={failure.tone === "error" ? "assertive" : "polite"}
            data-testid="admin-security-request-error"
            data-tone={failure.tone}
            className={`rounded-xl p-3 text-xs font-bold ${
              failure.tone === "error" ? "bg-red-500/10 text-red-200" : "bg-amber-500/10 text-amber-200"
            }`}
          >
            <p>{failure.message}</p>
            {failure.requiresReauthentication ? (
              <Link
                // The step-up URL, not the console-session one: the console
                // session is still valid here, and the plain reauthentication
                // page answers that by redirecting straight back to this screen.
                href={adminRecentAuthenticationHref(returnTo ?? pathname)}
                data-testid="admin-security-reauthenticate-link"
                className="mt-2 inline-flex cursor-pointer items-center rounded-lg border border-red-400/50 px-2.5 py-1.5 font-bold text-red-100 underline-offset-4 transition hover:bg-red-500/20 hover:underline"
              >
                {m.reauthenticate}
              </Link>
            ) : null}
          </div>
        ) : null}

        <p className="text-xs text-zinc-500">{m.footer}</p>
      </AdminTile>
    </section>
  );
}
