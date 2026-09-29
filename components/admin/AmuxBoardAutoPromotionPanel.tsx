"use client";

import { useState } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminAmuxBoardAutoPromotionMessages } from "@/lib/adminMessages/amuxBoardAutoPromotion";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

const STEP_UP_HREF = adminRecentAuthenticationHref("/admin/amux-promotion?tab=auto-promotion");
const DAY_MS = 24 * 60 * 60 * 1000;
// The resume request header. lib/amux/autoPromotionCore.ts owns these values
// and tests/amuxAutoPromotionCore.test.mjs keeps this copy equal to them; the
// core module hashes with node:crypto and cannot be bundled into this screen.
const RESUME_CANONICALIZATION_VERSION = "amux-json-v1";
const RESUME_POLICY_VERSION = 15;

type AutoPromotionBody = {
  applyPermitted?: boolean;
  refusal?: string | null;
  humanDecisions?: number;
  spanMs?: number;
  graduated?: boolean;
  openHalt?: { haltId: string; reason: string; violationCode: string | null; openedAt: string } | null;
  activeGrants?: number;
  status?: string;
  expired?: number;
  cleared?: boolean;
  error?: string;
  code?: string;
};

export function AmuxBoardAutoPromotionPanel() {
  const messages = useAdminMessages(adminAmuxBoardAutoPromotionMessages);
  const [requestText, setRequestText] = useState("");
  const [haltId, setHaltId] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AutoPromotionBody | null>(null);
  // Only a preview reports the switch. Grant and consume stay disabled until
  // one has said the server permits them; the server refuses them regardless.
  const [applySwitch, setApplySwitch] = useState<boolean | null>(null);
  const [overview, setOverview] = useState<AutoPromotionBody | null>(null);

  const send = async (action: string, body: string) => {
    setPending(true);
    try {
      const response = await adminFetch(`/api/admin/amux/board-auto-promotion?action=${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const payload = (await response.json()) as AutoPromotionBody;
      setResult(payload);
      if (action === "preview" && response.ok) {
        setOverview(payload);
        if (typeof payload.applyPermitted === "boolean") setApplySwitch(payload.applyPermitted);
        if (payload.openHalt?.haltId) setHaltId(payload.openHalt.haltId);
      }
    } catch {
      setResult({ error: "board_auto_promotion_failed" });
    } finally {
      setPending(false);
    }
  };

  const refusedForStepUp =
    result?.code === "ADMIN_REAUTHENTICATION_REQUIRED" || result?.error === "ADMIN_REAUTHENTICATION_REQUIRED";
  const writesReady = applySwitch === true;
  const resumeBody = JSON.stringify({
    canonicalizationVersion: RESUME_CANONICALIZATION_VERSION,
    policyVersion: RESUME_POLICY_VERSION,
    haltId: haltId.trim(),
  });

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-testid="amux-board-auto-promotion-panel">
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{messages.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{messages.description}</p>
      {overview ? (
        <div className="rounded-md border border-zinc-200 p-3 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-100">
          {typeof overview.humanDecisions === "number" && typeof overview.spanMs === "number" ? (
            <p>{messages.graduation(overview.humanDecisions, Math.floor(overview.spanMs / DAY_MS))}</p>
          ) : null}
          {typeof overview.graduated === "boolean" ? (
            <p>{messages.graduated(overview.graduated ? "true" : "false")}</p>
          ) : null}
          <p>
            {overview.openHalt
              ? messages.openHalt(overview.openHalt.reason, overview.openHalt.violationCode ?? "none")
              : messages.noHalt}
          </p>
          {typeof overview.activeGrants === "number" ? <p>{messages.activeGrants(overview.activeGrants)}</p> : null}
        </div>
      ) : null}
      <label
        className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100"
        htmlFor="amux-board-auto-promotion-request"
      >
        {messages.requestLabel}
        <textarea
          id="amux-board-auto-promotion-request"
          className="min-h-40 w-full rounded-md border border-zinc-300 bg-white p-3 text-base text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
          value={requestText}
          onChange={(event) => setRequestText(event.target.value)}
        />
      </label>
      <label
        className="flex flex-col gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-100"
        htmlFor="amux-board-auto-promotion-halt"
      >
        {messages.haltLabel}
        <input
          id="amux-board-auto-promotion-halt"
          className="min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-base text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
          value={haltId}
          onChange={(event) => setHaltId(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          disabled={pending}
          onClick={() => send("preview", "{}")}
        >
          {messages.preview}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || !writesReady || requestText.trim().length === 0}
          aria-describedby="amux-board-auto-promotion-apply-reason"
          onClick={() => send("grant", requestText)}
        >
          {messages.grant}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || !writesReady || requestText.trim().length === 0}
          aria-describedby="amux-board-auto-promotion-apply-reason"
          onClick={() => send("consume", requestText)}
        >
          {messages.consume}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending}
          onClick={() => send("expire-due", "{}")}
        >
          {messages.expireDue}
        </button>
        <button
          type="button"
          className="min-h-11 rounded-md border border-zinc-300 px-4 text-sm font-medium text-zinc-900 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-100"
          disabled={pending || haltId.trim().length === 0}
          onClick={() => send("resume", resumeBody)}
        >
          {messages.resume}
        </button>
      </div>
      <p id="amux-board-auto-promotion-apply-reason" className="text-sm text-zinc-700 dark:text-zinc-300">
        {writesReady
          ? messages.applyPermitted("true")
          : applySwitch === false
            ? messages.applyDisabled
            : messages.applyWaiting}
      </p>
      {refusedForStepUp ? (
        <a className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100" href={STEP_UP_HREF}>
          {messages.renewSignIn}
        </a>
      ) : null}
      {result ? (
        <div className="rounded-md border border-zinc-200 p-3 text-sm text-zinc-800 dark:border-zinc-700 dark:text-zinc-100" role="status">
          {result.error ? <p>{messages.error(result.error)}</p> : null}
          {result.status ? <p>{messages.status(result.status)}</p> : null}
          {result.refusal ? <p>{messages.refusal(result.refusal)}</p> : null}
          {typeof result.expired === "number" ? <p>{messages.expired(result.expired)}</p> : null}
          {result.cleared === true ? <p>{messages.cleared}</p> : null}
          {typeof result.applyPermitted === "boolean" ? (
            <p>{messages.applyPermitted(result.applyPermitted ? "true" : "false")}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
