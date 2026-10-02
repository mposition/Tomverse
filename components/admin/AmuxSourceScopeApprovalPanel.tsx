"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import {
  classifySourceScopeApprovalReply,
  clearSourceScopeApprovalAttempt,
  readSourceScopeApprovalAttempt,
  reserveSourceScopeApprovalAttempt,
  type ScopeApprovalBinding,
} from "@/lib/amux/ideaSourceScopeApprovalUiCore";

type CheckedScope = {
  canonicalScopeJson: string;
  ideaDigest: string;
  scopeDigest: string;
  scopeDigestKeyId: string;
};

type State =
  | { kind: "idle" }
  | { kind: "pending" | "outcome_unknown"; binding: ScopeApprovalBinding; reauthRequired?: boolean }
  | { kind: "approved"; binding: ScopeApprovalBinding; expiresAt: string }
  | { kind: "expired" | "refused"; code?: string }
  | { kind: "storage_unavailable" };

const receiptStore = (): Storage | null => {
  try { return window.sessionStorage; } catch { return null; }
};

/** A collection-scope decision only. It never fetches a GitHub file or calls a model. */
export function AmuxSourceScopeApprovalPanel({ ideaId, operatorId, checked, available }: {
  ideaId: string; operatorId: string; checked: CheckedScope; available: boolean;
}) {
  const messages = useAdminMessages(adminAmuxIdeaInputMessages);
  const [state, setState] = useState<State>({ kind: "idle" });
  const expected = useMemo(() => ({
    ideaId, ideaDigest: checked.ideaDigest,
    previewScopeDigest: checked.scopeDigest,
    previewScopeDigestKeyId: checked.scopeDigestKeyId,
  }), [ideaId, checked.ideaDigest, checked.scopeDigest, checked.scopeDigestKeyId]);

  const readBack = useCallback(async (binding: ScopeApprovalBinding) => {
    try {
      const query = new URLSearchParams({ approvalId: binding.approvalId });
      const response = await adminFetch(`/api/admin/amux/ideas/source-scope-approval?${query}`,
        { cache: "no-store" });
      const decision = classifySourceScopeApprovalReply({ status: response.status,
        body: await response.json() }, binding, "read");
      if (decision.kind === "approved") {
        setState({ kind: "approved", binding, expiresAt: decision.expiresAt });
      } else if (decision.kind === "expired") {
        if (!clearSourceScopeApprovalAttempt(receiptStore(), operatorId, binding)) {
          setState({ kind: "storage_unavailable" });
        } else {
          setState({ kind: "expired" });
        }
      } else if (decision.kind === "reauth_required") {
        setState({ kind: "outcome_unknown", binding, reauthRequired: true });
      } else {
        setState({ kind: "outcome_unknown", binding });
      }
    } catch { setState({ kind: "outcome_unknown", binding }); }
  }, [operatorId]);

  useEffect(() => {
    let active = true;
    const prior = readSourceScopeApprovalAttempt(receiptStore(), operatorId, expected);
    queueMicrotask(() => {
      if (!active) return;
      if (prior.kind === "unavailable") {
        setState({ kind: "storage_unavailable" });
      } else if (prior.kind === "present") {
        setState({ kind: "outcome_unknown", binding: prior.binding });
        if (available) void readBack(prior.binding);
      }
    });
    return () => { active = false; };
  }, [available, operatorId, expected, readBack]);

  const approve = async () => {
    if (!available || state.kind !== "idle") return;
    let approvalId: string;
    try { approvalId = crypto.randomUUID(); } catch {
      setState({ kind: "storage_unavailable" });
      return;
    }
    const binding = { ...expected, approvalId };
    if (!reserveSourceScopeApprovalAttempt(receiptStore(), operatorId, binding)) {
      const prior = readSourceScopeApprovalAttempt(receiptStore(), operatorId, expected);
      if (prior.kind === "present") {
        setState({ kind: "outcome_unknown", binding: prior.binding });
        await readBack(prior.binding);
      } else {
        setState({ kind: "storage_unavailable" });
      }
      return;
    }
    setState({ kind: "pending", binding });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/source-scope-approval", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, approvalId, ideaId,
          ideaDigest: checked.ideaDigest,
          canonicalScopeJson: checked.canonicalScopeJson,
          scopeDigest: checked.scopeDigest,
          scopeDigestKeyId: checked.scopeDigestKeyId }),
      });
      const decision = classifySourceScopeApprovalReply({ status: response.status,
        body: await response.json() }, binding, "write");
      if (decision.kind === "approved") {
        setState({ kind: "approved", binding, expiresAt: decision.expiresAt });
      } else if (decision.kind === "refused") {
        if (clearSourceScopeApprovalAttempt(receiptStore(), operatorId, binding)) {
          setState({ kind: "refused", code: decision.code });
        } else {
          setState({ kind: "storage_unavailable" });
        }
      } else {
        setState({ kind: "outcome_unknown", binding });
        await readBack(binding);
      }
    } catch {
      setState({ kind: "outcome_unknown", binding });
      await readBack(binding);
    }
  };

  return (
    <div className="space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <p className="text-xs break-all text-zinc-600 dark:text-zinc-400">
        {messages.sourceScopeDigest}: {checked.scopeDigest}
      </p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.sourceScopeApprovalBoundary}</p>
      {state.kind === "idle" ? (
        <button type="button" onClick={() => void approve()} disabled={!available}
          className="min-h-11 rounded-lg border border-blue-700 px-4 text-sm font-medium text-blue-800 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200">
          {messages.sourceScopeApprove}
        </button>
      ) : null}
      {state.kind === "pending" ? <p role="status" className="text-sm">{messages.sourceScopeApproving}</p> : null}
      {state.kind === "approved" ? <p role="status" className="text-sm">
        {messages.sourceScopeApproved(state.expiresAt)}</p> : null}
      {state.kind === "expired" ? <p role="status" className="text-sm">{messages.sourceScopeApprovalExpired}</p> : null}
      {state.kind === "refused" ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">
        {messages.sourceScopeApprovalRefused(state.code ?? "approval_unavailable")}</p> : null}
      {state.kind === "outcome_unknown" ? <div role="alert" className="space-y-2 text-sm text-amber-800 dark:text-amber-200">
        <p>{messages.sourceScopeApprovalUnknown(state.binding.approvalId)}</p>
        {state.reauthRequired ? (
          <a href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}
            className="block font-medium underline">{messages.stepUp}</a>
        ) : null}
        <button type="button" onClick={() => void readBack(state.binding)}
          className="min-h-11 rounded-lg border border-amber-700 px-3 font-medium dark:border-amber-300">
          {messages.sourceScopeApprovalReadBack}
        </button>
      </div> : null}
      {state.kind === "storage_unavailable" ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">
        {messages.sourceScopeApprovalStorageUnavailable}</p> : null}
      {!available ? <p className="text-sm text-zinc-600 dark:text-zinc-400">{messages.sourceScopeApprovalUnavailable}</p> : null}
      {state.kind === "refused" && state.code === "ADMIN_REAUTHENTICATION_REQUIRED" ? (
        <a href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}
          className="text-sm font-medium underline">{messages.stepUp}</a>
      ) : null}
    </div>
  );
}
