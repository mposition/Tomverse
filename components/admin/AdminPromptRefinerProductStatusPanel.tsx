"use client";

import { CheckCircle2, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { AdminPromptRefinerAutoResumeControl } from
  "@/components/admin/AdminPromptRefinerAutoResumeControl";

import {
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import { adminFetch, isAdminFetchAbort } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from
  "@/lib/adminReauthenticationCore";
import { adminPromptRefinerProductStatusMessages } from
  "@/lib/adminMessages/promptRefinerProductStatus";
import {
  CHAT_REFINER_INITIAL_AUTO_ACTIVATION_CONFIRMATION,
  CHAT_REFINER_INITIAL_AUTO_ACTIVATION_PATH,
  CHAT_REFINER_INITIAL_AUTO_ROLLOUT_CONFIRMATIONS,
  CHAT_REFINER_INITIAL_AUTO_ROLLOUT_PATH,
  chatRefinerInitialAutoEvidenceRefsSchema,
  chatRefinerInitialAutoActivationResponseSchema,
  chatRefinerInitialAutoRolloutResponseSchema,
} from "@/lib/chatRefinerInitialAutoReleaseApiContract";
import {
  PROMPT_REFINER_PRODUCT_STATUS_PATH,
  parsePromptRefinerProductStatus,
  type PromptRefinerProductStatus,
} from "@/lib/promptRefinerProductStatusContract";

type Failure = "request_failed" | "invalid_response" | null;
type MutationKind = "activate" | "enable" | "disable";
const ADMIN_PATH = "/admin/prompt-refiner-shadow";
const GUEST_CHAT_AUTO_ACTIVATION_PATH =
  "/api/admin/prompt-refiner/guest-chat-auto-activation";
const GUEST_CHAT_AUTO_ACTIVATION_CONFIRMATION =
  "ACTIVATE_EXACT_GUEST_CHAT_SMART_ADAPTIVE_DEPLOYMENT";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const guestChatAutoReleaseSchema = z.object({
  state: z.literal("active"),
  binding: z.object({
    runtimeCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
    runtimeDeploymentId: z.string().uuid(),
    configDigest: sha256Schema,
    baseRouterConfigDigest: sha256Schema,
    promptRefinerCandidateDigest: sha256Schema,
    promptRefinerPricePinDigest: sha256Schema,
    promptRefinerAdapterConfigDigest: sha256Schema,
  }).strict(),
  activationAuditLogId: z.string().min(1).max(240),
  activationPairDigest: sha256Schema,
  baseRouterActivationAuditLogId: z.string().min(1).max(240),
  baseProductActivationAuditLogId: z.string().min(1).max(240),
  actorUserId: z.string().min(1).max(240),
  approvedAt: z.string().datetime(),
}).strict();
const guestChatAutoReadbackSchema = z.object({
  release: guestChatAutoReleaseSchema.nullable(),
}).strict();
const guestChatAutoActivationResponseSchema = z.object({
  releaseKind: z.literal("guest_chat_smart_adaptive_v1"),
  activationAuditLogId: z.string().min(1).max(240),
  activationPairDigest: sha256Schema,
  runtimeCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  runtimeDeploymentId: z.string().uuid(),
  rolloutChanged: z.literal(false),
}).strict();

export type GuestChatAutoRelease = z.infer<typeof guestChatAutoReleaseSchema>;
type GuestChatAutoActivationResponse =
  z.infer<typeof guestChatAutoActivationResponseSchema>;
type GuestReadState = "loading" | "absent" | "active" | "unavailable" | "mismatch";
type GuestMutationResult =
  | "confirmed"
  | "confirmed_by_readback"
  | "failed"
  | "reauth"
  | "unknown"
  | "runtime_changed"
  | null;

export function parseGuestChatAutoReleaseReadback(value: unknown) {
  return guestChatAutoReadbackSchema.safeParse(value);
}

export function guestChatAutoReleaseMatches(
  release: GuestChatAutoRelease,
  runtime: { runtimeCommitSha: string; runtimeDeploymentId: string },
  expected?: Pick<GuestChatAutoActivationResponse,
    "activationAuditLogId" | "activationPairDigest">,
) {
  return release.binding.runtimeCommitSha === runtime.runtimeCommitSha &&
    release.binding.runtimeDeploymentId === runtime.runtimeDeploymentId &&
    (!expected || (
      release.activationAuditLogId === expected.activationAuditLogId &&
      release.activationPairDigest === expected.activationPairDigest
    ));
}

export function guestChatAutoActivationDisabled(input: {
  confirmed: boolean;
  hasExactRuntime: boolean;
  readState: GuestReadState;
  pending: boolean;
  postAttempted: boolean;
}) {
  return !input.confirmed || !input.hasExactRuntime ||
    input.readState !== "absent" || input.pending || input.postAttempted;
}

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
      <StatusField label={m.releaseKind} value={snapshot.release.releaseKind ?? m.unknown} />
      <StatusField label={m.routerExceptionApproval}
        value={snapshot.release.routerExceptionAuditLogId ?? m.unknown} />
      <StatusField label={m.router} value={snapshot.router.ready ? m.ready : m.pending} />
      <StatusField label={m.outstanding} value={snapshot.router.outstanding.join(", ") || m.none} />
      <StatusField label={m.problems} value={snapshot.router.problems.join("; ") || m.none} />
      <StatusField label={m.completion} value={m.notEstablished} />
    </dl>
  );
}

export function AdminChatRefinerInitialAutoReleaseControls({ snapshot, onRefresh,
  messages: m }: {
  snapshot: PromptRefinerProductStatus;
  onRefresh: () => Promise<void>;
  messages: typeof adminPromptRefinerProductStatusMessages.en;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<MutationKind | null>(null);
  const [result, setResult] = useState<"success" | "failed" | "reauth" | null>(null);
  const [evidenceRefs, setEvidenceRefs] = useState({
    independentReviewJobId: "",
    validationSealSha256: "",
    deploymentReadbackSha256: "",
  });
  const runtime = snapshot.serving.commitSha && snapshot.serving.deploymentId
    ? { runtimeCommitSha: snapshot.serving.commitSha,
      runtimeDeploymentId: snapshot.serving.deploymentId }
    : null;

  const mutate = async (kind: MutationKind) => {
    if (!confirmed || !runtime || pending) return;
    setPending(kind);
    setResult(null);
    const activation = kind === "activate";
    const body = activation
      ? { releaseKind: "initial_auto_v1", ...runtime,
        evidenceRefs,
        confirmation: CHAT_REFINER_INITIAL_AUTO_ACTIVATION_CONFIRMATION }
      : { enabled: kind === "enable", ...runtime,
        confirmation: kind === "enable"
          ? CHAT_REFINER_INITIAL_AUTO_ROLLOUT_CONFIRMATIONS.enabled
          : CHAT_REFINER_INITIAL_AUTO_ROLLOUT_CONFIRMATIONS.disabled };
    try {
      const response = await adminFetch(activation
        ? CHAT_REFINER_INITIAL_AUTO_ACTIVATION_PATH
        : CHAT_REFINER_INITIAL_AUTO_ROLLOUT_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 428 ||
          (payload as { code?: unknown } | null)?.code ===
            "ADMIN_REAUTHENTICATION_REQUIRED") {
        setConfirmed(false);
        setResult("reauth");
        return;
      }
      const valid = activation
        ? chatRefinerInitialAutoActivationResponseSchema.safeParse(payload).success
        : chatRefinerInitialAutoRolloutResponseSchema.safeParse(payload).success;
      if (!response.ok || !valid) {
        setConfirmed(false);
        setResult("failed");
        return;
      }
      setConfirmed(false);
      setResult("success");
      await onRefresh();
    } catch {
      setConfirmed(false);
      setResult("failed");
    } finally {
      setPending(null);
    }
  };

  const evidenceReady = chatRefinerInitialAutoEvidenceRefsSchema
    .safeParse(evidenceRefs).success;
  const disabled = !confirmed || !runtime || !snapshot.serving.exactProductIdentity ||
    pending !== null;
  return (
    <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4"
      data-testid="prompt-refiner-initial-auto-controls">
      <h3 className="text-sm font-bold text-white">{m.activationTitle}</h3>
      <p className="mt-1 text-sm leading-6 text-zinc-400">{m.activationDescription}</p>
      <label className="mt-3 flex items-start gap-3 text-sm text-zinc-200">
        <input type="checkbox" checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-1 h-4 w-4" />
        <span>{m.confirmLabel}</span>
      </label>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {([
          ["independentReviewJobId", m.reviewJobId],
          ["validationSealSha256", m.validationSeal],
          ["deploymentReadbackSha256", m.deploymentReadback],
        ] as const).map(([key, label]) => <label key={key}
          className="text-xs font-semibold text-zinc-300">
          {label}
          <input value={evidenceRefs[key]}
            onChange={(event) => setEvidenceRefs((current) => ({
              ...current, [key]: event.target.value.trim().toLowerCase(),
            }))}
            autoComplete="off" spellCheck={false}
            className="mt-1 min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100" />
        </label>)}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={disabled || !evidenceReady ||
          snapshot.release.releaseKind !== null}
          onClick={() => void mutate("activate")}
          className="min-h-11 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-50">
          {m.activate}
        </button>
        <button type="button" disabled={disabled ||
          snapshot.controls.rollout === "enabled" ||
          snapshot.release.releaseKind !== "initial_auto_v1"}
          onClick={() => void mutate("enable")}
          className="min-h-11 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-50">
          {m.enableRollout}
        </button>
        <button type="button" disabled={disabled ||
          snapshot.controls.rollout === "disabled"}
          onClick={() => void mutate("disable")}
          className="min-h-11 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-50">
          {m.disableRollout}
        </button>
      </div>
      {pending ? <p role="status" className="mt-3 text-sm text-zinc-400">
        {m.mutationPending}
      </p> : null}
      {result === "success" ? <p role="status" className="mt-3 text-sm text-emerald-200">
        {m.mutationSucceeded}
      </p> : null}
      {result === "failed" ? <p role="alert" className="mt-3 text-sm text-red-200">
        {m.mutationFailed}
      </p> : null}
      {result === "reauth" ? <a
        href={adminRecentAuthenticationHref(ADMIN_PATH)}
        className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-red-100 underline underline-offset-4">
        {m.reauthenticate}
      </a> : null}
    </div>
  );
}

export function AdminGuestChatSmartAdaptiveActivationControl({ snapshot,
  onRefresh, messages: m }: {
  snapshot: PromptRefinerProductStatus;
  onRefresh: () => Promise<void>;
  messages: typeof adminPromptRefinerProductStatusMessages.en;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [postAttempted, setPostAttempted] = useState(false);
  const [readState, setReadState] = useState<GuestReadState>("loading");
  const [release, setRelease] = useState<GuestChatAutoRelease | null>(null);
  const [result, setResult] = useState<GuestMutationResult>(null);
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const mutationInFlight = useRef(false);
  const runtime = useMemo(() =>
    snapshot.serving.commitSha && snapshot.serving.deploymentId
      ? { runtimeCommitSha: snapshot.serving.commitSha,
        runtimeDeploymentId: snapshot.serving.deploymentId }
      : null,
  [snapshot.serving.commitSha, snapshot.serving.deploymentId]);

  const applyReadback = useCallback((value: unknown,
    expectedRuntime: typeof runtime) => {
    const parsed = parseGuestChatAutoReleaseReadback(value);
    if (!parsed.success) {
      setRelease(null);
      setReadState("unavailable");
      return null;
    }
    if (!parsed.data.release) {
      setRelease(null);
      setReadState("absent");
      return parsed.data;
    }
    setRelease(parsed.data.release);
    setReadState(expectedRuntime && guestChatAutoReleaseMatches(
      parsed.data.release, expectedRuntime) ? "active" : "mismatch");
    return parsed.data;
  }, []);

  const readGuestRelease = useCallback(async (
    expectedRuntime: typeof runtime,
    signal?: AbortSignal,
  ) => {
    const response = await adminFetch(GUEST_CHAT_AUTO_ACTIVATION_PATH, {
      cache: "no-store",
      signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      setRelease(null);
      setReadState("unavailable");
      return null;
    }
    return applyReadback(body, expectedRuntime);
  }, [applyReadback]);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setReadState("loading");
    try {
      const readback = await readGuestRelease(runtime, controller.signal);
      if (readback?.release && runtime &&
          guestChatAutoReleaseMatches(readback.release, runtime)) {
        setResult((current) => current === "unknown" || current === "failed"
          ? "confirmed_by_readback"
          : current);
      }
    } catch (error) {
      if (generation === requestGeneration.current &&
          !isAdminFetchAbort(error)) {
        setRelease(null);
        setReadState("unavailable");
      }
    }
  }, [readGuestRelease, runtime]);

  useEffect(() => {
    queueMicrotask(() => void load());
    return () => {
      requestGeneration.current += 1;
      activeRequest.current?.abort();
    };
  }, [load]);

  const activate = async () => {
    if (mutationInFlight.current) return;
    if (guestChatAutoActivationDisabled({ confirmed,
      hasExactRuntime: Boolean(runtime && snapshot.serving.exactProductIdentity),
      readState, pending, postAttempted })) return;
    mutationInFlight.current = true;
    setPending(true);
    setResult(null);
    setConfirmed(false);
    let writeIssued = false;
    try {
      const statusResponse = await adminFetch(
        PROMPT_REFINER_PRODUCT_STATUS_PATH, { cache: "no-store" });
      const statusBody = await statusResponse.json().catch(() => null);
      const freshSnapshot = statusResponse.ok
        ? parsePromptRefinerProductStatus(statusBody)
        : null;
      const freshRuntime = freshSnapshot?.serving.commitSha &&
          freshSnapshot.serving.deploymentId
        ? { runtimeCommitSha: freshSnapshot.serving.commitSha,
          runtimeDeploymentId: freshSnapshot.serving.deploymentId }
        : null;
      if (!freshSnapshot?.serving.exactProductIdentity || !freshRuntime ||
          !runtime || freshRuntime.runtimeCommitSha !== runtime.runtimeCommitSha ||
          freshRuntime.runtimeDeploymentId !== runtime.runtimeDeploymentId) {
        setResult("runtime_changed");
        await onRefresh();
        return;
      }

      const preflight = await readGuestRelease(freshRuntime);
      if (!preflight) {
        setResult("failed");
        return;
      }
      if (preflight.release) {
        setResult(guestChatAutoReleaseMatches(preflight.release, freshRuntime)
          ? "confirmed_by_readback" : "runtime_changed");
        await onRefresh();
        return;
      }

      writeIssued = true;
      setPostAttempted(true);
      let activationResponse: GuestChatAutoActivationResponse | null = null;
      let responseStatus: number | null = null;
      let responseCode: string | null = null;
      try {
        const response = await adminFetch(GUEST_CHAT_AUTO_ACTIVATION_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...freshRuntime,
            confirmation: GUEST_CHAT_AUTO_ACTIVATION_CONFIRMATION }),
        });
        responseStatus = response.status;
        const body = await response.json().catch(() => null);
        responseCode = typeof (body as { code?: unknown } | null)?.code === "string"
          ? (body as { code: string }).code
          : null;
        const parsed = guestChatAutoActivationResponseSchema.safeParse(body);
        if (response.ok && parsed.success) activationResponse = parsed.data;
      } catch {
        // A transport error after the POST is an unknown outcome. The single
        // read below is verification, never a retry of the write.
      }

      if (responseStatus === 428 ||
          responseCode === "ADMIN_REAUTHENTICATION_REQUIRED") {
        setPostAttempted(false);
        setResult("reauth");
        return;
      }

      let readback: Awaited<ReturnType<typeof readGuestRelease>> = null;
      try {
        readback = await readGuestRelease(freshRuntime);
      } catch {
        setRelease(null);
        setReadState("unavailable");
      }
      if (readback?.release && guestChatAutoReleaseMatches(
        readback.release, freshRuntime, activationResponse ?? undefined)) {
        setResult(activationResponse ? "confirmed" : "confirmed_by_readback");
        await onRefresh();
        return;
      }
      setResult(responseStatus && responseStatus < 500 ? "failed" : "unknown");
    } catch {
      setResult(writeIssued ? "unknown" : "failed");
    } finally {
      mutationInFlight.current = false;
      setPending(false);
    }
  };

  const disabled = guestChatAutoActivationDisabled({ confirmed,
    hasExactRuntime: Boolean(runtime && snapshot.serving.exactProductIdentity),
    readState, pending, postAttempted });

  return (
    <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4"
      data-testid="guest-chat-smart-adaptive-activation-control">
      <h3 className="text-sm font-bold text-white">{m.guestActivationTitle}</h3>
      <p className="mt-1 text-sm leading-6 text-zinc-400">
        {m.guestActivationDescription}
      </p>
      <p className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs leading-5 text-zinc-300">
        {m.guestActivationScope}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void load()} disabled={pending || readState === "loading"}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-semibold text-zinc-200 disabled:opacity-50"
          data-testid="guest-chat-smart-adaptive-readback-refresh">
          {readState === "loading"
            ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            : <RefreshCw className="h-4 w-4" aria-hidden />}
          {m.guestActivationRefresh}
        </button>
        <span role="status" className="text-xs text-zinc-400"
          data-testid="guest-chat-smart-adaptive-readback-state">
          {readState === "loading" ? m.guestActivationLoading
            : readState === "active" ? m.guestActivationActive
              : readState === "absent" ? m.guestActivationAbsent
                : readState === "mismatch" ? m.guestActivationMismatch
                  : m.guestActivationUnreadable}
        </span>
      </div>

      {release && readState === "active" ? (
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          <StatusField label={m.guestActivationAudit}
            value={release.activationAuditLogId} />
          <StatusField label={m.guestActivationPair}
            value={release.activationPairDigest} />
          <StatusField label={m.commit}
            value={release.binding.runtimeCommitSha} />
          <StatusField label={m.deployment}
            value={release.binding.runtimeDeploymentId} />
          <StatusField label={m.guestActivationApprovedAt}
            value={release.approvedAt} />
        </dl>
      ) : null}

      <label className="mt-3 flex items-start gap-3 text-sm text-zinc-200">
        <input type="checkbox" checked={confirmed}
          disabled={readState !== "absent" || pending || postAttempted}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-1 h-4 w-4" />
        <span>{m.guestActivationConfirm}</span>
      </label>
      <button type="button" disabled={disabled}
        onClick={() => void activate()}
        className="mt-4 min-h-11 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-50"
        data-testid="guest-chat-smart-adaptive-activate">
        {pending ? m.guestActivationSaving : m.guestActivationAction}
      </button>

      {result === "confirmed" || result === "confirmed_by_readback" ? (
        <p role="status" className="mt-3 flex items-start gap-2 text-sm text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {result === "confirmed" ? m.guestActivationConfirmed
            : m.guestActivationConfirmedByReadback}
        </p>
      ) : null}
      {result === "runtime_changed" ? (
        <p role="alert" className="mt-3 text-sm text-amber-100">
          {m.guestActivationRuntimeChanged}
        </p>
      ) : null}
      {result === "failed" || result === "unknown" ? (
        <p role="alert" className="mt-3 text-sm text-red-200">
          {result === "unknown" ? m.guestActivationUnknown
            : m.guestActivationFailed}
        </p>
      ) : null}
      {result === "reauth" ? (
        <a href={adminRecentAuthenticationHref(ADMIN_PATH)}
          className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-red-100 underline underline-offset-4">
          {m.reauthenticate}
        </a>
      ) : null}
    </div>
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

      {snapshot ? <>
        <AdminPromptRefinerProductStatusReadback snapshot={snapshot} messages={m} />
        <AdminChatRefinerInitialAutoReleaseControls
          snapshot={snapshot} onRefresh={load} messages={m} />
        <AdminGuestChatSmartAdaptiveActivationControl
          snapshot={snapshot} onRefresh={load} messages={m} />
        <AdminPromptRefinerAutoResumeControl
          snapshot={snapshot} onRefresh={load} messages={m} />
      </> : null}
    </section>
  );
}
