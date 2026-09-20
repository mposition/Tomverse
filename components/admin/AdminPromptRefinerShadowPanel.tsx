"use client";

import Link from "next/link";
import {
  CheckCircle2,
  CircleStop,
  Loader2,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  useAdminLocale,
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import { describeAdminApiFailure } from "@/lib/adminApiOutcome";
import { adminPromptRefinerShadowMessages } from "@/lib/adminMessages/promptRefinerShadow";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import {
  PROMPT_REFINER_SHADOW_EXECUTION_PATH,
  PROMPT_REFINER_SHADOW_OPERATOR_PATH,
  PROMPT_REFINER_SHADOW_RUN_PATH,
  PROMPT_REFINER_SHADOW_STAGE_PATH,
  parsePromptRefinerExecutionPreview,
  parsePromptRefinerExecutionResult,
  parsePromptRefinerRunPreview,
  parsePromptRefinerStagePreview,
  promptRefinerExecutionBody,
  promptRefinerRunApprovalBody,
  promptRefinerStageApprovalBody,
  type PromptRefinerExecutionPreview,
  type PromptRefinerExecutionResult,
  type PromptRefinerRunPreview,
  type PromptRefinerStagePreview,
} from "@/lib/promptRefinerShadowOperatorCore";

type Busy = "stage" | "run" | "execution" | "refresh" | null;
type FailureBody = { error?: string; code?: string };

const usd = (microUsd: number) => `US$${(microUsd / 1_000_000).toFixed(6)}`;

const responseJson = async (response: Response): Promise<unknown> =>
  response.json().catch(() => null);

const Field = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5">
    <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
      {label}
    </dt>
    <dd className="mt-1 min-w-0 break-all font-mono text-xs text-zinc-200">
      {value}
    </dd>
  </div>
);

const Step = ({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) => (
  <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
    <h2 className="text-lg font-bold text-white">{title}</h2>
    <p className="mt-1 text-sm leading-6 text-zinc-400">{description}</p>
    <div className="mt-5">{children}</div>
  </section>
);

export function AdminPromptRefinerShadowPanel() {
  const m = useAdminMessages(adminPromptRefinerShadowMessages);
  const { locale } = useAdminLocale();
  const [stage, setStage] = useState<PromptRefinerStagePreview | null>(null);
  const [run, setRun] = useState<PromptRefinerRunPreview | null>(null);
  const [execution, setExecution] =
    useState<PromptRefinerExecutionPreview | null>(null);
  const [lastExecution, setLastExecution] =
    useState<PromptRefinerExecutionResult | null>(null);
  const [busy, setBusy] = useState<Busy>("stage");
  const [error, setError] = useState<string | null>(null);
  const [reauthenticationRequired, setReauthenticationRequired] =
    useState(false);
  // Once an execution POST has no response or is refused, this mounted screen
  // cannot prove whether the provider boundary was crossed. A GET is allowed;
  // another POST is not. A successful, explicit `paused` response is the only
  // state that opens the continuation button again.
  const [executionPostLocked, setExecutionPostLocked] = useState(false);

  const failResponse = useCallback(
    (response: Response, body: unknown, fallback = m.requestFailed) => {
      const candidate =
        body && typeof body === "object" ? (body as FailureBody) : null;
      const failure = describeAdminApiFailure({
        status: response.status,
        error: candidate?.error,
        code: candidate?.code,
        fallback,
        locale,
      });
      setError(failure.message);
      setReauthenticationRequired(failure.requiresReauthentication);
      return failure.message;
    },
    [locale, m.requestFailed]
  );

  const readStage = useCallback(async () => {
    setError(null);
    setReauthenticationRequired(false);
    const response = await fetch(PROMPT_REFINER_SHADOW_STAGE_PATH, {
      cache: "no-store",
    });
    const body = await responseJson(response);
    if (!response.ok) {
      failResponse(response, body);
      return null;
    }
    const parsed = parsePromptRefinerStagePreview(body);
    if (!parsed) {
      setError(m.previewInvalid);
      return null;
    }
    setStage(parsed);
    return parsed;
  }, [failResponse, m.previewInvalid]);

  const readRun = useCallback(
    async (knownStage: PromptRefinerStagePreview) => {
      setError(null);
      setReauthenticationRequired(false);
      const response = await fetch(PROMPT_REFINER_SHADOW_RUN_PATH, {
        cache: "no-store",
      });
      const body = await responseJson(response);
      if (!response.ok) {
        failResponse(response, body);
        return null;
      }
      const parsed = parsePromptRefinerRunPreview(body, knownStage);
      if (!parsed) {
        setError(m.previewInvalid);
        return null;
      }
      setRun(parsed);
      return parsed;
    },
    [failResponse, m.previewInvalid]
  );

  const readExecution = useCallback(
    async (knownRun: PromptRefinerRunPreview) => {
      setError(null);
      setReauthenticationRequired(false);
      const response = await fetch(PROMPT_REFINER_SHADOW_EXECUTION_PATH, {
        cache: "no-store",
      });
      const body = await responseJson(response);
      if (!response.ok) {
        failResponse(response, body);
        return null;
      }
      const parsed = parsePromptRefinerExecutionPreview(body, knownRun);
      if (!parsed) {
        setError(m.responseInvalid);
        return null;
      }
      setExecution(parsed);
      return parsed;
    },
    [failResponse, m.responseInvalid]
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      void readStage()
        .catch(() => {
          if (active) setError(m.requestFailed);
        })
        .finally(() => {
          if (active) setBusy(null);
        });
    });
    return () => {
      active = false;
    };
  }, [m.requestFailed, readStage]);

  const approveStage = async () => {
    if (!stage || busy) return;
    setBusy("stage");
    setError(null);
    try {
      if (stage.status === "ready_for_explicit_cost_approval") {
        const response = await fetch(PROMPT_REFINER_SHADOW_STAGE_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(promptRefinerStageApprovalBody(stage)),
        });
        const body = await responseJson(response);
        if (!response.ok) {
          failResponse(response, body);
          return;
        }
        const returned =
          body && typeof body === "object"
            ? (body as { stage?: { deploymentId?: unknown; commitSha?: unknown } })
                .stage
            : null;
        if (
          returned?.deploymentId !== stage.deploymentId ||
          returned?.commitSha !== stage.commitSha
        ) {
          setError(m.responseInvalid);
          return;
        }
      }
      await readRun(stage);
    } catch {
      setError(m.requestFailed);
    } finally {
      setBusy(null);
    }
  };

  const approveRun = async () => {
    if (
      !stage ||
      !run ||
      busy ||
      (run.status === "ready_for_explicit_cost_approval" &&
        !run.approvalEnabled)
    ) {
      return;
    }
    setBusy("run");
    setError(null);
    try {
      if (run.status === "ready_for_explicit_cost_approval") {
        const response = await fetch(PROMPT_REFINER_SHADOW_RUN_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(promptRefinerRunApprovalBody(run)),
        });
        const body = await responseJson(response);
        if (!response.ok) {
          failResponse(response, body);
          return;
        }
        const returned =
          body && typeof body === "object"
            ? (body as { run?: { deploymentId?: unknown; commitSha?: unknown } })
                .run
            : null;
        if (
          returned?.deploymentId !== stage.deploymentId ||
          returned?.commitSha !== stage.commitSha
        ) {
          setError(m.responseInvalid);
          return;
        }
      }
      await readExecution(run);
    } catch {
      setError(m.requestFailed);
    } finally {
      setBusy(null);
    }
  };

  const execute = async () => {
    if (
      !execution ||
      busy ||
      !execution.enabled ||
      executionPostLocked ||
      execution.inFlightAttemptId ||
      execution.status === "completed" ||
      execution.status === "stopped_unknown"
    ) {
      return;
    }
    setBusy("execution");
    setError(null);
    setExecutionPostLocked(true);
    let parsed: PromptRefinerExecutionResult | null = null;
    try {
      const response = await fetch(PROMPT_REFINER_SHADOW_EXECUTION_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promptRefinerExecutionBody(execution)),
      });
      const body = await responseJson(response);
      if (!response.ok) {
        const failure = failResponse(response, body);
        setError(`${failure} ${m.postFailureStop}`);
        setBusy(null);
        return;
      }
      parsed = parsePromptRefinerExecutionResult(body);
      if (!parsed) {
        setError(m.responseInvalid);
        setBusy(null);
        return;
      }
      setLastExecution(parsed);
    } catch {
      setError(m.transportUnknown);
      setBusy(null);
      return;
    }

    try {
      const refreshed = await readExecution(run!);
      if (refreshed && parsed?.status === "paused") {
        setExecutionPostLocked(false);
      }
    } catch {
      setError(m.statusRefreshFailed);
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    if (busy) return;
    setBusy("refresh");
    try {
      if (execution && run) await readExecution(run);
      else if (run && stage) await readRun(stage);
      else await readStage();
    } catch {
      setError(m.requestFailed);
    } finally {
      setBusy(null);
    }
  };

  const terminal =
    execution?.status === "completed" ||
    execution?.status === "stopped_unknown";
  const canExecute =
    Boolean(execution?.enabled) &&
    !terminal &&
    !execution?.inFlightAttemptId &&
    !executionPostLocked;

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="prompt-refiner-shadow-operator">
      <section className="rounded-3xl border border-blue-500/20 bg-gradient-to-br from-blue-500/10 via-zinc-950 to-zinc-950 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
              {m.eyebrow}
            </p>
            <h1 className="mt-2 text-2xl font-black text-white">{m.title}</h1>
            <p className="mt-3 text-sm leading-6 text-zinc-300">{m.description}</p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy !== null}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-bold text-zinc-200 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "refresh" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            {m.refresh}
          </button>
        </div>
        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-100">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <p>{m.boundary}</p>
        </div>
      </section>

      {error ? (
        <div role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm leading-6 text-red-100">
          <p>{error}</p>
          {reauthenticationRequired ? (
            <Link
              href={adminRecentAuthenticationHref(
                PROMPT_REFINER_SHADOW_OPERATOR_PATH
              )}
              className="mt-2 inline-flex min-h-11 items-center font-bold text-red-50 underline underline-offset-4"
            >
              {m.reauthenticate}
            </Link>
          ) : null}
        </div>
      ) : null}

      {!stage && busy === "stage" ? (
        <div role="status" className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/70 px-4 py-4 text-sm text-zinc-300">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {m.loading}
        </div>
      ) : null}

      {stage ? (
        <Step title={m.stageTitle} description={m.stageBody}>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label={m.status} value={stage.status} />
            <Field label={m.deployment} value={stage.deploymentId} />
            <Field label={m.commit} value={stage.commitSha} />
            <Field
              label={m.approvalWindow}
              value={`${stage.approvalTtlMinutes} min`}
            />
            <Field
              label={m.perRequestCeiling}
              value={usd(stage.perRequestCostMicroUsd)}
            />
            <Field
              label={m.stageCeiling}
              value={usd(stage.costCeilingMicroUsd)}
            />
            <Field label={m.maxReservations} value={stage.maxReservations} />
          </dl>
          {!run ? (
            <button
              type="button"
              onClick={() => void approveStage()}
              disabled={busy !== null}
              className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "stage" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <LockKeyhole className="h-4 w-4" aria-hidden />
              )}
              {stage.status === "already_exists"
                ? m.continueToRun
                : m.approveStage}
            </button>
          ) : null}
        </Step>
      ) : null}

      {run ? (
        <Step title={m.runTitle} description={m.runBody}>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label={m.status} value={run.status} />
            <Field label={m.model} value={`${run.provider}/${run.modelId}`} />
            <Field label={m.runCeiling} value={usd(run.costCeilingMicroUsd)} />
            <Field label={m.maxDispatches} value={run.maxDispatches} />
            <Field label={m.retryCount} value={run.retryCount} />
            <Field label={m.timeout} value={`${run.timeoutMs} ms`} />
            <Field
              label={m.approvalFlag}
              value={run.approvalEnabled ? m.enabled : m.disabled}
            />
          </dl>
          {!run.approvalEnabled &&
          run.status === "ready_for_explicit_cost_approval" ? (
            <p className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              {m.runApprovalFlagDisabled}
            </p>
          ) : null}
          {!execution ? (
            <button
              type="button"
              onClick={() => void approveRun()}
              disabled={
                busy !== null ||
                (run.status === "ready_for_explicit_cost_approval" &&
                  !run.approvalEnabled)
              }
              className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "run" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <LockKeyhole className="h-4 w-4" aria-hidden />
              )}
              {run.status === "already_exists"
                ? m.continueToExecution
                : m.approveRun}
            </button>
          ) : null}
        </Step>
      ) : null}

      {execution ? (
        <Step title={m.executionTitle} description={m.executionBody}>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label={m.status} value={execution.status} />
            <Field label={m.dispatches} value={execution.dispatchCount} />
            <Field label={m.terminals} value={execution.terminalCount} />
            <Field
              label={m.nextCase}
              value={execution.nextCaseId || m.none}
            />
            <Field
              label={m.inFlight}
              value={execution.inFlightAttemptId || m.none}
            />
            <Field label={m.expires} value={execution.approvalExpiresAt} />
            <Field
              label={m.executionFlag}
              value={execution.enabled ? m.enabled : m.disabled}
            />
            {execution.evidence ? (
              <>
                <Field
                  label={m.evidenceGate}
                  value={execution.evidence.gateOutcome}
                />
                <Field
                  label={m.evidenceCases}
                  value={`${execution.evidence.summary.passedCases}/16`}
                />
                <Field
                  label={m.evidenceCost}
                  value={
                    execution.evidence.summary.totalCostMicroUsd === null
                      ? m.none
                      : usd(execution.evidence.summary.totalCostMicroUsd)
                  }
                />
                <Field
                  label={m.evidenceLatency}
                  value={`${execution.evidence.summary.latencyP90Ms ?? m.none} / ${execution.evidence.summary.latencyMaxMs ?? m.none} ms`}
                />
              </>
            ) : null}
          </dl>

          {execution.status === "completed" ? (
            <p className="mt-5 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden />
              {m.completed}
            </p>
          ) : null}
          {execution.status === "stopped_unknown" ? (
            <p className="mt-5 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              <CircleStop className="h-5 w-5 shrink-0" aria-hidden />
              {m.stoppedUnknown}
            </p>
          ) : null}
          {!execution.enabled && !terminal ? (
            <p className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              {m.executionFlagDisabled}
            </p>
          ) : null}
          {lastExecution ? (
            <p className="mt-4 font-mono text-xs text-zinc-400">
              {lastExecution.status} · {lastExecution.attemptedThisInvocation} · {lastExecution.dispatchCount}/{lastExecution.terminalCount}
            </p>
          ) : null}

          {!terminal ? (
            <button
              type="button"
              onClick={() => void execute()}
              disabled={busy !== null || !canExecute}
              className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "execution" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
              {busy === "execution"
                ? m.working
                : execution.status === "running"
                  ? m.resume
                  : m.execute}
            </button>
          ) : null}
        </Step>
      ) : null}
    </div>
  );
}
