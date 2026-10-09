"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { AmuxAnalysisBudgetPanel } from "@/components/admin/AmuxAnalysisBudgetPanel";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { readAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import {
  classifyFrontierRegistrationReadFailure,
  classifyFrontierRegistrationPost,
  clearFrontierRegistrationReceipt,
  decideFrontierRegistrationRestart,
  readAvailableFrontierModels,
  readCheckedFrontierSelection,
  readFrontierCatalogApprovalReadBack,
  readFrontierRegistrationReceipt,
  reduceFrontierRegistrationPost,
  reserveFrontierRegistrationReceipt,
  type AvailableFrontierModel,
  type PendingFrontierCatalogApproval,
} from "@/lib/amux/ideaFrontierCatalogUiCore";
import {
  readPreparedIdeaTransferPreview, readPreviewReceipt, reservePreviewReceipt,
  type PreparedIdeaTransferPreview,
} from "@/lib/amux/ideaTransferPreviewUiCore";
import {
  clearRefusedConfirmationAttempt, readConfirmedIdeaTransfer, readConfirmationAttempt,
  readConfirmationAttemptForPreview, reserveConfirmationAttempt,
  type ConfirmedIdeaTransfer,
} from "@/lib/amux/ideaTransferConfirmationUiCore";

type PreviewState =
  | { kind: "idle" | "pending" | "unknown" | "expired" | "confirmed" | "recovery_unavailable" }
  | { kind: "prepared"; value: PreparedIdeaTransferPreview };
type ConfirmState =
  | { kind: "idle" | "pending" | "unknown" | "expired" | "refused" }
  | { kind: "confirmed"; value: ConfirmedIdeaTransfer };
type RegistrationState = "idle" | "pending" | "unknown" | "not_visible" |
  "approved" | "revoked" | "recovery_unavailable";

const FRONTIER_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const FRONTIER_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const FRONTIER_VERSION = /^(0|[1-9]\d{0,8})$/;

const receiptStore = (): Storage | null => {
  try { return window.sessionStorage; } catch { return null; }
};

export function AmuxFrontierModelsPanel({ available, writeAvailable, previewAvailable, confirmAvailable,
  analysisBudgetAvailable, ideaId, planReady,
  declaredExternalSources, operatorId, chunkIndex = 0 }: {
  available: boolean; writeAvailable: boolean;
  previewAvailable: boolean; confirmAvailable: boolean;
  analysisBudgetAvailable: boolean;
  ideaId: string | null;
  planReady: boolean; declaredExternalSources: boolean; operatorId: string;
  chunkIndex?: number;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
  const { locale } = useAdminLocale();
  const [models, setModels] = useState<AvailableFrontierModel[] | null>(null);
  const [loading, setLoading] = useState(available);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [registrationProvider, setRegistrationProvider] =
    useState<"openai" | "anthropic">("openai");
  const [registrationModelId, setRegistrationModelId] = useState("");
  const [registrationEfforts, setRegistrationEfforts] = useState<string[]>([]);
  const [registrationVersion, setRegistrationVersion] = useState("0");
  const [registrationConfirmed, setRegistrationConfirmed] = useState(false);
  const [registrationRecoveryChecked, setRegistrationRecoveryChecked] = useState(false);
  const [registrationState, setRegistrationState] = useState<RegistrationState>("idle");
  const [pendingRegistration, setPendingRegistration] =
    useState<PendingFrontierCatalogApproval | null>(null);
  const [registrationFailure, setRegistrationFailure] = useState<AdminApiFailure | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const [confirmation, setConfirmation] = useState<ConfirmState>({ kind: "idle" });
  const selected = models?.find((model) => model.approvalId === selectedApprovalId);

  const readConfirmation = useCallback(async (pendingId: string,
    expectedIdeaId: string, expectedDigest: string, expectedDigestKeyId: string) => {
    const report = (next: ConfirmState) => setConfirmation((current) =>
      current.kind === "confirmed" ? current : next);
    try {
      const query = new URLSearchParams({ previewId: pendingId });
      const response = await adminFetch(`/api/admin/amux/ideas/transfer-confirmation?${query}`,
        { cache: "no-store" });
      if (!response.ok) { report({ kind: "unknown" }); return; }
      const body: unknown = await response.json();
      const parsed = readConfirmedIdeaTransfer(response.status, body, pendingId,
        expectedIdeaId, expectedDigest, expectedDigestKeyId);
      if (parsed) {
        report({ kind: "confirmed", value: parsed });
        setPreview((current) => current.kind === "prepared" ? current : { kind: "confirmed" });
      } else if (body && typeof body === "object" &&
                 (body as Record<string, unknown>).state === "expired") {
        report({ kind: "expired" });
      } else { report({ kind: "unknown" }); }
    } catch { report({ kind: "unknown" }); }
  }, []);

  const readBack = useCallback(async (pendingId: string, model: AvailableFrontierModel,
    effort: string) => {
    try {
      const query = new URLSearchParams({ previewId: pendingId });
      const response = await adminFetch(`/api/admin/amux/ideas/transfer-preview?${query}`,
        { cache: "no-store" });
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response.clone(), {
          fallback: m.transferPreviewUnknown, locale,
        }));
        setPreview({ kind: "unknown" });
        return;
      }
      const body: unknown = await response.json();
      if (response.ok && body && typeof body === "object" &&
          (body as Record<string, unknown>).state === "expired") {
        setPreview({ kind: "expired" });
        return;
      }
      const parsed = readPreparedIdeaTransferPreview(response.status, body, pendingId, ideaId ?? "",
        model, effort, chunkIndex);
      if (parsed) {
        setPreview({ kind: "prepared", value: parsed });
        if (confirmAvailable) {
          const attempt = readConfirmationAttempt(receiptStore(), operatorId, pendingId,
            ideaId ?? "", parsed.payloadDigest, parsed.payloadDigestKeyId);
          if (attempt === "present") {
            setConfirmation({ kind: "pending" });
            await readConfirmation(pendingId, ideaId ?? "", parsed.payloadDigest,
              parsed.payloadDigestKeyId);
          } else if (attempt === "unavailable") {
            setConfirmation({ kind: "unknown" });
          }
        }
        return;
      }
      if (confirmAvailable && body && typeof body === "object" &&
          (body as Record<string, unknown>).state === "unavailable") {
        const attempt = readConfirmationAttemptForPreview(receiptStore(), operatorId,
          pendingId, ideaId ?? "");
        if (attempt.kind === "present") {
          setPreview({ kind: "unknown" });
          setConfirmation({ kind: "pending" });
          await readConfirmation(pendingId, ideaId ?? "", attempt.payloadDigest,
            attempt.payloadDigestKeyId);
        } else {
          setPreview({ kind: attempt.kind === "unavailable" ?
            "recovery_unavailable" : "unknown" });
        }
        return;
      }
      setPreview({ kind: "unknown" });
    } catch { setPreview({ kind: "unknown" }); }
  }, [chunkIndex, confirmAvailable, ideaId, locale, m.transferPreviewUnknown,
    operatorId, readConfirmation]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!available) return;
    try {
      const response = await adminFetch("/api/admin/amux/ideas/frontier-models?mode=available",
        { cache: "no-store", signal });
      if (!response.ok) {
        const reason = await readAdminApiFailure(response, { fallback: m.frontierModelsUnavailable, locale });
        if (!signal?.aborted) { setModels(null); setFailure(reason); }
        return;
      }
      const parsed = readAvailableFrontierModels(response.status, await response.json());
      if (!signal?.aborted) {
        if (parsed === null) {
          setModels(null);
          setFailure({ message: m.frontierModelsInvalid, tone: "error",
            requiresReauthentication: false, approvalId: null });
        } else { setFailure(null); setModels(parsed); }
      }
    } catch {
      if (!signal?.aborted) {
        setModels(null);
        setFailure({ message: m.frontierModelsUnavailable, tone: "error",
          requiresReauthentication: false, approvalId: null });
      }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [available, locale, m.frontierModelsUnavailable, m.frontierModelsInvalid]);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load(controller.signal);
    });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!ideaId || !previewAvailable) return;
    const receipt = readPreviewReceipt(receiptStore(), operatorId, ideaId,
      chunkIndex);
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (receipt.kind === "present") {
        setPreview({ kind: "pending" });
        void readBack(receipt.previewId, receipt.model, receipt.effort);
      } else if (receipt.kind === "unavailable") {
        setPreview({ kind: "recovery_unavailable" });
      }
    });
    return () => { active = false; };
  }, [chunkIndex, ideaId, operatorId, previewAvailable, readBack]);

  const refresh = () => {
    setLoading(true);
    setFailure(null);
    setModels(null);
    setSelectedApprovalId("");
    setSelectedEffort("");
    setChecked(false);
    void load();
  };

  const registrationVersionValue = FRONTIER_VERSION.test(registrationVersion)
    ? Number(registrationVersion) : null;
  const registrationInputValid = FRONTIER_MODEL_ID.test(registrationModelId.trim()) &&
    registrationEfforts.length > 0 && registrationVersionValue !== null &&
    registrationVersionValue <= 999_999_999;
  const registrationLocked = !writeAvailable || !registrationRecoveryChecked ||
    registrationState !== "idle";

  const toggleRegistrationEffort = (effort: string, checked: boolean) => {
    setRegistrationEfforts((current) => FRONTIER_EFFORTS.filter((candidate) =>
      candidate === effort ? checked : current.includes(candidate)));
    setRegistrationConfirmed(false);
  };

  const applyRegistrationPost = (
    decision: ReturnType<typeof classifyFrontierRegistrationPost>,
    registration: PendingFrontierCatalogApproval,
  ) => {
    const transition = reduceFrontierRegistrationPost(decision, registration);
    if (transition.receipt === "clear") {
      clearFrontierRegistrationReceipt(receiptStore(), operatorId, registration.approvalId);
    }
    setRegistrationState(transition.state);
    setPendingRegistration(transition.pendingRegistration);
    setRegistrationConfirmed(transition.registrationConfirmed);
    if (!transition.failure) {
      setRegistrationFailure(null);
      return transition.state === "approved" || transition.state === "revoked";
    }
    const message = transition.failure.kind === "reauthentication"
      ? m.frontierRegistrationReauthentication
      : transition.failure.kind === "refused"
        ? m.frontierRegistrationRefused(transition.failure.code ?? "unknown")
        : m.frontierRegistrationUnknown;
    setRegistrationFailure({ message, tone: "error",
      requiresReauthentication: transition.failure.kind === "reauthentication",
      approvalId: transition.failure.approvalId });
    return false;
  };

  const registerModel = async () => {
    if (!writeAvailable || !registrationRecoveryChecked || registrationState !== "idle" ||
        !registrationConfirmed || !registrationInputValid ||
        registrationVersionValue === null) return;
    const registration: PendingFrontierCatalogApproval = {
      approvalId: crypto.randomUUID(), provider: registrationProvider,
      modelId: registrationModelId.trim(), allowedEfforts: [...registrationEfforts],
      expectedPreviousVersion: registrationVersionValue,
    };
    if (!reserveFrontierRegistrationReceipt(receiptStore(), operatorId, registration)) {
      setRegistrationState("recovery_unavailable");
      return;
    }
    setPendingRegistration(registration);
    setRegistrationState("pending");
    setRegistrationFailure(null);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/frontier-models", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, action: "approve", ...registration,
          ownerConfirmedFrontierEligibility: true }),
      });
      const decision = classifyFrontierRegistrationPost({
        status: response.status,
        body: await response.json().catch(() => null),
      }, registration);
      if (applyRegistrationPost(decision, registration)) {
        setLoading(true);
        await load();
      }
    } catch {
      applyRegistrationPost({ kind: "verify" }, registration);
    }
  };

  const readRegistration = useCallback(async (registration: PendingFrontierCatalogApproval) => {
    setRegistrationState("pending");
    setRegistrationFailure(null);
    try {
      const query = new URLSearchParams({ approvalId: registration.approvalId });
      const response = await adminFetch(`/api/admin/amux/ideas/frontier-models?${query}`,
        { cache: "no-store" });
      if (!response.ok) {
        const failure = classifyFrontierRegistrationReadFailure({
          status: response.status,
          body: await response.json().catch(() => null),
        });
        setRegistrationFailure({
          message: failure.kind === "reauthentication"
            ? m.frontierRegistrationReadBackReauthentication
            : m.frontierRegistrationUnavailable,
          tone: "error",
          requiresReauthentication: failure.kind === "reauthentication",
          approvalId: null,
        });
        setRegistrationState("unknown");
        return;
      }
      const observed = readFrontierCatalogApprovalReadBack(
        response.status, await response.json(), registration);
      if (!observed) {
        setRegistrationFailure({ message: m.frontierRegistrationInvalidResponse,
          tone: "error", requiresReauthentication: false,
          approvalId: null });
        setRegistrationState("unknown");
        return;
      }
      if (observed.state === "not_visible") {
        setRegistrationState("not_visible");
        return;
      }
      setRegistrationState(observed.status);
      clearFrontierRegistrationReceipt(receiptStore(), operatorId, registration.approvalId);
      setLoading(true);
      await load();
    } catch {
      setRegistrationState("unknown");
    }
  }, [load, m.frontierRegistrationInvalidResponse,
    m.frontierRegistrationReadBackReauthentication,
    m.frontierRegistrationUnavailable, operatorId]);

  const startAnotherRegistration = () => {
    if (registrationState !== "approved" && registrationState !== "revoked") return;
    const restart = decideFrontierRegistrationRestart(
      readFrontierRegistrationReceipt(receiptStore(), operatorId));
    setRegistrationConfirmed(false);
    setRegistrationFailure(null);
    if (restart.kind === "unavailable") {
      setRegistrationState("recovery_unavailable");
      return;
    }
    if (restart.kind === "recover") {
      const registration = restart.registration;
      setRegistrationProvider(registration.provider);
      setRegistrationModelId(registration.modelId);
      setRegistrationEfforts(registration.allowedEfforts);
      setRegistrationVersion(String(registration.expectedPreviousVersion));
      setPendingRegistration(registration);
      setRegistrationState("pending");
      void readRegistration(registration);
      return;
    }
    setRegistrationProvider("openai");
    setRegistrationModelId("");
    setRegistrationEfforts([]);
    setRegistrationVersion("0");
    setPendingRegistration(null);
    setRegistrationState("idle");
  };

  useEffect(() => {
    const receipt = readFrontierRegistrationReceipt(receiptStore(), operatorId);
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setRegistrationRecoveryChecked(true);
      if (receipt.kind === "unavailable") {
        setRegistrationState("recovery_unavailable");
        return;
      }
      if (receipt.kind === "present") {
        const registration = receipt.registration;
        setRegistrationProvider(registration.provider);
        setRegistrationModelId(registration.modelId);
        setRegistrationEfforts(registration.allowedEfforts);
        setRegistrationVersion(String(registration.expectedPreviousVersion));
        setPendingRegistration(registration);
        setRegistrationState("pending");
        void readRegistration(registration);
      }
    });
    return () => { active = false; };
  }, [operatorId, readRegistration]);

  const checkSelection = async () => {
    if (!selected || !selected.allowedEfforts.includes(selectedEffort) || checking) return;
    setChecking(true);
    setChecked(false);
    setFailure(null);
    try {
      const params = new URLSearchParams({ mode: "check", provider: selected.provider,
        modelId: selected.modelId, reasoningEffort: selectedEffort });
      const response = await adminFetch(`/api/admin/amux/ideas/frontier-models?${params}`,
        { cache: "no-store" });
      if (!response.ok) {
        setFailure(await readAdminApiFailure(response, {
          fallback: m.frontierSelectionUnavailable, locale,
        }));
        return;
      }
      const result = readCheckedFrontierSelection(response.status, await response.json(), selected);
      if (!result) {
        setFailure({ message: m.frontierModelsInvalid, tone: "error",
          requiresReauthentication: false, approvalId: null });
        return;
      }
      setChecked(true);
    } catch {
      setFailure({ message: m.frontierSelectionUnavailable, tone: "error",
        requiresReauthentication: false, approvalId: null });
    } finally { setChecking(false); }
  };

  const preparePreview = async () => {
    if (!ideaId || !previewAvailable || !planReady || declaredExternalSources ||
        !selected || !checked ||
        !selected.allowedEfforts.includes(selectedEffort) || preview.kind !== "idle") return;
    const model = selected;
    const effort = selectedEffort;
    const previewId = crypto.randomUUID();
    if (!reservePreviewReceipt(receiptStore(), operatorId, ideaId, previewId,
      model, effort, chunkIndex)) {
      setPreview({ kind: "recovery_unavailable" });
      return;
    }
    setPreview({ kind: "pending" });
    try {
      const response = await adminFetch("/api/admin/amux/ideas/transfer-preview", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: chunkIndex === 0 ? 1 : 2, previewId, ideaId,
          ...(chunkIndex > 0 ? { chunkIndex } : {}),
          provider: model.provider, modelId: model.modelId,
          reasoningEffort: effort, approvalId: model.approvalId,
          approvalVersion: model.approvalVersion }),
      });
      const body: unknown = await response.json();
      const parsed = readPreparedIdeaTransferPreview(response.status, body,
        previewId, ideaId, model, effort, chunkIndex);
      if (parsed) { setPreview({ kind: "prepared", value: parsed }); return; }
      await readBack(previewId, model, effort);
    } catch { await readBack(previewId, model, effort); }
  };

  const recoverPreview = () => {
    if (!ideaId) return;
    const receipt = readPreviewReceipt(receiptStore(), operatorId, ideaId,
      chunkIndex);
    if (receipt.kind !== "present") {
      setPreview({ kind: "recovery_unavailable" });
      return;
    }
    setFailure(null);
    setPreview({ kind: "pending" });
    void readBack(receipt.previewId, receipt.model, receipt.effort);
  };

  const confirmPreview = async () => {
    if (!confirmAvailable || !ideaId || preview.kind !== "prepared" ||
        confirmation.kind !== "idle") return;
    const value = preview.value;
    if (!reserveConfirmationAttempt(receiptStore(), operatorId, value.previewId,
      ideaId, value.payloadDigest, value.payloadDigestKeyId)) {
      setConfirmation({ kind: "unknown" });
      await readConfirmation(value.previewId, ideaId, value.payloadDigest,
        value.payloadDigestKeyId);
      return;
    }
    setConfirmation({ kind: "pending" });
    setFailure(null);
    try {
      const response = await adminFetch("/api/admin/amux/ideas/transfer-confirmation", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, previewId: value.previewId, ideaId,
          payloadDigest: value.payloadDigest,
          payloadDigestKeyId: value.payloadDigestKeyId }),
      });
      if (response.status === 409) {
        await readConfirmation(value.previewId, ideaId, value.payloadDigest,
          value.payloadDigestKeyId);
        return;
      }
      if ([400, 401, 403, 404, 410, 413, 415, 428].includes(response.status)) {
        const refusal = await readAdminApiFailure(response, {
          fallback: m.transferConfirmRefused, locale,
        });
        setFailure(refusal);
        if (response.status !== 410) {
          clearRefusedConfirmationAttempt(receiptStore(), operatorId, value.previewId,
            ideaId, value.payloadDigest, value.payloadDigestKeyId);
        }
        setConfirmation((current) => current.kind === "confirmed" ? current :
          { kind: response.status === 410 ? "expired" : "refused" });
        return;
      }
      const body: unknown = await response.json();
      const parsed = readConfirmedIdeaTransfer(response.status, body, value.previewId,
        ideaId, value.payloadDigest, value.payloadDigestKeyId);
      if (parsed) { setConfirmation({ kind: "confirmed", value: parsed }); return; }
    } catch { /* A lost response must be read back by ID, not re-posted. */ }
    await readConfirmation(value.previewId, ideaId, value.payloadDigest,
      value.payloadDigestKeyId);
  };

  return (
    <section className="space-y-2 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
      aria-labelledby="amux-v4-frontier-models-heading">
      <h3 id="amux-v4-frontier-models-heading" className="font-semibold text-zinc-900 dark:text-zinc-100">
        {m.frontierModelsTitle}
      </h3>
      <p className="text-zinc-700 dark:text-zinc-300">{m.frontierModelsHint}</p>
      <div className="space-y-3 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
        <h4 className="font-semibold text-zinc-900 dark:text-zinc-100">
          {m.frontierRegistrationTitle}
        </h4>
        <p className="text-zinc-700 dark:text-zinc-300">{m.frontierRegistrationHint}</p>
        {!writeAvailable ? <p role="status">{m.frontierRegistrationDisabled}</p> : null}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor="amux-v4-frontier-registration-provider">
            {m.frontierRegistrationProvider}
            <select id="amux-v4-frontier-registration-provider"
              value={registrationProvider}
              disabled={registrationLocked}
              onChange={(event) => {
                setRegistrationProvider(event.target.value as "openai" | "anthropic");
                setRegistrationConfirmed(false);
              }}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 dark:border-zinc-600 dark:bg-zinc-900">
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor="amux-v4-frontier-registration-model">
            {m.frontierRegistrationModelId}
            <input id="amux-v4-frontier-registration-model" value={registrationModelId}
              maxLength={120} spellCheck={false}
              disabled={registrationLocked}
              onChange={(event) => {
                setRegistrationModelId(event.target.value);
                setRegistrationConfirmed(false);
              }}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 font-mono dark:border-zinc-600 dark:bg-zinc-900" />
          </label>
          <label className="flex flex-col gap-1" htmlFor="amux-v4-frontier-registration-version">
            {m.frontierRegistrationExpectedVersion}
            <input id="amux-v4-frontier-registration-version" value={registrationVersion}
              inputMode="numeric" pattern="[0-9]*" maxLength={9}
              disabled={registrationLocked}
              onChange={(event) => {
                setRegistrationVersion(event.target.value);
                setRegistrationConfirmed(false);
              }}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 font-mono dark:border-zinc-600 dark:bg-zinc-900" />
          </label>
          <fieldset className="space-y-1" disabled={registrationLocked}>
            <legend>{m.frontierRegistrationEfforts}</legend>
            <div className="flex flex-wrap gap-3">
              {FRONTIER_EFFORTS.map((effort) => <label key={effort}
                className="flex min-h-11 items-center gap-2">
                <input type="checkbox" checked={registrationEfforts.includes(effort)}
                  onChange={(event) => toggleRegistrationEffort(effort, event.target.checked)} />
                {effort}
              </label>)}
            </div>
          </fieldset>
        </div>
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={registrationConfirmed}
            disabled={registrationLocked || !registrationInputValid}
            onChange={(event) => setRegistrationConfirmed(event.target.checked)} />
          <span>{m.frontierRegistrationConfirm}</span>
        </label>
        <button type="button" onClick={() => void registerModel()}
          disabled={registrationLocked || !registrationConfirmed || !registrationInputValid}
          className="min-h-11 rounded-lg border border-blue-700 px-4 text-blue-800 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200">
          {m.frontierRegistrationAction}
        </button>
        {pendingRegistration ? <p className="break-all text-xs">
          {m.frontierRegistrationApprovalId}: {pendingRegistration.approvalId}
        </p> : null}
        {registrationState === "pending" ?
          <p role="status">{m.frontierRegistrationPending}</p> : null}
        {registrationFailure ? <AdminApiFailureNotice failure={registrationFailure} /> : null}
        {registrationState === "unknown" ?
          <p role="alert">{m.frontierRegistrationUnknown}</p> : null}
        {registrationState === "not_visible" ?
          <p role="alert">{m.frontierRegistrationNotVisible}</p> : null}
        {registrationState === "recovery_unavailable" ?
          <p role="alert">{m.frontierRegistrationRecoveryUnavailable}</p> : null}
        {registrationState === "approved" ?
          <p role="status">{m.frontierRegistrationApproved}</p> : null}
        {registrationState === "revoked" ?
          <p role="status">{m.frontierRegistrationRevoked}</p> : null}
        {registrationState === "approved" || registrationState === "revoked" ?
          <button type="button" onClick={startAnotherRegistration}
            className="min-h-11 rounded-lg border border-zinc-400 px-4 dark:border-zinc-600">
            {m.frontierRegistrationAnother}
          </button> : null}
        {pendingRegistration && ["unknown", "not_visible"].includes(registrationState) ?
          <button type="button" onClick={() => void readRegistration(pendingRegistration)}
            className="min-h-11 rounded-lg border border-zinc-400 px-4 dark:border-zinc-600">
            {m.frontierRegistrationReadBack}
          </button> : null}
      </div>
      {!available ? <p>{m.frontierModelsUnavailable}</p> : null}
      {available ? <button type="button" onClick={refresh} disabled={loading || checking}
        className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
        {m.frontierModelsRefresh}
      </button> : null}
      {loading ? <p role="status">{m.frontierModelsLoading}</p> : null}
      {failure ? <AdminApiFailureNotice failure={failure} /> : null}
      {models?.length === 0 ? <p role="status">{m.frontierModelsEmpty}</p> : null}
      {models && models.length > 0 ? (
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            {m.frontierSelectionModel}
            <select value={selectedApprovalId} disabled={checking}
              onChange={(event) => { setSelectedApprovalId(event.target.value); setSelectedEffort(""); setChecked(false); }}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 dark:border-zinc-600 dark:bg-zinc-900">
              <option value="">{m.frontierSelectionChoose}</option>
              {models.map((model) => <option key={model.approvalId} value={model.approvalId}>
                {model.provider} / {model.modelId}
              </option>)}
            </select>
          </label>
          {selected ? <label className="flex flex-col gap-1">
            {m.frontierModelsEfforts}
            <select value={selectedEffort} disabled={checking}
              onChange={(event) => { setSelectedEffort(event.target.value); setChecked(false); }}
              className="min-h-11 rounded-lg border border-zinc-400 px-3 dark:border-zinc-600 dark:bg-zinc-900">
              <option value="">{m.frontierSelectionChoose}</option>
              {selected.allowedEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </label> : null}
          <button type="button" onClick={() => void checkSelection()}
            disabled={!selected || !selectedEffort || checking}
            className="min-h-11 rounded-lg border border-zinc-400 px-4 disabled:opacity-50 dark:border-zinc-600">
            {m.frontierSelectionCheck}
          </button>
          {checked ? <p role="status">{m.frontierSelectionCurrent}</p> : null}
          {ideaId ? <button type="button" onClick={() => void preparePreview()}
            disabled={!previewAvailable || !planReady || declaredExternalSources ||
              !checked || preview.kind !== "idle"}
            className="min-h-11 rounded-lg border border-blue-700 px-4 text-blue-800 disabled:opacity-50 dark:border-blue-400 dark:text-blue-200">
            {m.transferPreviewPrepare}
          </button> : null}
        </div>
      ) : null}
      {ideaId && !previewAvailable ? <p>{m.transferPreviewUnavailable}</p> : null}
      {ideaId && previewAvailable && declaredExternalSources ?
        <p>{m.transferPreviewIdeaOnly}</p> : null}
      {ideaId && previewAvailable && !declaredExternalSources && !planReady ?
        <p>{m.transferPreviewPlanRequired}</p> : null}
      {preview.kind === "pending" ? <p role="status">{m.transferPreviewPreparing}</p> : null}
      {preview.kind === "recovery_unavailable" ? <p role="alert">{m.recoveryUnavailable}</p> : null}
      {preview.kind === "expired" ? <p role="status">{m.transferPreviewExpired}</p> : null}
      {preview.kind === "unknown" && confirmation.kind === "idle" ? <div className="space-y-2">
        <p role="alert">{m.transferPreviewUnknown}</p>
        <button type="button" onClick={recoverPreview} className="min-h-11 rounded-lg border border-zinc-400 px-4 dark:border-zinc-600">
          {m.transferPreviewReadBack}
        </button>
      </div> : null}
      {preview.kind === "prepared" ? (
        <div className="space-y-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
          <p role="status">{m.transferPreviewPrepared}</p>
          <p className="break-all text-xs">{preview.value.provider} / {preview.value.modelId}
            {` · ${preview.value.reasoningEffort} · ${preview.value.previewId}`}</p>
          <p className="text-xs">{m.transferPreviewExpires}: {preview.value.expiresAt}</p>
          <p className="break-all text-xs">{m.transferPreviewDigest}: {preview.value.payloadDigest}</p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
            {preview.value.prompt}
          </pre>
          <p>{confirmation.kind === "confirmed" ? m.transferConfirmRecordedBoundary :
            m.transferPreviewBoundary}</p>
          {confirmAvailable && confirmation.kind === "idle" ? <button type="button"
            onClick={() => void confirmPreview()}
            className="min-h-11 rounded-lg border border-blue-700 px-4 text-blue-800 dark:border-blue-400 dark:text-blue-200">
            {m.transferConfirmAction}
          </button> : null}
        </div>
      ) : null}
      {confirmation.kind === "pending" ? <p role="status">{m.transferConfirmPending}</p> : null}
      {confirmation.kind === "confirmed" ? <p role="status">{m.transferConfirmRecorded}</p> : null}
      {confirmation.kind === "confirmed" ? <AmuxAnalysisBudgetPanel
        key={confirmation.value.previewId} confirmed={confirmation.value}
        available={analysisBudgetAvailable} /> : null}
      {confirmation.kind === "expired" ? <p role="status">{m.transferConfirmExpired}</p> : null}
      {confirmation.kind === "refused" && !failure ?
        <p role="alert">{m.transferConfirmRefused}</p> : null}
      {confirmation.kind === "unknown" ? <div className="space-y-2">
        <p role="alert">{m.transferConfirmUnknown}</p>
        <button type="button" onClick={() => {
          const receipt = ideaId ? readPreviewReceipt(receiptStore(), operatorId,
            ideaId, chunkIndex) : null;
          const attempt = receipt?.kind === "present" && ideaId ?
            readConfirmationAttemptForPreview(receiptStore(), operatorId,
              receipt.previewId, ideaId) : null;
          if (receipt?.kind === "present" && attempt?.kind === "present" && ideaId) {
            void readConfirmation(receipt.previewId, ideaId,
              attempt.payloadDigest, attempt.payloadDigestKeyId);
          } else { setPreview({ kind: "recovery_unavailable" }); }
        }} className="min-h-11 rounded-lg border border-zinc-400 px-4 dark:border-zinc-600">
          {m.transferConfirmReadBack}
        </button>
      </div> : null}
    </section>
  );
}
