"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { CodingModelDetail, CodingModelForm, type CodingModelFormValue } from "@/components/admin/modelCatalog/CodingCatalogViews";
import { CodingCandidates, CodingChannelsTile, CodingLinkDetail } from "@/components/admin/modelCatalog/CodingLinkViews";
import {
  CandidateSummary,
  CodingChannelBanner,
  CodingFilterBar,
  CodingModelTable,
  CodingSummary,
} from "@/components/admin/modelCatalog/CodingListViews";
import {
  CodingProviderTable,
  ProviderStartFields,
  type ProviderStartForm,
  ProviderTermsDraftPanel,
} from "@/components/admin/modelCatalog/CodingProviderViews";
import { CatalogToast, type CatalogToastValue, reasonText } from "@/components/admin/modelCatalog/ImageCatalogViews";
import { AdminConfirmDialog } from "@/components/admin/ui/AdminConfirmDialog";
import { AdminReasonDialog } from "@/components/admin/ui/AdminReasonDialog";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch, isAdminFetchTimeout } from "@/lib/adminFetch";
import { adminCodingCatalogMessages } from "@/lib/adminMessages/codingCatalog";
import { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";
import { adminModelsBoardMessages } from "@/lib/adminMessages/modelsBoard";
import {
  type CodingCandidateView,
  type CodingCatalogItem,
  type CodingCatalogReport,
  type CodingEditValue,
  type CodingListFilter,
  type CodingSettingsValue,
  type ImageNextAction,
  codingCatalogItems,
  codingDraftSources,
  codingEdit,
  codingSettingsFrom,
  codingSettingsRequest,
  filterCodingItems,
  isSessionGone,
  reasonMessage,
  refusalReasons,
} from "@/lib/adminModelCatalogFlow";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { CODING_DRAFT_QUERY_KEYS, codingDraftRequest } from "@/lib/codingCatalogDraftLink";

// Admin > Models > Coding catalog (owner decision 2026-11-20; Figma "코딩
// 카탈로그 시안 v1"). Two sections: the models (both kinds of row, the chat
// candidates and the Code snapshot) and the per-provider conditions. Reads
// /api/admin/model-catalog/coding; turning a model on or holding it and a
// dedicated model's whole-profile draft go through /api/admin/model-catalog,
// where one writer judges every activation.

const CODING_API = "/api/admin/model-catalog/coding";
const CATALOG_API = "/api/admin/model-catalog";
const CODING_PATH = "/admin/models?tab=coding";
// A draft fetches up to three pages (10 s each) and makes one LLM call (90 s).
const DRAFT_REQUEST_TIMEOUT_MS = 130_000;

type SendResult = { ok: true; payload: unknown } | { ok: false; timedOut: boolean };
type View = "models" | "providers";

const elapsedText = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const textarea =
  "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500";

const emptyCodingForm = (provider = "anthropic"): CodingModelFormValue => ({
  modelId: null,
  provider,
  apiModelId: "",
  priceUrl: "",
  termsUrl: "",
  retentionUrl: "",
});

const initialView = (): View => {
  if (typeof window === "undefined") return "models";
  return new URLSearchParams(window.location.search).get("view") === "providers" ? "providers" : "models";
};

/** Drops a handled discovery link's query, so a reload does not open the form again. */
const clearCodingDraftQuery = () => {
  const url = new URL(window.location.href);
  for (const key of CODING_DRAFT_QUERY_KEYS) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", url);
};

export function AdminCodingCatalogPanel() {
  const c = useAdminMessages(adminCodingCatalogMessages);
  const m = useAdminMessages(adminModelCatalogMessages);
  const board = useAdminMessages(adminModelsBoardMessages).catalog;
  const [report, setReport] = useState<CodingCatalogReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [toast, setToast] = useState<CatalogToastValue | null>(null);
  const [view, setView] = useState<View>("models");
  const [candidatesOpen, setCandidatesOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<CodingListFilter>({ query: "", provider: "all", source: "all", state: "all" });
  const [settings, setSettings] = useState<Record<string, CodingSettingsValue>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [adding, setAdding] = useState<{ id: string; startedAt: number } | null>(null);
  const [urlPrompt, setUrlPrompt] = useState<{ candidate: CodingCandidateView; toolUrl: string; structuredUrl: string } | null>(null);
  const [providerDrafting, setProviderDrafting] = useState<{ provider: string; startedAt: number } | null>(null);
  const [openProviderDraft, setOpenProviderDraft] = useState<string | null>(null);
  const [providerStart, setProviderStart] = useState<ProviderStartForm | null>(null);
  const [activate, setActivate] = useState<{ item: CodingCatalogItem; publish: boolean } | null>(null);
  const [hold, setHold] = useState<{ modelId: string; name: string } | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const [unlink, setUnlink] = useState<CodingCatalogItem | null>(null);
  // Dedicated models: the whole-profile draft flow.
  const [codingEdits, setCodingEdits] = useState<Record<string, CodingEditValue>>({});
  const [codingForm, setCodingForm] = useState<CodingModelFormValue | null>(null);
  const [drafting, setDrafting] = useState<{ modelId: string; startedAt: number } | null>(null);
  // A link from the discovery queue (?draft=coding&provider=&api=), held until the report has loaded.
  const [pendingDraft, setPendingDraft] = useState<{ provider: string; apiModelId: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((value: CatalogToastValue | null) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(value);
    if (value?.tone === "ok") toastTimer.current = setTimeout(() => setToast(null), 6_000);
  }, []);

  const load = useCallback(async (): Promise<CodingCatalogReport | null> => {
    setLoading(true);
    try {
      const response = await adminFetch(CODING_API, { cache: "no-store" });
      if (response.status === 404) setSessionExpired(true);
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as CodingCatalogReport;
      setReport(next);
      setLoadError(false);
      return next;
    } catch {
      setLoadError(true);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      setView(initialView());
      setPendingDraft(codingDraftRequest(window.location.search));
      void load();
    });
  }, [load]);

  useEffect(() => {
    if (!adding && !providerDrafting && !drafting) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [adding, providerDrafting, drafting]);

  const providerRows = useMemo(() => report?.providers ?? [], [report]);
  const items = useMemo(() => (report ? codingCatalogItems(report) : []), [report]);
  const shown = useMemo(() => filterCodingItems(items, filter), [items, filter]);
  const openItem = items.find((item) => item.id === openId) ?? null;

  // The discovery queue sends a coding model here with its provider and API
  // model id filled in. The form opens prefilled (the provider's confirmed
  // terms and retention pages too, when it has them); nothing is written until
  // the operator confirms. A model already in the catalogue opens its row.
  useEffect(() => {
    if (!pendingDraft || !report) return;
    const request = pendingDraft;
    queueMicrotask(() => {
      setPendingDraft(null);
      clearCodingDraftQuery();
      const existing = items.find((item) => item.id === request.apiModelId);
      if (existing) {
        setView("models");
        setOpenId(existing.id);
        return;
      }
      const provider = report.draftProviders.some((entry) => entry.provider === request.provider)
        ? request.provider
        : (report.draftProviders[0]?.provider ?? request.provider);
      const terms = providerRows.find((row) => row.provider === provider)?.terms ?? null;
      setView("models");
      setCodingForm({
        ...emptyCodingForm(provider),
        apiModelId: request.apiModelId,
        termsUrl: terms?.termsUrl ?? "",
        retentionUrl: terms?.retentionUrl ?? "",
      });
    });
  }, [pendingDraft, report, items, providerRows]);
  const pendingIds = useMemo(() => new Set((report?.snapshot?.pendingChanges ?? []).map((change) => change.modelId)), [report]);
  const reason = useCallback((code: string) => reasonText(m, reasonMessage(code)), [m]);

  const refused = useCallback(
    (codes: readonly string[], detail = "") =>
      showToast({ tone: "refused", title: c.toast.refused, body: codes.map((code) => reasonText(m, reasonMessage(code, detail))).join(" ") }),
    [c, m, showToast]
  );

  /** One request; refusals become a toast in words. A timeout is reported, never retried here. */
  const send = async (url: string, method: "PATCH" | "POST", body: unknown, timeoutMs?: number): Promise<SendResult> => {
    let response: Response;
    try {
      response = await adminFetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeoutMs });
    } catch (error) {
      const timedOut = isAdminFetchTimeout(error);
      if (!timedOut) refused(["network_error"]);
      return { ok: false, timedOut };
    }
    const payload = (await response.json().catch(() => null)) as { error?: string; reasons?: string[]; detail?: string | null } | null;
    if (!response.ok) {
      if (isSessionGone(response.status, payload)) {
        setSessionExpired(true);
        showToast({
          tone: "refused",
          title: c.toast.sessionExpired,
          action: { label: c.toast.relogin, onClick: () => window.location.assign(adminRecentAuthenticationHref(CODING_PATH)) },
        });
      } else if (response.status === 403) {
        refused(["forbidden"]);
      } else {
        refused(refusalReasons(payload?.error ?? String(response.status), payload?.reasons ?? []), payload?.detail ?? "");
      }
      return { ok: false, timedOut: false };
    }
    return { ok: true, payload };
  };

  const settingsFor = (item: CodingCatalogItem): CodingSettingsValue | null =>
    item.link ? (settings[item.id] ?? codingSettingsFrom(item.link)) : null;

  // --- chat links --------------------------------------------------------------

  const addCandidate = async (candidate: CodingCandidateView, sourceUrls: string[] = []) => {
    setUrlPrompt(null);
    setAdding({ id: candidate.id, startedAt: Date.now() });
    setNow(Date.now());
    const result = await send(CODING_API, "POST", { action: "link", registryModelId: candidate.id, sourceUrls }, DRAFT_REQUEST_TIMEOUT_MS);
    setAdding(null);
    if (result.ok) {
      await load();
      setCandidatesOpen(false);
      setOpenId(candidate.id);
      showToast({ tone: "ok", title: c.candidates.added(candidate.name) });
      return;
    }
    if (result.timedOut) {
      showToast({ tone: "progress", title: c.toast.checking });
      const next = await load();
      if (next?.models.some((row) => row.modelId === candidate.id)) showToast({ tone: "ok", title: c.toast.finishedAnyway });
      else refused(["timeout"]);
      return;
    }
  };

  const onAdd = (candidate: CodingCandidateView) => {
    // The draft reads one tool calling page and one structured output page;
    // the dialog shows the provider's defaults so the operator sees and can
    // replace what is read before the draft call.
    const defaults = report?.draftProviders.find((entry) => entry.provider === candidate.provider)?.capabilitySources ?? null;
    setUrlPrompt({ candidate, toolUrl: defaults?.toolCalling ?? "", structuredUrl: defaults?.structuredOutput ?? "" });
  };

  const saveSettings = async (item: CodingCatalogItem) => {
    const value = settingsFor(item);
    if (!item.link || !value) return;
    setBusy(true);
    const result = await send(CODING_API, "POST", { action: "settings", modelId: item.id, settings: codingSettingsRequest(item.link, value) });
    setBusy(false);
    if (!result.ok) return;
    setSettings((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    await load();
    showToast({ tone: "ok", title: c.detail.saved });
  };

  // A dedicated row's settings here: where it is offered, and its coding API credits.
  const saveChannels = async (item: CodingCatalogItem, settings: { channels?: string[]; apiCreditWeight?: number | null }) => {
    setBusy(true);
    const result = await send(CODING_API, "POST", { action: "settings", modelId: item.id, settings });
    setBusy(false);
    if (!result.ok) return;
    await load();
    showToast({ tone: "ok", title: c.detail.saved });
  };

  const doUnlink = async (item: CodingCatalogItem) => {
    setBusy(true);
    const result = await send(CODING_API, "POST", { action: "unlink", modelId: item.id });
    setBusy(false);
    setUnlink(null);
    if (!result.ok) return;
    setOpenId(null);
    await load();
    showToast({ tone: "ok", title: c.detail.unlinked(item.name) });
  };

  // --- activation, hold and the snapshot ---------------------------------------

  const publishSnapshot = async (): Promise<number | null> => {
    const result = await send(CODING_API, "POST", { action: "publish_snapshot" });
    if (!result.ok) return null;
    const payload = result.payload as { created?: boolean; snapshot?: { version?: number } };
    return payload.snapshot?.version ?? null;
  };

  const onPublish = async () => {
    setBusy(true);
    const result = await send(CODING_API, "POST", { action: "publish_snapshot" });
    setBusy(false);
    if (!result.ok) return;
    const payload = result.payload as { created?: boolean; snapshot?: { version?: number } };
    await load();
    showToast({ tone: "ok", title: payload.created && payload.snapshot?.version ? c.snapshot.published(payload.snapshot.version) : c.snapshot.unchanged });
  };

  const doActivate = async (item: CodingCatalogItem, publish: boolean) => {
    setBusy(true);
    const result = await send(CATALOG_API, "PATCH", { category: "coding", modelId: item.id, enabled: true, holdReason: null });
    if (!result.ok) {
      setBusy(false);
      setActivate(null);
      return;
    }
    const version = publish ? await publishSnapshot() : null;
    setBusy(false);
    setActivate(null);
    await load();
    // A failed publish keeps a refusal on screen: the model is on, but not in a new snapshot.
    if (publish && version === null) {
      showToast({ tone: "refused", title: c.activate.donePublishFailed(item.name) });
      return;
    }
    showToast({ tone: "ok", title: version ? c.activate.donePublished(item.name, version) : c.activate.done(item.name) });
  };

  const doHold = async () => {
    if (!hold || !holdReason.trim()) return;
    const target = hold;
    const reasonText = holdReason.trim();
    setHold(null);
    if ((await send(CATALOG_API, "PATCH", { category: "coding", modelId: target.modelId, holdReason: reasonText })).ok) {
      await load();
      showToast({ tone: "ok", title: m.toastHeld(target.name) });
    }
  };

  // --- dedicated models: the whole-profile draft ----------------------------------

  const requestCodingDraft = async (value: CodingModelFormValue) => {
    const apiModelId = value.apiModelId.trim();
    const modelId = value.modelId ?? apiModelId;
    const before = items.find((item) => item.id === modelId)?.draftCreatedAt ?? null;
    const defaults = report?.draftProviders.find((entry) => entry.provider === value.provider)?.defaultSources ?? [];
    setCodingForm(null);
    setDrafting({ modelId, startedAt: Date.now() });
    setNow(Date.now());
    setOpenId(modelId);
    showToast({ tone: "progress", title: m.codingFlow.draftingTitle, body: m.codingFlow.draftingBody });
    const result = await send(
      CATALOG_API,
      "POST",
      { action: "draft", category: "coding", modelId, provider: value.provider, apiModelId, sourceUrls: codingDraftSources(value, defaults) },
      DRAFT_REQUEST_TIMEOUT_MS
    );
    setDrafting(null);
    if (result.ok) {
      await load();
      showToast({ tone: "ok", title: m.codingFlow.toastDraftReady(apiModelId), body: m.codingFlow.toastDraftReadyBody });
      return;
    }
    if (result.timedOut) {
      showToast({ tone: "progress", title: c.toast.checking });
      const next = await load();
      const after = next ? codingCatalogItems(next).find((item) => item.id === modelId)?.draftCreatedAt ?? null : null;
      if (after && after !== before) showToast({ tone: "ok", title: c.toast.finishedAnyway });
      else refused(["timeout"]);
    }
  };

  const codingFormFor = (item: CodingCatalogItem): CodingModelFormValue => {
    const profile = item.draft ?? item.profile;
    return {
      modelId: item.id,
      provider: item.provider || report?.draftProviders[0]?.provider || "anthropic",
      apiModelId: item.apiModelId,
      priceUrl: profile?.pricing.sources.find((url) => url !== profile.terms?.url && url !== profile.retention?.url) ?? "",
      termsUrl: profile?.terms?.url ?? "",
      retentionUrl: profile?.retention?.url ?? "",
    };
  };

  const onDedicatedAction = (item: CodingCatalogItem, action: ImageNextAction) => {
    if (action === "enable") {
      setActivate({ item, publish: false });
      return;
    }
    if (action === "make_draft" || action === "redraft" || action === "fix_profile") setCodingForm(codingFormFor(item));
  };

  const applyCodingProfile = async (item: CodingCatalogItem) => {
    if (!item.draft) return;
    setBusy(true);
    const result = await send(CATALOG_API, "POST", {
      action: "apply_draft",
      category: "coding",
      modelId: item.id,
      codingEdit: codingEdit(item.draft, codingEdits[item.id] ?? {}),
    });
    setBusy(false);
    if (!result.ok) return;
    setCodingEdits((current) => ({ ...current, [item.id]: {} }));
    const next = await load();
    // The applied name, which the operator may just have changed.
    const name = (next ? codingCatalogItems(next).find((entry) => entry.id === item.id)?.name : null) ?? item.name;
    showToast({ tone: "ok", title: m.codingFlow.toastApplied(name) });
  };

  // --- provider conditions -------------------------------------------------------

  const draftProviderTerms = async (provider: string, sourceUrls: string[]) => {
    setProviderStart(null);
    setProviderDrafting({ provider, startedAt: Date.now() });
    setNow(Date.now());
    const result = await send(CODING_API, "POST", { action: "provider_terms_draft", provider, sourceUrls }, DRAFT_REQUEST_TIMEOUT_MS);
    setProviderDrafting(null);
    if (result.ok) {
      await load();
      setOpenProviderDraft(provider);
      showToast({ tone: "ok", title: c.providers.draftReady(provider) });
      return;
    }
    if (result.timedOut) {
      showToast({ tone: "progress", title: c.toast.checking });
      const next = await load();
      if (next?.providers.find((row) => row.provider === provider)?.draft) {
        setOpenProviderDraft(provider);
        showToast({ tone: "ok", title: c.toast.finishedAnyway });
      } else refused(["timeout"]);
    }
  };

  const settleProviderDraft = async (provider: string, apply: boolean) => {
    setBusy(true);
    const result = await send(CODING_API, "POST", { action: apply ? "provider_terms_apply" : "provider_terms_discard", provider });
    setBusy(false);
    if (!result.ok) return;
    setOpenProviderDraft(null);
    await load();
    showToast({ tone: "ok", title: apply ? c.providers.applied(provider) : c.providers.discarded });
  };

  // --- render ----------------------------------------------------------------------

  const providerNames = useMemo(() => [...new Set(items.map((item) => item.provider).filter(Boolean))].sort(), [items]);
  const openProviderRow = providerRows.find((row) => row.provider === openProviderDraft) ?? null;
  const activateItem = activate?.item ?? null;
  const activateProvider = activateItem ? (providerRows.find((row) => row.provider === activateItem.provider) ?? null) : null;
  const startRow = providerStart ? (providerRows.find((row) => row.provider === providerStart.provider) ?? null) : null;
  const codingFormValid =
    codingForm !== null &&
    codingForm.apiModelId.trim().length > 0 &&
    codingForm.termsUrl.trim().length > 0 &&
    codingForm.retentionUrl.trim().length > 0 &&
    (report?.draftProviders ?? []).some(
      (entry) => entry.provider === codingForm.provider && (codingForm.priceUrl.trim().length > 0 || entry.defaultSources.length > 0)
    );

  const viewButton = (id: View, count: number) => (
    <button
      type="button"
      aria-pressed={view === id}
      onClick={() => {
        setView(id);
        setOpenId(null);
        setCandidatesOpen(false);
      }}
      data-testid={`coding-view-${id}`}
      className={`min-h-9 rounded-xl border px-3 text-sm font-bold ${
        view === id ? "border-blue-500 bg-blue-500/10 text-zinc-100" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
      }`}
    >
      {c.views[id]} · {count}
    </button>
  );

  const linkValue = openItem?.source === "chat" ? settingsFor(openItem) : null;
  const modelsView = !report ? null : openItem && linkValue ? (
        <CodingLinkDetail
          key={openItem.id}
          c={c}
          item={openItem}
          provider={providerRows.find((row) => row.provider === openItem.provider) ?? null}
          value={linkValue}
          busy={busy}
          reasonText={reason}
          toolCallingLabel={(entry) => m.codingFlow.toolCalling[entry] ?? entry}
          structuredOutputLabel={(entry) => m.codingFlow.structuredOutput[entry] ?? entry}
          stepperLabel={m.stepperLabel}
          stepStates={m.stepStates}
          onBack={() => setOpenId(null)}
          onChange={(next) => setSettings((current) => ({ ...current, [openItem.id]: next }))}
          onReset={() =>
            setSettings((current) => {
              const next = { ...current };
              delete next[openItem.id];
              return next;
            })
          }
          onSave={() => void saveSettings(openItem)}
          onActivate={() => setActivate({ item: openItem, publish: false })}
          onHold={() => {
            setHoldReason("");
            setHold({ modelId: openItem.id, name: openItem.name });
          }}
          onUnlink={() => setUnlink(openItem)}
          onProviders={() => {
            setOpenId(null);
            setView("providers");
          }}
        />
      ) : openItem ? (
        <CodingModelDetail
          m={m}
          item={openItem}
          edits={codingEdits[openItem.id] ?? {}}
          drafting={drafting?.modelId === openItem.id ? elapsedText(now - drafting.startedAt) : null}
          onBack={() => setOpenId(null)}
          onEdit={(field, value) =>
            setCodingEdits((current) => ({ ...current, [openItem.id]: { ...(current[openItem.id] ?? {}), [field]: value } }))
          }
          onResetEdits={() => setCodingEdits((current) => ({ ...current, [openItem.id]: {} }))}
          onApply={() => void applyCodingProfile(openItem)}
          onAction={(action) => onDedicatedAction(openItem, action)}
          onHold={() => {
            setHoldReason("");
            setHold({ modelId: openItem.id, name: openItem.name });
          }}
          channels={
            <CodingChannelsTile
              key={`${openItem.id}:${openItem.channels.join(",")}:${openItem.apiCredit?.override ?? ""}`}
              c={c}
              item={openItem}
              busy={busy}
              onSave={(settings) => void saveChannels(openItem, settings)}
            />
          }
        />
      ) : drafting && !items.some((item) => item.id === drafting.modelId) ? (
        <AdminStateBlock kind="loading" />
      ) : candidatesOpen ? (
        <>
          <CodingSummary
            c={c}
            items={items}
            candidateCount={report.candidates.eligible.length}
            snapshot={report.snapshot}
            onCandidates={() => setCandidatesOpen(false)}
            candidatesOpen
            onPublish={() => void onPublish()}
            busy={busy}
            showSnapshot={false}
          />
          <CodingCandidates
            c={c}
            candidates={report.candidates.eligible}
            excluded={report.candidates.excluded}
            adding={adding ? { id: adding.id, elapsed: elapsedText(now - adding.startedAt) } : null}
            draftConfigured={report.draftLlm.configured}
            onAdd={onAdd}
            onBack={() => setCandidatesOpen(false)}
          />
        </>
      ) : (
      <>
        <CodingSummary
          c={c}
          items={items}
          candidateCount={report.candidates.eligible.length}
          snapshot={report.snapshot}
          onCandidates={() => setCandidatesOpen(true)}
          candidatesOpen={false}
          onPublish={() => void onPublish()}
          busy={busy}
        />
        <CodingFilterBar c={c} providers={providerNames} filter={filter} onChange={setFilter} />
        <CodingChannelBanner c={c} external={report.externalChannels} />
        <CodingModelTable c={c} items={shown} pendingIds={pendingIds} reasonText={reason} onOpen={(item) => setOpenId(item.id)} />
        <CandidateSummary c={c} candidates={report.candidates.eligible} onOpen={() => setCandidatesOpen(true)} />
      </>
      );

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="coding-catalog-panel">
      <AdminTile title={c.title} description={c.description}>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm font-bold text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
            {c.refresh}
          </button>
          {report ? (
            <AdminWriteButton
              disabled={!report.draftLlm.configured || drafting !== null}
              onClick={() => setCodingForm(emptyCodingForm(report.draftProviders.find((entry) => entry.provider === "anthropic")?.provider ?? report.draftProviders[0]?.provider))}
              data-testid="model-catalog-add-coding"
            >
              <Plus className="h-4 w-4" aria-hidden />
              {c.addDedicated}
            </AdminWriteButton>
          ) : null}
        </div>
        {report && !report.draftLlm.configured ? <p className="text-xs text-amber-300">{c.draftNotConfigured(report.draftLlm.env)}</p> : null}
      </AdminTile>

      {sessionExpired ? (
        <div role="alert" data-testid="model-catalog-session-expired" className="flex flex-col gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-sm font-bold text-amber-300">{c.toast.sessionExpired}</p>
          <a
            href={adminRecentAuthenticationHref(CODING_PATH)}
            className="inline-flex min-h-10 items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-500"
          >
            {c.toast.relogin}
          </a>
        </div>
      ) : null}
      {loadError && !sessionExpired ? (
        <AdminStateBlock kind="error" title={board.loadFailedTitle} detail={board.loadFailedDetail} onRetry={() => void load()} />
      ) : null}
      {toast ? <CatalogToast m={m} toast={toast} onClose={() => showToast(null)} /> : null}
      {loading && !report ? <AdminStateBlock kind="loading" /> : null}

      {report ? (
        <>
          <div role="group" aria-label={c.viewsLabel} className="flex flex-wrap gap-2">
            {viewButton("models", items.length)}
            {viewButton("providers", providerRows.length)}
          </div>
          {view === "providers" ? (
            <>
              <CodingProviderTable
                c={c}
                providers={providerRows}
                drafting={providerDrafting?.provider ?? null}
                openDraft={openProviderDraft}
                draftConfigured={report.draftLlm.configured}
                onCheck={(row) =>
                  row.terms ? void draftProviderTerms(row.provider, []) : setProviderStart({ provider: row.provider, termsUrl: "", retentionUrl: "", extraUrl: "" })
                }
                onOpenDraft={(row) => setOpenProviderDraft(openProviderDraft === row.provider ? null : row.provider)}
              />
              {providerDrafting ? (
                <p className="text-xs font-bold text-blue-300" role="status">
                  {c.providers.drafting} {elapsedText(now - providerDrafting.startedAt)}
                </p>
              ) : null}
              {openProviderRow ? (
                <ProviderTermsDraftPanel
                  c={c}
                  row={openProviderRow}
                  busy={busy}
                  onDiscard={() => void settleProviderDraft(openProviderRow.provider, false)}
                  onApply={() => void settleProviderDraft(openProviderRow.provider, true)}
                />
              ) : null}
              <p className="text-xs text-zinc-500">{c.providers.footnote}</p>
            </>
          ) : (
            modelsView
          )}
        </>
      ) : null}

      <AdminConfirmDialog
        open={activateItem !== null}
        title={activateItem ? c.activate.title(activateItem.name) : ""}
        summary={
          activateItem
            ? c.activate.summary(activateItem.provider, activateItem.apiModelId, activateItem.source ? c.source[activateItem.source] : "")
            : undefined
        }
        effects={
          activateItem?.profile
            ? [
                c.activate.effectChannels(
                  activateItem.name,
                  activateItem.channels.map((channel) => c.channel[channel as "code" | "api" | "cli"] ?? channel).join(" · "),
                  activateItem.profile.minimumPlan,
                  report?.externalChannels.enabled ?? false
                ),
                c.activate.effectCredits(activateItem.profile.pricing.creditWeight),
                c.activate.effectProvider(activateItem.provider),
                c.activate.effectSnapshot(report?.snapshot?.version ?? null, report?.snapshot?.coverageUntil.slice(0, 10) ?? null),
                c.activate.effectJudge,
                c.activate.conditions(activateItem.provider, activateProvider?.checkedAt ?? activateItem.termsCheckedAt),
                c.activate.undo,
                <label key="publish" className="inline-flex items-center gap-2 font-bold text-zinc-100">
                  <input
                    type="checkbox"
                    checked={activate?.publish ?? false}
                    onChange={(event) => activate && setActivate({ ...activate, publish: event.target.checked })}
                    data-testid="coding-activate-publish"
                    className="h-4 w-4 accent-blue-600"
                  />
                  {c.activate.publishAfter}
                </label>,
              ]
            : []
        }
        confirmLabel={c.activate.confirm}
        busy={busy}
        onConfirm={() => activate && void doActivate(activate.item, activate.publish)}
        onClose={() => setActivate(null)}
      />

      <AdminConfirmDialog
        open={unlink !== null}
        title={unlink ? c.detail.unlinkTitle(unlink.name) : ""}
        effects={c.detail.unlinkEffects}
        confirmLabel={c.detail.unlink}
        tone="danger"
        busy={busy}
        onConfirm={() => unlink && void doUnlink(unlink)}
        onClose={() => setUnlink(null)}
      />

      <AdminReasonDialog
        open={urlPrompt !== null}
        title={urlPrompt ? c.candidates.urlTitle(urlPrompt.candidate.name) : ""}
        description={
          report?.draftProviders.find((entry) => entry.provider === urlPrompt?.candidate.provider)?.capabilitySources
            ? c.candidates.urlDescription
            : c.candidates.urlDescriptionNoDefault
        }
        confirmLabel={c.candidates.urlConfirm}
        confirmDisabled={!urlPrompt?.toolUrl.trim()}
        onConfirm={() =>
          urlPrompt &&
          void addCandidate(
            urlPrompt.candidate,
            [...new Set([urlPrompt.toolUrl.trim(), urlPrompt.structuredUrl.trim()].filter(Boolean))]
          )
        }
        onClose={() => setUrlPrompt(null)}
      >
        {urlPrompt ? (
          <div className="space-y-3">
            <label className="block text-xs font-bold text-zinc-300">
              {c.candidates.toolUrlLabel}
              <input
                type="url"
                value={urlPrompt.toolUrl}
                onChange={(event) => setUrlPrompt({ ...urlPrompt, toolUrl: event.target.value })}
                data-testid="coding-candidate-tool-url"
                className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
              />
            </label>
            <label className="block text-xs font-bold text-zinc-300">
              {c.candidates.structuredUrlLabel}
              <input
                type="url"
                value={urlPrompt.structuredUrl}
                onChange={(event) => setUrlPrompt({ ...urlPrompt, structuredUrl: event.target.value })}
                data-testid="coding-candidate-structured-url"
                className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-blue-500"
              />
            </label>
          </div>
        ) : null}
      </AdminReasonDialog>

      <AdminReasonDialog
        open={providerStart !== null}
        title={providerStart ? c.providers.startTitle(providerStart.provider) : ""}
        description={c.providers.startDescription}
        confirmLabel={c.providers.startConfirm}
        confirmDisabled={!providerStart?.termsUrl.trim() || !providerStart?.retentionUrl.trim()}
        onConfirm={() =>
          providerStart &&
          void draftProviderTerms(
            providerStart.provider,
            [...new Set([providerStart.termsUrl.trim(), providerStart.retentionUrl.trim(), providerStart.extraUrl.trim()].filter(Boolean))]
          )
        }
        onClose={() => setProviderStart(null)}
      >
        {providerStart ? <ProviderStartFields c={c} value={providerStart} hosts={startRow?.hosts ?? []} onChange={setProviderStart} /> : null}
      </AdminReasonDialog>

      <AdminReasonDialog
        open={codingForm !== null}
        title={m.codingFlow.addTitle}
        description={m.codingFlow.addDescription}
        confirmLabel={m.codingFlow.addConfirm}
        confirmDisabled={!codingFormValid}
        onConfirm={() => codingForm && void requestCodingDraft(codingForm)}
        onClose={() => setCodingForm(null)}
      >
        {codingForm ? <CodingModelForm m={m} value={codingForm} onChange={setCodingForm} providers={report?.draftProviders ?? []} /> : null}
      </AdminReasonDialog>

      <AdminReasonDialog
        open={hold !== null}
        title={board.holdTitle}
        description={m.holdPrompt}
        confirmLabel={board.holdConfirm}
        confirmDisabled={!holdReason.trim()}
        onConfirm={() => void doHold()}
        onClose={() => setHold(null)}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-bold text-zinc-100">{board.holdReason}</span>
          <textarea value={holdReason} onChange={(event) => setHoldReason(event.target.value)} rows={3} className={textarea} />
        </label>
      </AdminReasonDialog>
    </div>
  );
}
