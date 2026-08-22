"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Bot, BrainCircuit, Database, Image as ImageIcon, KeyRound, Loader2, RefreshCw, Save, Settings2, ShieldAlert } from "lucide-react";
import {
  canUseModelWithPlan,
  getModelUsageProfile,
} from "@/lib/models";
import { GUEST_BRAND_TRIO_MODEL_IDS } from "@/lib/appDefaults";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import type { PublicAppSettings } from "@/lib/appSettings";
import { dispatchAppToast } from "@/lib/appToast";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";

/**
 * Where the reauthentication CTA brings the operator back to.
 *
 * A constant, not `usePathname()`: this panel is the whole of `/admin/platform`
 * and its only other mount is outside `/admin` entirely, where
 * `normalizeAdminCallbackPath()` would fold the callback to `/admin/overview`
 * and drop the operator somewhere other than the settings they were editing.
 */
const PLATFORM_SETTINGS_PATH = "/admin/platform";

type AdminAppSettingsResponse = {
  settings?: PublicAppSettings;
  imageGenerationEnabled?: boolean;
  externalConversationImportEnabled?: boolean;
  assistantProfilesEnabled?: boolean;
  assistantKnowledgeEnabled?: boolean;
  memoryExtractionEnabled?: boolean;
  memoryInjectionEnabled?: boolean;
  memoryApprovedPairCount?: number;
  error?: string;
};

/** The read-only half of this screen: reported, never submitted. */
type MemoryReleaseStatus = {
  memoryExtractionEnabled: boolean;
  memoryInjectionEnabled: boolean;
  memoryApprovedPairCount: number;
};

type Props = {
  settings: PublicAppSettings;
  /** Opt-in beta flag; resolved separately from the default-on kill switches. */
  imageGenerationEnabled: boolean;
  /** Release A import rollout flag; same opt-in, fail-closed shape. */
  externalConversationImportEnabled: boolean;
  /** Release C profile rollout flag; same opt-in, fail-closed shape. */
  assistantProfilesEnabled: boolean;
  /**
   * Release C knowledge rollout flag. Read back from the server as the
   * *effective* value, which is off whenever profiles are off (§15) -- so the
   * checkbox shows what is actually in force rather than what is stored.
   */
  assistantKnowledgeEnabled: boolean;
  /**
   * Release B (account memory), reported and never edited here. Enabling
   * either one is the import/memory policy §12.4 human procedure, so this
   * screen has no control for them -- and `/api/admin/app-settings` refuses a
   * request that names them rather than ignoring it. What it does have is the
   * answer to "what are they, then", which an operator otherwise has to get
   * from the database.
   */
  memoryExtractionEnabled: boolean;
  memoryInjectionEnabled: boolean;
  /**
   * Approved AND un-revoked extraction pairs. Zero means both flags above are
   * inert whatever they say: extraction refuses every run and injection stops
   * at `no_approved_pair`. Reporting the flags without this would show two
   * switches whose position explains nothing.
   */
  memoryApprovedPairCount: number;
};

export function PlatformSettingsPanel({
  settings,
  imageGenerationEnabled: initialImageGenerationEnabled,
  externalConversationImportEnabled: initialExternalImportEnabled,
  assistantProfilesEnabled: initialAssistantProfilesEnabled,
  assistantKnowledgeEnabled: initialAssistantKnowledgeEnabled,
  memoryExtractionEnabled: initialMemoryExtractionEnabled,
  memoryInjectionEnabled: initialMemoryInjectionEnabled,
  memoryApprovedPairCount: initialMemoryApprovedPairCount,
}: Props) {
  const { models } = useModelCatalog();
  const guestModels = useMemo(
    () =>
      models.filter(
        (model) =>
          GUEST_BRAND_TRIO_MODEL_IDS.includes(model.id) &&
          model.enabled &&
          canUseModelWithPlan("Guest", model) &&
          getModelUsageProfile(model).category === "Standard"
      ),
    [models]
  );
  const [guestDefaultModelId, setGuestDefaultModelId] = useState(
    settings.guestDefaultModelId
  );
  const [aiChatEnabled, setAiChatEnabled] = useState(settings.aiChatEnabled);
  const [attachmentsEnabled, setAttachmentsEnabled] = useState(settings.attachmentsEnabled);
  const [publicSharingEnabled, setPublicSharingEnabled] = useState(settings.publicSharingEnabled);
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(
    initialImageGenerationEnabled
  );
  const [externalImportEnabled, setExternalImportEnabled] = useState(
    initialExternalImportEnabled
  );
  const [assistantProfilesEnabled, setAssistantProfilesEnabled] = useState(
    initialAssistantProfilesEnabled
  );
  const [assistantKnowledgeEnabled, setAssistantKnowledgeEnabled] = useState(
    initialAssistantKnowledgeEnabled
  );
  // One state object rather than three: they are read together and are only
  // ever meaningful together, and no control writes any of them.
  const [memoryStatus, setMemoryStatus] = useState<MemoryReleaseStatus>({
    memoryExtractionEnabled: initialMemoryExtractionEnabled,
    memoryInjectionEnabled: initialMemoryInjectionEnabled,
    memoryApprovedPairCount: initialMemoryApprovedPairCount,
  });
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // Survives on screen until the operator leaves for the reauthentication
  // flow. A toast was the only recovery channel before, and it disappears --
  // taking with it the one instruction ("sign in again") that a retry cannot
  // substitute for, which left Save as the only visible action and every press
  // of it producing the same 428.
  const [reauthenticationRequired, setReauthenticationRequired] =
    useState(false);
  const selectedModel =
    guestModels.find((model) => model.id === guestDefaultModelId) || guestModels[0];

  const applySettings = (
    nextSettings: PublicAppSettings,
    nextImageGenerationEnabled?: boolean,
    nextExternalImportEnabled?: boolean,
    nextAssistantProfilesEnabled?: boolean,
    nextAssistantKnowledgeEnabled?: boolean
  ) => {
    setGuestDefaultModelId(nextSettings.guestDefaultModelId);
    setAiChatEnabled(nextSettings.aiChatEnabled);
    setAttachmentsEnabled(nextSettings.attachmentsEnabled);
    setPublicSharingEnabled(nextSettings.publicSharingEnabled);
    if (typeof nextImageGenerationEnabled === "boolean") {
      setImageGenerationEnabled(nextImageGenerationEnabled);
    }
    if (typeof nextExternalImportEnabled === "boolean") {
      setExternalImportEnabled(nextExternalImportEnabled);
    }
    if (typeof nextAssistantProfilesEnabled === "boolean") {
      setAssistantProfilesEnabled(nextAssistantProfilesEnabled);
    }
    if (typeof nextAssistantKnowledgeEnabled === "boolean") {
      setAssistantKnowledgeEnabled(nextAssistantKnowledgeEnabled);
    }
    setLastSyncedAt(new Date().toLocaleTimeString());
  };

  /**
   * Kept out of `applySettings` on purpose. That function applies what the
   * form submits; this applies what the form only reports. Folding the two
   * together is how a read-only field acquires a writer by accident.
   */
  const applyMemoryStatus = (data: AdminAppSettingsResponse) => {
    if (
      typeof data.memoryExtractionEnabled !== "boolean" ||
      typeof data.memoryInjectionEnabled !== "boolean" ||
      typeof data.memoryApprovedPairCount !== "number"
    ) {
      // A partial response leaves the card showing what it last read rather
      // than a default: "extraction off, 0 pairs" invented from a missing
      // field is the one wrong answer that looks exactly like the right one.
      return;
    }
    setMemoryStatus({
      memoryExtractionEnabled: data.memoryExtractionEnabled,
      memoryInjectionEnabled: data.memoryInjectionEnabled,
      memoryApprovedPairCount: data.memoryApprovedPairCount,
    });
  };

  const reload = async () => {
    if (isLoading || isSaving) return;
    setIsLoading(true);
    try {
      const response = await fetch("/api/admin/app-settings", {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as
        | AdminAppSettingsResponse
        | null;
      if (!response.ok || !data?.settings) {
        throw new Error(data?.error || "Settings reload failed");
      }
      applySettings(
        data.settings,
        data.imageGenerationEnabled,
        data.externalConversationImportEnabled,
        data.assistantProfilesEnabled,
        data.assistantKnowledgeEnabled
      );
      applyMemoryStatus(data);
      dispatchAppToast("Platform settings reloaded. The form now matches what is stored.", "success");
    } catch {
      dispatchAppToast("Platform settings could not be reloaded, so the form still shows the values it had. Retry before editing.", "error");
    } finally {
      setIsLoading(false);
    }
  };

  const save = async () => {
    if (isLoading || isSaving || reauthenticationRequired) return;
    setIsSaving(true);
    try {
      const response = await fetch("/api/admin/app-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestDefaultModelId,
          aiChatEnabled,
          attachmentsEnabled,
          publicSharingEnabled,
          imageGenerationEnabled,
          externalConversationImportEnabled: externalImportEnabled,
          assistantProfilesEnabled,
          assistantKnowledgeEnabled,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | AdminAppSettingsResponse
        | null;
      if (!response.ok || !data?.settings) {
        // The endpoint refuses for reasons the operator can act on, and each
        // one needs a different action: sign in again (428), pick a different
        // guest default (400), wait (429), get the permission (403). Telling
        // all of them to "retry" sends the operator in a loop on the ones a
        // retry cannot fix, which is what "nothing changed" used to do to a
        // step-up prompt. So the server's own explanation is what gets shown.
        if (response.status === 428) {
          // The alert below is the recovery; the toast only announces it. The
          // request is not retried and the edit is not re-sent -- a high-risk
          // write has to be submitted again deliberately, after a real
          // sign-in, by the operator looking at the values.
          setReauthenticationRequired(true);
          dispatchAppToast(
            "Platform settings were not saved: this is a high-risk action, so sign in again before saving.",
            "error"
          );
          return;
        }
        dispatchAppToast(
          data?.error
            ? `Platform settings were not saved. ${data.error} Nothing changed.`
            : "Platform settings were not saved. Nothing changed -- retry, or reload to discard the edit.",
          "error"
        );
        return;
      }
      applySettings(
        data.settings,
        data.imageGenerationEnabled,
        data.externalConversationImportEnabled,
        data.assistantProfilesEnabled,
        data.assistantKnowledgeEnabled
      );
      applyMemoryStatus(data);
      dispatchAppToast("Platform settings saved and are live.", "success");
    } catch {
      // Only a transport failure reaches here now; a retry is the right advice.
      dispatchAppToast("Platform settings could not be sent. Nothing changed -- check your connection and retry.", "error");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80 shadow-2xl shadow-black/20">
      <div className="border-b border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-200">
              <Settings2 className="h-3.5 w-3.5" />
              Platform settings
            </div>
            <h2 className="mt-3 text-2xl font-black text-white">
              Product defaults and guest experience
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
              Configure platform-level behavior that is not part of billing,
              provider health, or user support workflows.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={reload}
              disabled={isLoading || isSaving}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Reload DB
            </button>
            <button
              type="button"
              onClick={save}
              // Disabled while a step-up is outstanding, and described by the
              // alert that says why: the endpoint would answer 428 again, and
              // an enabled Save is what turns one refusal into a loop.
              disabled={isLoading || isSaving || reauthenticationRequired}
              aria-describedby={
                reauthenticationRequired
                  ? "admin-platform-reauthentication"
                  : undefined
              }
              data-testid="admin-platform-save"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save platform settings
            </button>
          </div>
        </div>
      </div>

      {reauthenticationRequired ? (
        <div
          id="admin-platform-reauthentication"
          data-testid="admin-platform-reauthentication"
          role="alert"
          aria-live="assertive"
          className="border-b border-amber-500/30 bg-amber-500/10 p-5"
        >
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-200">
              <KeyRound className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-black text-amber-100">
                Nothing was saved
              </h3>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-100/90">
                Changing platform settings is a high-risk action and needs a
                more recent administrator sign-in than this session has. The
                whole request was refused, so every setting is still exactly as
                it was stored -- your edits below have not been applied and
                will not be re-sent for you.
              </p>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-100/90">
                Signing in again ends this app session and brings you back to
                this screen. Review the settings here and save them again.
                Refreshing the page does not renew the sign-in.
              </p>
              <Link
                href={adminRecentAuthenticationHref(PLATFORM_SETTINGS_PATH)}
                data-testid="admin-platform-reauthenticate-link"
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 text-sm font-black text-zinc-950 transition hover:bg-amber-300"
              >
                <KeyRound className="h-4 w-4" aria-hidden />
                Sign in again to continue
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-5 p-5 xl:grid-cols-[1fr_0.8fr]">
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-5 xl:col-span-2">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-red-500/30 bg-red-500/10 text-red-300">
              <ShieldAlert className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-red-300">Emergency kill switches</p>
              <h3 className="mt-2 text-xl font-black text-white">Operational feature controls</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Disabled features are blocked by the server immediately. Attachment deletion and share revocation remain available for safe cleanup.
              </p>
              <div className="mt-4 grid gap-2 md:grid-cols-3">
                {([
                  ["AI chat", aiChatEnabled, setAiChatEnabled],
                  ["Attachments", attachmentsEnabled, setAttachmentsEnabled],
                  ["Public sharing", publicSharingEnabled, setPublicSharingEnabled],
                ] as const).map(([label, enabled, setEnabled]) => (
                  <label key={label} className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-sm font-bold text-white">
                    <span>{label}</span>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(event) => setEnabled(event.target.checked)}
                      className="h-5 w-5 accent-blue-600"
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5 xl:col-span-2">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300">
              <ImageIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-fuchsia-300">Opt-in beta</p>
              <h3 className="mt-2 text-xl font-black text-white">Image generation</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Default-off, unlike the kill switches above: it is enabled only
                while this toggle is on. Provider budget env vars must be live
                first or /api/ready fails the moment this turns on
                (docs/policy/image-generation.md §8).
              </p>
              <label className="mt-4 flex w-fit cursor-pointer items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-sm font-bold text-white">
                <input
                  type="checkbox"
                  data-testid="admin-image-generation-flag"
                  checked={imageGenerationEnabled}
                  onChange={(event) => setImageGenerationEnabled(event.target.checked)}
                  className="h-5 w-5 accent-fuchsia-600"
                />
                <span>Image generation enabled</span>
              </label>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5 xl:col-span-2">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/10 text-blue-300">
              <Database className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">Opt-in rollout</p>
              <h3 className="mt-2 text-xl font-black text-white">External conversation import</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Release A of the import/memory program: ChatGPT, Claude and
                Gemini (Google Takeout) export files, parsed in the browser,
                stored per account. One switch for all three — there is no
                per-provider flag, so enabling this enables Gemini too.
                Default-off and fail-closed; turning this off closes the
                import APIs and UI while listing, deletion and export stay
                available to owners
                (docs/policy/external-conversation-import-and-memory.md §15).
              </p>
              <label className="mt-4 flex w-fit cursor-pointer items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-sm font-bold text-white">
                <input
                  type="checkbox"
                  data-testid="admin-external-import-flag"
                  checked={externalImportEnabled}
                  onChange={(event) => setExternalImportEnabled(event.target.checked)}
                  className="h-5 w-5 accent-blue-600"
                />
                <span>External conversation import enabled</span>
              </label>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/10 text-blue-300">
              <Bot className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">Opt-in rollout</p>
              <h3 className="mt-2 text-xl font-black text-white">Assistant profiles</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Release C of the import/memory program: private assistant
                profiles with their own instructions, model and versioned
                snapshots. Default-off and fail-closed. Knowledge files are a
                second switch and are only in force while profiles are on, so
                the order in
                docs/policy/external-conversation-import-and-memory.md §15 --
                profiles first, then knowledge -- is what the two checkboxes
                below enforce, not a note to follow by hand.
              </p>
              <label className="mt-4 flex w-fit cursor-pointer items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-sm font-bold text-white">
                <input
                  type="checkbox"
                  data-testid="admin-assistant-profiles-flag"
                  checked={assistantProfilesEnabled}
                  onChange={(event) => setAssistantProfilesEnabled(event.target.checked)}
                  className="h-5 w-5 accent-blue-600"
                />
                <span>Assistant profiles enabled</span>
              </label>
              <label className="mt-3 flex w-fit cursor-pointer items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-sm font-bold text-white">
                <input
                  type="checkbox"
                  data-testid="admin-assistant-knowledge-flag"
                  checked={assistantKnowledgeEnabled}
                  onChange={(event) => setAssistantKnowledgeEnabled(event.target.checked)}
                  className="h-5 w-5 accent-blue-600"
                />
                <span>Assistant knowledge files enabled</span>
              </label>
              {assistantKnowledgeEnabled && !assistantProfilesEnabled ? (
                <p className="mt-3 text-sm font-bold text-amber-300">
                  Knowledge stays off until assistant profiles are enabled.
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <div
          data-testid="admin-memory-release-status"
          className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5 xl:col-span-2"
        >
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-teal-500/30 bg-teal-500/10 text-teal-300">
              <BrainCircuit className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-300">
                Reported, not editable
              </p>
              <h3 className="mt-2 text-xl font-black text-white">Account memory (Release B)</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Enabling either flag is the import/memory policy &sect;12.4 human
                procedure &mdash; a decision-grade eval, blind review, an
                independent re-run, a signed approval, a register merge and a
                staging verification. There is no control here on purpose, and
                the endpoint refuses a request naming these flags rather than
                ignoring it. Stopping is the opposite direction and does have a
                control: emergency pair revocation (&sect;12.1).
              </p>
              <dl className="mt-4 grid gap-2 md:grid-cols-3">
                {([
                  ["memoryExtractionEnabled", memoryStatus.memoryExtractionEnabled ? "on" : "off", "memory-extraction-flag"],
                  ["memoryInjectionEnabled", memoryStatus.memoryInjectionEnabled ? "on" : "off", "memory-injection-flag"],
                  ["Approved, un-revoked pairs", String(memoryStatus.memoryApprovedPairCount), "memory-approved-pairs"],
                ] as const).map(([label, value, testId]) => (
                  <div
                    key={label}
                    className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3"
                  >
                    <dt className="text-[11px] font-semibold text-zinc-500">{label}</dt>
                    <dd
                      data-testid={`admin-${testId}`}
                      className="mt-1 font-mono text-sm font-bold text-white"
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              {memoryStatus.memoryApprovedPairCount === 0 ? (
                <p
                  data-testid="admin-memory-blocked-notice"
                  className="mt-3 text-sm font-bold text-amber-300"
                >
                  Blocked &mdash; no decision-grade eval has been run and no
                  extraction pair is approved. Both flags above are inert
                  whatever they read: every extraction run answers
                  MEMORY_EXTRACTION_PAIR_UNAVAILABLE and injection refuses with
                  no_approved_pair. What has to be decided first is in
                  docs/ops/memory-extraction-eval-program-kickoff.md.
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/10 text-blue-300">
              <Bot className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
                Guest default model
              </p>
              <h3 className="mt-2 text-xl font-black text-white">
                게스트 모드 기본 대화 엔진
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
                로그인하지 않은 게스트에게는 항상 GPT · Claude · Gemini 3개 모델이
                함께 제공됩니다. 여기서 고르는 모델은 그중 어느 모델을 맨 앞(리딩
                슬롯)에 둘지만 결정하며, 게스트 첫 사용 경험에 영향을 줍니다.
              </p>

              <label className="mt-5 block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
                  Leading engine
                </span>
                <select
                  value={guestDefaultModelId}
                  onChange={(event) => setGuestDefaultModelId(event.target.value)}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-sm font-bold text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                >
                  {guestModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} - {model.provider}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-zinc-500">
            Current selection
          </p>
          {selectedModel ? (
            <div className="mt-4 flex items-start gap-4">
              <ModelLogo provider={selectedModel.provider} size="lg" />
              <div>
                <h3 className="font-black text-white">{selectedModel.name}</h3>
                <p className="mt-1 text-sm font-semibold text-zinc-500">
                  {selectedModel.provider} · {getModelUsageProfile(selectedModel).category} · Guest
                </p>
                <p className="mt-3 text-sm leading-6 text-zinc-400">
                  Only enabled guest-accessible Standard models can be used as the guest default.
                </p>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-red-200">
              No eligible guest-accessible Standard model is available.
            </p>
          )}
          <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
            <p className="flex items-center gap-2 text-sm font-bold text-emerald-300">
              <Database className="h-4 w-4" />
              {lastSyncedAt ? `Synced ${lastSyncedAt}` : "Loaded on page open"}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
