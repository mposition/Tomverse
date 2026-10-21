"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminFetch } from "@/lib/adminFetch";
import { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";

// Operator surface over /api/admin/model-catalog. Raw JSON editors on purpose:
// the schemas are enforced server-side (lib/modelCatalogCore.ts), and a form
// per field would be code that a model-written draft makes unnecessary.

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

type CatalogReport = {
  image: { models: ImageRow[]; problems: { modelId: string; problem: string }[] };
  coding: {
    models: CodingRow[];
    snapshot: { version: number; models: unknown[]; coverageUntil: string } | null;
  };
  chat: { models: { modelId: string; name: string; provider: string; enabled: boolean }[] };
  video: { policy: { reasons: string[] } };
  draftLlm: { configured: boolean; env: string };
};

const cell = "px-3 py-2 align-top text-sm text-zinc-200";
const button =
  "rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-bold text-zinc-200 hover:bg-zinc-900 disabled:opacity-50";
const textarea =
  "mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-200";

const reasonsOf = (admission: Admission | null | undefined) =>
  admission?.admitted ? "" : (admission?.reasons ?? []).join(", ");

export function AdminModelCatalogPanel() {
  const m = useAdminMessages(adminModelCatalogMessages);
  const [report, setReport] = useState<CatalogReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
  const [profileDrafts, setProfileDrafts] = useState<Record<string, string>>({});
  const [newCodingId, setNewCodingId] = useState("");
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
    } catch {
      setNotice(m.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [m.loadFailed]);

  useEffect(() => {
    // Deferred a tick so no state write is synchronous within the effect,
    // the same idiom the other admin panels use for their mount load.
    queueMicrotask(() => void load());
  }, [load]);

  const send = async (method: "PATCH" | "POST", body: unknown) => {
    setNotice(null);
    const response = await adminFetch("/api/admin/model-catalog", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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
    <div className="flex flex-wrap gap-1">
      <button type="button" className={button} onClick={() => void send("PATCH", { category, modelId, enabled: true, holdReason: null })}>
        {m.enable}
      </button>
      <button
        type="button"
        className={button}
        onClick={() => {
          const reason = window.prompt(m.holdPrompt)?.trim();
          if (reason) void send("PATCH", { category, modelId, holdReason: reason });
        }}
      >
        {m.hold}
      </button>
      <button type="button" className={button} onClick={() => void send("PATCH", { category, modelId, enabled: null, holdReason: null })}>
        {m.inherit}
      </button>
    </div>
  );

  const draftBlock = (category: "image" | "coding", modelId: string, draft: unknown) =>
    draft ? (
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-bold text-zinc-400">{m.draft}</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-900 p-2 text-[11px] text-zinc-300">{JSON.stringify(draft, null, 2)}</pre>
        <button type="button" className={`${button} mt-1`} onClick={() => void send("POST", { action: "apply_draft", category, modelId })}>
          {m.applyDraft}
        </button>
      </details>
    ) : null;

  return (
    <section className="overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950/80">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/60 p-5">
        <div>
          <h2 className="text-2xl font-black text-white">{m.title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">{m.description}</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-4 py-2 text-sm font-bold text-zinc-200 hover:bg-zinc-900">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {m.refresh}
        </button>
      </div>
      {notice ? <p role="status" className="border-b border-zinc-800 px-5 py-3 text-sm font-semibold text-zinc-200">{notice}</p> : null}

      {report ? (
        <div className="flex flex-col gap-8 p-5">
          <div>
            <h3 className="text-lg font-black text-white">{m.image}</h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                    <th className={cell}>{m.model}</th>
                    <th className={cell}>{m.state}</th>
                    <th className={cell}>{m.price}</th>
                    <th className={cell}>{m.judge}</th>
                    <th className={cell}>{m.actions}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.image.models.map((row) => (
                    <tr key={row.id} className="border-t border-zinc-800">
                      <td className={cell}>
                        <div className="font-bold">{row.name}</div>
                        <div className="font-mono text-xs text-zinc-500">{row.id} · {row.provider} · {row.source}</div>
                      </td>
                      <td className={cell}>{row.disabledReason ?? m.serving}{row.holdReason ? ` · ${row.holdReason}` : ""}</td>
                      <td className={`${cell} font-mono text-xs`}>{row.pricingVersion}</td>
                      <td className={`${cell} text-xs`}>{row.admissionIfEnabled.admitted ? m.admitted : reasonsOf(row.admissionIfEnabled)}</td>
                      <td className={cell}>
                        {stateButtons("image", row.id)}
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs font-bold text-zinc-400">{m.priceRevision}</summary>
                          <p className="mt-1 text-[11px] text-zinc-500">{m.priceRevisionHint}</p>
                          <textarea
                            className={textarea}
                            rows={5}
                            value={priceDrafts[row.id] ?? ""}
                            onChange={(event) => setPriceDrafts({ ...priceDrafts, [row.id]: event.target.value })}
                          />
                          <button
                            type="button"
                            className={`${button} mt-1`}
                            onClick={() => {
                              const revision = parseJson(priceDrafts[row.id] ?? "");
                              if (revision !== undefined) void send("POST", { action: "price_revision", modelId: row.id, revision });
                            }}
                          >
                            {m.submit}
                          </button>
                        </details>
                        {draftBlock("image", row.id, row.draft)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.image.problems.length > 0 ? (
              <p className="mt-2 text-xs text-amber-300">
                {m.problems}: {report.image.problems.map((p) => `${p.modelId} (${p.problem})`).join(", ")}
              </p>
            ) : null}
          </div>

          <div>
            <h3 className="text-lg font-black text-white">{m.coding}</h3>
            <div className="mt-2 flex flex-col gap-3">
              {report.coding.models.map((row) => (
                <div key={row.modelId} className="rounded-xl border border-zinc-800 p-3">
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
                  <label className="mt-2 block text-xs font-bold text-zinc-400">
                    {m.profile}
                    <textarea
                      className={textarea}
                      rows={6}
                      value={profileDrafts[row.modelId] ?? JSON.stringify(row.profile ? { ...(row.profile as object), modelId: undefined } : {}, null, 2)}
                      onChange={(event) => setProfileDrafts({ ...profileDrafts, [row.modelId]: event.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    className={`${button} mt-1`}
                    onClick={() => {
                      const profile = parseJson(profileDrafts[row.modelId] ?? "");
                      if (profile !== undefined) void send("PATCH", { category: "coding", modelId: row.modelId, profile });
                    }}
                  >
                    {m.saveProfile}
                  </button>
                  {draftBlock("coding", row.modelId, row.draft)}
                </div>
              ))}
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs font-bold text-zinc-400">
                  {m.newCodingModel}
                  <input className={textarea} value={newCodingId} onChange={(event) => setNewCodingId(event.target.value)} />
                </label>
                <button
                  type="button"
                  className={button}
                  disabled={!newCodingId.trim()}
                  onClick={() => void send("PATCH", { category: "coding", modelId: newCodingId.trim(), enabled: null })}
                >
                  {m.submit}
                </button>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-zinc-800 p-3">
              <div className="text-sm font-bold text-zinc-100">{m.snapshot}</div>
              <div className="text-xs text-zinc-400">
                {report.coding.snapshot
                  ? m.snapshotLine(report.coding.snapshot.version, report.coding.snapshot.models.length, report.coding.snapshot.coverageUntil.slice(0, 10))
                  : m.snapshotNone}
              </div>
              <button type="button" className={`${button} mt-2`} onClick={() => void send("POST", { action: "publish_snapshot" })}>
                {m.publishSnapshot}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 p-3">
            <div className="text-sm font-bold text-zinc-100">{m.requestDraft}</div>
            {!report.draftLlm.configured ? (
              <p className="mt-1 text-xs text-amber-300">{m.draftNotConfigured(report.draftLlm.env)}</p>
            ) : null}
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <select
                className={textarea}
                value={draftForm.category}
                onChange={(event) => setDraftForm({ ...draftForm, category: event.target.value })}
              >
                <option value="coding">{m.coding}</option>
                <option value="image">{m.image}</option>
              </select>
              <label className="text-xs font-bold text-zinc-400">
                {m.draftModelId}
                <input className={textarea} value={draftForm.modelId} onChange={(event) => setDraftForm({ ...draftForm, modelId: event.target.value })} />
              </label>
              <label className="text-xs font-bold text-zinc-400">
                {m.provider}
                <input className={textarea} value={draftForm.provider} onChange={(event) => setDraftForm({ ...draftForm, provider: event.target.value })} />
              </label>
              <label className="text-xs font-bold text-zinc-400">
                {m.draftApiModelId}
                <input className={textarea} value={draftForm.apiModelId} onChange={(event) => setDraftForm({ ...draftForm, apiModelId: event.target.value })} />
              </label>
            </div>
            <label className="mt-2 block text-xs font-bold text-zinc-400">
              {m.draftSources}
              <textarea className={textarea} rows={3} value={draftForm.sources} onChange={(event) => setDraftForm({ ...draftForm, sources: event.target.value })} />
            </label>
            <button
              type="button"
              className={`${button} mt-1`}
              disabled={!report.draftLlm.configured}
              onClick={() =>
                void send("POST", {
                  action: "draft",
                  category: draftForm.category,
                  modelId: draftForm.modelId.trim(),
                  provider: draftForm.provider.trim(),
                  apiModelId: draftForm.apiModelId.trim(),
                  sourceUrls: draftForm.sources.split("\n").map((line) => line.trim()).filter(Boolean),
                })
              }
            >
              {m.submit}
            </button>
          </div>

          <div>
            <h3 className="text-lg font-black text-white">{m.chat}</h3>
            <p className="text-xs text-zinc-500">{m.chatNote}</p>
            <ul className="mt-2 grid gap-1 text-xs text-zinc-300 sm:grid-cols-2">
              {report.chat.models.map((row) => (
                <li key={row.modelId} className="font-mono">
                  {row.modelId} · {row.provider} · {row.enabled ? m.serving : m.inherit}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-lg font-black text-white">{m.video}</h3>
            <p className="text-xs text-zinc-500">{m.videoNote}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
