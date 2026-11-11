"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminReasonDialog } from "@/components/admin/ui/AdminReasonDialog";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch, isAdminFetchTimeout } from "@/lib/adminFetch";
import { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";
import { adminModelsBoardMessages } from "@/lib/adminMessages/modelsBoard";
import { discoveryDraftRequest, runtimeImageProfileTemplate } from "@/lib/runtimeImageProviders";

// Operator surface over /api/admin/model-catalog. Raw JSON editors on purpose:
// the schemas are enforced server-side (lib/modelCatalogCore.ts), and a form
// per field would be code that a model-written draft makes unnecessary.

// A draft fetches up to three pages (10 s each) and makes one LLM call (90 s);
// the 15 s admin default cut it off and the panel showed nothing.
const DRAFT_REQUEST_TIMEOUT_MS = 130_000;

type Admission = { admitted: boolean; reasons?: string[] };

type ImageRow = {
  id: string;
  name: string;
  provider: string;
  source: "code" | "catalog";
  enabled: boolean | null;
  holdReason: string | null;
  disabledReason: string | null;
  pricingVersion: string;
  admissionIfEnabled: Admission;
  draft: unknown;
};

type CodingRow = {
  modelId: string;
  enabled: boolean | null;
  holdReason: string | null;
  profile: unknown;
  problem: string | null;
  admission: Admission | null;
  draft: unknown;
};

type PendingImageRow = { modelId: string; profile: unknown; draft: unknown; problem: string | null };

type CatalogReport = {
  image: {
    models: ImageRow[];
    problems: { modelId: string; problem: string }[];
    pending?: PendingImageRow[];
  };
  coding: {
    models: CodingRow[];
    snapshot: { version: number; models: unknown[]; coverageUntil: string } | null;
  };
  chat: { models: { modelId: string; name: string; provider: string; enabled: boolean }[] };
  video: { policy: { reasons: string[] } };
  draftLlm: { configured: boolean; env: string };
};

const textarea =
  "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-200 outline-none focus:border-blue-500";
const fieldLabel = "text-xs font-bold text-zinc-400";

const reasonsOf = (admission: Admission | null | undefined) =>
  admission?.admitted ? "" : (admission?.reasons ?? []).join(", ");

export function AdminModelCatalogPanel() {
  const m = useAdminMessages(adminModelCatalogMessages);
  const board = useAdminMessages(adminModelsBoardMessages).catalog;
  const [report, setReport] = useState<CatalogReport | null>(null);
  const [loading, setLoading] = useState(false);
  // A failed read is its own state: an empty catalogue would say "no models".
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [profileDrafts, setProfileDrafts] = useState<Record<string, string>>({});
  const [newCodingId, setNewCodingId] = useState("");
  const [hold, setHold] = useState<{ category: "image" | "coding"; modelId: string } | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const [newImage, setNewImage] = useState({ modelId: "", profile: "" });
  const [draftForm, setDraftForm] = useState({
    category: "coding",
    modelId: "",
    provider: "",
    apiModelId: "",
    sources: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await adminFetch("/api/admin/model-catalog", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      setReport((await response.json()) as CatalogReport);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so no state write is synchronous within the effect,
    // the same idiom the other admin panels use for their mount load.
    queueMicrotask(() => void load());
  }, [load]);

  // A link from the discovery queue fills in the image draft and the new
  // model's profile; nothing is written until the operator submits.
  useEffect(() => {
    const request = discoveryDraftRequest(window.location.search);
    if (!request) return;
    queueMicrotask(() => {
      setDraftForm((form) => ({ ...form, category: "image", ...request }));
      setNewImage({
        modelId: request.modelId,
        profile: JSON.stringify(runtimeImageProfileTemplate(request.provider, request.apiModelId), null, 2),
      });
      document.getElementById("model-catalog-new-image")?.scrollIntoView({ block: "start" });
    });
  }, []);

  const send = async (method: "PATCH" | "POST", body: unknown, timeoutMs?: number) => {
    setNotice(null);
    let response: Response;
    try {
      response = await adminFetch("/api/admin/model-catalog", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs,
      });
    } catch (error) {
      setNotice(m.refused(isAdminFetchTimeout(error) ? "timeout" : "network_error", ""));
      return false;
    }
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; reasons?: string[]; detail?: string | null }
      | null;
    if (!response.ok) {
      setNotice(m.refused(payload?.error ?? String(response.status), (payload?.reasons ?? []).join(", ") || (payload?.detail ?? "")));
      return false;
    }
    setNotice(m.saved);
    await load();
    return true;
  };

  const parseJson = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      setNotice(m.refused("invalid_json", ""));
      return undefined;
    }
  };

  const stateButtons = (category: "image" | "coding", modelId: string) => (
    <div className="flex flex-wrap gap-1.5">
      <AdminWriteButton
        size="sm"
        variant="secondary"
        onClick={() => void send("PATCH", { category, modelId, enabled: true, holdReason: null })}
      >
        {m.enable}
      </AdminWriteButton>
      <AdminWriteButton
        size="sm"
        variant="secondary"
        onClick={() => {
          setHoldReason("");
          setHold({ category, modelId });
        }}
      >
        {m.hold}
      </AdminWriteButton>
      <AdminWriteButton
        size="sm"
        variant="secondary"
        onClick={() => void send("PATCH", { category, modelId, enabled: null, holdReason: null })}
      >
        {m.inherit}
      </AdminWriteButton>
    </div>
  );

  const priceRevisionBlock = (modelId: string) => (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-bold text-zinc-400">{m.priceRevision}</summary>
      <p className="mt-1 text-[11px] text-zinc-500">{m.priceRevisionHint}</p>
      <textarea
        className={textarea}
        rows={5}
        value={priceDrafts[modelId] ?? ""}
        onChange={(event) => setPriceDrafts({ ...priceDrafts, [modelId]: event.target.value })}
      />
      <AdminWriteButton
        size="sm"
        variant="secondary"
        className="mt-1"
        onClick={() => {
          const revision = parseJson(priceDrafts[modelId] ?? "");
          if (revision !== undefined) void send("POST", { action: "price_revision", modelId, revision });
        }}
      >
        {m.submit}
      </AdminWriteButton>
    </details>
  );

  const draftBlock = (category: "image" | "coding", modelId: string, draft: unknown) =>
    draft ? (
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-bold text-zinc-400">{m.draft}</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded-xl bg-zinc-950 p-2 text-[11px] text-zinc-300">{JSON.stringify(draft, null, 2)}</pre>
        <AdminWriteButton
          size="sm"
          variant="secondary"
          className="mt-1"
          onClick={() => void send("POST", { action: "apply_draft", category, modelId })}
        >
          {m.applyDraft}
        </AdminWriteButton>
      </details>
    ) : null;

  const imageColumns: AdminDataColumn<ImageRow>[] = [
    {
      key: "model",
      header: m.model,
      render: (row) => (
        <div>
          <div className="font-bold text-zinc-100">{row.name}</div>
          <div className="font-mono text-xs text-zinc-500">{row.id} · {row.provider} · {row.source}</div>
        </div>
      ),
    },
    {
      key: "state",
      header: m.state,
      render: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <AdminStatusChip tone={row.holdReason ? "warn" : row.disabledReason ? "idle" : "ok"}>
            {row.disabledReason ?? m.serving}
          </AdminStatusChip>
          {row.holdReason ? <span className="text-xs text-zinc-400">{row.holdReason}</span> : null}
        </div>
      ),
    },
    {
      key: "price",
      header: m.price,
      render: (row) => <span className="font-mono text-xs">{row.pricingVersion}</span>,
    },
    {
      key: "judge",
      header: m.judge,
      render: (row) => (
        <span className="text-xs">
          {row.admissionIfEnabled.admitted ? m.admitted : reasonsOf(row.admissionIfEnabled)}
        </span>
      ),
    },
    {
      key: "actions",
      header: m.actions,
      render: (row) => (
        <div>
          {stateButtons("image", row.id)}
          {priceRevisionBlock(row.id)}
          {draftBlock("image", row.id, row.draft)}
        </div>
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminTile
        title={m.title}
        description={m.description}
        action={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm font-bold text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
            {m.refresh}
          </button>
        }
      />
      {loadError ? (
        <AdminStateBlock
          kind="error"
          title={board.loadFailedTitle}
          detail={board.loadFailedDetail}
          onRetry={() => void load()}
        />
      ) : notice ? (
        <p
          role="status"
          className={`rounded-2xl px-4 py-3 text-sm font-bold ${
            notice === m.saved ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300"
          }`}
        >
          {notice}
        </p>
      ) : null}
      {loading && !report ? <AdminStateBlock kind="loading" /> : null}

      {report ? (
        <>
          <AdminTile title={m.image}>
            <AdminDataTable
              caption={board.imageTableCaption}
              columns={imageColumns}
              rows={report.image.models}
              rowKey={(row) => row.id}
            />
            {(report.image.pending ?? []).length > 0 ? (
              <div className="flex flex-col gap-3">
                <div className="text-sm font-bold text-amber-300">{m.pendingImage}</div>
                {(report.image.pending ?? []).map((row) => (
                  <div key={row.modelId} data-testid="model-catalog-pending-image" className="rounded-xl border border-amber-500/30 p-3">
                    <div className="font-mono text-sm font-bold text-zinc-100">{row.modelId}</div>
                    <div className="text-xs text-amber-300">{row.problem ?? m.pendingNoProblem}</div>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs font-bold text-zinc-400">{m.profile}</summary>
                      <pre className="mt-1 max-h-48 overflow-auto rounded-xl bg-zinc-950 p-2 text-[11px] text-zinc-300">
                        {JSON.stringify(row.profile, null, 2)}
                      </pre>
                    </details>
                    {priceRevisionBlock(row.modelId)}
                    {draftBlock("image", row.modelId, row.draft)}
                  </div>
                ))}
              </div>
            ) : report.image.problems.length > 0 ? (
              <p className="text-xs text-amber-300">
                {m.problems}: {report.image.problems.map((p) => `${p.modelId} (${p.problem})`).join(", ")}
              </p>
            ) : null}
            <div id="model-catalog-new-image" className="rounded-xl border border-zinc-800 p-3">
              <div className="text-sm font-bold text-zinc-100">{m.newImageModel}</div>
              <p className="mt-1 text-[11px] text-zinc-500">{m.newImageModelHint}</p>
              <label className={`mt-2 block ${fieldLabel}`}>
                {m.draftModelId}
                <input
                  className={textarea}
                  value={newImage.modelId}
                  onChange={(event) => setNewImage({ ...newImage, modelId: event.target.value })}
                />
              </label>
              <label className={`mt-2 block ${fieldLabel}`}>
                {m.profile}
                <textarea
                  className={textarea}
                  rows={8}
                  value={newImage.profile}
                  onChange={(event) => setNewImage({ ...newImage, profile: event.target.value })}
                />
              </label>
              <AdminWriteButton
                size="sm"
                variant="secondary"
                className="mt-1"
                disabled={!newImage.modelId.trim() || !newImage.profile.trim()}
                onClick={() => {
                  const profile = parseJson(newImage.profile);
                  if (profile !== undefined) void send("PATCH", { category: "image", modelId: newImage.modelId.trim(), profile });
                }}
              >
                {m.saveProfile}
              </AdminWriteButton>
            </div>
          </AdminTile>

          <AdminTile title={m.coding}>
            <div className="flex flex-col">
              {report.coding.models.map((row) => (
                <div key={row.modelId} className="border-t border-zinc-800 py-3 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-mono text-sm font-bold text-zinc-100">{row.modelId}</div>
                      <div className="text-xs text-zinc-400">
                        {row.holdReason ? `${m.hold} · ${row.holdReason}` : row.enabled === true ? m.serving : m.inherit}
                        {" · "}
                        {m.judge}: {row.admission?.admitted ? m.admitted : reasonsOf(row.admission) || row.problem}
                      </div>
                    </div>
                    {stateButtons("coding", row.modelId)}
                  </div>
                  <label className={`mt-2 block ${fieldLabel}`}>
                    {m.profile}
                    <textarea
                      className={textarea}
                      rows={6}
                      value={profileDrafts[row.modelId] ?? JSON.stringify(row.profile ? { ...(row.profile as object), modelId: undefined } : {}, null, 2)}
                      onChange={(event) => setProfileDrafts({ ...profileDrafts, [row.modelId]: event.target.value })}
                    />
                  </label>
                  <AdminWriteButton
                    size="sm"
                    variant="secondary"
                    className="mt-1"
                    onClick={() => {
                      const profile = parseJson(profileDrafts[row.modelId] ?? "");
                      if (profile !== undefined) void send("PATCH", { category: "coding", modelId: row.modelId, profile });
                    }}
                  >
                    {m.saveProfile}
                  </AdminWriteButton>
                  {draftBlock("coding", row.modelId, row.draft)}
                </div>
              ))}
              <div className="flex flex-wrap items-end gap-2 border-t border-zinc-800 pt-3">
                <label className={fieldLabel}>
                  {m.newCodingModel}
                  <input className={textarea} value={newCodingId} onChange={(event) => setNewCodingId(event.target.value)} />
                </label>
                <AdminWriteButton
                  size="sm"
                  variant="secondary"
                  disabled={!newCodingId.trim()}
                  onClick={() => void send("PATCH", { category: "coding", modelId: newCodingId.trim(), enabled: null })}
                >
                  {m.submit}
                </AdminWriteButton>
              </div>
            </div>
            <div className="border-t border-zinc-800 pt-3">
              <div className="text-sm font-bold text-zinc-100">{m.snapshot}</div>
              <div className="text-xs text-zinc-400">
                {report.coding.snapshot
                  ? m.snapshotLine(report.coding.snapshot.version, report.coding.snapshot.models.length, report.coding.snapshot.coverageUntil.slice(0, 10))
                  : m.snapshotNone}
              </div>
              <AdminWriteButton
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => void send("POST", { action: "publish_snapshot" })}
              >
                {m.publishSnapshot}
              </AdminWriteButton>
            </div>
          </AdminTile>

          <AdminTile title={m.requestDraft}>
            {!report.draftLlm.configured ? (
              <p className="text-xs text-amber-300">{m.draftNotConfigured(report.draftLlm.env)}</p>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <select
                className={textarea}
                aria-label={m.requestDraft}
                value={draftForm.category}
                onChange={(event) => setDraftForm({ ...draftForm, category: event.target.value })}
              >
                <option value="coding">{m.coding}</option>
                <option value="image">{m.image}</option>
              </select>
              <label className={fieldLabel}>
                {m.draftModelId}
                <input className={textarea} value={draftForm.modelId} onChange={(event) => setDraftForm({ ...draftForm, modelId: event.target.value })} />
              </label>
              <label className={fieldLabel}>
                {m.provider}
                <input className={textarea} value={draftForm.provider} onChange={(event) => setDraftForm({ ...draftForm, provider: event.target.value })} />
              </label>
              <label className={fieldLabel}>
                {m.draftApiModelId}
                <input className={textarea} value={draftForm.apiModelId} onChange={(event) => setDraftForm({ ...draftForm, apiModelId: event.target.value })} />
              </label>
            </div>
            <label className={`block ${fieldLabel}`}>
              {m.draftSources}
              <textarea className={textarea} rows={3} value={draftForm.sources} onChange={(event) => setDraftForm({ ...draftForm, sources: event.target.value })} />
            </label>
            <div>
              <AdminWriteButton
                size="sm"
                variant="secondary"
                disabled={!report.draftLlm.configured}
                onClick={() =>
                  void send("POST", {
                    action: "draft",
                    category: draftForm.category,
                    modelId: draftForm.modelId.trim(),
                    provider: draftForm.provider.trim(),
                    apiModelId: draftForm.apiModelId.trim(),
                    sourceUrls: draftForm.sources.split("\n").map((line) => line.trim()).filter(Boolean),
                  }, DRAFT_REQUEST_TIMEOUT_MS)
                }
              >
                {m.submit}
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
        open={hold !== null}
        title={board.holdTitle}
        description={m.holdPrompt}
        confirmLabel={board.holdConfirm}
        confirmDisabled={!holdReason.trim()}
        onConfirm={() => {
          if (!hold || !holdReason.trim()) return;
          const target = hold;
          const reason = holdReason.trim();
          setHold(null);
          void send("PATCH", { category: target.category, modelId: target.modelId, holdReason: reason });
        }}
        onClose={() => setHold(null)}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-bold text-zinc-100">{board.holdReason}</span>
          <textarea
            value={holdReason}
            onChange={(event) => setHoldReason(event.target.value)}
            rows={3}
            className={textarea}
          />
        </label>
      </AdminReasonDialog>
    </div>
  );
}
