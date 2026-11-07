"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { KeyRound, Link2, Loader2, MessageCircle, Paperclip, RefreshCw, Save } from "lucide-react";
import {
  canUseModelWithPlan,
  getModelUsageCredits,
  getModelUsageProfile,
} from "@/lib/models";
import { APP_DEFAULTS, GUEST_BRAND_TRIO_MODEL_IDS, createDefaultLineupEligibilityCheck, createGuestEligibilityCheck, createReplacementResolver, isDefaultLineupServable, isOnePerLineupProvider, lineupSlotProviders } from "@/lib/appDefaults";
import {
  assessFallbackTransition,
  describeGuestDefault,
  fallbackTransitionRequestText,
} from "@/lib/defaultModelConsole";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import type { PublicAppSettings } from "@/lib/appSettings";
import { dispatchAppToast } from "@/lib/appToast";
import {
  describeAdminApiFailure,
  type AdminApiFailure,
} from "@/lib/adminApiOutcome";
import { AdminApiFailureNotice } from "@/components/admin/AdminApiFailureNotice";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { useAdminMessages,
  useAdminLocale,
} from "@/components/admin/AdminLocaleProvider";
import { EmergencyStopsSection, FeatureSwitchesSection } from "@/components/admin/PlatformSwitchSections";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminPlatformMemoryMessages } from "@/lib/adminMessages/platformMemory";
import { adminPlatformSettingsMessages } from "@/lib/adminMessages/platformSettings";
import { adminFetch } from "@/lib/adminFetch";
import { ReviewProviderDefaultsSettings } from "@/components/settings/ReviewProviderDefaultsSettings";
import { DefaultModelsView, type DefaultModelOption } from "@/components/admin/models/DefaultModelsView";

/**
 * Which part of the settings a mount shows. `all` is the whole screen; the
 * other four are the tabs of Feature flags (`emergency`, `features`,
 * `account-defaults`) and the Default models tab of Models (`default-models`),
 * which is where the default-model block lives since 2026-11-07. Every mount
 * holds the same state. The route saves all nine flags together, so a save
 * from a tab sends its own sections' values and takes the others from the
 * server as they are when it is pressed: a tab left open must never write
 * back a value it cannot show, such as an emergency stop another operator has
 * engaged since the page loaded.
 */
export type PlatformSettingsView =
  | "all"
  | "emergency"
  | "features"
  | "account-defaults"
  | "default-models";

/**
 * Where the reauthentication CTA brings the operator back to.
 *
 * A constant per view, not `usePathname()`: this panel's only other mount is
 * outside `/admin` entirely, where `normalizeAdminCallbackPath()` would fold
 * the callback to `/admin/overview` and drop the operator somewhere other than
 * the settings they were editing.
 */
const platformSettingsPath = (view: PlatformSettingsView) =>
  view === "default-models"
    ? "/admin/models?tab=defaults"
    : view === "all"
      ? "/admin/platform"
      : `/admin/platform?tab=${view}`;

type AdminAppSettingsResponse = {
  settings?: PublicAppSettings;
  imageGenerationEnabled?: boolean;
  externalConversationImportEnabled?: boolean;
  externalConversationContinuationEnabled?: boolean;
  assistantProfilesEnabled?: boolean;
  assistantKnowledgeEnabled?: boolean;
  chatStarterEnabled?: boolean;
  memoryExtractionEnabled?: boolean;
  memoryInjectionEnabled?: boolean;
  memoryApprovedPairCount?: number;
  guestLead?: { stored: string | null; effective: string | null };
  error?: string;
};

/** The read-only half of this screen: reported, never submitted. */
type MemoryReleaseStatus = {
  memoryExtractionEnabled: boolean;
  memoryInjectionEnabled: boolean;
  memoryApprovedPairCount: number;
};

type Props = {
  /** The part of the screen to draw; the whole screen when absent. */
  view?: PlatformSettingsView;
  settings: PublicAppSettings;
  /**
   * External assistant package import.
   *
   * Not part of the form below and deliberately so: policy §12.2.1 keeps this
   * flag off the bulk save (`docs/policy/assistant-package-import.md`
   * §12.2.1), because a request that carries the whole panel
   * leaves an audit row saying settings were saved and cannot say this flag
   * moved. It has its own control, its own request and its own row.
   */
  assistantPackageImportEnabled?: boolean;
  /** Opt-in beta flag; resolved separately from the default-on kill switches. */
  imageGenerationEnabled: boolean;
  /** Release A import rollout flag; same opt-in, fail-closed shape. */
  externalConversationImportEnabled: boolean;
  /**
   * "Tomverse에서 이어가기"; same opt-in, fail-closed shape, and deliberately
   * a separate switch from the import flag above
   * (docs/policy/external-conversation-continuation.md §7).
   */
  externalConversationContinuationEnabled: boolean;
  /** Release C profile rollout flag; same opt-in, fail-closed shape. */
  assistantProfilesEnabled: boolean;
  /**
   * Release C knowledge rollout flag. Read back from the server as the
   * *effective* value, which is off whenever profiles are off (§15) -- so the
   * checkbox shows what is actually in force rather than what is stored.
   */
  assistantKnowledgeEnabled: boolean;
  /**
   * The Chat welcome screen's starter catalogue
   * (docs/ui-contracts/chat-starter-catalog.md). An ordinary rollout flag:
   * it has a control here, unlike the memory flags below, because turning
   * it on calls no provider and can advertise nothing the build does not
   * already do -- `npm run check:starter-catalog` settles that before the
   * commit exists, so there is no procedure for this checkbox to skip.
   */
  chatStarterEnabled: boolean;
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
  /** Raw AppSetting value. Null when the row has never been saved. */
  storedGuestDefaultModelId?: string | null;
};

// How a lineup slot names its provider. One model per provider is the rule
// (GUEST_LINEUP_PROVIDERS in lib/appDefaults.ts); Google's models are Gemini.
const PROVIDER_LABELS: ReadonlyMap<string, string> = new Map([
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["google", "Gemini"],
]);

export function PlatformSettingsPanel({
  view = "all",
  settings,
  assistantPackageImportEnabled: initialAssistantPackageImportEnabled = false,
  imageGenerationEnabled: initialImageGenerationEnabled,
  externalConversationImportEnabled: initialExternalImportEnabled,
  externalConversationContinuationEnabled: initialExternalContinuationEnabled,
  assistantProfilesEnabled: initialAssistantProfilesEnabled,
  assistantKnowledgeEnabled: initialAssistantKnowledgeEnabled,
  chatStarterEnabled: initialChatStarterEnabled,
  memoryExtractionEnabled: initialMemoryExtractionEnabled,
  memoryInjectionEnabled: initialMemoryInjectionEnabled,
  memoryApprovedPairCount: initialMemoryApprovedPairCount,
  storedGuestDefaultModelId = null,
}: Props) {
  const m = useAdminMessages(adminPlatformSettingsMessages);
  const memoryCopy = useAdminMessages(adminPlatformMemoryMessages);
  const show = (section: Exclude<PlatformSettingsView, "all">) => view === "all" || view === section;
  const returnPath = platformSettingsPath(view);
  const router = useRouter();
  useEffect(() => {
    // `/admin/platform#default-models` was a link people kept. A hash never
    // reaches the server, so the move to Models > Default models is made here.
    if (
      view !== "default-models" &&
      window.location.pathname === "/admin/platform" &&
      window.location.hash === "#default-models"
    ) {
      router.replace("/admin/models?tab=defaults#default-models");
    }
  }, [view, router]);
  const { models } = useModelCatalog();
  // The effective default lineup, as the server resolved it (lib/appSettings).
  // A response without the field -- an older build answering -- keeps the
  // compiled trio rather than an empty lineup.
  const [guestTrio, setGuestTrio] = useState<string[]>(
    settings.guestBrandTrioModelIds ?? [...GUEST_BRAND_TRIO_MODEL_IDS]
  );
  const [lineupDraft, setLineupDraft] = useState<string[]>(guestTrio);
  const [lineupError, setLineupError] = useState<string | null>(null);
  const [lineupSaving, setLineupSaving] = useState(false);
  const isGuestStandard = (model: (typeof models)[number]) =>
    model.enabled &&
    !model.catalogDeleted &&
    model.publiclyListed !== false &&
    canUseModelWithPlan("Guest", model) &&
    getModelUsageProfile(model).category === "Standard";
  const guestModels = useMemo(
    () =>
      models.filter(
        (model) =>
          guestTrio.includes(model.id) &&
          model.enabled &&
          canUseModelWithPlan("Guest", model) &&
          getModelUsageProfile(model).category === "Standard"
      ),
    [guestTrio, models]
  );
  // What a lineup slot may name: the lifecycle the save checks
  // (isDefaultLineupServable -- a limited row is not offered) plus guest and
  // Standard. The server also checks the price (guestBrandTrioRejection), so a
  // model with no verified price is offered here and refused with its reason
  // there.
  const lineupCandidates = models.filter(
    (model) => isGuestStandard(model) && isDefaultLineupServable(model)
  );
  const [guestDefaultModelId, setGuestDefaultModelId] = useState(
    settings.guestDefaultModelId
  );
  // The lead as last saved, kept apart from the dropdown above: a lineup save
  // carries the saved lead, never an unsaved pick in that dropdown.
  const [appliedLead, setAppliedLead] = useState(settings.guestDefaultModelId);
  const [storedGuestLead, setStoredGuestLead] = useState<string | null>(
    storedGuestDefaultModelId
  );
  const [leadError, setLeadError] = useState<string | null>(null);
  const [leadSaving, setLeadSaving] = useState(false);
  const [candidateId, setCandidateId] = useState("");
  const [registryLoaded, setRegistryLoaded] = useState(false);
  const [registryModels, setRegistryModels] = useState<
    Array<{
      id: string;
      name: string;
      provider: string;
      enabled: boolean;
      publiclyListed: boolean;
      catalogDeleted: boolean;
      status: string;
      minimumPlan: string;
      usageClass: string;
      creditWeight: number;
      hasPricingProfile?: boolean;
      inCodeCatalog?: boolean;
    }>
  >([]);
  const [aiChatEnabled, setAiChatEnabled] = useState(settings.aiChatEnabled);
  const [attachmentsEnabled, setAttachmentsEnabled] = useState(settings.attachmentsEnabled);
  const [publicSharingEnabled, setPublicSharingEnabled] = useState(settings.publicSharingEnabled);
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(
    initialImageGenerationEnabled
  );
  const [externalImportEnabled, setExternalImportEnabled] = useState(
    initialExternalImportEnabled
  );
  const [externalContinuationEnabled, setExternalContinuationEnabled] =
    useState(initialExternalContinuationEnabled);
  /**
   * The package import rollout control, kept apart from the form.
   *
   * Its own state, its own request, its own audit row. The
   * rationale is required by the server, so it is a field here rather than
   * something the operator discovers as a 403. Policy:
   * `docs/policy/assistant-package-import.md` §12.2.1.
   */
  const [packageImportEnabled, setPackageImportEnabled] = useState(
    initialAssistantPackageImportEnabled
  );
  const [packageImportRationale, setPackageImportRationale] = useState("");
  const [packageImportBusy, setPackageImportBusy] = useState(false);

  const submitPackageImportFlag = async (enabled: boolean) => {
    if (packageImportBusy) return;
    setPackageImportBusy(true);
    try {
      const response = await adminFetch("/api/admin/assistant-package-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, rationale: packageImportRationale }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        code?: string;
        outcome?: string;
        before?: string | null;
        after?: string;
      };
      if (!response.ok) {
        if (data.code === "ADMIN_REAUTHENTICATION_REQUIRED") {
          // A toast alone was the bug: it names the remedy and gives the
          // operator no way to reach it, so the screen looks broken rather
          // than gated. The banner above already carries the step-up link
          // this panel's save uses, so raising the same flag reuses it
          // instead of inventing a second way to say the same thing.
          setReauthenticationRequired(true);
          dispatchAppToast(
            m.toast.packageImportSignIn,
            "error"
          );
          return;
        }
        dispatchAppToast(
          data.code === "ASSISTANT_PACKAGE_IMPORT_RATIONALE_REQUIRED"
            ? m.toast.rationaleRequired
            : m.toast.refused,
          "error"
        );
        return;
      }
      setPackageImportEnabled(enabled);
      setPackageImportRationale("");
      dispatchAppToast(
        // Both values, because a no-op is worth knowing about: pressing
        // enable on something already enabled is a different fact from
        // enabling it.
        data.outcome === "unchanged"
          ? m.toast.packageImportUnchanged(data.after)
          : m.toast.packageImportChanged(data.after, data.before ?? m.toast.noBefore),
        "success"
      );
    } catch {
      dispatchAppToast(m.toast.packageImportUndelivered, "error");
    } finally {
      setPackageImportBusy(false);
    }
  };

  const [assistantProfilesEnabled, setAssistantProfilesEnabled] = useState(
    initialAssistantProfilesEnabled
  );
  const [assistantKnowledgeEnabled, setAssistantKnowledgeEnabled] = useState(
    initialAssistantKnowledgeEnabled
  );
  const [chatStarterEnabled, setChatStarterEnabled] = useState(
    initialChatStarterEnabled
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
  // 428 keeps its own alert below -- it is the recovery, not a message about
  // one. Everything else the endpoint refuses with was flattened into a
  // generic "not saved" toast, including the 409 that means the change is
  // queued for a second administrator and must not be re-sent.
  const { locale: apiLocale } = useAdminLocale();
  const [apiFailure, setApiFailure] = useState<AdminApiFailure | null>(null);
  const [reauthenticationRequired, setReauthenticationRequired] =
    useState(false);
  const touchSyncedAt = () => setLastSyncedAt(formatAestDateTime(new Date(), { seconds: true }) ?? "-");

  const applyLeadSettings = (nextSettings: PublicAppSettings) => {
    setGuestDefaultModelId(nextSettings.guestDefaultModelId);
    setAppliedLead(nextSettings.guestDefaultModelId);
    const nextTrio = nextSettings.guestBrandTrioModelIds ?? [...GUEST_BRAND_TRIO_MODEL_IDS];
    setGuestTrio(nextTrio);
    setLineupDraft(nextTrio);
    setLeadError(null);
    setLineupError(null);
    touchSyncedAt();
  };

  const applyOperationalSettings = (
    nextSettings: PublicAppSettings,
    nextImageGenerationEnabled?: boolean,
    nextExternalImportEnabled?: boolean,
    nextExternalContinuationEnabled?: boolean,
    nextAssistantProfilesEnabled?: boolean,
    nextAssistantKnowledgeEnabled?: boolean,
    nextChatStarterEnabled?: boolean
  ) => {
    setAiChatEnabled(nextSettings.aiChatEnabled);
    setAttachmentsEnabled(nextSettings.attachmentsEnabled);
    setPublicSharingEnabled(nextSettings.publicSharingEnabled);
    if (typeof nextImageGenerationEnabled === "boolean") {
      setImageGenerationEnabled(nextImageGenerationEnabled);
    }
    if (typeof nextExternalImportEnabled === "boolean") {
      setExternalImportEnabled(nextExternalImportEnabled);
    }
    if (typeof nextExternalContinuationEnabled === "boolean") {
      setExternalContinuationEnabled(nextExternalContinuationEnabled);
    }
    if (typeof nextAssistantProfilesEnabled === "boolean") {
      setAssistantProfilesEnabled(nextAssistantProfilesEnabled);
    }
    if (typeof nextAssistantKnowledgeEnabled === "boolean") {
      setAssistantKnowledgeEnabled(nextAssistantKnowledgeEnabled);
    }
    if (typeof nextChatStarterEnabled === "boolean") {
      setChatStarterEnabled(nextChatStarterEnabled);
    }
    touchSyncedAt();
  };

  const applySettings = (
    nextSettings: PublicAppSettings,
    nextImageGenerationEnabled?: boolean,
    nextExternalImportEnabled?: boolean,
    nextExternalContinuationEnabled?: boolean,
    nextAssistantProfilesEnabled?: boolean,
    nextAssistantKnowledgeEnabled?: boolean,
    nextChatStarterEnabled?: boolean
  ) => {
    applyLeadSettings(nextSettings);
    applyOperationalSettings(
      nextSettings,
      nextImageGenerationEnabled,
      nextExternalImportEnabled,
      nextExternalContinuationEnabled,
      nextAssistantProfilesEnabled,
      nextAssistantKnowledgeEnabled,
      nextChatStarterEnabled
    );
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
      const response = await adminFetch("/api/admin/app-settings", {
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
        data.externalConversationContinuationEnabled,
        data.assistantProfilesEnabled,
        data.assistantKnowledgeEnabled,
        data.chatStarterEnabled
      );
      applyMemoryStatus(data);
      if (data.guestLead) setStoredGuestLead(data.guestLead.stored);
      dispatchAppToast(m.toast.reloaded, "success");
    } catch {
      dispatchAppToast(m.toast.reloadFailed, "error");
    } finally {
      setIsLoading(false);
    }
  };

  const save = async () => {
    if (isLoading || isSaving || reauthenticationRequired) return;
    setIsSaving(true);
    try {
      // The route saves the nine flags together. A mount that draws only some
      // of them sends the values it shows and reads the rest now, so a stale
      // copy of a stop it cannot show is never written back. If that read
      // fails nothing is saved.
      let current: AdminAppSettingsResponse | null = null;
      if (!(show("emergency") && show("features"))) {
        const currentResponse = await adminFetch("/api/admin/app-settings", { cache: "no-store" });
        current = (await currentResponse.json().catch(() => null)) as AdminAppSettingsResponse | null;
        const readable =
          currentResponse.ok &&
          current?.settings &&
          [
            current.imageGenerationEnabled,
            current.externalConversationImportEnabled,
            current.externalConversationContinuationEnabled,
            current.assistantProfilesEnabled,
            current.assistantKnowledgeEnabled,
            current.chatStarterEnabled,
          ].every((value) => typeof value === "boolean");
        if (!readable) {
          dispatchAppToast(m.toast.notSaved, "error");
          return;
        }
      }
      const emergency = show("emergency") || !current?.settings
        ? { aiChatEnabled, attachmentsEnabled, publicSharingEnabled }
        : {
            aiChatEnabled: current.settings.aiChatEnabled,
            attachmentsEnabled: current.settings.attachmentsEnabled,
            publicSharingEnabled: current.settings.publicSharingEnabled,
          };
      const rollout = show("features") || !current
        ? {
            imageGenerationEnabled,
            externalConversationImportEnabled: externalImportEnabled,
            externalConversationContinuationEnabled: externalContinuationEnabled,
            assistantProfilesEnabled,
            assistantKnowledgeEnabled,
            chatStarterEnabled,
          }
        : {
            imageGenerationEnabled: current.imageGenerationEnabled,
            externalConversationImportEnabled: current.externalConversationImportEnabled,
            externalConversationContinuationEnabled: current.externalConversationContinuationEnabled,
            assistantProfilesEnabled: current.assistantProfilesEnabled,
            assistantKnowledgeEnabled: current.assistantKnowledgeEnabled,
            chatStarterEnabled: current.chatStarterEnabled,
          };
      const response = await adminFetch("/api/admin/app-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...emergency, ...rollout }),
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
            m.toast.saveNeedsSignIn,
            "error"
          );
          return;
        }
        const outcome = describeAdminApiFailure({
          status: response.status,
          error: data?.error,
          code: (data as { code?: string | null } | null)?.code,
          approvalId: (data as { approvalId?: string | null } | null)?.approvalId,
          fallback: m.toast.notSaved,
          locale: apiLocale,
        });
        setApiFailure(outcome);
        dispatchAppToast(
          data?.error && !outcome.approvalId && !outcome.requiresReauthentication
            ? m.toast.notSavedWithError(data.error)
            : outcome.message,
          outcome.tone
        );
        return;
      }
      applyOperationalSettings(
        data.settings,
        data.imageGenerationEnabled,
        data.externalConversationImportEnabled,
        data.externalConversationContinuationEnabled,
        data.assistantProfilesEnabled,
        data.assistantKnowledgeEnabled,
        data.chatStarterEnabled
      );
      applyMemoryStatus(data);
      dispatchAppToast(m.toast.saved, "success");
    } catch {
      // Only a transport failure reaches here now; a retry is the right advice.
      dispatchAppToast(m.toast.sendFailed, "error");
    } finally {
      setIsSaving(false);
    }
  };

  const saveLead = async () => {
    if (isLoading || isSaving || leadSaving || reauthenticationRequired) return;
    setLeadSaving(true);
    setLeadError(null);
    try {
      const response = await adminFetch("/api/admin/app-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestDefaultModelId }),
      });
      const data = (await response.json().catch(() => null)) as AdminAppSettingsResponse | null;
      if (response.status === 428) {
        setReauthenticationRequired(true);
        dispatchAppToast(m.toast.saveNeedsSignIn, "error");
        return;
      }
      if (!response.ok || !data?.settings) {
        setLeadError(data?.error || m.toast.leadNotSaved);
        dispatchAppToast(m.toast.leadNotSaved, "error");
        return;
      }
      applyLeadSettings(data.settings);
      setStoredGuestLead(data.guestLead?.stored ?? data.settings.guestDefaultModelId);
      dispatchAppToast(m.toast.leadSaved, "success");
    } catch {
      setLeadError(m.toast.sendFailed);
      dispatchAppToast(m.toast.sendFailed, "error");
    } finally {
      setLeadSaving(false);
    }
  };

  // The lead travels with the lineup: the saved one if the new lineup keeps
  // it, otherwise the lineup's first model, stated before the click. The
  // server refuses a lineup that would strand the stored lead, so sending it
  // explicitly is what keeps the two settings one decision.
  const lineupLead = lineupDraft.includes(appliedLead) ? appliedLead : lineupDraft[0];
  const providerOf = (id: string) => models.find((model) => model.id === id)?.provider ?? null;
  // Each slot offers one provider of the rule: the saved model's own when it
  // keeps the rule, otherwise one the saved lineup is missing -- so a lineup
  // that breaks the rule is repaired here rather than locked to the providers
  // that break it.
  const slotProviders = lineupSlotProviders(guestTrio.map(providerOf));
  const slotProvider = (index: number) => slotProviders[index] || null;
  const lineupChanged = lineupDraft.some((id, index) => id !== guestTrio[index]);
  const lineupComplete =
    lineupDraft.length === guestTrio.length &&
    lineupDraft.every(Boolean) &&
    new Set(lineupDraft).size === lineupDraft.length &&
    isOnePerLineupProvider(lineupDraft.map(providerOf));

  const saveLineup = async () => {
    if (isLoading || isSaving || lineupSaving || reauthenticationRequired) return;
    setLineupSaving(true);
    setLineupError(null);
    try {
      const response = await adminFetch("/api/admin/app-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestBrandTrioModelIds: lineupDraft,
          guestDefaultModelId: lineupLead,
        }),
      });
      const data = (await response.json().catch(() => null)) as AdminAppSettingsResponse | null;
      if (response.status === 428) {
        setReauthenticationRequired(true);
        dispatchAppToast(m.toast.saveNeedsSignIn, "error");
        return;
      }
      if (!response.ok || !data?.settings) {
        setLineupError(data?.error || m.toast.lineupNotSaved);
        dispatchAppToast(m.toast.lineupNotSaved, "error");
        return;
      }
      applyLeadSettings(data.settings);
      setStoredGuestLead(data.guestLead?.stored ?? data.settings.guestDefaultModelId);
      dispatchAppToast(m.toast.lineupSaved, "success");
    } catch {
      setLineupError(m.toast.sendFailed);
      dispatchAppToast(m.toast.sendFailed, "error");
    } finally {
      setLineupSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void adminFetch("/api/admin/models", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { models?: typeof registryModels }) => {
        if (!cancelled && Array.isArray(data?.models)) setRegistryModels(data.models);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setRegistryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const lookupModel = (id: string) => models.find((model) => model.id === id);
  // What a default may name, as every default resolver judges it.
  const guestEligibility = createDefaultLineupEligibilityCheck(
    lookupModel,
    createGuestEligibilityCheck(lookupModel)
  );
  const guestDescription = describeGuestDefault({
    storedLead: storedGuestLead,
    isEligible: guestEligibility,
    resolveReplacement: createReplacementResolver((id) =>
      models.find((model) => model.id === id)
    ),
    trio: guestTrio,
    providerOf,
  });
  const leadInList = guestModels.some((model) => model.id === guestDefaultModelId);
  const labelFor = (id: string) =>
    registryModels.find((model) => model.id === id)?.name ||
    models.find((model) => model.id === id)?.name ||
    id;
  const fallbackRow =
    registryModels.find((model) => model.id === APP_DEFAULTS.defaultModelId) ||
    models.find((model) => model.id === APP_DEFAULTS.defaultModelId);
  const candidate = registryModels.find((model) => model.id === candidateId) ?? null;
  const transitionChecks = candidate
    ? assessFallbackTransition({
        candidate,
        inCodeCatalog: Boolean(candidate.inCodeCatalog),
        hasPricingProfile: Boolean(candidate.hasPricingProfile),
        fallbackCreditWeight: fallbackRow?.creditWeight ?? 1,
      })
    : [];
  const outsideTrio = registryModels.filter(
    (model) =>
      model.enabled &&
      model.publiclyListed &&
      !model.catalogDeleted &&
      model.minimumPlan === "Guest" &&
      model.usageClass === "standard" &&
      !guestTrio.includes(model.id)
  );

  const reauthAlert = (
    reauthenticationRequired ? (
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
                {m.reauth.title}
              </h3>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-100/90">
                {m.reauth.body}
              </p>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-100/90">
                {m.reauth.next}
              </p>
              <Link
                href={adminRecentAuthenticationHref(returnPath)}
                data-testid="admin-platform-reauthenticate-link"
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 text-sm font-black text-zinc-950 transition hover:bg-amber-300"
              >
                <KeyRound className="h-4 w-4" aria-hidden />
                {m.reauth.link}
              </Link>
            </div>
          </div>
        </div>
    ) : null
  );

  const optionOf = (model: (typeof models)[number]): DefaultModelOption => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    credits: getModelUsageCredits(model),
  });
  const defaultModelsView = (
    <DefaultModelsView
      syncedLabel={lastSyncedAt}
      reload={{ busy: isLoading || isSaving, onReload: () => void reload() }}
      fallback={{
        name: fallbackRow?.name || APP_DEFAULTS.defaultModelId,
        id: APP_DEFAULTS.defaultModelId,
        provider: fallbackRow?.provider || "openai",
        credits: (() => { const row = models.find((model) => model.id === APP_DEFAULTS.defaultModelId); return row ? getModelUsageCredits(row) : null; })(),
      }}
      transition={{
        loaded: registryLoaded,
        candidates: registryModels
          .filter((model) => model.id !== APP_DEFAULTS.defaultModelId && !model.catalogDeleted)
          .map((model) => ({ id: model.id, name: model.name, provider: model.provider })),
        candidateId,
        onCandidate: setCandidateId,
        checks: transitionChecks,
        hasCandidate: Boolean(candidate),
        onCopy: () => {
          if (!candidate) return;
          const text = fallbackTransitionRequestText({
            candidateId: candidate.id,
            checks: transitionChecks,
          });
          void navigator.clipboard?.writeText(text).then(
            () => dispatchAppToast(m.toast.copyDoesNotApply, "success"),
            () => dispatchAppToast(m.toast.copyFailed, "error")
          );
        },
      }}
      lineup={{
        draft: lineupDraft,
        slotProviders: lineupDraft.map((_, index) => slotProvider(index)),
        options: lineupCandidates.map(optionOf),
        labelFor,
        changed: lineupChanged,
        complete: lineupComplete,
        saving: lineupSaving,
        error: lineupError,
        leadMovesTo:
          lineupChanged && lineupLead && lineupLead !== appliedLead ? labelFor(lineupLead) : null,
        onSlot: (index, id) => {
          setLineupError(null);
          setLineupDraft((current) => current.map((slotId, slot) => (slot === index ? id : slotId)));
        },
        onSave: () => void saveLineup(),
      }}
      lead={{
        value: guestDefaultModelId,
        options: guestModels.map(optionOf),
        inList: leadInList,
        saving: leadSaving,
        error: leadError,
        onChange: (id) => {
          setLeadError(null);
          setGuestDefaultModelId(id);
        },
        onSave: () => void saveLead(),
      }}
      notices={{
        visibleOrder: guestDescription.visibleIds.map(labelFor).join(", "),
        missingProviders:
          guestDescription.missingProviders.length > 0
            ? guestDescription.missingProviders
                .map((provider) => PROVIDER_LABELS.get(provider) ?? provider)
                .join(", ")
            : null,
        storedNotApplied:
          guestDescription.storedNotApplied && storedGuestLead && guestDescription.effectiveLeadId
            ? { stored: storedGuestLead, effective: guestDescription.effectiveLeadId }
            : null,
        substitutions: guestDescription.ineligibleTrioIds.flatMap((id, index) => {
          const substituteId = guestDescription.substituteIds[index];
          return substituteId
            ? [{ id, missing: labelFor(id), substitute: labelFor(substituteId) }]
            : [];
        }),
        outsideTrio: outsideTrio.map((model) => ({ id: model.id, name: model.name })),
      }}
    />
  );

  const stops = [
    { id: "ai-chat", icon: MessageCircle, copy: m.stops.cards.aiChat, enabled: aiChatEnabled, set: setAiChatEnabled },
    { id: "attachments", icon: Paperclip, copy: m.stops.cards.attachments, enabled: attachmentsEnabled, set: setAttachmentsEnabled },
    { id: "public-sharing", icon: Link2, copy: m.stops.cards.publicSharing, enabled: publicSharingEnabled, set: setPublicSharingEnabled },
  ].map((stop) => ({
    id: stop.id,
    icon: stop.icon,
    label: stop.copy.label,
    detail: stop.copy.detail,
    enabled: stop.enabled,
    onChange: stop.set,
  }));

  const flagRows = [
    { testId: "admin-chat-starter-flag", copy: m.switches.items.chatStarter, enabled: chatStarterEnabled, set: setChatStarterEnabled, waiting: false },
    { testId: "admin-image-generation-flag", copy: m.switches.items.imageGeneration, enabled: imageGenerationEnabled, set: setImageGenerationEnabled, waiting: false },
    { testId: "admin-external-import-flag", copy: m.switches.items.externalImport, enabled: externalImportEnabled, set: setExternalImportEnabled, waiting: false },
    { testId: "admin-external-continuation-flag", copy: m.switches.items.externalContinuation, enabled: externalContinuationEnabled, set: setExternalContinuationEnabled, waiting: false },
    { testId: "admin-assistant-profiles-flag", copy: m.switches.items.assistantProfiles, enabled: assistantProfilesEnabled, set: setAssistantProfilesEnabled, waiting: false },
    {
      testId: "admin-assistant-knowledge-flag",
      copy: m.switches.items.assistantKnowledge,
      enabled: assistantKnowledgeEnabled,
      set: setAssistantKnowledgeEnabled,
      // Knowledge is only in force while profiles are on (policy section 15).
      waiting: assistantKnowledgeEnabled && !assistantProfilesEnabled,
    },
  ].map((flag) => ({
    testId: flag.testId,
    label: flag.copy.label,
    detail: flag.copy.detail,
    enabled: flag.enabled,
    onChange: flag.set,
    waiting: flag.waiting,
  }));

  const reloadButton = (
    <button
      type="button"
      onClick={reload}
      disabled={isLoading || isSaving}
      className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <RefreshCw className="h-4 w-4" aria-hidden />
      )}
      {m.reload}
    </button>
  );

  // The Default models tab is its own page of cards, not a panel inside this
  // screen's frame; the whole-screen view keeps it in the frame.
  if (view === "default-models") {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {apiFailure ? <AdminApiFailureNotice failure={apiFailure} /> : null}
        {reauthAlert}
        {defaultModelsView}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="admin-platform-settings">
      {apiFailure ? <AdminApiFailureNotice failure={apiFailure} /> : null}
      {reauthenticationRequired ? (
        <div
          id="admin-platform-reauthentication"
          data-testid="admin-platform-reauthentication"
          role="alert"
          aria-live="assertive"
          className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5"
        >
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-200">
              <KeyRound className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-black text-amber-100">
                {m.reauth.title}
              </h3>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-100/90">
                {m.reauth.body}
              </p>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-amber-100/90">
                {m.reauth.next}
              </p>
              <Link
                href={adminRecentAuthenticationHref(returnPath)}
                data-testid="admin-platform-reauthenticate-link"
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-amber-400 px-4 py-2 text-sm font-black text-zinc-950 transition hover:bg-amber-300"
              >
                <KeyRound className="h-4 w-4" aria-hidden />
                {m.reauth.link}
              </Link>
            </div>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {reloadButton}
        {view === "all" || view === "emergency" || view === "features" ? (
          <AdminWriteButton
            stepUp
            onClick={save}
            // Disabled while a step-up is outstanding, and described by the
            // alert that says why: the endpoint would answer 428 again, and
            // an enabled Save is what turns one refusal into a loop.
            disabled={isLoading || isSaving || reauthenticationRequired}
            aria-describedby={
              reauthenticationRequired ? "admin-platform-reauthentication" : undefined
            }
            data-testid="admin-platform-save"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            {m.save}
          </AdminWriteButton>
        ) : null}
      </div>

      {show("emergency") ? <EmergencyStopsSection items={stops} /> : null}

      {show("features") ? (
        <>
          <FeatureSwitchesSection items={flagRows} />

          <AdminTile
            data-testid="admin-memory-release-status"
            title={m.switches.memory.title}
            description={m.switches.memory.summary}
          >
            <dl className="grid gap-3 sm:grid-cols-3">
              {[
                [m.switches.memory.extraction, memoryStatus.memoryExtractionEnabled, "memory-extraction-flag"],
                [m.switches.memory.injection, memoryStatus.memoryInjectionEnabled, "memory-injection-flag"],
              ].map(([label, on, testId]) => (
                <div key={String(testId)} className="rounded-xl bg-zinc-950/50 p-3">
                  <dt className="text-xs text-zinc-500">{label}</dt>
                  <dd data-testid={"admin-" + testId} className="mt-1">
                    <AdminStatusChip tone={on ? "ok" : "idle"}>
                      {on ? m.switches.memory.on : m.switches.memory.off}
                    </AdminStatusChip>
                  </dd>
                </div>
              ))}
              <div className="rounded-xl bg-zinc-950/50 p-3">
                <dt className="text-xs text-zinc-500">{memoryCopy.approvedPairs}</dt>
                <dd
                  data-testid="admin-memory-approved-pairs"
                  className="mt-1 text-lg font-bold tabular-nums text-white"
                >
                  {String(memoryStatus.memoryApprovedPairCount)}
                </dd>
              </div>
            </dl>
            {memoryStatus.memoryApprovedPairCount === 0 ? (
              <p data-testid="admin-memory-blocked-notice" className="text-sm font-bold text-amber-300">
                {memoryCopy.blocked}
              </p>
            ) : null}
            <AdminTechInfo summary={m.switches.memory.details}>
              <p className="font-sans leading-5">{memoryCopy.description}</p>
            </AdminTechInfo>
          </AdminTile>

          <AdminTile
            data-testid="admin-package-import-control"
            title={m.switches.packageImport.title}
            description={m.switches.packageImport.summary}
            action={
              <AdminStatusChip tone={packageImportEnabled ? "ok" : "idle"}>
                {packageImportEnabled
                  ? m.switches.packageImport.enabled
                  : m.switches.packageImport.disabled}
              </AdminStatusChip>
            }
          >
            <p className="sr-only">
              {packageImportEnabled
                ? m.packageImport.currentlyEnabled
                : m.packageImport.currentlyDisabled}
            </p>
            <label className="block text-sm font-bold text-white">
              {m.packageImport.rationale}
              <textarea
                value={packageImportRationale}
                onChange={(event) => setPackageImportRationale(event.target.value)}
                maxLength={500}
                rows={2}
                className="mt-2 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm font-normal text-white"
                data-testid="admin-package-import-rationale"
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <AdminWriteButton
                stepUp
                disabled={packageImportBusy}
                onClick={() => void submitPackageImportFlag(true)}
                data-testid="admin-package-import-enable"
              >
                {m.packageImport.enable}
              </AdminWriteButton>
              <AdminWriteButton
                variant="secondary"
                disabled={packageImportBusy}
                onClick={() => void submitPackageImportFlag(false)}
                data-testid="admin-package-import-disable"
              >
                {m.packageImport.rollBack}
              </AdminWriteButton>
            </div>
            <AdminTechInfo summary={m.switches.packageImport.details}>
              <p className="font-sans leading-5">{m.packageImport.eyebrow}</p>
              <p className="mt-2 font-sans leading-5">{m.packageImport.description}</p>
            </AdminTechInfo>
          </AdminTile>
        </>
      ) : null}

      {show("account-defaults") ? (
        <div data-testid="admin-account-defaults">
          <ReviewProviderDefaultsSettings scope="platform" />
        </div>
      ) : null}

      {view === "all" ? defaultModelsView : null}
    </div>
  );
}
