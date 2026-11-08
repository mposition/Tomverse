"use client";

import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mail, RefreshCw } from "lucide-react";

import { dispatchAppToast } from "@/lib/appToast";
import {
  describeAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { useAdminMessages,
  useAdminLocale,
} from "@/components/admin/AdminLocaleProvider";
import { adminEmailPolicyMessages } from "@/lib/adminMessages/emailPolicy";
import { adminFetch } from "@/lib/adminFetch";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";

/**
 * The jurisdiction policy console.
 *
 * Contract: docs/policy/email-notifications.md §12.5.
 *
 * Three things this screen is built to make hard to get wrong:
 *
 *  - **Activation is never one click from a list.** It asks for a reason. The
 *    administrator who submits it activates the version, and the audit log
 *    records who did it and why.
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

const dateLabel = (value: string | null) => formatAestDateTime(value) ?? "—";

const footerBlockList = (value: unknown) =>
  Array.isArray(value) ? value.map(String) : [];

const quietHoursLabel = (value: unknown) => {
  if (!value || typeof value !== "object") return "—";
  const window = value as { start?: unknown; end?: unknown; tz?: unknown };
  if (!window.start || !window.end) return "—";
  return `${String(window.start)}–${String(window.end)} ${String(window.tz ?? "")}`.trim();
};

/** One jurisdiction: its countries, the version in force and the rules it carries. */
export function AdminEmailPolicyProfileCard({
  profile,
  version,
  status,
}: {
  profile: ProfileView;
  version: string;
  status: string;
}) {
  const messages = useAdminMessages(adminEmailPolicyMessages);
  const m = messages.policy;
  const tone: AdminTone = status === "active" ? "ok" : status === "draft" ? "warn" : "idle";
  const label = m.status[status as keyof typeof m.status] ?? status;
  return (
    <article
      data-testid={`email-policy-profile-${profile.profileKey}`}
      className="flex min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-sm font-bold text-white">
          {profile.profileKey}
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-bold text-white">
            {profile.countries.join(" ") || m.profile.fallback}
          </h3>
          <p className="truncate text-xs text-zinc-500">{profile.marketingBasis}</p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
        <span>{m.profile.inForce}</span>
        <span className="font-bold text-zinc-100">{version}</span>
      </div>
      <AdminStatusChip tone={tone} className="justify-center">
        {label}
      </AdminStatusChip>

      <dl className="space-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="w-32 shrink-0 text-zinc-500">{m.profile.unsubscribeCopy}</dt>
          <dd className="text-zinc-200">
            {m.profile.businessDays(profile.unsubscribeSlaBusinessDays)}
            <span className="text-zinc-500">{m.profile.processedImmediately}</span>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-32 shrink-0 text-zinc-500">{m.profile.consentNotice}</dt>
          <dd className="text-zinc-200">
            {profile.consentNoticeIntervalMonths
              ? m.profile.everyMonths(profile.consentNoticeIntervalMonths)
              : m.profile.noDuty}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-32 shrink-0 text-zinc-500">{m.profile.quietHours}</dt>
          <dd className="text-zinc-200">{quietHoursLabel(profile.quietHours)}</dd>
        </div>
      </dl>

      <AdminTechInfo summary={m.profile.techSummary}>
        <dl className="space-y-1">
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-zinc-500">{m.profile.subjectPrefix}</dt>
            <dd className="text-zinc-200">
              {profile.subjectPrefix ? JSON.stringify(profile.subjectPrefix) : "—"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-zinc-500">{m.profile.footerBlocks}</dt>
            <dd className="text-zinc-200">
              {footerBlockList(profile.footerBlocks).join(", ") || "—"}
            </dd>
          </div>
        </dl>
        <p className="mt-3 font-sans text-xs font-bold text-zinc-400">{m.profile.sources}</p>
        <p className="mt-1 whitespace-pre-line font-sans text-xs leading-5 text-zinc-400">
          {profile.notes}
        </p>
      </AdminTechInfo>
    </article>
  );
}

export function AdminEmailPolicyPanel() {
  const messages = useAdminMessages(adminEmailPolicyMessages);
  const m = messages.policy;
  // Read through a ref so a language switch does not re-run `load`, which
  // would reset the selected version to the server's default.
  const loadFailedMessage = useRef(m.toast.loadFailed);
  useEffect(() => {
    loadFailedMessage.current = m.toast.loadFailed;
  }, [m.toast.loadFailed]);
  const { locale: apiLocale } = useAdminLocale();
  // Classified rather than thrown as a bare string. `describeAdminApiFailure`
  // tells a stale step-up window (428) apart from a fault, and the notice
  // below gives that refusal a way back -- rule 7 of
  // docs/ui-contracts/admin-console-ia.md.
  const [apiFailure, setApiFailure] = useState<AdminApiFailure | null>(null);
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<"draft" | "activate" | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async (versionId?: string | null) => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
      const response = await adminFetch(`/api/admin/email-policy${query}`, {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | PolicyResponse
        | { error?: string }
        | null;
      if (!response.ok || !payload || !("versions" in payload)) {
        const outcome = describeAdminApiFailure({
          status: response.status,
          error: payload && "error" in payload ? payload.error : null,
          fallback: loadFailedMessage.current,
          locale: apiLocale,
        });
        setApiFailure(outcome);
        throw new Error(outcome.message);
      }
      setData(payload);
      setSelectedId(payload.selected?.id ?? null);
    } catch (error) {
      // A failed read is an error block as well as a toast, never an empty list.
      setLoadFailed(true);
      dispatchAppToast(
        error instanceof Error ? error.message : loadFailedMessage.current,
        "error"
      );
    } finally {
      setLoading(false);
    }
  }, [apiLocale]);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    const response = await adminFetch("/api/admin/email-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!response.ok) {
      throw new Error(
        typeof payload?.error === "string" ? payload.error : m.toast.refused
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
        result?.created ? m.toast.draftCreated : m.toast.draftExists,
        "success"
      );
      await load(
        typeof (result?.version as { id?: string })?.id === "string"
          ? (result?.version as { id: string }).id
          : selectedId
      );
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.toast.draftFailed,
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
        dispatchAppToast(m.toast.activated, "success");
        setReason("");
      }
      await load(selectedId);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.toast.activateFailed,
        "error"
      );
    } finally {
      setBusy(null);
    }
  };

  const selected = data?.selected ?? null;
  const statusTone = (status: string): AdminTone =>
    status === "active" ? "ok" : status === "draft" ? "warn" : "idle";
  const statusLabel = (status: string) =>
    m.status[status as keyof typeof m.status] ?? status;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {apiFailure ? <AdminApiFailureNotice failure={apiFailure} /> : null}

      <AdminTile
        title={m.title}
        description={m.intro}
        action={
          <>
            <AdminWriteButton
              variant="secondary"
              onClick={() => void load(selectedId)}
              disabled={loading}
              data-testid="email-policy-refresh"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden />
              )}
              {m.refresh}
            </AdminWriteButton>
            <AdminWriteButton
              variant="secondary"
              onClick={createDraft}
              disabled={busy !== null}
              data-testid="email-policy-create-draft"
            >
              <Mail className="h-4 w-4" aria-hidden />
              {m.seedDraft}
            </AdminWriteButton>
          </>
        }
      >
        {loadFailed && !data ? (
          <AdminStateBlock
            kind="error"
            title={m.toast.loadFailed}
            detail={m.loadFailedDetail}
            onRetry={() => void load(selectedId)}
          />
        ) : !data ? (
          <AdminStateBlock kind="loading" />
        ) : (
          <ol className="flex flex-wrap gap-2" data-testid="email-policy-versions">
            {data.versions.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  onClick={() => void load(version.id)}
                  aria-current={version.id === selectedId ? "true" : undefined}
                  className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-2xl border px-3 py-2 text-left transition ${
                    version.id === selectedId
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-zinc-800 bg-zinc-950/40 hover:bg-zinc-800"
                  }`}
                >
                  <span className="flex flex-col">
                    <span className="text-sm font-bold text-zinc-100">{version.version}</span>
                    <span className="text-xs text-zinc-500">
                      {m.versionCounts(version.profileCount, version.countryCount)}
                    </span>
                  </span>
                  <AdminStatusChip tone={statusTone(version.status)}>
                    {statusLabel(version.status)}
                  </AdminStatusChip>
                </button>
              </li>
            ))}
            {data.versions.length === 0 ? (
              <li className="w-full">
                <AdminStateBlock kind="empty" title={m.noVersions} />
              </li>
            ) : null}
          </ol>
        )}
      </AdminTile>

      {selected ? (
        <>
          <AdminTile title={selected.version} description={selected.changeSummary}>
            <dl className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
              {[
                [m.fields.created, dateLabel(selected.createdAt)],
                [m.fields.activated, dateLabel(selected.activatedAt)],
                [m.fields.superseded, dateLabel(selected.supersededAt)],
                [m.fields.approvedBy, selected.approvedByEmail ?? "—"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-zinc-950/60 px-3 py-2">
                  <dt className="text-zinc-500">{label}</dt>
                  <dd className="mt-0.5 break-all text-zinc-200">{value}</dd>
                </div>
              ))}
            </dl>

            {selected.status === "draft" ? (
              <div className="border-t border-zinc-800 pt-4">
                <label htmlFor="email-policy-reason" className="text-xs font-bold text-zinc-300">
                  {m.reasonLabel}
                </label>
                <p id="email-policy-reason-help" className="mt-1 text-xs leading-5 text-zinc-500">
                  {m.reasonHelp}
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
                  <AdminWriteButton
                    onClick={activate}
                    disabled={busy !== null || reason.trim().length === 0}
                    data-testid="email-policy-activate"
                  >
                    {m.activate}
                  </AdminWriteButton>
                </div>
              </div>
            ) : null}
          </AdminTile>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {selected.profiles.map((profile) => (
              <AdminEmailPolicyProfileCard
                key={profile.profileKey}
                profile={profile}
                version={selected.version}
                status={selected.status}
              />
            ))}
          </div>
        </>
      ) : data ? (
        <AdminStateBlock kind="empty" title={m.nothingSelected} />
      ) : null}
    </div>
  );
}
