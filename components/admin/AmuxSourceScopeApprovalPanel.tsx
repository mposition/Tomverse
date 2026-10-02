"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const mounted = useRef(false);
  const lifecycleVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    lifecycleVersion.current += 1;
    return () => { mounted.current = false; lifecycleVersion.current += 1; };
  }, []);
  const isCurrent = useCallback((version: number) =>
    mounted.current && lifecycleVersion.current === version, []);
  const setActiveState = useCallback((next: State) => {
    if (mounted.current) setState(next);
  }, []);
  const expected = useMemo(() => ({
    ideaId, ideaDigest: checked.ideaDigest,
    previewScopeDigest: checked.scopeDigest,
    previewScopeDigestKeyId: checked.scopeDigestKeyId,
  }), [ideaId, checked.ideaDigest, checked.scopeDigest, checked.scopeDigestKeyId]);

  const readBack = useCallback(async (binding: ScopeApprovalBinding,
    version = lifecycleVersion.current) => {
    try {
      const query = new URLSearchParams({ approvalId: binding.approvalId });
      const response = await adminFetch(`/api/admin/amux/ideas/source-scope-approval?${query}`,
        { cache: "no-store" });
      const decision = classifySourceScopeApprovalReply({ status: response.status,
        body: await response.json() }, binding, "read");
      if (!isCurrent(version)) return;
      if (decision.kind === "approved") {
        setActiveState({ kind: "approved", binding, expiresAt: decision.expiresAt });
      } else if (decision.kind === "expired") {
        if (!clearSourceScopeApprovalAttempt(receiptStore(), operatorId, binding)) {
          setActiveState({ kind: "storage_unavailable" });
        } else {
          setActiveState({ kind: "expired" });
        }
      } else if (decision.kind === "reauth_required") {
        setActiveState({ kind: "outcome_unknown", binding, reauthRequired: true });
      } else {
        setActiveState({ kind: "outcome_unknown", binding });
      }
    } catch {
      if (isCurrent(version)) setActiveState({ kind: "outcome_unknown", binding });
    }
  }, [isCurrent, operatorId, setActiveState]);

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
    const version = lifecycleVersion.current;
    let approvalId: string;
    try { approvalId = crypto.randomUUID(); } catch {
      setActiveState({ kind: "storage_unavailable" });
      return;
    }
    const binding = { ...expected, approvalId };
    if (!reserveSourceScopeApprovalAttempt(receiptStore(), operatorId, binding)) {
      const prior = readSourceScopeApprovalAttempt(receiptStore(), operatorId, expected);
      if (prior.kind === "present") {
        setActiveState({ kind: "outcome_unknown", binding: prior.binding });
        await readBack(prior.binding, version);
      } else {
        setActiveState({ kind: "storage_unavailable" });
      }
      return;
    }
    setActiveState({ kind: "pending", binding });
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
      if (!isCurrent(version)) return;
      if (decision.kind === "approved") {
        setActiveState({ kind: "approved", binding, expiresAt: decision.expiresAt });
      } else if (decision.kind === "refused") {
        if (clearSourceScopeApprovalAttempt(receiptStore(), operatorId, binding)) {
          setActiveState({ kind: "refused", code: decision.code });
        } else {
          setActiveState({ kind: "storage_unavailable" });
        }
      } else {
        setActiveState({ kind: "outcome_unknown", binding });
        await readBack(binding, version);
      }
    } catch {
      if (!isCurrent(version)) return;
      setActiveState({ kind: "outcome_unknown", binding });
      await readBack(binding, version);
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
