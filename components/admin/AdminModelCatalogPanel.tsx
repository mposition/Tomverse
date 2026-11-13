"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  CodingCatalogList,
  CodingModelDetail,
  CodingModelForm,
  type CodingModelFormValue,
} from "@/components/admin/modelCatalog/CodingCatalogViews";
import {
  CatalogToast,
  type CatalogToastValue,
  ImageCatalogList,
  ImageModelDetail,
  ImageModelForm,
  type ImageModelFormValue,
  reasonText,
} from "@/components/admin/modelCatalog/ImageCatalogViews";
import { AdminConfirmDialog } from "@/components/admin/ui/AdminConfirmDialog";
import { AdminReasonDialog } from "@/components/admin/ui/AdminReasonDialog";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch, isAdminFetchTimeout } from "@/lib/adminFetch";
import { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";
import { adminModelsBoardMessages } from "@/lib/adminMessages/modelsBoard";
import {
  type CodingCatalogItem,
  codingCatalogItems,
  codingDraftSources,
  codingEdit,
  type CodingEditValue,
  codingStage,
  creditOverrides,
  type ImageCatalogItem,
  imageCatalogItems,
  type ImageNextAction,
  imageStage,
  isSessionGone,
  priceRange,
  reasonMessage,
  refusalReasons,
} from "@/lib/adminModelCatalogFlow";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import {
  discoveryDraftRequest,
  RUNTIME_IMAGE_QUALITIES,
  RUNTIME_IMAGE_SIZES,
  runtimeImageProfileTemplate,
} from "@/lib/runtimeImageProviders";

// Operator surface over /api/admin/model-catalog. Image models follow one
// guided flow (details -> price draft -> check prices -> turn on) with no JSON
// to type; the schemas and the judge stay server-side (lib/modelCatalogCore.ts).
// Coding models follow the same four steps; their draft is a whole profile,
// shown as a field table where only the name, minimum plan and credit weight
// are the operator's to change.

// A draft fetches up to three pages (10 s each) and makes one LLM call (90 s);
// the 15 s admin default cut it off and the panel showed nothing.
const DRAFT_REQUEST_TIMEOUT_MS = 130_000;
const CATALOG_PATH = "/admin/models?tab=catalog";

type CatalogReport = {
  image: Parameters<typeof imageCatalogItems>[0] & {
    providers?: { provider: string; defaultSources: string[]; hosts: string[] }[];
  };
  coding: Parameters<typeof codingCatalogItems>[0] & {
    snapshot: { version: number; models: unknown[]; coverageUntil: string } | null;
    providers?: { provider: string; defaultSources: string[]; hosts: string[] }[];
  };
  chat: { models: { modelId: string; name: string; provider: string; enabled: boolean }[] };
  video: { policy: { reasons: string[] } };
  draftLlm: { configured: boolean; env: string };
};

type SendResult = { ok: true; payload: unknown } | { ok: false; timedOut: boolean };

const textarea =
  "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500";

const emptyForm = (provider = "openai"): ImageModelFormValue => ({
  provider,
  apiModelId: "",
  name: "",
  sizes: [...RUNTIME_IMAGE_SIZES],
  qualities: [...RUNTIME_IMAGE_QUALITIES],
  sources: "",
});

const emptyCodingForm = (provider = "anthropic"): CodingModelFormValue => ({
  modelId: null,
  provider,
  apiModelId: "",
  priceUrl: "",
  termsUrl: "",
  retentionUrl: "",
});

const elapsedText = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function AdminModelCatalogPanel() {
  const m = useAdminMessages(adminModelCatalogMessages);
  const board = useAdminMessages(adminModelsBoardMessages).catalog;
  const [report, setReport] = useState<CatalogReport | null>(null);
  const [loading, setLoading] = useState(false);
  // A failed read is its own state: an empty catalogue would say "no models".
  const [loadError, setLoadError] = useState(false);
  const [toast, setToast] = useState<CatalogToastValue | null>(null);
  // The toast fades; this notice stays until the operator signs in again
  // (admin-console-ia: a toast alone is not a way back).
  const [sessionExpired, setSessionExpired] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [form, setForm] = useState<{ mode: "add" | "fix"; modelId: string | null; value: ImageModelFormValue } | null>(null);
  const [drafting, setDrafting] = useState<{ category: "image" | "coding"; modelId: string; startedAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirmEnable, setConfirmEnable] = useState<ImageCatalogItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [codingOpenId, setCodingOpenId] = useState<string | null>(null);
  const [codingEdits, setCodingEdits] = useState<Record<string, CodingEditValue>>({});
  const [codingForm, setCodingForm] = useState<CodingModelFormValue | null>(null);
  const [confirmCodingEnable, setConfirmCodingEnable] = useState<CodingCatalogItem | null>(null);
  const [hold, setHold] = useState<{ category: "image" | "coding"; modelId: string; name: string } | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((value: CatalogToastValue | null) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(value);
    // Success fades; progress and refusals stay until replaced or closed.
    if (value?.tone === "ok") toastTimer.current = setTimeout(() => setToast(null), 6_000);
  }, []);

  const load = useCallback(async (): Promise<CatalogReport | null> => {
    setLoading(true);
    try {
      const response = await adminFetch("/api/admin/model-catalog", { cache: "no-store" });
      if (response.status === 404) setSessionExpired(true);
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as CatalogReport;
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
    // Deferred a tick so no state write is synchronous within the effect,
    // the same idiom the other admin panels use for their mount load.
    queueMicrotask(() => void load());
  }, [load]);

  useEffect(() => {
    if (!drafting) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [drafting]);

  // A link from the discovery queue opens the add form prefilled; nothing is
  // written until the operator submits.
  useEffect(() => {
    const request = discoveryDraftRequest(window.location.search);
    if (!request) return;
    queueMicrotask(() => {
      setForm({
        mode: "add",
        modelId: null,
        value: { ...emptyForm(request.provider), apiModelId: request.apiModelId, name: request.apiModelId },
      });
    });
  }, []);

  const items = useMemo(() => (report ? imageCatalogItems(report.image) : []), [report]);
  const providers = report?.image.providers ?? [];
  const openItem = items.find((item) => item.id === openId) ?? null;
  const codingItems = useMemo(() => (report ? codingCatalogItems(report.coding) : []), [report]);
  const codingProviders = report?.coding.providers ?? [];
  const openCoding = codingItems.find((item) => item.id === codingOpenId) ?? null;

  const refusedToast = useCallback(
    (codes: readonly string[], detail = "") => {
      const text = codes.map((code) => reasonText(m, reasonMessage(code, detail))).join(" ");
      showToast({ tone: "refused", title: m.toastRefused, body: text });
    },
    [m, showToast]
  );

  /** One request; refusals become a toast in words. A timeout is reported, never retried here. */
  const send = async (method: "PATCH" | "POST", body: unknown, timeoutMs?: number): Promise<SendResult> => {
    let response: Response;
    try {
      response = await adminFetch("/api/admin/model-catalog", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs,
      });
    } catch (error) {
      const timedOut = isAdminFetchTimeout(error);
      if (!timedOut) refusedToast(["network_error"]);
      return { ok: false, timedOut };
    }
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; code?: string; reasons?: string[]; detail?: string | null }
      | null;
    if (!response.ok) {
      // The session check answers a bare 404 "Not found." when the admin
      // session is gone or expired. A catalogue refusal can also be a 404
      // (no_draft when another admin applied it first) and is not a sign-out.
      if (isSessionGone(response.status, payload)) {
        setSessionExpired(true);
        showToast({
          tone: "refused",
          title: m.sessionExpiredTitle,
          body: m.sessionExpiredBody,
          action: { label: m.relogin, onClick: () => window.location.assign(adminRecentAuthenticationHref(CATALOG_PATH)) },
        });
      } else if (response.status === 403) {
        refusedToast(["forbidden"]);
      } else {
        const code = payload?.code ?? payload?.error ?? String(response.status);
        refusedToast(refusalReasons(code, payload?.reasons ?? []), payload?.detail ?? "");
      }
      return { ok: false, timedOut: false };
    }
    return { ok: true, payload };
  };

  /**
   * Ask for a price draft (one paid LLM call). On a timeout the outcome is
   * unknown, so the catalogue is read again to see whether the draft landed;
   * the request is not sent a second time.
   */
  const requestDraft = async (input: {
    modelId: string;
    provider: string;
    apiModelId: string;
    name: string;
    choices?: { name?: string; sizes?: string[]; qualities?: string[] };
    sources: string[];
  }) => {
    const before = items.find((item) => item.id === input.modelId)?.draftCreatedAt ?? null;
    setDrafting({ category: "image", modelId: input.modelId, startedAt: Date.now() });
    setNow(Date.now());
    setOpenId(input.modelId);
    showToast({ tone: "progress", title: m.draftingTitle, body: m.draftingBody });
    const result = await send(
      "POST",
      {
        action: "draft",
        category: "image",
        modelId: input.modelId,
        provider: input.provider,
        apiModelId: input.apiModelId,
        sourceUrls: input.sources,
        ...(input.choices ? { profile: input.choices } : {}),
      },
      DRAFT_REQUEST_TIMEOUT_MS
    );
    setDrafting(null);
    if (result.ok) {
      await load();
      showToast({ tone: "ok", title: m.toastDraftReady(input.name), body: m.toastDraftReadyBody });
      return;
    }
    if (result.timedOut) {
      showToast({ tone: "progress", title: m.toastChecking });
      const next = await load();
      const after = next ? imageCatalogItems(next.image).find((item) => item.id === input.modelId)?.draftCreatedAt ?? null : null;
      if (after && after !== before) showToast({ tone: "ok", title: m.toastFinishedAnyway });
      else refusedToast(["timeout"]);
    }
  };

  const profileChoices = (item: ImageCatalogItem) =>
    item.source === "catalog"
      ? { name: item.name, sizes: item.sizes.length ? item.sizes : undefined, qualities: item.qualities.length ? item.qualities : undefined }
      : undefined;

  const formFromItem = (item: ImageCatalogItem): ImageModelFormValue => ({
    provider: item.provider || "openai",
    apiModelId: item.apiModelId,
    name: item.name,
    sizes: item.sizes.length ? item.sizes : [...RUNTIME_IMAGE_SIZES],
    qualities: item.qualities.length ? item.qualities : [...RUNTIME_IMAGE_QUALITIES],
    sources: "",
  });

  const onAction = (item: ImageCatalogItem, action: ImageNextAction) => {
    if (action === "fix_profile") {
      setForm({ mode: "fix", modelId: item.id, value: formFromItem(item) });
      return;
    }
    if (action === "enable") {
      setConfirmEnable(item);
      return;
    }
    if (action === "make_draft" || action === "redraft") {
      // No default pricing page for this provider: the form asks for one.
      const defaults = providers.find((entry) => entry.provider === item.provider)?.defaultSources ?? [];
      if (defaults.length === 0) {
        setForm({ mode: "add", modelId: item.id, value: formFromItem(item) });
        return;
      }
      void requestDraft({
        modelId: item.id,
        provider: item.provider,
        apiModelId: item.apiModelId,
        name: item.name,
        choices: profileChoices(item),
        sources: [],
      });
      return;
    }
    setOpenId(item.id);
  };

  const submitForm = async () => {
    if (!form) return;
    const value = form.value;
    const apiModelId = value.apiModelId.trim();
    const choices = { name: value.name.trim() || undefined, sizes: value.sizes, qualities: value.qualities };
    if (form.mode === "fix" && form.modelId) {
      setBusy(true);
      const result = await send("PATCH", {
        category: "image",
        modelId: form.modelId,
        profile: runtimeImageProfileTemplate(value.provider, apiModelId, choices),
      });
      setBusy(false);
      if (result.ok) {
        setForm(null);
        await load();
        showToast({ tone: "ok", title: m.toastSaved });
      }
      return;
    }
    const modelId = form.modelId ?? apiModelId;
    setForm(null);
    await requestDraft({
      modelId,
      provider: value.provider,
      apiModelId,
      name: choices.name ?? apiModelId,
      choices,
      sources: value.sources
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    });
  };

  const applyPrices = async (item: ImageCatalogItem) => {
    if (!item.draft) return;
    setBusy(true);
    const result = await send("POST", {
      action: "apply_draft",
      category: "image",
      modelId: item.id,
      creditOverrides: creditOverrides(item.draft.prices, edits[item.id] ?? {}),
    });
    setBusy(false);
    if (!result.ok) return;
    setEdits((current) => ({ ...current, [item.id]: {} }));
    const next = await load();
    const updated = next ? imageCatalogItems(next.image).find((entry) => entry.id === item.id) : null;
    const stage = updated ? imageStage(updated) : null;
    // "It can be turned on" only when the judge would admit it; otherwise the
    // toast says what still stands in the way.
    showToast({
      tone: "ok",
      title: m.toastApplied(item.name),
      body: stage === "ready_to_enable" ? m.toastAppliedBody : stage && stage !== "serving" ? m.stage[stage] : undefined,
      action: updated && stage === "ready_to_enable" ? { label: m.goEnable, onClick: () => setConfirmEnable(updated) } : null,
    });
  };

  const enable = async (item: ImageCatalogItem) => {
    setBusy(true);
    const result = await send("PATCH", { category: "image", modelId: item.id, enabled: true, holdReason: null });
    setBusy(false);
    setConfirmEnable(null);
    if (!result.ok) return;
    await load();
    showToast({ tone: "ok", title: m.toastEnabled(item.name) });
  };

  const inherit = async (item: ImageCatalogItem) => {
    const result = await send("PATCH", { category: "image", modelId: item.id, enabled: null, holdReason: null });
    if (!result.ok) return;
    await load();
    showToast({ tone: "ok", title: m.toastSaved });
  };

  /**
   * Ask for a coding profile draft (one paid LLM call), like requestDraft:
   * on a timeout the catalogue is read again, the request is not resent.
   */
  const requestCodingDraft = async (value: CodingModelFormValue) => {
    const apiModelId = value.apiModelId.trim();
    // A new draft for an existing row keeps that row's id (it can differ from the API id).
    const modelId = value.modelId ?? apiModelId;
    const before = codingItems.find((item) => item.id === modelId)?.draftCreatedAt ?? null;
    const defaults = codingProviders.find((entry) => entry.provider === value.provider)?.defaultSources ?? [];
    setCodingForm(null);
    setDrafting({ category: "coding", modelId, startedAt: Date.now() });
    setNow(Date.now());
    setCodingOpenId(modelId);
    showToast({ tone: "progress", title: m.codingFlow.draftingTitle, body: m.codingFlow.draftingBody });
    const result = await send(
      "POST",
      {
        action: "draft",
        category: "coding",
        modelId,
        provider: value.provider,
        apiModelId,
        sourceUrls: codingDraftSources(value, defaults),
      },
      DRAFT_REQUEST_TIMEOUT_MS
    );
    setDrafting(null);
    if (result.ok) {
      const next = await load();
      const name = (next ? codingCatalogItems(next.coding).find((item) => item.id === modelId)?.name : null) ?? apiModelId;
      showToast({ tone: "ok", title: m.codingFlow.toastDraftReady(name), body: m.codingFlow.toastDraftReadyBody });
      return;
    }
    if (result.timedOut) {
      showToast({ tone: "progress", title: m.toastChecking });
      const next = await load();
      const after = next ? codingCatalogItems(next.coding).find((item) => item.id === modelId)?.draftCreatedAt ?? null : null;
      if (after && after !== before) showToast({ tone: "ok", title: m.toastFinishedAnyway });
      else refusedToast(["timeout"]);
    }
  };

  /** The form for a new draft of an existing model, with the pages its last profile or draft read. */
  const codingFormFor = (item: CodingCatalogItem): CodingModelFormValue => {
    const shown = item.draft ?? item.profile;
    return {
      modelId: item.id,
      provider: item.provider || codingProviders[0]?.provider || "anthropic",
      apiModelId: item.apiModelId,
      priceUrl: shown?.pricing.sources.find((url) => url !== shown.terms.url && url !== shown.retention.url) ?? "",
      termsUrl: shown?.terms.url ?? "",
      retentionUrl: shown?.retention.url ?? "",
    };
  };

  const onCodingAction = (item: CodingCatalogItem, action: ImageNextAction) => {
    if (action === "enable") {
      setConfirmCodingEnable(item);
      return;
    }
    if (action === "make_draft" || action === "redraft" || action === "fix_profile") {
      setCodingForm(codingFormFor(item));
      return;
    }
    setCodingOpenId(item.id);
  };

  const applyCodingProfile = async (item: CodingCatalogItem) => {
    if (!item.draft) return;
    setBusy(true);
    const result = await send("POST", {
      action: "apply_draft",
      category: "coding",
      modelId: item.id,
      codingEdit: codingEdit(item.draft, codingEdits[item.id] ?? {}),
    });
    setBusy(false);
    if (!result.ok) return;
    setCodingEdits((current) => ({ ...current, [item.id]: {} }));
    const next = await load();
    const updated = next ? codingCatalogItems(next.coding).find((entry) => entry.id === item.id) : null;
    const stage = updated ? codingStage(updated) : null;
    showToast({
      tone: "ok",
      title: m.codingFlow.toastApplied(updated?.name ?? item.name),
      body: stage === "ready_to_enable" ? m.toastAppliedBody : stage && stage !== "serving" ? m.codingFlow.stage[stage] : undefined,
      action: updated && stage === "ready_to_enable" ? { label: m.goEnable, onClick: () => setConfirmCodingEnable(updated) } : null,
    });
  };

  const enableCoding = async (item: CodingCatalogItem) => {
    setBusy(true);
    const result = await send("PATCH", { category: "coding", modelId: item.id, enabled: true, holdReason: null });
    setBusy(false);
    setConfirmCodingEnable(null);
    if (!result.ok) return;
    await load();
    showToast({ tone: "ok", title: m.toastEnabled(item.name) });
  };

  const publishSnapshot = async () => {
    if ((await send("POST", { action: "publish_snapshot" })).ok) {
      await load();
      showToast({ tone: "ok", title: m.toastSaved });
    }
  };

  const enableRange = confirmEnable?.served ? priceRange(confirmEnable.served.prices) : null;
  const formValid =
    form !== null &&
    form.value.apiModelId.trim().length > 0 &&
    form.value.sizes.length > 0 &&
    form.value.qualities.length > 0 &&
    providers.some((entry) => entry.provider === form.value.provider);
  // The retention page is required (a draft without one is refused for
  // nothing), and the price page only where the provider has no default.
  const codingFormValid =
    codingForm !== null &&
    codingForm.apiModelId.trim().length > 0 &&
    codingForm.termsUrl.trim().length > 0 &&
    codingForm.retentionUrl.trim().length > 0 &&
    codingProviders.some(
      (entry) => entry.provider === codingForm.provider && (codingForm.priceUrl.trim().length > 0 || entry.defaultSources.length > 0)
    );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/* The buttons sit under the description, not beside the title: two of
          them beside it squeezed the title to one character per line at 390 px. */}
      <AdminTile title={m.title} description={m.description}>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm font-bold text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
              {m.refresh}
            </button>
            {report ? (
              <AdminWriteButton
                disabled={!report.draftLlm.configured || drafting !== null}
                onClick={() => setForm({ mode: "add", modelId: null, value: emptyForm(providers[0]?.provider) })}
                data-testid="model-catalog-add-image"
              >
                <Plus className="h-4 w-4" aria-hidden />
                {m.addImageModel}
              </AdminWriteButton>
            ) : null}
          </div>
      </AdminTile>
      {sessionExpired ? (
        <div
          role="alert"
          data-testid="model-catalog-session-expired"
          className="flex flex-col gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center"
        >
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-bold text-amber-300">{m.sessionExpiredTitle}</p>
            <p className="mt-0.5 text-zinc-300">{m.sessionExpiredBody}</p>
          </div>
          <a
            href={adminRecentAuthenticationHref(CATALOG_PATH)}
            className="inline-flex min-h-10 items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-500"
          >
            {m.relogin}
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
          <AdminTile title={m.image}>
            {!report.draftLlm.configured ? (
              <p className="text-xs text-amber-300">{m.draftNotConfigured(report.draftLlm.env)}</p>
            ) : null}
            {openItem ? (
              <ImageModelDetail
                key={openItem.id}
                m={m}
                item={openItem}
                edits={edits[openItem.id] ?? {}}
                drafting={drafting?.category === "image" && drafting.modelId === openItem.id ? elapsedText(now - drafting.startedAt) : null}
                onBack={() => setOpenId(null)}
                onEdit={(key, value) =>
                  setEdits((current) => ({ ...current, [openItem.id]: { ...(current[openItem.id] ?? {}), [key]: value } }))
                }
                onResetEdits={() => setEdits((current) => ({ ...current, [openItem.id]: {} }))}
                onApply={() => void applyPrices(openItem)}
                onAction={(action) => onAction(openItem, action)}
                onHold={() => {
                  setHoldReason("");
                  setHold({ category: "image", modelId: openItem.id, name: openItem.name });
                }}
                onRename={async (name) => {
                  const result = await send("PATCH", { category: "image", modelId: openItem.id, name });
                  if (!result.ok) return false;
                  await load();
                  showToast({ tone: "ok", title: m.toastRenamed(name) });
                  return true;
                }}
              />
            ) : drafting?.category === "image" && !items.some((item) => item.id === drafting.modelId) ? (
              // A brand-new model has no row until its draft is stored.
              <AdminStateBlock kind="loading" />
            ) : (
              <ImageCatalogList
                m={m}
                items={items}
                onOpen={(item) => setOpenId(item.id)}
                onAction={onAction}
                onHold={(item) => {
                  setHoldReason("");
                  setHold({ category: "image", modelId: item.id, name: item.name });
                }}
                onInherit={(item) => void inherit(item)}
              />
            )}
          </AdminTile>

          <AdminTile
            title={m.coding}
            action={
              <AdminWriteButton
                size="sm"
                disabled={!report.draftLlm.configured || drafting !== null || codingProviders.length === 0}
                onClick={() => setCodingForm(emptyCodingForm(codingProviders.find((entry) => entry.provider === "anthropic")?.provider ?? codingProviders[0]?.provider))}
                data-testid="model-catalog-add-coding"
              >
                <Plus className="h-4 w-4" aria-hidden />
                {m.codingFlow.add}
              </AdminWriteButton>
            }
          >
            {!report.draftLlm.configured ? (
              <p className="text-xs text-amber-300">{m.draftNotConfigured(report.draftLlm.env)}</p>
            ) : null}
            {openCoding ? (
              <CodingModelDetail
                m={m}
                item={openCoding}
                edits={codingEdits[openCoding.id] ?? {}}
                drafting={drafting?.category === "coding" && drafting.modelId === openCoding.id ? elapsedText(now - drafting.startedAt) : null}
                onBack={() => setCodingOpenId(null)}
                onEdit={(field, value) =>
                  setCodingEdits((current) => ({ ...current, [openCoding.id]: { ...(current[openCoding.id] ?? {}), [field]: value } }))
                }
                onResetEdits={() => setCodingEdits((current) => ({ ...current, [openCoding.id]: {} }))}
                onApply={() => void applyCodingProfile(openCoding)}
                onAction={(action) => onCodingAction(openCoding, action)}
                onHold={() => {
                  setHoldReason("");
                  setHold({ category: "coding", modelId: openCoding.id, name: openCoding.name });
                }}
              />
            ) : drafting?.category === "coding" && !codingItems.some((item) => item.id === drafting.modelId) ? (
              // A brand-new model has no row until its draft is stored.
              <AdminStateBlock kind="loading" />
            ) : (
              <CodingCatalogList
                m={m}
                items={codingItems}
                onOpen={(item) => setCodingOpenId(item.id)}
                onAction={onCodingAction}
                onHold={(item) => {
                  setHoldReason("");
                  setHold({ category: "coding", modelId: item.id, name: item.name });
                }}
              />
            )}
            <div className="border-t border-zinc-800 pt-3">
              <div className="text-sm font-bold text-zinc-100">{m.snapshot}</div>
              <div className="text-xs text-zinc-400">
                {report.coding.snapshot
                  ? m.snapshotLine(report.coding.snapshot.version, report.coding.snapshot.models.length, report.coding.snapshot.coverageUntil.slice(0, 10))
                  : m.snapshotNone}
              </div>
              <AdminWriteButton size="sm" variant="secondary" className="mt-2" onClick={() => void publishSnapshot()}>
                {m.publishSnapshot}
              </AdminWriteButton>
            </div>
          </AdminTile>

          <AdminTile title={m.chat} description={m.chatNote} action={<span className="text-xs text-zinc-500">{board.chatCount(report.chat.models.length)}</span>}>
            <ul className="grid gap-1 text-xs text-zinc-300 sm:grid-cols-2">
              {report.chat.models.map((row) => (
                <li key={row.modelId} className="font-mono">
                  {row.modelId} · {row.provider} · {row.enabled ? m.serving : m.inherit}
                </li>
              ))}
            </ul>
          </AdminTile>

          <AdminTile title={m.video} description={m.videoNote} />
        </>
      ) : null}

      <AdminReasonDialog
        open={form !== null}
        title={form?.mode === "fix" ? m.fixTitle : m.addTitle}
        description={form?.mode === "fix" ? m.fixDescription : m.addDescription}
        confirmLabel={form?.mode === "fix" ? m.fixConfirm : m.addConfirm}
        confirmDisabled={!formValid}
        busy={busy}
        onConfirm={() => void submitForm()}
        onClose={() => setForm(null)}
      >
        {form ? (
          <ImageModelForm
            m={m}
            mode={form.mode}
            value={form.value}
            onChange={(value) => setForm({ ...form, value })}
            providers={providers}
            sizes={RUNTIME_IMAGE_SIZES}
            qualities={RUNTIME_IMAGE_QUALITIES}
          />
        ) : null}
      </AdminReasonDialog>

      <AdminConfirmDialog
        open={confirmEnable !== null}
        title={confirmEnable ? m.enableTitle(confirmEnable.name) : ""}
        summary={confirmEnable?.served ? m.enableSummary(confirmEnable.served.pricingVersion) : undefined}
        effects={
          confirmEnable
            ? [
                m.enableEffectListed(confirmEnable.name),
                ...(enableRange ? [m.enableEffectCharges(enableRange.min, enableRange.max, confirmEnable.provider)] : []),
                m.enableEffectUndo,
              ]
            : []
        }
        confirmLabel={m.enable}
        busy={busy}
        onConfirm={() => confirmEnable && void enable(confirmEnable)}
        onClose={() => setConfirmEnable(null)}
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
        {codingForm ? <CodingModelForm m={m} value={codingForm} onChange={setCodingForm} providers={codingProviders} /> : null}
      </AdminReasonDialog>

      <AdminConfirmDialog
        open={confirmCodingEnable !== null}
        title={confirmCodingEnable ? m.enableTitle(confirmCodingEnable.name) : ""}
        summary={
          confirmCodingEnable?.profile
            ? m.codingFlow.enableSummary(confirmCodingEnable.profile.pricing.inputUsdPerMTok, confirmCodingEnable.profile.pricing.outputUsdPerMTok)
            : undefined
        }
        effects={
          confirmCodingEnable?.profile
            ? [
                m.codingFlow.enableEffectListed(confirmCodingEnable.name, confirmCodingEnable.profile.minimumPlan),
                m.codingFlow.enableEffectCharges(confirmCodingEnable.profile.pricing.creditWeight, confirmCodingEnable.provider),
                m.codingFlow.enableEffectSnapshot,
              ]
            : []
        }
        confirmLabel={m.enable}
        busy={busy}
        onConfirm={() => confirmCodingEnable && void enableCoding(confirmCodingEnable)}
        onClose={() => setConfirmCodingEnable(null)}
      />

      <AdminReasonDialog
        open={hold !== null}
        title={board.holdTitle}
        description={m.holdPrompt}
        confirmLabel={board.holdConfirm}
        confirmDisabled={!holdReason.trim()}
        onConfirm={async () => {
          if (!hold || !holdReason.trim()) return;
          const target = hold;
          const reason = holdReason.trim();
          setHold(null);
          if ((await send("PATCH", { category: target.category, modelId: target.modelId, holdReason: reason })).ok) {
            await load();
            showToast({ tone: "ok", title: m.toastHeld(target.name) });
          }
        }}
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
