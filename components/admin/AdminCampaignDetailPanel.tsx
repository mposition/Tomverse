"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { dispatchAppToast } from "@/lib/appToast";

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
  claimsAutomaticTransition: boolean;
  approvalId: string | null;
  approvedAt: string | null;
  createdByEmail: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  waves: WaveView[];
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

const ATTESTATION_LABEL: Record<string, string> = {
  differences_stated:
    "The copy states the capability and credit differences",
  staging_verified: "The migration was rehearsed on staging",
  reconciliation_ready: "The reconciliation script and its rollback are ready",
};

const ATTESTATION_ABOUT: Record<string, string> = {
  differences_stated:
    "About the body. Goes stale when the copy changes, because the reading no longer describes what would be sent.",
  staging_verified:
    "About the migration. A copy edit does not undo a rehearsal, so this does not expire with one.",
  reconciliation_ready:
    "About the script. A copy edit does not undo it either.",
};

const EXCLUDED_LABEL: Record<string, string> = {
  no_email: "No address on the account",
  account_inactive: "Account inactive",
  suppressed: "Address suppressed",
  no_consent: "No consent for this purpose",
  plan_incompatible: "Replacement not available on their plan",
  already_changed: "No longer in any cohort",
};

const COHORT_LABEL: Record<string, string> = {
  default_model: "Their default model",
  new_conversation_lead: "Lead of their new-conversation set",
  conversation_selection: "Selected in a conversation",
};

const when = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toISOString().replace("T", " ").slice(0, 16);
};

export function AdminCampaignDetailPanel({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");

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
            : "Could not load this campaign."
        );
      }
      setData(payload);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not load this campaign.",
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
        dispatchAppToast(
          "Recorded. A second administrator has to approve this in the work queue before the campaign is approved.",
          "success"
        );
        return null;
      }
      throw new Error(
        typeof payload?.error === "string"
          ? payload.error
          : "The request was refused."
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
        error instanceof Error ? error.message : "The request was refused.",
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
          {loading ? "Loading the campaign…" : "This campaign could not be loaded."}
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
            Refresh
          </button>
        </div>

        <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Status", campaign.status],
            ["Trigger", campaign.triggerMode],
            ["Languages", campaign.locales.join(", ") || "—"],
            [
              "Effective",
              campaign.effectiveAt
                ? `${when(campaign.effectiveAt)} (${campaign.timezoneLabel ?? "no timezone"})`
                : "—",
            ],
            [
              "Models",
              campaign.targetModelId
                ? `${campaign.targetModelId} → ${campaign.replacementModelId ?? "—"}`
                : "—",
            ],
            [
              "Estimated recipients",
              campaign.estimatedRecipients === null
                ? "not estimated"
                : `${campaign.estimatedRecipients} (audience v${campaign.audienceVersion})`,
            ],
            ["Work item", campaign.workItemId ?? "—"],
            ["Drafted by", campaign.createdByEmail],
            [
              "Approved",
              campaign.approvedAt ? when(campaign.approvedAt) : "not approved",
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
            Cancelled {when(campaign.cancelledAt)}: {campaign.cancelReason}
          </p>
        ) : null}
      </section>

      <section
        className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5"
        data-testid="admin-campaign-gates"
      >
        <h3 className="text-lg font-black text-white">What this campaign is waiting on</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          Asked of the server every time this page loads. A gate answered once is
          a gate that was true once — a replacement model can be disabled and a
          copy edit takes an attestation with it.
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
              {sendRefusal ? `Send refused: ${sendRefusal.refusal}` : "The send gate passes"}
            </p>
            {sendRefusal ? (
              <p className="mt-1 text-sm leading-6 text-amber-100">
                {sendRefusal.message}
              </p>
            ) : (
              <p className="mt-1 text-sm leading-6 text-emerald-100">
                Nothing refuses this campaign right now. It is still re-asked at
                the moment each wave runs.
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
                ? `${scheduleProblems.length} problem(s) with the schedule`
                : "The schedule is consistent"}
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
                This campaign promises an automatic transition
              </p>
              <p className="mt-1 text-sm leading-6 text-zinc-300">
                {transitionClaim?.mayClaim
                  ? "Every condition for that promise is met."
                  : `${transitionClaim?.unmet.length ?? 0} of the twelve conditions are unmet. The send is refused rather than quietly downgraded to the safe sentence — otherwise words nobody chose would go out and the operator would never learn the promise was not made.`}
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
        <h3 className="text-lg font-black text-white">Attestations</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          Three things no column can answer, so a person says them. Recorded with
          who and when — that is what makes an attestation worth more than a
          parameter somebody passed.
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
                {ATTESTATION_LABEL[attestation.kind] ?? attestation.kind}
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {ATTESTATION_ABOUT[attestation.kind] ?? ""}
              </p>
              <p className="mt-2 text-sm text-zinc-200">
                {attestation.stale
                  ? `${attestation.attestedByEmail} said this on ${when(attestation.attestedAt)}, and the copy has changed since. It no longer describes what would be sent.`
                  : attestation.satisfied
                    ? `${attestation.attestedByEmail} said this on ${when(attestation.attestedAt)}.`
                    : "Nobody has said this."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void run(
                      `attest:${attestation.kind}`,
                      () =>
                        send("/attestations", "POST", { kind: attestation.kind }),
                      "Recorded."
                    )
                  }
                  disabled={busy !== null}
                  className="inline-flex min-h-11 items-center rounded-xl border border-blue-500/40 bg-blue-500/15 px-4 text-sm font-bold text-white hover:border-blue-400 disabled:opacity-60"
                >
                  {attestation.satisfied ? "Re-attest" : "I checked this"}
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
                        "Withdrawn."
                      )
                    }
                    disabled={busy !== null}
                    className="inline-flex min-h-11 items-center rounded-xl border border-zinc-800 bg-zinc-900 px-4 text-sm font-bold text-zinc-200 hover:border-zinc-700 disabled:opacity-60"
                  >
                    Withdraw
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <h3 className="text-lg font-black text-white">Approval</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          The only two-person action here, and the only place a person reads the
          copy. Drafting sends nothing; scheduling a wave sends nothing; running
          a wave carries out what was approved. Approving is what is reviewed.
        </p>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          The request carries this campaign&rsquo;s language list —{" "}
          <span
            className="font-mono text-zinc-200"
            data-testid="admin-campaign-approve-locales"
          >
            {campaign.locales.join(", ") || "none"}
          </span>{" "}
          — so an approval cannot be inherited by a campaign that has since
          changed which languages it sends in.
        </p>
        <label className="mt-4 block text-sm font-bold text-zinc-200">
          Why this may go out
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            className="mt-2 min-h-11 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 text-sm text-white placeholder:text-zinc-600"
            placeholder="Read the copy in every language and confirmed the effective date"
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
              "Approved."
            )
          }
          disabled={busy !== null || reason.trim().length === 0}
          className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-blue-500/40 bg-blue-500/15 px-5 text-sm font-bold text-white hover:border-blue-400 disabled:opacity-60"
          data-testid="admin-campaign-approve"
        >
          Approve this campaign
        </button>
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <h3 className="text-lg font-black text-white">Waves</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          Listed in the order they are meant to happen, not the order they are
          scheduled — a reminder set before its announcement is a mistake, and a
          list sorted by time would render it as a correct-looking sequence.
        </p>
        {campaign.waves.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
            No waves have been created for this campaign.
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
                        ? `due ${when(wave.scheduledAt)}`
                        : "started by hand"}
                      {wave.dryRun ? " · dry run" : ""}
                      {wave.recipientCap === null
                        ? ""
                        : ` · cap ${wave.recipientCap}`}
                      {` · expanded ${wave.expandedCount}`}
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
                        "Started."
                      )
                    }
                    disabled={busy !== null}
                    className="inline-flex min-h-11 items-center rounded-xl border border-zinc-800 bg-zinc-900 px-4 text-sm font-bold text-zinc-200 hover:border-zinc-700 disabled:opacity-60"
                  >
                    Start now
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5"
        data-testid="admin-campaign-audience"
      >
        <h3 className="text-lg font-black text-white">Who each wave reached</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          The expansion ledger, read back. Every person the expander considered
          is one row: either a delivery was written for them, or a reason was
          recorded for why it was not.
        </p>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          Counts, not people. Each row holds the address it was written to, and
          whether an operator may see addresses on a campaign screen is the same
          open question as the one on Email delivery. Building the list would be
          answering it.
        </p>

        {audience.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
            No wave has expanded yet, so nobody has been considered.
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
                    {wave.total} considered
                  </p>
                </div>

                {wave.total === 0 ? (
                  <p className="mt-2 text-sm text-zinc-400">
                    This wave has not expanded.
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
                          would have been written to — this was a dry run, so
                          every one of those deliveries was skipped and nothing
                          was sent.
                        </span>
                      ) : (
                        "had a delivery row written."
                      )}
                    </p>

                    <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                      {Object.entries(wave.excluded).map(([reason, count]) => (
                        <div
                          key={reason}
                          className="flex items-baseline justify-between gap-3 border-b border-zinc-900 py-1"
                        >
                          <dt className="min-w-0 text-sm text-zinc-400">
                            {EXCLUDED_LABEL[reason] ?? reason}
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
                      Why they were in the audience
                    </p>
                    <dl className="mt-1 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                      {Object.entries(wave.cohorts).map(([cohort, count]) => (
                        <div
                          key={cohort}
                          className="flex items-baseline justify-between gap-3 py-1"
                        >
                          <dt className="min-w-0 text-sm text-zinc-400">
                            {COHORT_LABEL[cohort] ?? cohort}
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
                        {wave.malformed} of these people had a stored value the
                        parser could not read. It was reported and left exactly
                        as it was — nothing rewrote it — so the count is here
                        rather than in a log nobody opens.
                      </p>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
        <h3 className="text-lg font-black text-white">Cancel</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          Cancelling stops every wave that has not started.{" "}
          {editable
            ? "This campaign can still be edited through the API; once it is approved, editing is refused and cancelling is how it is stopped."
            : "This campaign can no longer be edited — an approval covers the copy it was given, so changing it afterwards is what this layer refuses. Cancel it and draft another."}
        </p>
        <label className="mt-4 block text-sm font-bold text-zinc-200">
          Why
          <input
            type="text"
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            maxLength={500}
            className="mt-2 min-h-11 w-full rounded-xl border border-zinc-800 bg-zinc-900 px-4 text-sm text-white placeholder:text-zinc-600"
            placeholder="The retirement date moved"
            data-testid="admin-campaign-cancel-reason"
          />
        </label>
        <button
          type="button"
          onClick={() =>
            void run(
              "cancel",
              () => send("", "PATCH", { cancelReason: cancelReason.trim() }),
              "Cancelled."
            )
          }
          disabled={busy !== null || cancelReason.trim().length === 0}
          className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-red-800 bg-red-950/40 px-5 text-sm font-bold text-red-100 hover:border-red-700 disabled:opacity-60"
          data-testid="admin-campaign-cancel"
        >
          Cancel this campaign
        </button>
      </section>
    </div>
  );
}
