"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Mail, RefreshCw } from "lucide-react";

import { dispatchAppToast } from "@/lib/appToast";

/**
 * The jurisdiction policy console.
 *
 * Contract: docs/policy/email-notifications.md §12.5.
 *
 * Three things this screen is built to make hard to get wrong:
 *
 *  - **Activation is never one click from a list.** It asks for a reason and
 *    then answers 409 the first time, because the second administrator has not
 *    approved it yet. That is the two-person rule (§12.3) surfacing where the
 *    act happens rather than in a runbook.
 *  - **Every value shows its sources.** §12.5 requires it: an operator asked to
 *    change a subject prefix cannot judge the change without knowing what the
 *    current one is based on, and a footnote in a document nobody has open is
 *    not knowing.
 *  - **A superseded version is still readable.** "What was in force on the
 *    14th" is the question an audit asks, and a screen that only rendered the
 *    active row could not answer it.
 */

type ProfileView = {
  profileKey: string;
  marketingBasis: string;
  subjectPrefix: string | null;
  footerBlocks: unknown;
  unsubscribeSlaBusinessDays: number;
  consentNoticeIntervalMonths: number | null;
  quietHours: unknown;
  impliedConsentDays: unknown;
  notes: string;
  countries: string[];
};

type VersionSummary = {
  id: string;
  version: string;
  status: string;
  changeSummary: string;
  activatedAt: string | null;
  supersededAt: string | null;
  approvedByEmail: string | null;
  approvedAt: string | null;
  createdAt: string;
  profileCount: number;
  countryCount: number;
};

type PolicyResponse = {
  versions: VersionSummary[];
  selected: (VersionSummary & { profiles: ProfileView[] }) | null;
};

const dateLabel = (value: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

const footerBlockList = (value: unknown) =>
  Array.isArray(value) ? value.map(String) : [];

const quietHoursLabel = (value: unknown) => {
  if (!value || typeof value !== "object") return "—";
  const window = value as { start?: unknown; end?: unknown; tz?: unknown };
  if (!window.start || !window.end) return "—";
  return `${String(window.start)}–${String(window.end)} ${String(window.tz ?? "")}`.trim();
};

const STATUS_STYLE: Record<string, string> = {
  active: "border-emerald-700 bg-emerald-950/60 text-emerald-300",
  draft: "border-amber-700 bg-amber-950/60 text-amber-300",
  superseded: "border-zinc-700 bg-zinc-900 text-zinc-400",
};

export function AdminEmailPolicyPanel() {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"draft" | "activate" | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async (versionId?: string | null) => {
    setLoading(true);
    try {
      const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
      const response = await fetch(`/api/admin/email-policy${query}`, {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | PolicyResponse
        | { error?: string }
        | null;
      if (!response.ok || !payload || !("versions" in payload)) {
        throw new Error(
          payload && "error" in payload && payload.error
            ? payload.error
            : "Could not load jurisdiction policy versions."
        );
      }
      setData(payload);
      setSelectedId(payload.selected?.id ?? null);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error
          ? error.message
          : "Could not load jurisdiction policy versions.",
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/admin/email-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!response.ok) {
      const code = payload?.code;
      // The expected first answer, not a failure: the request has been
      // recorded and is waiting for a second administrator.
      if (code === "ADMIN_APPROVAL_REQUIRED") {
        dispatchAppToast(
          "Recorded. A second administrator has to approve this in the work queue before it takes effect.",
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

  const createDraft = async () => {
    if (busy) return;
    setBusy("draft");
    try {
      const result = await post({ action: "create_draft" });
      dispatchAppToast(
        result?.created
          ? "Draft created. It changes nothing until it is activated."
          : "That draft already exists.",
        "success"
      );
      await load(
        typeof (result?.version as { id?: string })?.id === "string"
          ? (result?.version as { id: string }).id
          : selectedId
      );
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not create the draft.",
        "error"
      );
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    if (busy || !selectedId || reason.trim().length === 0) return;
    setBusy("activate");
    try {
      const result = await post({
        action: "activate",
        versionId: selectedId,
        reason: reason.trim(),
      });
      if (result) {
        dispatchAppToast("Activated. The previous version is now superseded.", "success");
        setReason("");
      }
      await load(selectedId);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Could not activate the version.",
        "error"
      );
    } finally {
      setBusy(null);
    }
  };

  const selected = data?.selected ?? null;

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
            Email
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">
            Jurisdiction policy
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            Subject prefixes, footer blocks, unsubscribe wording, quiet hours and
            consent notice intervals, per jurisdiction. Exactly one version is in
            force; a delivery already in flight keeps the version it was rendered
            under.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void load(selectedId)}
            disabled={loading}
            data-testid="email-policy-refresh"
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-sm font-bold text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </button>
          <button
            type="button"
            onClick={createDraft}
            disabled={busy !== null}
            data-testid="email-policy-create-draft"
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-zinc-700 px-3 py-2 text-sm font-bold text-zinc-200 transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Mail className="h-4 w-4" />
            Seed draft
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[18rem_1fr]">
        <ol className="space-y-2" data-testid="email-policy-versions">
          {(data?.versions ?? []).map((version) => (
            <li key={version.id}>
              <button
                type="button"
                onClick={() => void load(version.id)}
                aria-current={version.id === selectedId ? "true" : undefined}
                className={`w-full cursor-pointer rounded-2xl border px-3 py-3 text-left transition ${
                  version.id === selectedId
                    ? "border-blue-600 bg-blue-950/40"
                    : "border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-zinc-300">
                    {version.version}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${
                      STATUS_STYLE[version.status] ?? STATUS_STYLE.superseded
                    }`}
                  >
                    {version.status}
                  </span>
                </span>
                <span className="mt-1 block text-xs leading-5 text-zinc-500">
                  {version.profileCount} profiles · {version.countryCount} countries
                </span>
              </button>
            </li>
          ))}
          {data && data.versions.length === 0 ? (
            <li className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-3 py-4 text-xs leading-5 text-zinc-400">
              No policy version exists yet. Seeding one creates a draft; nothing
              is sent under it until it is activated.
            </li>
          ) : null}
        </ol>

        <div>
          {selected ? (
            <>
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                <p className="text-sm leading-6 text-zinc-300">
                  {selected.changeSummary}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
                  {[
                    ["Created", dateLabel(selected.createdAt)],
                    ["Activated", dateLabel(selected.activatedAt)],
                    ["Superseded", dateLabel(selected.supersededAt)],
                    ["Approved by", selected.approvedByEmail ?? "—"],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2"
                    >
                      <dt className="text-zinc-500">{label}</dt>
                      <dd className="mt-0.5 break-all text-zinc-200">{value}</dd>
                    </div>
                  ))}
                </dl>

                {selected.status === "draft" ? (
                  <div className="mt-4 border-t border-zinc-800 pt-4">
                    <label
                      htmlFor="email-policy-reason"
                      className="text-xs font-bold text-zinc-300"
                    >
                      Why this version is being activated
                    </label>
                    <p
                      id="email-policy-reason-help"
                      className="mt-1 text-xs leading-5 text-zinc-500"
                    >
                      Activation needs a second administrator&rsquo;s approval.
                      The first submission records the request; the change lands
                      when the approval is granted and the request is repeated.
                    </p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <input
                        id="email-policy-reason"
                        value={reason}
                        aria-describedby="email-policy-reason-help"
                        onChange={(event) => setReason(event.target.value)}
                        maxLength={500}
                        className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
                      />
                      <button
                        type="button"
                        onClick={activate}
                        disabled={busy !== null || reason.trim().length === 0}
                        data-testid="email-policy-activate"
                        className="shrink-0 cursor-pointer rounded-xl border border-emerald-700 bg-emerald-950/60 px-4 py-2 text-sm font-bold text-emerald-200 transition hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Activate
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                {selected.profiles.map((profile) => (
                  <article
                    key={profile.profileKey}
                    data-testid={`email-policy-profile-${profile.profileKey}`}
                    className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-mono text-sm font-bold text-white">
                        {profile.profileKey}
                      </h3>
                      <span className="text-xs text-zinc-500">
                        {profile.marketingBasis}
                      </span>
                    </div>

                    <dl className="mt-3 space-y-1 text-xs">
                      <div className="flex gap-2">
                        <dt className="w-40 shrink-0 text-zinc-500">
                          Subject prefix
                        </dt>
                        <dd className="font-mono text-zinc-200">
                          {profile.subjectPrefix
                            ? JSON.stringify(profile.subjectPrefix)
                            : "—"}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-40 shrink-0 text-zinc-500">Footer blocks</dt>
                        <dd className="text-zinc-200">
                          {footerBlockList(profile.footerBlocks).join(", ") || "—"}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-40 shrink-0 text-zinc-500">
                          Unsubscribe copy
                        </dt>
                        <dd className="text-zinc-200">
                          {profile.unsubscribeSlaBusinessDays} business days
                          <span className="text-zinc-500"> (processed immediately)</span>
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-40 shrink-0 text-zinc-500">Consent notice</dt>
                        <dd className="text-zinc-200">
                          {profile.consentNoticeIntervalMonths
                            ? `every ${profile.consentNoticeIntervalMonths} months`
                            : "no duty"}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-40 shrink-0 text-zinc-500">Quiet hours</dt>
                        <dd className="text-zinc-200">
                          {quietHoursLabel(profile.quietHours)}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="w-40 shrink-0 text-zinc-500">Countries</dt>
                        <dd className="break-all font-mono text-zinc-200">
                          {profile.countries.join(" ") || "— (fallback)"}
                        </dd>
                      </div>
                    </dl>

                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-bold text-blue-300">
                        Sources and confirmation dates
                      </summary>
                      <p className="mt-2 whitespace-pre-line text-xs leading-5 text-zinc-400">
                        {profile.notes}
                      </p>
                    </details>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <p className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-6 text-sm leading-6 text-zinc-400">
              Nothing selected.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
