"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  EMPTY_PERSONALIZATION,
  PERSONALIZATION_TEXT_MAX_LENGTH,
  RESPONSE_STYLES,
  personalizationFromRow,
  type ResponseStyle,
  type UserPersonalizationValue,
} from "@/lib/chatPersonalizationCore";
import { chatPersonalizationCopy, type ChatPersonalizationCopy } from "@/locales/chatPersonalization";

const STYLE_LABEL: Record<ResponseStyle, keyof ChatPersonalizationCopy> = {
  default: "styleDefault",
  concise: "styleConcise",
  detailed: "styleDetailed",
  formal: "styleFormal",
  friendly: "styleFriendly",
};

const readSaved = (body: unknown): UserPersonalizationValue | null => {
  const value = (body as { personalization?: unknown } | null)?.personalization as
    | { aboutMe?: unknown; responsePreferences?: unknown; responseStyle?: unknown }
    | undefined;
  if (!value || typeof value.aboutMe !== "string" || typeof value.responsePreferences !== "string" ||
      typeof value.responseStyle !== "string") return null;
  return personalizationFromRow({
    aboutMe: value.aboutMe, responsePreferences: value.responsePreferences, responseStyle: value.responseStyle,
  });
};

/**
 * The AI personalization tab's personal instructions card
 * (docs/ui-contracts/settings-navigation.md §2: a card inside the tab it
 * belongs to, with no detail page). Reads and saves its own object through
 * `/api/user/personalization`, so the panel's every-dirty-field save never
 * carries it.
 */
export function PersonalInstructionsSettings() {
  const { lang } = useLanguage();
  const c = chatPersonalizationCopy(lang);
  const { data: session } = useSession();
  const owner = session?.user?.id ?? "";
  const ownerRef = useRef(owner);
  useLayoutEffect(() => { ownerRef.current = owner; }, [owner]);
  const [saved, setSaved] = useState<{ owner: string; value: UserPersonalizationValue } | null>(null);
  const [draft, setDraft] = useState<UserPersonalizationValue>(EMPTY_PERSONALIZATION);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "loadFailed" | "saveFailed">("idle");

  useEffect(() => {
    if (!owner) return;
    const controller = new AbortController();
    void fetch("/api/user/personalization", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        const value = response.ok ? readSaved(body) : null;
        if (controller.signal.aborted) return;
        if (!value) { setStatus("loadFailed"); return; }
        setSaved({ owner, value });
        setDraft(value);
        setStatus("idle");
      })
      .catch(() => { if (!controller.signal.aborted) setStatus("loadFailed"); });
    return () => controller.abort();
  }, [owner, revision]);

  const loaded = saved?.owner === owner ? saved.value : null;
  const tooLong =
    draft.aboutMe.length > PERSONALIZATION_TEXT_MAX_LENGTH ||
    draft.responsePreferences.length > PERSONALIZATION_TEXT_MAX_LENGTH;
  const dirty = loaded !== null && (
    loaded.aboutMe !== draft.aboutMe ||
    loaded.responsePreferences !== draft.responsePreferences ||
    loaded.responseStyle !== draft.responseStyle
  );
  const edit = (patch: Partial<UserPersonalizationValue>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setStatus("idle");
  };

  const save = async () => {
    if (busy || !loaded || tooLong) return;
    setBusy(true);
    setStatus("idle");
    try {
      const response = await fetch("/api/user/personalization", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = await response.json().catch(() => null);
      if (ownerRef.current !== owner) return;
      const value = response.ok ? readSaved(body) : null;
      if (!value) { setStatus("saveFailed"); return; }
      setSaved({ owner, value });
      setDraft(value);
      setStatus("saved");
    } catch {
      if (ownerRef.current === owner) setStatus("saveFailed");
    } finally {
      if (ownerRef.current === owner) setBusy(false);
    }
  };

  const fieldClass =
    "mt-2 block w-full resize-y rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm leading-6 text-zinc-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";
  const counter = (value: string) => (
    <span className={`text-xs ${value.length > PERSONALIZATION_TEXT_MAX_LENGTH ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>
      {value.length}/{PERSONALIZATION_TEXT_MAX_LENGTH}
    </span>
  );

  return (
    <section
      data-testid="settings-personal-instructions"
      className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-4 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <div>
        <h3 className="text-base font-semibold">{c.title}</h3>
        <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-300">{c.description}</p>
        <p className="mt-1 text-xs leading-5 text-zinc-500">{c.scopeNote}</p>
      </div>
      {!loaded && status !== "loadFailed" && <p role="status" className="text-sm">{c.loading}</p>}
      {status === "loadFailed" && (
        <div className="space-y-2">
          <p role="alert" className="text-sm">{c.loadFailed}</p>
          <button
            type="button"
            onClick={() => { setStatus("idle"); setRevision((value) => value + 1); }}
            className="min-h-11 rounded-xl border border-zinc-200 px-3 py-2 text-sm transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {c.reload}
          </button>
        </div>
      )}
      {loaded && (
        <>
          <label className="block text-sm font-medium">
            <span className="flex items-center justify-between gap-2">{c.aboutMeLabel}{counter(draft.aboutMe)}</span>
            <textarea
              data-testid="personal-instructions-about"
              rows={4}
              value={draft.aboutMe}
              disabled={busy}
              placeholder={c.aboutMePlaceholder}
              onChange={(event) => edit({ aboutMe: event.target.value })}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            <span className="flex items-center justify-between gap-2">{c.preferencesLabel}{counter(draft.responsePreferences)}</span>
            <textarea
              data-testid="personal-instructions-preferences"
              rows={4}
              value={draft.responsePreferences}
              disabled={busy}
              placeholder={c.preferencesPlaceholder}
              onChange={(event) => edit({ responsePreferences: event.target.value })}
              className={fieldClass}
            />
          </label>
          <label className="block text-sm font-medium">
            {c.styleLabel}
            <select
              data-testid="personal-instructions-style"
              value={draft.responseStyle}
              disabled={busy}
              onChange={(event) => edit({ responseStyle: event.target.value as ResponseStyle })}
              className="mt-2 min-h-11 w-full cursor-pointer rounded-xl border border-zinc-200 bg-zinc-50 px-3 dark:border-zinc-700 dark:bg-zinc-950"
            >
              {RESPONSE_STYLES.map((style) => (
                <option key={style} value={style}>{c[STYLE_LABEL[style]]}</option>
              ))}
            </select>
          </label>
          {tooLong && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {c.tooLong.replace("{max}", String(PERSONALIZATION_TEXT_MAX_LENGTH))}
            </p>
          )}
          <button
            type="button"
            data-testid="personal-instructions-save"
            disabled={busy || !dirty || tooLong}
            onClick={() => void save()}
            className="min-h-11 w-full cursor-pointer rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:bg-blue-950 dark:hover:bg-blue-900"
          >
            {busy ? c.saving : c.save}
          </button>
        </>
      )}
      {status === "saved" && <p role="status" className="text-sm">{c.saved}</p>}
      {status === "saveFailed" && <p role="alert" className="text-sm">{c.saveFailed}</p>}
    </section>
  );
}
