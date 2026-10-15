"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import type { AdminApiFailure } from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import {
  classifyFrontierRegistrationReadFailure,
  classifyFrontierRegistrationPost,
  clearFrontierRegistrationReceipt,
  decideFrontierRegistrationRestart,
  readFrontierCatalogApprovalReadBack,
  readFrontierRegistrationReceipt,
  reduceFrontierRegistrationPost,
  reserveFrontierRegistrationReceipt,
  type PendingFrontierCatalogApproval,
} from "@/lib/amux/ideaFrontierCatalogUiCore";

type RegistrationState = "idle" | "pending" | "unknown" | "not_visible" |
  "approved" | "revoked" | "recovery_unavailable";

const FRONTIER_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const FRONTIER_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const FRONTIER_VERSION = /^(0|[1-9]\d{0,8})$/;

const receiptStore = (): Storage | null => {
  try { return window.sessionStorage; } catch { return null; }
};

/**
 * Owner approval of one frontier analysis model and its efforts, moved from
 * the Ideas flow to Operations settings › Analysis settings (approved backlog
 * redesign, screen C). Registration calls no model and starts no analysis;
 * the execution approval's model choice only lists what is approved here.
 * The receipt is kept before the write and an unknown answer is read back by
 * its exact approval id, never resent.
 */
export function AmuxFrontierModelRegistrationPanel({ writeAvailable, operatorId }: {
  writeAvailable: boolean;
  operatorId: string;
}) {
  const m = useAdminMessages(adminAmuxIdeaInputMessages);
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
      applyRegistrationPost(decision, registration);
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
    } catch {
      setRegistrationState("unknown");
    }
  }, [m.frontierRegistrationInvalidResponse,
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


  return (
    <section className="space-y-2 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
      data-testid="amux-frontier-model-registration">
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
        {registrationFailure ? <AdminApiFailureNotice failure={registrationFailure}
          returnTo="/admin/amux-settings?tab=analysis" /> : null}
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
    </section>
  );
}
