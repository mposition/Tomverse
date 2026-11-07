"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, Loader2, Send } from "lucide-react";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";

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
import {
  type AssistantKnowledgeCampaignLanguage,
  type ProductAnnouncementContent,
} from "@/lib/productAnnouncementEmail";
import { adminFetch } from "@/lib/adminFetch";

const PRODUCT_ANNOUNCEMENT_TEMPLATE = "product_announcement";

type ComposerLocale = AssistantKnowledgeCampaignLanguage;
type Preview = {
  language: string;
  subject: string;
  html: string;
  text: string;
  contentHash: string;
};

const inputClass =
  "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 outline-none transition focus:border-blue-500";

export function AdminCampaignComposer({
  mayWrite,
  campaignsEnabled,
  starterContent,
}: {
  mayWrite: boolean;
  campaignsEnabled: boolean;
  starterContent: Record<ComposerLocale, ProductAnnouncementContent>;
}) {
  const router = useRouter();
  const m = useAdminMessages(adminEmailCampaignsMessages).composer;
  const { locale: apiLocale } = useAdminLocale();
  const [apiFailure, setApiFailure] = useState<AdminApiFailure | null>(null);
  const [content, setContent] = useState(() =>
    structuredClone(starterContent)
  );
  const [locale, setLocale] = useState<ComposerLocale>("ko");
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [copyDigest, setCopyDigest] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const editRevision = useRef(0);
  const locales = useMemo(() => Object.keys(content) as ComposerLocale[], [content]);
  const current = content[locale];
  const currentPreview = previews.find((preview) => preview.language === locale);

  const update = <K extends keyof ProductAnnouncementContent>(
    key: K,
    value: ProductAnnouncementContent[K]
  ) => {
    editRevision.current += 1;
    setContent((previous) => ({
      ...previous,
      [locale]: { ...previous[locale], [key]: value },
    }));
    setPreviews([]);
    setCopyDigest(null);
  };

  const updateFeature = (
    index: number,
    key: "title" | "body",
    value: string
  ) => {
    const features = current.features.map((feature, featureIndex) =>
      featureIndex === index ? { ...feature, [key]: value } : feature
    );
    update("features", features);
  };

  const updateMedia = (
    key: "posterUrl" | "alt" | "badge",
    value: string
  ) => {
    update("media", {
      posterUrl: current.media?.posterUrl ?? "",
      alt: current.media?.alt ?? "",
      badge: current.media?.badge ?? "",
      [key]: value,
    });
  };

  const request = async (path: string) => {
    setApiFailure(null);
    const response = await adminFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateKey: PRODUCT_ANNOUNCEMENT_TEMPLATE,
        locales,
        contentByLocale: content,
        ...(path.endsWith("/preview")
          ? {}
          : {
              category: "other",
              audienceSpec: {
                cohort: {
                  kind: "marketing_consent",
                  purpose: "product_updates",
                },
              },
              triggerMode: "manual",
              waves: [{ kind: "launch", sequence: 1 }],
            }),
      }),
    });
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      // 409 and 428 are answers, not faults: the shared notice names them and,
      // for a stale sign-in, links back into step-up for this screen.
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
    const requestedRevision = editRevision.current;
    setBusy("preview");
    try {
      const payload = await request("/api/admin/email-campaigns/preview");
      if (editRevision.current !== requestedRevision) return;
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
    if (busy || !mayWrite || !campaignsEnabled || !copyDigest) return;
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
    <AdminTile
      title={m.title}
      description={
        <>
          {m.intro}
          <span className="mt-1 block text-xs text-zinc-500">{m.audience}</span>
        </>
      }
      data-testid="admin-campaign-composer"
    >
      {!mayWrite ? (
        <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200">
          {m.readOnly}
        </p>
      ) : null}
      {!campaignsEnabled ? (
        <p className="rounded-xl bg-amber-500/10 p-3 text-sm leading-6 text-amber-200">
          {m.disabled}
        </p>
      ) : null}
      {apiFailure ? <AdminApiFailureNotice failure={apiFailure} /> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
        <div className="min-w-0">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">
              {m.locale}
            </p>
            <div className="mt-2 flex gap-2">
              {locales.map((language) => (
                <button
                  key={language}
                  type="button"
                  onClick={() => setLocale(language)}
                  aria-pressed={locale === language}
                  className={`min-h-10 rounded-xl px-4 text-sm font-bold ${
                    locale === language
                      ? "bg-zinc-100 text-zinc-900"
                      : "border border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
                  }`}
                >
                  {language.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-4">
            {(
              [
                ["subject", m.subject],
                ["preheader", m.preheader],
                ["eyebrow", m.eyebrow],
                ["headline", m.headline],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="text-xs font-bold text-zinc-400">
                {label}
                <input
                  value={current[key]}
                  onChange={(event) => update(key, event.target.value)}
                  className={inputClass}
                />
              </label>
            ))}
            <label className="text-xs font-bold text-zinc-400">
              {m.introLabel}
              <textarea
                rows={4}
                value={current.intro}
                onChange={(event) => update("intro", event.target.value)}
                className={inputClass}
              />
            </label>
            {current.media ? (
              <fieldset className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
                <legend className="px-1 text-xs font-bold uppercase tracking-wider text-blue-300">
                  {m.media}
                </legend>
                <label className="text-xs font-bold text-zinc-400">
                  {m.mediaPosterUrl}
                  <input
                    type="url"
                    value={current.media.posterUrl}
                    onChange={(event) =>
                      updateMedia("posterUrl", event.target.value)
                    }
                    className={inputClass}
                  />
                </label>
                <label className="mt-3 block text-xs font-bold text-zinc-400">
                  {m.mediaAlt}
                  <input
                    value={current.media.alt}
                    onChange={(event) => updateMedia("alt", event.target.value)}
                    className={inputClass}
                  />
                </label>
                <label className="mt-3 block text-xs font-bold text-zinc-400">
                  {m.mediaBadge}
                  <input
                    value={current.media.badge}
                    onChange={(event) =>
                      updateMedia("badge", event.target.value)
                    }
                    className={inputClass}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => update("media", null)}
                  className="mt-3 text-xs font-bold text-zinc-400 underline underline-offset-4 transition hover:text-zinc-200"
                >
                  {m.removeMedia}
                </button>
              </fieldset>
            ) : (
              <button
                type="button"
                onClick={() =>
                  update("media", { posterUrl: "", alt: "", badge: "" })
                }
                className="rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-bold text-zinc-200 transition hover:bg-zinc-800 hover:text-white"
              >
                {m.addMedia}
              </button>
            )}
            {current.features.map((feature, index) => (
              <fieldset
                key={index}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4"
              >
                <legend className="px-1 text-xs font-bold uppercase tracking-wider text-blue-300">
                  {m.feature(index + 1)}
                </legend>
                <label className="text-xs font-bold text-zinc-400">
                  {m.featureTitle}
                  <input
                    value={feature.title}
                    onChange={(event) =>
                      updateFeature(index, "title", event.target.value)
                    }
                    className={inputClass}
                  />
                </label>
                <label className="mt-3 block text-xs font-bold text-zinc-400">
                  {m.featureBody}
                  <textarea
                    rows={3}
                    value={feature.body}
                    onChange={(event) =>
                      updateFeature(index, "body", event.target.value)
                    }
                    className={inputClass}
                  />
                </label>
              </fieldset>
            ))}
            <label className="text-xs font-bold text-zinc-400">
              {m.closing}
              <textarea
                rows={3}
                value={current.closing ?? ""}
                onChange={(event) => update("closing", event.target.value)}
                className={inputClass}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-xs font-bold text-zinc-400">
                {m.ctaLabel}
                <input
                  value={current.ctaLabel}
                  onChange={(event) => update("ctaLabel", event.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="text-xs font-bold text-zinc-400">
                {m.ctaUrl}
                <input
                  type="url"
                  value={current.ctaUrl}
                  onChange={(event) => update("ctaUrl", event.target.value)}
                  className={inputClass}
                />
              </label>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <AdminWriteButton
              variant="secondary"
              onClick={() => void preview()}
              disabled={Boolean(busy)}
            >
              {busy === "preview" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Eye className="h-4 w-4" aria-hidden />
              )}
              {busy === "preview" ? m.previewing : m.preview}
            </AdminWriteButton>
            <AdminWriteButton
              writable={mayWrite}
              requiredRole="ops:write"
              onClick={() => void create()}
              disabled={Boolean(busy) || !campaignsEnabled || !copyDigest}
            >
              {busy === "create" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              {busy === "create" ? m.creating : m.create}
            </AdminWriteButton>
          </div>
        </div>

        <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950/40 p-3">
          <h3 className="px-2 py-1 text-sm font-black text-white">{m.previewTitle}</h3>
          {currentPreview ? (
            <>
              <p className="px-2 pb-3 text-xs text-zinc-400">
                {currentPreview.subject}
              </p>
              <iframe
                title={`${m.previewTitle} ${locale.toUpperCase()}`}
                sandbox=""
                srcDoc={currentPreview.html}
                className="h-[720px] w-full rounded-xl bg-white"
              />
              {copyDigest ? (
                <div className="mt-3">
                <AdminTechInfo summary={m.digest}>
                  <span className="break-all">{copyDigest}</span>
                </AdminTechInfo>
              </div>
              ) : null}
            </>
          ) : (
            <p className="rounded-xl border border-dashed border-zinc-700 p-6 text-sm leading-6 text-zinc-500">
              {m.previewEmpty}
            </p>
          )}
        </div>
      </div>
    </AdminTile>
  );
}

/**
 * The "New campaign" section: one writing surface at a time.
 *
 * The two composers used to sit open one above the other. Here an operator
 * picks what they are writing and only that composer is shown. The other stays
 * mounted but hidden, so switching back does not lose a half-written update or
 * a preview that was already rendered. The composers themselves, their requests
 * and their gates are unchanged.
 */
export function AdminCampaignNewTab({
  product,
  notice,
}: {
  product: React.ReactNode;
  notice: React.ReactNode;
}) {
  const m = useAdminMessages(adminEmailCampaignsMessages).newTab;
  const [kind, setKind] = useState<"product" | "notice">("product");
  const options = [
    { id: "product", label: m.product, hint: m.productHint },
    { id: "notice", label: m.notice, hint: m.noticeHint },
  ] as const;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div role="group" aria-label={m.kindLabel} className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={kind === option.id}
            data-testid={`admin-campaign-new-${option.id}`}
            onClick={() => setKind(option.id)}
            className={`rounded-2xl border p-4 text-left transition ${
              kind === option.id
                ? "border-blue-500 bg-blue-500/10"
                : "border-zinc-800 bg-zinc-900 hover:bg-zinc-800"
            }`}
          >
            <span className="block text-sm font-bold text-white">{option.label}</span>
            <span className="mt-0.5 block text-xs text-zinc-400">{option.hint}</span>
          </button>
        ))}
      </div>
      <div hidden={kind !== "product"}>{product}</div>
      <div hidden={kind !== "notice"}>{notice}</div>
    </div>
  );
}
