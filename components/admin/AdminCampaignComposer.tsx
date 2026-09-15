"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, Loader2, Send } from "lucide-react";

import { dispatchAppToast } from "@/lib/appToast";
import {
  useAdminLocale,
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import {
  readAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { adminFetch } from "@/lib/adminFetch";
import { adminEmailCampaignsMessages } from "@/lib/adminMessages/emailCampaigns";
import {
  type AssistantKnowledgeCampaignLanguage,
  type ProductAnnouncementPayload,
} from "@/lib/productAnnouncementEmail";

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
  "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 outline-none transition focus:border-teal-500";

export function AdminCampaignComposer({
  mayWrite,
  campaignsEnabled,
  starterContent,
}: {
  mayWrite: boolean;
  campaignsEnabled: boolean;
  starterContent: Record<ComposerLocale, ProductAnnouncementPayload>;
}) {
  const router = useRouter();
  const m = useAdminMessages(adminEmailCampaignsMessages).composer;
  const { locale: apiLocale } = useAdminLocale();
  const [content, setContent] = useState(() =>
    structuredClone(starterContent)
  );
  const [locale, setLocale] = useState<ComposerLocale>("ko");
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [copyDigest, setCopyDigest] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "create" | null>(null);
  const [apiFailure, setApiFailure] = useState<AdminApiFailure | null>(null);
  const editRevision = useRef(0);
  const locales = useMemo(() => Object.keys(content) as ComposerLocale[], [content]);
  const current = content[locale];
  const currentPreview = previews.find((preview) => preview.language === locale);

  const update = <K extends keyof ProductAnnouncementPayload>(
    key: K,
    value: ProductAnnouncementPayload[K]
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
    if (!response.ok) {
      const outcome = await readAdminApiFailure(response, {
        fallback: path.endsWith("/preview") ? m.previewFailed : m.createFailed,
        locale: apiLocale,
      });
      setApiFailure(outcome);
      dispatchAppToast(outcome.message, outcome.tone);
      return null;
    }
    setApiFailure(null);
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!payload) {
      throw new Error(
        path.endsWith("/preview") ? m.previewFailed : m.createFailed
      );
    }
    return payload;
  };

  const preview = async () => {
    if (busy) return;
    const requestedRevision = editRevision.current;
    setBusy("preview");
    try {
      const payload = await request("/api/admin/email-campaigns/preview");
      if (!payload) return;
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
      if (!payload) return;
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
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      {apiFailure ? <AdminApiFailureNotice failure={apiFailure} /> : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-300">
            {m.badge}
          </p>
          <h2 className="mt-2 text-2xl font-black text-white">{m.title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">{m.intro}</p>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-teal-200/80">
            {m.audience}
          </p>
        </div>
      </div>

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

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
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
                  className={`min-h-10 rounded-xl border px-4 text-sm font-bold ${
                    locale === language
                      ? "border-teal-500 bg-teal-950 text-teal-100"
                      : "border-zinc-800 bg-zinc-900 text-zinc-400"
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
                <legend className="px-1 text-xs font-bold uppercase tracking-wider text-teal-300">
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
                className="rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-bold text-zinc-200 transition hover:border-teal-500 hover:text-white"
              >
                {m.addMedia}
              </button>
            )}
            {current.features.map((feature, index) => (
              <fieldset
                key={index}
                className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4"
              >
                <legend className="px-1 text-xs font-bold uppercase tracking-wider text-teal-300">
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
            <button
              type="button"
              onClick={() => void preview()}
              disabled={Boolean(busy)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:border-zinc-600 disabled:opacity-60"
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
                Boolean(busy) || !mayWrite || !campaignsEnabled || !copyDigest
              }
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-600 px-4 text-sm font-black text-white hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "create" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              {busy === "create" ? m.creating : m.create}
            </button>
          </div>
        </div>

        <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-3">
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
                <p className="mt-3 break-all px-2 font-mono text-[10px] leading-4 text-zinc-500">
                  {m.digest}: {copyDigest}
                </p>
              ) : null}
            </>
          ) : (
            <p className="rounded-xl border border-dashed border-zinc-700 p-6 text-sm leading-6 text-zinc-500">
              {m.previewEmpty}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
