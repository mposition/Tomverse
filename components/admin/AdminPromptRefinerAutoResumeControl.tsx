"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { adminFetch, isAdminFetchAbort } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { adminPromptRefinerProductStatusMessages } from
  "@/lib/adminMessages/promptRefinerProductStatus";
import { PROMPT_REFINER_PRODUCT_AUTO_RESUME_PATH,
  promptRefinerProductAutoResumeBody, promptRefinerProductAutoResumeStateSchema,
  type PromptRefinerProductAutoResumeState } from
  "@/lib/promptRefinerProductAutoResumeContract";
import type { PromptRefinerProductStatus } from "@/lib/promptRefinerProductStatusContract";

export function AdminPromptRefinerAutoResumeControl({ snapshot, onRefresh,
  messages: m }: { snapshot: PromptRefinerProductStatus;
    onRefresh: () => Promise<void>;
    messages: typeof adminPromptRefinerProductStatusMessages.en }) {
  const [state, setState] = useState<PromptRefinerProductAutoResumeState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<"failed" | "reauth" | "success" | null>(null);
  const [pending, setPending] = useState(false);
  const mutationLatch = useRef(false);
  const requestGeneration = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    setState(null);
    setConfirmed(false);
    setLoading(true);
    try {
      const response = await adminFetch(PROMPT_REFINER_PRODUCT_AUTO_RESUME_PATH,
        { cache: "no-store", signal: controller.signal });
      const parsed = promptRefinerProductAutoResumeStateSchema.safeParse(
        await response.json().catch(() => null));
      if (generation !== requestGeneration.current) return;
      if (response.ok && parsed.success) setState(parsed.data);
      else setResult("failed");
    } catch (error) {
      if (generation === requestGeneration.current && !isAdminFetchAbort(error)) {
        setResult("failed");
      }
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    queueMicrotask(() => void load());
    return () => { requestGeneration.current += 1; activeRead.current?.abort(); };
  }, [load]);

  const body = state ? promptRefinerProductAutoResumeBody(state) : null;
  const identityMatches = state?.runtimeCommitSha === snapshot.serving.commitSha &&
    state?.runtimeDeploymentId === snapshot.serving.deploymentId;
  const available = Boolean(body && identityMatches && snapshot.release.explicitEnabled &&
    snapshot.controls.rollout === "enabled" && !snapshot.controls.killSwitchEngaged);
  const resume = async () => {
    if (!confirmed || !available || !body || mutationLatch.current) return;
    mutationLatch.current = true;
    setPending(true);
    setConfirmed(false);
    setResult(null);
    try {
      const response = await adminFetch(PROMPT_REFINER_PRODUCT_AUTO_RESUME_PATH, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (response.status === 428 || value?.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setResult("reauth");
      } else if (response.ok && value?.autoEnabled === true &&
          value.generation === body.expectedGeneration + 1 &&
          value.runtimeCommitSha === state?.runtimeCommitSha &&
          value.runtimeDeploymentId === state?.runtimeDeploymentId &&
          typeof value.resumeAuditLogId === "string" && value.resumeAuditLogId.length > 0) {
        setResult("success");
        await onRefresh();
      } else setResult("failed");
    } catch { setResult("failed"); }
    finally { setPending(false); setState(null); }
    // A second mutation requires a fresh read and a new explicit confirmation.
  };
  const refresh = async () => {
    if (pending) return;
    await load();
    mutationLatch.current = false;
  };
  return <div className="mt-4 rounded-2xl border border-zinc-800 p-4"
    data-testid="prompt-refiner-auto-resume-control">
    <h3 className="text-sm font-bold text-white">{m.resumeTitle}</h3>
    <p className="mt-1 text-sm leading-6 text-zinc-400">{m.resumeDescription}</p>
    <button type="button" disabled={loading || pending} onClick={() => void refresh()}
      className="mt-3 min-h-11 rounded-xl border border-zinc-700 px-4 text-sm disabled:opacity-50">
      {m.resumeRefresh}
    </button>
    {state ? <dl className="mt-3 text-xs leading-6 text-zinc-300">
      <dt>{m.resumeState}</dt><dd>{state.active ? m.enabled : m.disabled}</dd>
      <dt>{m.resumeGeneration}</dt><dd>{state.generation ?? m.unknown}</dd>
      <dt>{m.resumeReason}</dt><dd>{state.reasonCode ?? m.none}</dd>
      <dt>{m.resumeAudit}</dt><dd className="break-all">{state.transitionAuditLogId ?? m.unknown}</dd>
    </dl> : null}
    {state && !state.writerEnabled ? <p className="mt-3 text-sm text-amber-200">
      {m.resumeWriterDisabled}</p> : null}
    <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-zinc-200">
      <input type="checkbox" checked={confirmed} disabled={!available || pending}
        onChange={event => setConfirmed(event.target.checked)} />{m.resumeConfirm}
    </label>
    <button type="button" disabled={!available || !confirmed || pending}
      onClick={() => void resume()}
      className="min-h-11 rounded-xl border border-zinc-700 px-4 text-sm disabled:opacity-50">
      {m.resumeAction}
    </button>
    {loading || pending ? <p role="status" className="mt-3 text-sm">{m.mutationPending}</p> : null}
    {result === "failed" ? <p role="alert" className="mt-3 text-sm text-red-200">{m.mutationFailed}</p> : null}
    {result === "success" ? <p role="status" className="mt-3 text-sm text-emerald-200">{m.mutationSucceeded}</p> : null}
    {result === "reauth" ? <a href={adminRecentAuthenticationHref("/admin/prompt-refiner-shadow")}
      className="mt-3 inline-flex min-h-11 items-center underline">{m.reauthenticate}</a> : null}
  </div>;
}
