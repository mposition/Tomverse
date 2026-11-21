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
  type CodingLinkAllResult,
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
// 카탈로그 시안 v1"): the models (both kinds of row, the chat candidates and
// the Code snapshot). Provider conditions are gone (owner decision 2026-11-21).
// Reads /api/admin/model-catalog/coding; turning a model on or holding it and a
// dedicated model's whole-profile draft go through /api/admin/model-catalog,
// where one writer judges every activation.

const CODING_API = "/api/admin/model-catalog/coding";
const CATALOG_API = "/api/admin/model-catalog";
const CODING_PATH = "/admin/models?tab=coding";
// A draft fetches up to three pages (10 s each) and makes one LLM call (90 s).
const DRAFT_REQUEST_TIMEOUT_MS = 130_000;

type SendResult = { ok: true; payload: unknown } | { ok: false; timedOut: boolean };

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
});

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
  const [candidatesOpen, setCandidatesOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<CodingListFilter>({ query: "", provider: "all", source: "all", state: "all" });
  const [settings, setSettings] = useState<Record<string, CodingSettingsValue>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // The candidate being added (a request with no LLM call), and the add-all flow.
  const [adding, setAdding] = useState<string | null>(null);
  const [linkAll, setLinkAll] = useState<{ publish: boolean } | null>(null);
  const [addingAll, setAddingAll] = useState(false);
  const [linkAllResult, setLinkAllResult] = useState<{ result: CodingLinkAllResult; publish: number | "failed" | null } | null>(null);
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
      setPendingDraft(codingDraftRequest(window.location.search));
      void load();
    });
  }, [load]);

  useEffect(() => {
    if (!drafting) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [drafting]);

  const items = useMemo(() => (report ? codingCatalogItems(report) : []), [report]);
  const shown = useMemo(() => filterCodingItems(items, filter), [items, filter]);
  const openItem = items.find((item) => item.id === openId) ?? null;

  // The discovery queue sends a coding model here with its provider and API
  // model id filled in. The form opens prefilled; nothing is written until the
  // operator confirms. A model already in the catalogue opens its row.
  useEffect(() => {
    if (!pendingDraft || !report) return;
    const request = pendingDraft;
    queueMicrotask(() => {
      setPendingDraft(null);
      clearCodingDraftQuery();
      const existing = items.find((item) => item.id === request.apiModelId);
      if (existing) {
        setOpenId(existing.id);
        return;
      }
      const provider = report.draftProviders.some((entry) => entry.provider === request.provider)
        ? request.provider
        : (report.draftProviders[0]?.provider ?? request.provider);
      setCodingForm({ ...emptyCodingForm(provider), apiModelId: request.apiModelId });
    });
  }, [pendingDraft, report, items]);
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

  // A link reads the chat registry only: no LLM call, no page.
  const addCandidate = async (candidate: CodingCandidateView) => {
    setAdding(candidate.id);
    const result = await send(CODING_API, "POST", { action: "link", registryModelId: candidate.id });
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
    }
  };

  // Every candidate the judge passes, linked on Code and the coding API and switched on (one request).
  const doLinkAll = async (publish: boolean) => {
    setLinkAll(null);
    setAddingAll(true);
    setLinkAllResult(null);
    const result = await send(CODING_API, "POST", { action: "link_all" }, DRAFT_REQUEST_TIMEOUT_MS);
    if (!result.ok) {
      setAddingAll(false);
      if (result.timedOut) {
        // Each model commits on its own: what was added before the timeout stays added.
        showToast({ tone: "progress", title: c.toast.checking });
        await load();
        refused(["timeout"]);
      }
      return;
    }
    const outcome = result.payload as CodingLinkAllResult;
    let published: number | "failed" | null = null;
    if (publish && outcome.added.length > 0) published = (await publishSnapshot()) ?? "failed";
    await load();
    setAddingAll(false);
    setLinkAllResult({ result: outcome, publish: published });
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
      // A row drafted before terms pages were dropped lists them among its sources; the price page is the other one.
      priceUrl: profile?.pricing.sources.find((url) => url !== profile.terms?.url && url !== profile.retention?.url) ?? "",
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

  // --- render ----------------------------------------------------------------------

  const providerNames = useMemo(() => [...new Set(items.map((item) => item.provider).filter(Boolean))].sort(), [items]);
  const activateItem = activate?.item ?? null;
  const codingFormValid =
    codingForm !== null &&
    codingForm.apiModelId.trim().length > 0 &&
    (report?.draftProviders ?? []).some(
      (entry) => entry.provider === codingForm.provider && (codingForm.priceUrl.trim().length > 0 || entry.defaultSources.length > 0)
    );

  const linkValue = openItem?.source === "chat" ? settingsFor(openItem) : null;
  const modelsView = !report ? null : openItem && linkValue ? (
        <CodingLinkDetail
          key={openItem.id}
          c={c}
          item={openItem}
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
            adding={adding}
            addingAll={addingAll}
            result={linkAllResult?.result ?? null}
            resultPublish={linkAllResult?.publish ?? null}
            reasonText={reason}
            onAdd={(candidate) => void addCandidate(candidate)}
            onAddAll={() => setLinkAll({ publish: false })}
            onCloseResult={() => setLinkAllResult(null)}
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

      {modelsView}

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
        open={linkAll !== null}
        title={c.candidates.addAllTitle(report?.candidates.eligible.length ?? 0)}
        effects={[
          ...c.candidates.addAllEffects(report?.candidates.eligible.length ?? 0),
          <label key="publish" className="inline-flex items-center gap-2 font-bold text-zinc-100">
            <input
              type="checkbox"
              checked={linkAll?.publish ?? false}
              onChange={(event) => setLinkAll({ publish: event.target.checked })}
              data-testid="coding-link-all-publish-option"
              className="h-4 w-4 accent-blue-600"
            />
            {c.candidates.addAllPublish}
          </label>,
        ]}
        confirmLabel={c.candidates.addAllConfirm}
        busy={addingAll}
        onConfirm={() => linkAll && void doLinkAll(linkAll.publish)}
        onClose={() => setLinkAll(null)}
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
