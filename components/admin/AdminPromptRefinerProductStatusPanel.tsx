"use client";

import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import { adminFetch, isAdminFetchAbort } from "@/lib/adminFetch";
import { adminPromptRefinerProductStatusMessages } from
  "@/lib/adminMessages/promptRefinerProductStatus";
import {
  PROMPT_REFINER_PRODUCT_STATUS_PATH,
  parsePromptRefinerProductStatus,
  type PromptRefinerProductStatus,
} from "@/lib/promptRefinerProductStatusContract";

type Failure = "request_failed" | "invalid_response" | null;

const StatusField = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5">
    <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
      {label}
    </dt>
    <dd className="mt-1 break-all text-xs leading-5 text-zinc-200">{value}</dd>
  </div>
);

export function AdminPromptRefinerProductStatusReadback({ snapshot, messages: m }: {
  snapshot: PromptRefinerProductStatus;
  messages: typeof adminPromptRefinerProductStatusMessages.en;
}) {
  const bool = (value: boolean | null) => value === null
    ? m.unknown
    : value ? m.enabled : m.disabled;
  const rollout = snapshot.controls.rollout === "enabled"
    ? m.enabled
    : snapshot.controls.rollout === "disabled" ? m.disabled : m.unknown;

  return (
    <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatusField label={m.observedAt} value={snapshot.observedAt} />
      <StatusField label={m.commit} value={snapshot.serving.commitSha ?? m.unknown} />
      <StatusField label={m.deployment} value={snapshot.serving.deploymentId ?? m.unknown} />
      <StatusField label={m.exactIdentity} value={snapshot.serving.exactProductIdentity ? m.yes : m.no} />
      <StatusField label={m.rollout} value={rollout} />
      <StatusField label={m.killSwitch} value={snapshot.controls.killSwitchEngaged ? m.enabled : m.disabled} />
      <StatusField label={m.release} value={m.releaseStates[snapshot.release.state]} />
      <StatusField label={m.explicit} value={bool(snapshot.release.explicitEnabled)} />
      <StatusField label={m.auto} value={bool(snapshot.release.autoEnabled)} />
      <StatusField label={m.approval} value={snapshot.release.approvalAuditLogId ?? m.unknown} />
      <StatusField label={m.router} value={snapshot.router.ready ? m.ready : m.pending} />
      <StatusField label={m.outstanding} value={snapshot.router.outstanding.join(", ") || m.none} />
      <StatusField label={m.problems} value={snapshot.router.problems.join("; ") || m.none} />
      <StatusField label={m.completion} value={m.notEstablished} />
    </dl>
  );
}

export function AdminPromptRefinerProductStatusPanel() {
  const m = useAdminMessages(adminPromptRefinerProductStatusMessages);
  const [snapshot, setSnapshot] =
    useState<PromptRefinerProductStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure>(null);
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setFailure(null);
    setSnapshot(null);
    try {
      const response = await adminFetch(PROMPT_REFINER_PRODUCT_STATUS_PATH, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (generation !== requestGeneration.current) return;
      if (!response.ok) {
        setFailure("request_failed");
        return;
      }
      const parsed = parsePromptRefinerProductStatus(body);
      if (!parsed) {
        setFailure("invalid_response");
        return;
      }
      setSnapshot(parsed);
    } catch (error) {
      if (generation === requestGeneration.current && !isAdminFetchAbort(error)) {
        setFailure("request_failed");
      }
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
    return () => {
      requestGeneration.current += 1;
      activeRequest.current?.abort();
    };
  }, [load]);

  const failureMessage = failure === "invalid_response"
    ? m.invalidResponse
    : failure === "request_failed" ? m.requestFailed : null;

  return (
    <section
      className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5"
      data-testid="prompt-refiner-product-status-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-zinc-400">
            <ShieldCheck className="h-4 w-4" aria-hidden />
            {m.eyebrow}
          </p>
          <h2 className="mt-2 text-lg font-bold text-white">{m.title}</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-400">{m.description}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="prompt-refiner-product-status-refresh"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> :
            <RefreshCw className="h-4 w-4" aria-hidden />}
          {m.refresh}
        </button>
      </div>

      <p className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm leading-6 text-amber-100">
        {m.caveat}
      </p>
      {loading ? <p role="status" className="mt-4 text-sm text-zinc-400">{m.loading}</p> : null}
      {failureMessage ? (
        <p role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">
          {failureMessage}
        </p>
      ) : null}

      {snapshot ? <AdminPromptRefinerProductStatusReadback
        snapshot={snapshot} messages={m} /> : null}
    </section>
  );
}
