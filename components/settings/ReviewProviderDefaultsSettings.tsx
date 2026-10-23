"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { Check } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { reviewProviderName } from "@/components/chat/ReviewStudioChrome";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { adminFetch } from "@/lib/adminFetch";
import { describeAdminApiFailure, type AdminApiFailure } from "@/lib/adminApiOutcome";
import { parseReviewProviderDefaults, REVIEW_PROVIDER_PREFERENCES_UPDATED } from "@/lib/reviewProviderPreferencesCore";
import { reviewProviderPreferencesCopy } from "@/lib/reviewProviderPreferencesCopy";

type Defaults = { selected: string[] | null; platform: string[]; available: string[]; max: number; effective: string[] };
const editableSelection = (defaults: Defaults) => defaults.selected === null ? null
  : defaults.selected.filter(provider => defaults.available.includes(provider)).slice(0, defaults.max);

export function ReviewProviderDefaultsSettings({ scope = "personal" }: { scope?: "personal" | "platform" }) {
  const { lang } = useLanguage();
  const c = reviewProviderPreferencesCopy(lang);
  const { data: session } = useSession();
  const owner = session?.user?.id ?? "";
  const ownerRef = useRef(owner);
  useLayoutEffect(() => { ownerRef.current = owner; }, [owner]);
  const platformScope = scope === "platform";
  const url = platformScope ? "/api/admin/app-settings" : "/api/user/settings";
  const [snapshot, setSnapshot] = useState<{ owner: string; defaults: Defaults } | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<AdminApiFailure | null>(null);
  const [readbackRequired, setReadbackRequired] = useState(false);
  const [saved, setSaved] = useState(false);
  const read = async (signal?: AbortSignal) => {
    const response = await (platformScope ? adminFetch : fetch)(url, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(c.loadFailed);
    if (!Array.isArray(data.reviewEasyProviderOptions)) throw new Error(c.loadFailed);
    return {
      selected: parseReviewProviderDefaults(data.reviewEasyDefaultProviders),
      platform: parseReviewProviderDefaults(platformScope ? data.reviewEasyDefaultProviders : data.reviewEasyPlatformProviders) ?? [],
      available: data.reviewEasyProviderOptions.filter((item: unknown): item is string => typeof item === "string"),
      max: platformScope ? 3 : Math.max(1, Math.min(3, Number(data.reviewEasyMaxProviders) || 3)),
      effective: Array.isArray(data.reviewEasyEffectiveProviders) ? data.reviewEasyEffectiveProviders : [],
    } satisfies Defaults;
  };
  const readRef = useRef(read);
  useEffect(() => { readRef.current = read; });
  useEffect(() => {
    const controller = new AbortController();
    void readRef.current(controller.signal).then(defaults => {
      if (controller.signal.aborted) return;
      setSnapshot({ owner, defaults }); setDraft(editableSelection(defaults)); setError(null);
      setReadbackRequired(false); setFailure(null);
    }).catch(() => { if (!controller.signal.aborted) setError(c.loadFailed); });
    return () => controller.abort();
  }, [owner, revision, url, c.loadFailed]);
  const defaults = snapshot?.owner === owner ? snapshot.defaults : null;
  const inherited = defaults ? defaults.platform.filter(provider => defaults.available.includes(provider)).slice(0, defaults.max) : [];
  const selected = draft ?? inherited;
  const writeBlocked = busy || readbackRequired || Boolean(failure?.requiresReauthentication);
  const save = async () => {
    if (writeBlocked || !defaults) return;
    setBusy(true); setSaved(false); setError(null); setFailure(null);
    try {
      const response = await (platformScope ? adminFetch : fetch)(url, {
        method: platformScope ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewEasyDefaultProviders: draft }),
      });
      const body = await response.json().catch(() => null);
      if (ownerRef.current !== owner) return;
      if (!response.ok) {
        if (platformScope) setFailure(describeAdminApiFailure({ status: response.status, error: body?.error, code: body?.code, approvalId: body?.approvalId, fallback: c.saveUnknown, locale: lang === "ko" ? "ko" : "en" }));
        setError(response.status >= 500 ? c.saveUnknown : body?.error ?? c.saveUnknown);
        setReadbackRequired(response.status >= 500);
        return;
      }
      setReadbackRequired(true);
      const canonical = await readRef.current();
      if (ownerRef.current !== owner) return;
      setSnapshot({ owner, defaults: canonical }); setDraft(editableSelection(canonical));
      setReadbackRequired(false); setSaved(true);
      if (!platformScope) window.dispatchEvent(new CustomEvent(REVIEW_PROVIDER_PREFERENCES_UPDATED, { detail: { userId: owner, providers: canonical.effective } }));
    } catch {
      if (ownerRef.current === owner) { setError(c.saveUnknown); setReadbackRequired(true); }
    } finally { if (ownerRef.current === owner) setBusy(false); }
  };
  const controlClass = "min-h-11 cursor-pointer rounded-xl border px-3 py-2 text-sm transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800";
  return <section data-testid={`review-defaults-${scope}`} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-4 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
    <h3 className="text-base font-semibold">{platformScope ? c.platformTitle : c.title}</h3>
    <p className="text-xs leading-5 text-zinc-600 dark:text-zinc-300">{c.description}</p>
    {!defaults && !error && <p role="status">{c.loading}</p>}
    {defaults && <>
      {!platformScope && <label className="block text-sm">{c.source}<select data-testid="review-defaults-source" value={draft === null ? "platform" : "personal"} disabled={writeBlocked} onChange={event => { setDraft(event.target.value === "platform" ? null : inherited); setSaved(false); }} className="mt-2 min-h-11 w-full cursor-pointer rounded-xl border border-zinc-200 bg-zinc-50 px-3 dark:border-zinc-700 dark:bg-zinc-950"><option value="platform">{c.inherit}</option><option value="personal">{c.personal}</option></select></label>}
      <fieldset className="min-w-0"><legend className="mb-2 text-sm font-medium">{c.providers}</legend><div className="flex flex-wrap gap-2">{defaults.available.map(provider => <button key={provider} type="button" data-provider={provider} aria-pressed={selected.includes(provider)} disabled={writeBlocked || (!platformScope && draft === null) || (!selected.includes(provider) && selected.length >= defaults.max)} onClick={() => { setDraft(selected.includes(provider) ? selected.filter(item => item !== provider) : [...selected, provider]); setSaved(false); }} className={`${controlClass} inline-flex items-center gap-2 ${selected.includes(provider) ? "border-blue-300 bg-blue-50 dark:border-blue-600 dark:bg-blue-950" : "border-zinc-200 dark:border-zinc-700"}`}>{reviewProviderName(provider)}{selected.includes(provider) && <Check size={14} aria-hidden="true" />}</button>)}</div></fieldset>
      <p className="text-xs text-zinc-600 dark:text-zinc-300">{defaults.available.length ? platformScope ? c.platformLimit : c.limit.replace("{count}", String(defaults.max)) : c.unavailable}</p>
      <button type="button" data-testid="review-defaults-save" disabled={writeBlocked || (draft !== null && !draft.length) || !defaults.available.length} onClick={() => void save()} className={`${controlClass} w-full border-blue-200 bg-blue-50 font-medium dark:border-blue-800 dark:bg-blue-950`}>{busy ? c.saving : c.save}</button>
    </>}
    {saved && <p role="status" className="text-sm">{c.saved}</p>}
    {failure && platformScope ? <AdminApiFailureNotice failure={failure} returnTo="/admin/platform" /> : error && <p role="alert" className="text-sm">{error}</p>}
    {error && <button type="button" disabled={busy} onClick={() => { setSnapshot(null); setError(null); setRevision(value => value + 1); }} className={controlClass}>{c.reload}</button>}
  </section>;
}
