"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CatalogMessages } from "@/components/admin/modelCatalog/ImageCatalogViews";
import { ChoiceChips } from "@/components/admin/modelCatalog/ImageCatalogViews";
import { AdminConfirmDialog } from "@/components/admin/ui/AdminConfirmDialog";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import { adminFetch } from "@/lib/adminFetch";
import { formatUsd, QUALITY_ORDER, SIZE_ORDER } from "@/lib/adminModelCatalogFlow";
import {
  emptyMeasurementForm,
  type MeasurementForm,
  type MeasurementPlan,
  measurementMethodFor,
  measurementPlanFromForm,
  type MeasurementSample,
  type MeasurementVerdict,
  sampleCeilingMicroUsd,
  sampleRequests,
} from "@/lib/imageBillingMeasurementCore";
import type { ConfirmedImageBillingTerms } from "@/lib/imageModelRegistry";

// The billing measurement screen (policy section 12.1): plan a paid
// measurement, watch its samples, and confirm the terms they support. The
// server holds the budget, sends the requests and judges the samples again on
// confirmation; this only shows what it reports.

export type MeasureTarget = { provider: string; apiModelId: string; name: string };

type MeasurementView = {
  id: string;
  status: "running" | "completed" | "stopped" | "failed" | "interrupted";
  stopReason: string | null;
  plan: MeasurementPlan | null;
  planned: number | null;
  sampleCeilingMicroUsd: number | null;
  maxCostMicroUsd: number;
  spentMicroUsd: number;
  samples: MeasurementSample[];
  verdict: MeasurementVerdict | null;
  createdAt: string;
};

type MeasureReport = {
  enabled: boolean;
  confirmed: null | { terms: ConfirmedImageBillingTerms; sources?: unknown; createdAt?: string; actorEmail?: string | null };
  measurements: MeasurementView[];
};

const ENDPOINT = "/api/admin/model-catalog/measurements";
const POLL_MS = 3_000;

const field =
  "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500";
const help = "mt-1 block text-xs font-normal text-zinc-500";

function TermsText({ m, terms }: { m: CatalogMessages; terms: ConfirmedImageBillingTerms }) {
  const t = m.measure.terms;
  if (terms.kind === "per_image_no_thinking") return <p className="text-sm text-zinc-200">{t.per_image_no_thinking}</p>;
  if (terms.kind === "measured_output_limit") {
    return (
      <p className="text-sm text-zinc-200">
        {t.measured_output_limit(terms.maxOutputTokens, terms.textOutputUsdPerMTok, terms.imageTokensPerImage)}
      </p>
    );
  }
  return (
    <div className="text-sm text-zinc-200">
      <p>{t.tokens_per_image(terms.imageOutputUsdPerMTok)}</p>
      <ul className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-1 font-mono text-xs">
        {terms.tokens.map((row) => (
          <li key={`${row.quality}|${row.size}`}>
            {(m.quality[row.quality] ?? row.quality)} · {row.size.replace("x", "×")}: {row.tokens}
          </li>
        ))}
      </ul>
    </div>
  );
}

const usageText = (usage: Record<string, number> | null) =>
  usage ? Object.entries(usage).map(([key, value]) => `${key}=${value}`).join(" ") : "—";

function SampleTable({ m, measurement }: { m: CatalogMessages; measurement: MeasurementView }) {
  const c = m.measure.columns;
  const method = measurement.plan?.method;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs" data-testid="model-catalog-measure-samples">
        <thead>
          <tr className="text-left text-zinc-500">
            <th scope="col" className="px-2 py-1.5 font-medium">{c.sample}</th>
            <th scope="col" className="px-2 py-1.5 font-medium">{c.option}</th>
            <th scope="col" className="px-2 py-1.5 font-medium">{c.image}</th>
            {method === "output_limit" ? (
              <>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{c.nonImage}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{c.imageTokens}</th>
              </>
            ) : method === "tokens_per_image" ? (
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{c.outputTokens}</th>
            ) : (
              <th scope="col" className="px-2 py-1.5 font-medium">{c.usage}</th>
            )}
            <th scope="col" className="px-2 py-1.5 text-right font-medium">{c.cost}</th>
          </tr>
        </thead>
        <tbody>
          {measurement.samples.map((sample) => (
            <tr key={sample.index} className="border-t border-zinc-800 text-zinc-300">
              <td className="px-2 py-1.5 font-mono">{sample.index + 1}</td>
              <td className="px-2 py-1.5">
                {(m.quality[sample.quality] ?? sample.quality)} · {sample.size.replace("x", "×")}
              </td>
              <td className={`px-2 py-1.5 font-bold ${sample.delivered ? "text-emerald-300" : "text-red-300"}`}>
                {sample.delivered ? m.measure.yes : m.measure.no(sample.failure ?? "?")}
              </td>
              {method === "output_limit" ? (
                <>
                  <td className="px-2 py-1.5 text-right font-mono">{sample.nonImageBillableTokens ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{sample.billedImageTokens ?? "—"}</td>
                </>
              ) : method === "tokens_per_image" ? (
                <td className="px-2 py-1.5 text-right font-mono">{sample.outputTokens ?? "—"}</td>
              ) : (
                <td className="break-all px-2 py-1.5 font-mono">{usageText(sample.usage)}</td>
              )}
              <td className="px-2 py-1.5 text-right font-mono">{formatUsd(sample.costMicroUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const statusTone = (status: MeasurementView["status"]) =>
  status === "completed" ? "ok" : status === "running" ? "info" : status === "stopped" ? "warn" : "bad";

/** One provider model's measurement screen. */
export function ImageBillingMeasurePanel({
  m,
  target,
  defaultSources,
  onBack,
  onRedraft,
}: {
  m: CatalogMessages;
  target: MeasureTarget;
  defaultSources: readonly string[];
  onBack: () => void;
  /** A new price draft for this model, once terms are confirmed. */
  onRedraft: () => void;
}) {
  const mm = m.measure;
  const method = measurementMethodFor(target.provider);
  const [report, setReport] = useState<MeasureReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<MeasurementForm>(emptyMeasurementForm);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmTerms, setConfirmTerms] = useState<MeasurementView | null>(null);
  const [sources, setSources] = useState(defaultSources.join("\n"));
  const [busy, setBusy] = useState(false);

  const query = useMemo(
    () => `${ENDPOINT}?${new URLSearchParams({ provider: target.provider, apiModelId: target.apiModelId })}`,
    [target.provider, target.apiModelId]
  );

  const load = useCallback(async () => {
    try {
      const response = await adminFetch(query, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      setReport((await response.json()) as MeasureReport);
    } catch {
      setError(mm.refusal.failed);
    }
  }, [query, mm.refusal.failed]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const running = report?.measurements.some((row) => row.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const draft = useMemo(() => measurementPlanFromForm(target.provider, target.apiModelId, form), [target, form]);
  const plan = draft.plan;
  const samples = plan ? sampleRequests(plan).length : 0;
  const ceiling = plan ? sampleCeilingMicroUsd(plan) : null;
  const problemText =
    draft.problem === null
      ? null
      : draft.problem === "unsupported"
        ? mm.unsupported
        : draft.problem.startsWith("max_cost_below_worst_case")
          ? mm.maxCostBelow(formatUsd(draft.worstCaseMicroUsd ?? 0))
          : draft.problem === "max_cost_too_high"
            ? mm.refusal.max_cost_too_high
            : mm.refusal.invalid_plan;

  const post = async (body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const response = await adminFetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; reasons?: string[] } | null;
      if (!response.ok) {
        const code = payload?.error ?? "failed";
        const text = (mm.refusal as Record<string, string>)[code] ?? mm.refusal.failed;
        setError(payload?.reasons?.length ? `${text} (${payload.reasons.join(", ")})` : text);
        return false;
      }
      return true;
    } catch {
      setError(mm.refusal.failed);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!plan) return;
    setConfirmStart(false);
    if (await post({ action: "start", plan })) {
      setNotice(mm.started);
      await load();
    }
  };

  const confirm = async (measurement: MeasurementView) => {
    setConfirmTerms(null);
    const urls = sources
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (await post({ action: "confirm", measurementId: measurement.id, sources: urls })) {
      setNotice(mm.confirmedToast);
      await load();
    }
  };

  const setField = (key: keyof MeasurementForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const optionKeys = QUALITY_ORDER.flatMap((quality) => SIZE_ORDER.map((size) => `${quality}|${size}`));

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="model-catalog-measure">
      <div>
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-bold text-zinc-400 hover:text-zinc-100">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {mm.back}
        </button>
        <h2 className="mt-2 text-xl font-bold text-zinc-100">{mm.title(target.name)}</h2>
        <p className="mt-1 break-all font-mono text-xs text-zinc-500">
          {target.provider} · {target.apiModelId}
        </p>
        <p className="mt-2 text-sm text-zinc-300">{mm.intro}</p>
      </div>

      {notice ? (
        <p role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300" data-testid="model-catalog-measure-error">
          {error}
        </p>
      ) : null}

      {report?.confirmed ? (
        <AdminTile title={mm.confirmed} description={report.confirmed.createdAt ? mm.confirmedAt(report.confirmed.createdAt.slice(0, 10), report.confirmed.actorEmail ?? "") : undefined}>
          <TermsText m={m} terms={report.confirmed.terms} />
          <AdminWriteButton variant="secondary" onClick={onRedraft} data-testid="model-catalog-measure-redraft">
            {mm.redraft}
          </AdminWriteButton>
        </AdminTile>
      ) : null}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <AdminTile title={mm.historyTitle}>
          {!report ? (
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" aria-hidden />
          ) : report.measurements.length === 0 ? (
            <p className="text-sm text-zinc-400">{mm.noMeasurements}</p>
          ) : (
            <div className="flex flex-col gap-4">
              {report.measurements.map((measurement) => (
                <section key={measurement.id} className="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3" data-testid="model-catalog-measurement" data-status={measurement.status}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                    <AdminStatusChip tone={statusTone(measurement.status)}>{mm.status[measurement.status]}</AdminStatusChip>
                    <span>{measurement.createdAt.slice(0, 16).replace("T", " ")}Z</span>
                    {measurement.planned !== null ? <span>{mm.progress(measurement.samples.length, measurement.planned)}</span> : null}
                    <span>{mm.spent(formatUsd(measurement.spentMicroUsd), formatUsd(measurement.maxCostMicroUsd))}</span>
                    {measurement.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                  </div>
                  {measurement.stopReason && measurement.stopReason in mm.stopReason ? (
                    <p className="text-xs text-amber-300">{mm.stopReason[measurement.stopReason as keyof typeof mm.stopReason]}</p>
                  ) : null}
                  {measurement.samples.length > 0 ? <SampleTable m={m} measurement={measurement} /> : null}
                  {measurement.status !== "running" && measurement.verdict ? (
                    measurement.verdict.confirmable && measurement.verdict.terms ? (
                      <div className="flex flex-col gap-2 rounded-xl bg-emerald-500/10 p-3" data-testid="model-catalog-measure-verdict" data-confirmable="true">
                        <p className="text-xs font-bold text-emerald-300">{mm.verdictOk}</p>
                        <TermsText m={m} terms={measurement.verdict.terms} />
                        {measurement.status === "completed" ? (
                          <>
                            <label className="text-xs font-bold text-zinc-300">
                              {mm.sourcesLabel}
                              <textarea className={`${field} font-mono`} rows={2} value={sources} onChange={(event) => setSources(event.target.value)} />
                              <span className={help}>{mm.sourcesHelp}</span>
                            </label>
                            <AdminWriteButton disabled={busy || !sources.trim()} onClick={() => setConfirmTerms(measurement)} data-testid="model-catalog-measure-confirm">
                              {mm.confirm}
                            </AdminWriteButton>
                          </>
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-xl bg-red-500/10 p-3 text-xs text-red-300" data-testid="model-catalog-measure-verdict" data-confirmable="false">
                        <p className="font-bold">{mm.verdictRefused}</p>
                        <ul className="mt-1 list-disc pl-4">
                          {measurement.verdict.reasons.map((reason) => {
                            const [head, ...rest] = reason.split(":");
                            const text = (mm.verdictReason as Record<string, string>)[head] ?? head;
                            return <li key={reason}>{rest.length ? `${text} (${rest.join(":")})` : text}</li>;
                          })}
                        </ul>
                      </div>
                    )
                  ) : null}
                  {measurement.verdict?.notes.length ? (
                    <p className="font-mono text-[11px] text-zinc-500">
                      {mm.notes}: {measurement.verdict.notes.join(" · ")}
                    </p>
                  ) : null}
                </section>
              ))}
            </div>
          )}
        </AdminTile>

        <AdminTile title={mm.planTitle} description={method ? mm.method[method] : mm.unsupported}>
          {!report ? null : !report.enabled ? (
            <p className="rounded-xl bg-amber-500/10 p-3 text-xs text-amber-300" data-testid="model-catalog-measure-disabled">
              {mm.disabled("IMAGE_BILLING_MEASUREMENT_ENABLED")}
            </p>
          ) : null}
          {method ? (
            <div className="flex flex-col gap-3 text-sm" data-testid="model-catalog-measure-form">
              {method === "output_limit" ? (
                <label className="text-xs font-bold text-zinc-300">
                  {mm.maxOutputTokens}
                  <input inputMode="numeric" className={`${field} font-mono`} value={form.maxOutputTokens} onChange={(event) => setField("maxOutputTokens", event.target.value)} />
                  <span className={help}>{mm.maxOutputTokensHelp}</span>
                </label>
              ) : null}
              {method === "tokens_per_image" ? (
                <>
                  <div>
                    <span className="text-xs font-bold text-zinc-300">{mm.options}</span>
                    <ChoiceChips
                      values={optionKeys}
                      selected={form.options}
                      label={(key) => {
                        const [quality, size] = key.split("|");
                        return `${m.quality[quality] ?? quality} ${size.replace("x", "×")}`;
                      }}
                      onToggle={(key) =>
                        setForm((current) => ({
                          ...current,
                          options: current.options.includes(key) ? current.options.filter((entry) => entry !== key) : [...current.options, key],
                        }))
                      }
                    />
                  </div>
                  <label className="text-xs font-bold text-zinc-300">
                    {mm.samplesPerOption}
                    <input inputMode="numeric" className={`${field} font-mono`} value={form.samplesPerOption} onChange={(event) => setField("samplesPerOption", event.target.value)} />
                  </label>
                </>
              ) : (
                <label className="text-xs font-bold text-zinc-300">
                  {mm.samples}
                  <input inputMode="numeric" className={`${field} font-mono`} value={form.samples} onChange={(event) => setField("samples", event.target.value)} />
                </label>
              )}
              {method === "output_limit" ? (
                <label className="text-xs font-bold text-zinc-300">
                  {mm.textRate}
                  <input inputMode="decimal" className={`${field} font-mono`} value={form.textRate} onChange={(event) => setField("textRate", event.target.value)} />
                </label>
              ) : null}
              {method === "per_image" ? (
                <label className="text-xs font-bold text-zinc-300">
                  {mm.perImageUsd}
                  <input inputMode="decimal" className={`${field} font-mono`} value={form.perImageUsd} onChange={(event) => setField("perImageUsd", event.target.value)} />
                </label>
              ) : (
                <label className="text-xs font-bold text-zinc-300">
                  {mm.imageRate}
                  <input inputMode="decimal" className={`${field} font-mono`} value={form.imageRate} onChange={(event) => setField("imageRate", event.target.value)} />
                </label>
              )}
              <span className={help}>{mm.ratesHelp}</span>
              <label className="text-xs font-bold text-zinc-300">
                {mm.maxCost}
                <input
                  inputMode="decimal"
                  className={`${field} font-mono`}
                  placeholder={draft.worstCaseMicroUsd !== null ? (Math.ceil(draft.worstCaseMicroUsd / 10_000) / 100).toFixed(2) : ""}
                  value={form.maxCostUsd}
                  onChange={(event) => setField("maxCostUsd", event.target.value)}
                />
              </label>
              {plan && ceiling !== null && draft.worstCaseMicroUsd !== null ? (
                <p className="text-xs text-zinc-400" data-testid="model-catalog-measure-worst">
                  {mm.worstCase(samples, formatUsd(ceiling), formatUsd(draft.worstCaseMicroUsd))}
                </p>
              ) : null}
              {problemText ? <p className="text-xs text-red-300">{problemText}</p> : null}
              <AdminWriteButton
                disabled={busy || running || !plan || draft.problem !== null || !report?.enabled}
                onClick={() => setConfirmStart(true)}
                data-testid="model-catalog-measure-start"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                {mm.start}
              </AdminWriteButton>
            </div>
          ) : null}
        </AdminTile>
      </div>

      <AdminConfirmDialog
        open={confirmStart && plan !== null}
        title={mm.confirmStartTitle}
        summary={plan ? `${target.provider} · ${target.apiModelId}` : undefined}
        effects={plan ? [mm.confirmStartBody(samples, formatUsd(plan.maxCostMicroUsd))] : []}
        confirmLabel={mm.confirmStartAction}
        busy={busy}
        onConfirm={() => void start()}
        onClose={() => setConfirmStart(false)}
      />
      <AdminConfirmDialog
        open={confirmTerms !== null}
        title={mm.confirmTitle}
        summary={confirmTerms?.verdict?.terms ? <TermsText m={m} terms={confirmTerms.verdict.terms} /> : undefined}
        effects={[mm.confirmBody]}
        confirmLabel={mm.confirm}
        busy={busy}
        onConfirm={() => confirmTerms && void confirm(confirmTerms)}
        onClose={() => setConfirmTerms(null)}
      />
    </div>
  );
}
