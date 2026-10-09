"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, Loader2, Scale } from "lucide-react";

import { dispatchAppToast } from "@/lib/appToast";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import {
  useAdminLocale,
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import {
  describeAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { adminEmailCampaignsMessages } from "@/lib/adminMessages/emailCampaigns";
import { adminFetch } from "@/lib/adminFetch";
import { POLICY_NOTICE_CAMPAIGN_WAVES } from "@/lib/emailAudienceExpansionCore";

type Preview = {
  language: string;
  subject: string;
  html: string;
  text: string;
  contentHash: string;
};

/**
 * Drafts the amendment notice campaign (S10).
 *
 * Nothing here is editable. The notice's wording is fixed and approved by hash
 * (lib/policyChangeNoticeEmail.ts), so the only things this panel decides are
 * that the campaign is the notice, in every language the notice is approved
 * in, to the notice's own cohort. Approval and sending stay on the campaign's
 * own page, under the same gates as every other campaign.
 */
export function AdminPolicyNoticeComposer({
  mayWrite,
  campaignsEnabled,
  templateKey,
  locales,
  effectiveDate,
  wordingApproved,
}: {
  mayWrite: boolean;
  campaignsEnabled: boolean;
  templateKey: string;
  locales: readonly string[];
  /** YYYY-MM-DD, or null while the notice has no date. */
  effectiveDate: string | null;
  /** Every locale renders to an approved hash on this deployment. */
  wordingApproved: boolean;
}) {
  const router = useRouter();
  const m = useAdminMessages(adminEmailCampaignsMessages).noticeComposer;
  const { locale: apiLocale } = useAdminLocale();
  const [apiFailure, setApiFailure] = useState<AdminApiFailure | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [copyDigest, setCopyDigest] = useState<string | null>(null);
  const [language, setLanguage] = useState(locales[0] ?? "en");
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const ready = Boolean(effectiveDate) && wordingApproved;
  const currentPreview = previews.find((preview) => preview.language === language);

  const request = async (path: string) => {
    setApiFailure(null);
    const response = await adminFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateKey,
        locales,
        // The notice takes no content: its words are the approved render.
        contentByLocale: Object.fromEntries(locales.map((entry) => [entry, {}])),
        ...(path.endsWith("/preview")
          ? {}
          : {
              category: "other",
              audienceSpec: {
                cohort: { kind: "policy_change_notice", effectiveDate },
              },
              triggerMode: "manual",
              // The campaign page runs only waves the draft created.
              waves: POLICY_NOTICE_CAMPAIGN_WAVES,
            }),
      }),
    });
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      const outcome = describeAdminApiFailure({
        status: response.status,
        error: typeof payload?.error === "string" ? payload.error : null,
        code: typeof payload?.code === "string" ? payload.code : null,
        approvalId:
          typeof payload?.approvalId === "string" ? payload.approvalId : null,
        fallback: path.endsWith("/preview") ? m.previewFailed : m.createFailed,
        locale: apiLocale,
      });
      setApiFailure(outcome);
      throw new Error(outcome.message);
    }
    return payload;
  };

  const preview = async () => {
    if (busy) return;
    setBusy("preview");
    try {
      const payload = await request("/api/admin/email-campaigns/preview");
      setPreviews((payload?.previews as Preview[]) ?? []);
      setCopyDigest(
        typeof payload?.copyDigest === "string" ? payload.copyDigest : null
      );
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.previewFailed,
        "error"
      );
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (busy || !mayWrite || !campaignsEnabled || !ready || !copyDigest) return;
    setBusy("create");
    try {
      const payload = await request("/api/admin/email-campaigns");
      const campaign = payload?.campaign as { id?: unknown } | undefined;
      if (typeof campaign?.id !== "string") throw new Error(m.createFailed);
      dispatchAppToast(m.created, "success");
      router.push(`/admin/email-campaigns/${encodeURIComponent(campaign.id)}`);
      router.refresh();
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.createFailed,
        "error"
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5"
      data-testid="admin-policy-notice-composer"
    >
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
        {m.badge}
      </p>
      <h2 className="mt-2 text-2xl font-black text-white">{m.title}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">{m.intro}</p>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-300">
        {effectiveDate ? m.audience(effectiveDate) : m.noDate}
      </p>
      {!wordingApproved ? (
        <p className="mt-4 rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-sm leading-6 text-amber-100">
          {m.notApproved}
        </p>
      ) : null}
      {!mayWrite ? (
        <p className="mt-4 rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-100">
          {m.readOnly}
        </p>
      ) : null}
      {!campaignsEnabled ? (
        <p className="mt-4 rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-sm leading-6 text-amber-100">
          {m.disabled}
        </p>
      ) : null}
      {apiFailure ? <AdminApiFailureNotice failure={apiFailure} /> : null}

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void preview()}
          disabled={Boolean(busy)}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:border-zinc-600 disabled:opacity-60"
          data-testid="admin-policy-notice-preview"
        >
          {busy === "preview" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Eye className="h-4 w-4" aria-hidden />
          )}
          {busy === "preview" ? m.previewing : m.preview}
        </button>
        <button
          type="button"
          onClick={() => void create()}
          disabled={
            Boolean(busy) || !mayWrite || !campaignsEnabled || !ready || !copyDigest
          }
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="admin-policy-notice-create"
        >
          {busy === "create" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Scale className="h-4 w-4" aria-hidden />
          )}
          {busy === "create" ? m.creating : m.create}
        </button>
      </div>
      {!copyDigest ? (
        <p className="mt-2 text-xs text-zinc-500">{m.previewFirst}</p>
      ) : null}

      {previews.length > 0 ? (
        <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="flex flex-wrap gap-2 px-2 py-1">
            {locales.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setLanguage(entry)}
                aria-pressed={language === entry}
                className={`min-h-10 rounded-xl border px-4 text-sm font-bold ${
                  language === entry
                    ? "border-blue-500 bg-blue-950 text-blue-100"
                    : "border-zinc-800 bg-zinc-900 text-zinc-400"
                }`}
              >
                {entry.toUpperCase()}
              </button>
            ))}
          </div>
          {currentPreview ? (
            <>
              <p className="px-2 py-2 text-xs text-zinc-400">
                {currentPreview.subject}
              </p>
              <iframe
                title={`${m.previewTitle} ${language.toUpperCase()}`}
                sandbox=""
                srcDoc={currentPreview.html}
                className="h-[640px] w-full rounded-xl bg-white"
              />
            </>
          ) : null}
          {copyDigest ? (
            <p className="mt-3 break-all px-2 font-mono text-[10px] leading-4 text-zinc-500">
              {m.digest}: {copyDigest}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
