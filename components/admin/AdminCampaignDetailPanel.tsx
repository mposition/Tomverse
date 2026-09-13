"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { dispatchAppToast } from "@/lib/appToast";
import { AdminWaveLedger } from "@/components/admin/AdminWaveLedger";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminEmailCampaignDetailMessages } from "@/lib/adminMessages/emailCampaignDetail";

/**
 * One campaign, and every decision an operator makes about it.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3;
 * docs/policy/email-notifications.md §12.3.
 *
 * Four things this screen is built to make hard to get wrong:
 *
 *  - **Nothing here claims a send is possible.** The gates say what they refuse
 *    and the buttons stay live, because a disabled button with no sentence next
 *    to it is indistinguishable from a broken one. Every refusal is the
 *    server's; this screen only repeats it.
 *  - **A stale attestation is not a missing one.** It keeps its signer and the
 *    screen says the copy moved underneath it, because "nobody has said this"
 *    is wrong about somebody who did the work.
 *  - **Approving asks what is being approved.** The language list goes into the
 *    request, so an approval cannot be inherited by a campaign that has since
 *    changed which languages it sends in.
 *  - **`ADMIN_APPROVAL_REQUIRED` is the expected first answer**, not a failure.
 *    The request is recorded and waits for a second administrator.
 *
 * Everything is re-read from the server after every action rather than patched
 * locally: the gates are computed from rows this screen does not hold, and a
 * locally-updated view would show an operator a send gate that had not been
 * asked again.
 */

type WaveView = {
  id: string;
  kind: string;
  sequence: number;
  status: string;
  scheduledAt: string | null;
  dryRun: boolean;
  recipientCap: number | null;
  expandedCount: number;
};

type AttestationView = {
  kind: string;
  /** Whether it counts right now. */
  satisfied: boolean;
  /** Exists and no longer counts: a different sentence from "nobody said this". */
  stale: boolean;
  attestedByEmail: string | null;
  attestedAt: string | null;
};

type TransitionClaimView = {
  mayClaim: boolean;
  unmet: string[];
  reasons: Record<string, string>;
} | null;

type CampaignView = {
  id: string;
  category: string;
  templateKey: string;
  status: string;
  locales: string[];
  triggerMode: string;
  scheduledAt: string | null;
  effectiveAt: string | null;
  timezoneLabel: string | null;
  workItemId: string | null;
  targetModelId: string | null;
  replacementModelId: string | null;
  audienceVersion: number;
  estimatedRecipients: number | null;
  estimatedAt: string | null;
  estimatedByEmail: string | null;
  audienceEstimate: AudienceSummaryView | null;
  claimsAutomaticTransition: boolean;
  approvalId: string | null;
  approvedAt: string | null;
  createdByEmail: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  waves: WaveView[];
};

type AudienceSummaryView = {
  cohortRows: Record<string, number>;
  cohortUsers: Record<string, number>;
  distinctUsers: number;
  excluded: Record<string, number>;
  noticeAudience: number;
  autoMigratable: number;
  malformed: number;
  /** The scan stopped before the audience did: every figure is a floor. */
  truncated: boolean;
};

type AudienceView = {
  waveId: string;
  kind: string;
  sequence: number;
  dryRun: boolean;
  total: number;
  written: number;
  malformed: number;
  excluded: Record<string, number>;
  cohorts: Record<string, number>;
};

type DetailResponse = {
  campaign: CampaignView;
  sendRefusal: { refusal: string; message: string; languages?: string[] } | null;
  scheduleProblems: Array<{
    code: "out_of_order" | "duplicate_kind" | "in_the_past" | "after_effective_at";
    message: string;
  }>;
  attestations: AttestationView[];
  transitionClaim: TransitionClaimView;
  audience: AudienceView[];
};

/** The exclusion reasons an estimate labels; any other key shows as stored. */
const ESTIMATE_EXCLUDED_REASONS = new Set([
  "no_email",
  "account_inactive",
  "suppressed",
  "plan_incompatible",
]);

const labelFor = (labels: object, key: string): string | undefined =>
  Object.hasOwn(labels, key)
    ? (labels as Record<string, string>)[key]
    : undefined;

const when = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toISOString().replace("T", " ").slice(0, 16);
};

export function AdminCampaignDetailPanel({
  campaignId,
  /**
   * Whether this administrator may reveal an address (D10: `owner` and `ops`).
   *
   * Resolved on the server and passed down, for the reason the delivery screen
   * gives: a browser deciding whether it may reveal is a browser that can
   * decide it may. The server refuses regardless.
   */
  mayRevealAddresses,
}: {
  campaignId: string;
  mayRevealAddresses: boolean;
}) {
  const m = useAdminMessages(adminEmailCampaignDetailMessages);
  // Read through a ref so a language switch does not re-run `load`.
  const loadFailedMessage = useRef(m.toast.loadFailed);
  useEffect(() => {
    loadFailedMessage.current = m.toast.loadFailed;
  }, [m.toast.loadFailed]);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  // At most one wave's ledger is open. D10 made the screen the unit of a
  // reveal, and several ledgers on one page would leave "which screen"
  // unanswered.
  const [openLedgerWaveId, setOpenLedgerWaveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/admin/email-campaigns/${encodeURIComponent(campaignId)}`,
        { cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as
        | DetailResponse
        | { error?: string }
        | null;
      if (!response.ok || !payload || !("campaign" in payload)) {
        throw new Error(
          payload && "error" in payload && payload.error
            ? payload.error
            : loadFailedMessage.current
        );
      }
      setData(payload);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : loadFailedMessage.current,
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const send = async (
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body: Record<string, unknown>
  ) => {
    const response = await fetch(
      `/api/admin/email-campaigns/${encodeURIComponent(campaignId)}${path}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      // Recorded and waiting for a second administrator: the ordinary first
      // answer for the one two-person action on this page.
      if (payload?.code === "ADMIN_APPROVAL_REQUIRED") {
        dispatchAppToast(m.toast.approvalRecorded, "success");
        return null;
      }
      throw new Error(
        typeof payload?.error === "string" ? payload.error : m.toast.refused
      );
    }
    return payload;
  };

  const run = async (
    key: string,
    action: () => Promise<unknown>,
    success: string
  ) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
      dispatchAppToast(success, "success");
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.toast.refused,
        "error"
      );
    } finally {
      setBusy(null);
      await load();
    }
  };

  if (!data) {
    return (
      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <p className="text-sm text-zinc-400">
          {loading ? m.loading : m.loadFailed}
        </p>
      </section>
    );
  }

  const {
    campaign,
    sendRefusal,
    scheduleProblems,
    attestations,
    transitionClaim,
    audience,
  } = data;
  const editable =
    campaign.status === "draft" || campaign.status === "pending_approval";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
              {campaign.category}
            </p>
            <h2 className="mt-2 break-words text-2xl font-black text-white">
              {campaign.templateKey}
            </h2>
            <p className="mt-1 font-mono text-xs text-zinc-500">{campaign.id}</p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-4 text-sm font-bold text-zinc-200 hover:border-zinc-700 disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
            {m.refresh}
          </button>
        </div>

        <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            [m.fields.status, campaign.status],
            [m.fields.trigger, campaign.triggerMode],
            [m.fields.languages, campaign.locales.join(", ") || "—"],
            [
              m.fields.effective,
              campaign.effectiveAt
                ? `${when(campaign.effectiveAt)} (${campaign.timezoneLabel ?? m.fields.noTimezone})`
                : "—",
            ],
            [
              m.fields.models,
              campaign.targetModelId
                ? `${campaign.targetModelId} → ${campaign.replacementModelId ?? "—"}`
                : "—",
            ],
            [
              m.fields.estimatedRecipients,
              campaign.estimatedRecipients === null
                ? m.fields.notMeasured
                : m.fields.estimateValue(
                    campaign.estimatedRecipients,
                    when(campaign.estimatedAt),
                    campaign.estimatedByEmail ?? m.fields.unknown,
                    campaign.audienceVersion
                  ),
            ],
            [m.fields.workItem, campaign.workItemId ?? "—"],
            [m.fields.draftedBy, campaign.createdByEmail],
            [
              m.fields.approved,
              campaign.approvedAt ? when(campaign.approvedAt) : m.fields.notApproved,
            ],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs uppercase tracking-wider text-zinc-500">
                {label}
              </dt>
              <dd className="mt-1 break-words text-sm text-zinc-200">{value}</dd>
            </div>
          ))}
        </dl>

        {campaign.cancelledAt ? (
          <p className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-300">
            {m.cancelledAt(when(campaign.cancelledAt), campaign.cancelReason ?? "")}
          </p>
        ) : null}
      </section>

      <section
        className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5"
        data-testid="admin-campaign-gates"
      >
        <h3 className="text-lg font-black text-white">{m.gates.title}</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.gates.intro}
        </p>

        <div className="mt-4 space-y-3">
          <div
            className={`rounded-2xl border p-4 ${
              sendRefusal
                ? "border-amber-800 bg-amber-950/40"
                : "border-emerald-900 bg-emerald-950/30"
            }`}
            data-testid="admin-campaign-send-refusal"
          >
            <p className="text-sm font-bold text-white">
              {sendRefusal
                ? m.gates.sendRefused(sendRefusal.refusal)
                : m.gates.sendPasses}
            </p>
            {sendRefusal ? (
              <p className="mt-1 text-sm leading-6 text-amber-100">
                {sendRefusal.message}
              </p>
            ) : (
              <p className="mt-1 text-sm leading-6 text-emerald-100">
                {m.gates.sendPassesDetail}
              </p>
            )}
          </div>

          <div
            className={`rounded-2xl border p-4 ${
              scheduleProblems.length > 0
                ? "border-amber-800 bg-amber-950/40"
                : "border-zinc-800 bg-zinc-900/50"
            }`}
            data-testid="admin-campaign-schedule-problems"
          >
            <p className="text-sm font-bold text-white">
              {scheduleProblems.length > 0
                ? m.gates.scheduleProblems(scheduleProblems.length)
                : m.gates.scheduleConsistent}
            </p>
            <ul className="mt-1 space-y-1 text-sm leading-6 text-zinc-300">
              {scheduleProblems.map((problem) => (
                <li key={`${problem.code}:${problem.message}`}>
                  {problem.message}
                </li>
              ))}
            </ul>
          </div>

          {campaign.claimsAutomaticTransition ? (
            <div
              className={`rounded-2xl border p-4 ${
                transitionClaim?.mayClaim
                  ? "border-emerald-900 bg-emerald-950/30"
                  : "border-amber-800 bg-amber-950/40"
              }`}
              data-testid="admin-campaign-transition-claim"
            >
              <p className="text-sm font-bold text-white">
                {m.gates.transitionTitle}
              </p>
              <p className="mt-1 text-sm leading-6 text-zinc-300">
                {transitionClaim?.mayClaim
                  ? m.gates.transitionMet
                  : m.gates.transitionUnmet(transitionClaim?.unmet.length ?? 0)}
              </p>
              {transitionClaim && !transitionClaim.mayClaim ? (
                <ul className="mt-2 space-y-1 text-sm leading-6 text-amber-100">
                  {transitionClaim.unmet.map((condition) => (
                    <li key={condition}>
                      <span className="font-mono text-xs">{condition}</span>
                      {transitionClaim.reasons[condition]
                        ? ` — ${transitionClaim.reasons[condition]}`
                        : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <h3 className="text-lg font-black text-white">{m.attestations.title}</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.attestations.intro}
        </p>
        <ul className="mt-4 space-y-3">
          {attestations.map((attestation) => (
            <li
              key={attestation.kind}
              className={`rounded-2xl border p-4 ${
                attestation.satisfied
                  ? "border-emerald-900 bg-emerald-950/30"
                  : attestation.stale
                    ? "border-amber-800 bg-amber-950/40"
                    : "border-zinc-800 bg-zinc-900/50"
              }`}
              data-testid={`admin-campaign-attestation-${attestation.kind}`}
            >
              <p className="text-sm font-bold text-white">
                {labelFor(m.attestation, attestation.kind) ?? attestation.kind}
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {labelFor(m.attestationAbout, attestation.kind) ?? ""}
              </p>
              <p className="mt-2 text-sm text-zinc-200">
                {attestation.stale
                  ? m.attestations.stale(
                      `${attestation.attestedByEmail}`,
                      when(attestation.attestedAt)
                    )
                  : attestation.satisfied
                    ? m.attestations.satisfied(
                        `${attestation.attestedByEmail}`,
                        when(attestation.attestedAt)
                      )
                    : m.attestations.nobody}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void run(
                      `attest:${attestation.kind}`,
                      () =>
                        send("/attestations", "POST", { kind: attestation.kind }),
                      m.toast.recorded
                    )
                  }
                  disabled={busy !== null}
                  className="inline-flex min-h-11 items-center rounded-xl border border-blue-500/40 bg-blue-500/15 px-4 text-sm font-bold text-white hover:border-blue-400 disabled:opacity-60"
                >
                  {attestation.satisfied
                    ? m.attestations.reattest
                    : m.attestations.attest}
                </button>
                {attestation.satisfied || attestation.stale ? (
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        `withdraw:${attestation.kind}`,
                        () =>
                          send("/attestations", "DELETE", {
                            kind: attestation.kind,
                          }),
                        m.toast.withdrawn
                      )
                    }
                    disabled={busy !== null}
                    className="inline-flex min-h-11 items-center rounded-xl border border-zinc-800 bg-zinc-900 px-4 text-sm font-bold text-zinc-200 hover:border-zinc-700 disabled:opacity-60"
                  >
                    {m.attestations.withdraw}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <h3 className="text-lg font-black text-white">{m.approval.title}</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.approval.intro}
        </p>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.approval.localesBefore}{" "}
          <span
            className="font-mono text-zinc-200"
            data-testid="admin-campaign-approve-locales"
          >
            {campaign.locales.join(", ") || m.approval.localesNone}
          </span>{" "}
          {m.approval.localesAfter}
        </p>
        <label className="mt-4 block text-sm font-bold text-zinc-200">
          {m.approval.reasonLabel}
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            className="mt-2 min-h-11 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 text-sm text-white placeholder:text-zinc-600"
            placeholder={m.approval.reasonPlaceholder}
            data-testid="admin-campaign-approve-reason"
          />
        </label>
        <button
          type="button"
          onClick={() =>
            void run(
              "approve",
              () =>
                send("/approve", "POST", {
                  reason: reason.trim(),
                  locales: campaign.locales,
                }),
              m.toast.approved
            )
          }
          disabled={busy !== null || reason.trim().length === 0}
          className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-blue-500/40 bg-blue-500/15 px-5 text-sm font-bold text-white hover:border-blue-400 disabled:opacity-60"
          data-testid="admin-campaign-approve"
        >
          {m.approval.approve}
        </button>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <h3 className="text-lg font-black text-white">{m.waves.title}</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.waves.intro}
        </p>
        {campaign.waves.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
            {m.waves.empty}
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {campaign.waves.map((wave) => (
              <li
                key={wave.id}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4"
                data-testid="admin-campaign-wave"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-white">
                      {wave.kind}
                      {wave.sequence > 1 ? ` #${wave.sequence}` : ""}{" "}
                      <span className="text-zinc-400">— {wave.status}</span>
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {wave.scheduledAt
                        ? m.waves.due(when(wave.scheduledAt))
                        : m.waves.startedByHand}
                      {wave.dryRun ? m.waves.dryRun : ""}
                      {wave.recipientCap === null
                        ? ""
                        : m.waves.cap(wave.recipientCap)}
                      {m.waves.expanded(wave.expandedCount)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        `run:${wave.id}`,
                        () =>
                          send("/waves", "POST", {
                            kind: wave.kind,
                            sequence: wave.sequence,
                            action: "run",
                          }),
                        m.toast.started
                      )
                    }
                    disabled={busy !== null}
                    className="inline-flex min-h-11 items-center rounded-xl border border-zinc-800 bg-zinc-900 px-4 text-sm font-bold text-zinc-200 hover:border-zinc-700 disabled:opacity-60"
                  >
                    {m.waves.startNow}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5"
        data-testid="admin-campaign-estimate"
      >
        <h3 className="text-lg font-black text-white">{m.estimate.title}</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.estimate.intro}
        </p>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.estimate.gatesNothing}
        </p>

        {campaign.audienceEstimate === null ? (
          <p
            className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400"
            data-testid="admin-campaign-estimate-absent"
          >
            {m.estimate.absent}
          </p>
        ) : (
          <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="text-sm text-zinc-200">
              <span
                className="text-2xl font-black text-white"
                data-testid="admin-campaign-estimate-headline"
              >
                {campaign.audienceEstimate.truncated ? m.estimate.atLeast : ""}
                {campaign.audienceEstimate.noticeAudience}
              </span>{" "}
              {m.estimate.headlineAfter(campaign.audienceEstimate.distinctUsers)}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {m.estimate.measured(
                when(campaign.estimatedAt),
                campaign.estimatedByEmail ?? m.fields.unknown,
                campaign.audienceVersion
              )}
            </p>

            {campaign.audienceEstimate.truncated ? (
              <p
                className="mt-3 rounded-xl border border-amber-800 bg-amber-950/40 p-3 text-sm leading-6 text-amber-100"
                data-testid="admin-campaign-estimate-truncated"
              >
                {m.estimate.truncated}
              </p>
            ) : null}

            <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {Object.entries(campaign.audienceEstimate.excluded).map(
                ([reason, count]) => (
                  <div
                    key={reason}
                    className="flex items-baseline justify-between gap-3 border-b border-zinc-900 py-1"
                  >
                    <dt className="min-w-0 text-sm text-zinc-400">
                      {(ESTIMATE_EXCLUDED_REASONS.has(reason)
                        ? labelFor(m.excluded, reason)
                        : undefined) ?? reason}
                    </dt>
                    <dd
                      className={`text-sm font-bold ${
                        count > 0 ? "text-amber-200" : "text-zinc-600"
                      }`}
                    >
                      {count}
                    </dd>
                  </div>
                )
              )}
            </dl>

            <p className="mt-3 text-sm text-zinc-300">
              {m.estimate.autoMigratable(
                campaign.audienceEstimate.autoMigratable
              )}{" "}
              {campaign.audienceEstimate.malformed > 0
                ? m.estimate.malformed(campaign.audienceEstimate.malformed)
                : ""}
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={() =>
            void run(
              "estimate",
              () => send("/estimate", "POST", {}),
              m.toast.measured
            )
          }
          disabled={busy !== null}
          className="mt-4 inline-flex min-h-11 items-center rounded-xl border border-blue-500/40 bg-blue-500/15 px-5 text-sm font-bold text-white hover:border-blue-400 disabled:opacity-60"
          data-testid="admin-campaign-estimate-run"
        >
          {busy === "estimate"
            ? m.estimate.counting
            : campaign.audienceEstimate
              ? m.estimate.measureAgain
              : m.estimate.measure}
        </button>
      </section>

      <section
        className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5"
        data-testid="admin-campaign-audience"
      >
        <h3 className="text-lg font-black text-white">{m.audience.title}</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.audience.intro}
        </p>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.audience.introMasked}
        </p>

        {audience.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
            {m.audience.empty}
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {audience.map((wave) => (
              <li
                key={wave.waveId}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4"
                data-testid="admin-campaign-audience-wave"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-bold text-white">
                    {wave.kind}
                    {wave.sequence > 1 ? ` #${wave.sequence}` : ""}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {m.audience.considered(wave.total)}
                  </p>
                </div>

                {wave.total === 0 ? (
                  <p className="mt-2 text-sm text-zinc-400">
                    {m.audience.notExpanded}
                  </p>
                ) : (
                  <>
                    {/* Said as "a delivery row was written", never as "sent".
                        On a dry run every one of those deliveries was written
                        `skipped`, and a column headed "sent" would report a
                        rehearsal as a send. */}
                    <p className="mt-2 text-sm text-zinc-200">
                      <span className="font-bold">{wave.written}</span>{" "}
                      {wave.dryRun ? (
                        <span data-testid="admin-campaign-audience-dry-run">
                          {m.audience.dryRunWritten}
                        </span>
                      ) : (
                        m.audience.written
                      )}
                    </p>

                    <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                      {Object.entries(wave.excluded).map(([reason, count]) => (
                        <div
                          key={reason}
                          className="flex items-baseline justify-between gap-3 border-b border-zinc-900 py-1"
                        >
                          <dt className="min-w-0 text-sm text-zinc-400">
                            {labelFor(m.excluded, reason) ?? reason}
                          </dt>
                          <dd
                            className={`text-sm font-bold ${
                              count > 0 ? "text-amber-200" : "text-zinc-600"
                            }`}
                          >
                            {count}
                          </dd>
                        </div>
                      ))}
                    </dl>

                    <p className="mt-3 text-xs uppercase tracking-wider text-zinc-500">
                      {m.audience.whyInAudience}
                    </p>
                    <dl className="mt-1 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                      {Object.entries(wave.cohorts).map(([cohort, count]) => (
                        <div
                          key={cohort}
                          className="flex items-baseline justify-between gap-3 py-1"
                        >
                          <dt className="min-w-0 text-sm text-zinc-400">
                            {labelFor(m.cohort, cohort) ?? cohort}
                          </dt>
                          <dd className="text-sm text-zinc-300">{count}</dd>
                        </div>
                      ))}
                    </dl>

                    {wave.malformed > 0 ? (
                      <p
                        className="mt-3 rounded-xl border border-amber-800 bg-amber-950/40 p-3 text-sm leading-6 text-amber-100"
                        data-testid="admin-campaign-audience-malformed"
                      >
                        {m.audience.malformed(wave.malformed)}
                      </p>
                    ) : null}

                    {/* The ledger is fetched only when asked for. It is one row
                        per person, and loading it for every wave on every visit
                        would read an audience-sized list for an operator who
                        opened the page to check a schedule. */}
                    <button
                      type="button"
                      onClick={() =>
                        setOpenLedgerWaveId((current) =>
                          current === wave.waveId ? null : wave.waveId
                        )
                      }
                      className="mt-3 min-h-11 rounded-xl border border-zinc-800 px-3 text-sm font-bold text-zinc-300 hover:border-zinc-700"
                      aria-expanded={openLedgerWaveId === wave.waveId}
                      data-testid="admin-campaign-audience-open-ledger"
                    >
                      {openLedgerWaveId === wave.waveId
                        ? m.audience.hidePeople
                        : m.audience.showPeople}
                    </button>

                    {openLedgerWaveId === wave.waveId ? (
                      <AdminWaveLedger
                        campaignId={campaignId}
                        waveId={wave.waveId}
                        dryRun={wave.dryRun}
                        mayRevealAddresses={mayRevealAddresses}
                      />
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <h3 className="text-lg font-black text-white">{m.cancel.title}</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          {m.cancel.intro}{" "}
          {editable ? m.cancel.editable : m.cancel.notEditable}
        </p>
        <label className="mt-4 block text-sm font-bold text-zinc-200">
          {m.cancel.reasonLabel}
          <input
            type="text"
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            maxLength={500}
            className="mt-2 min-h-11 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 text-sm text-white placeholder:text-zinc-600"
            placeholder={m.cancel.reasonPlaceholder}
            data-testid="admin-campaign-cancel-reason"
          />
        </label>
        <button
          type="button"
          onClick={() =>
            void run(
              "cancel",
              () => send("", "PATCH", { cancelReason: cancelReason.trim() }),
              m.toast.cancelled
            )
          }
          disabled={busy !== null || cancelReason.trim().length === 0}
          className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-red-800 bg-red-950/40 px-5 text-sm font-bold text-red-100 hover:border-red-700 disabled:opacity-60"
          data-testid="admin-campaign-cancel"
        >
          {m.cancel.cancel}
        </button>
      </section>
    </div>
  );
}
