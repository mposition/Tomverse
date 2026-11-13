"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import { useState } from "react";

import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminStepper } from "@/components/admin/ui/AdminStepper";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import type { AdminMessageShape } from "@/lib/adminLocale";
import type { adminModelCatalogMessages } from "@/lib/adminMessages/modelCatalog";
import {
  creditProblems,
  formatUsd,
  imageFlowSteps,
  imageNextAction,
  imageStage,
  type ImageCatalogItem,
  type ImageNextAction,
  type ImageOptionFloor,
  type ImageOptionPrice,
  type ImageStage,
  needsAction,
  optionKey,
  orderedPrices,
  priceRange,
  reasonMessage,
  type ReasonMessage,
  suggestsMeasurement,
} from "@/lib/adminModelCatalogFlow";
import type { AdminTone } from "@/lib/adminUiCore";

// The image catalogue's screens. Presentational only: the panel
// (AdminModelCatalogPanel) owns the requests and passes the handlers in.
// Dark classes only; Light is the console's palette remap.

export type CatalogMessages = AdminMessageShape<(typeof adminModelCatalogMessages)["en"]>;

export const reasonText = (m: CatalogMessages, message: ReasonMessage): string => {
  const r = m.reason;
  switch (message.key) {
    case "unofficialSource":
      return r.unofficialSource(message.host);
    case "creditsBelowFloor":
      return r.creditsBelowFloor(m.quality[message.quality] ?? message.quality, m.size[message.size] ?? message.size);
    case "priceBelowMeasured":
      return r.priceBelowMeasured(m.quality[message.quality] ?? message.quality, m.size[message.size] ?? message.size);
    case "thinkingCapBelowMinimum":
      return r.thinkingCapBelowMinimum(message.minimum);
    case "noPriceFound":
      return r.noPriceFound(message.detail);
    case "codingWeightBelowFloor":
      return r.codingWeightBelowFloor(message.floor);
    case "draftIncomplete":
      return r.draftIncomplete(message.detail);
    case "unknown":
      return r.unknown(message.code);
    default:
      return r[message.key];
  }
};

export const STAGE_TONE: Record<ImageStage, AdminTone> = {
  profile_invalid: "warn",
  needs_draft: "warn",
  draft_ready: "warn",
  ready_to_enable: "info",
  blocked: "bad",
  needs_budget: "warn",
  serving: "ok",
  held: "warn",
};

export function ImageStageChip({ m, stage }: { m: CatalogMessages; stage: ImageStage }) {
  return <AdminStatusChip tone={STAGE_TONE[stage]}>{m.stageChip[stage]}</AdminStatusChip>;
}

/** The four steps; coding passes its own step names (the draft is a profile, not prices). */
export function ImageFlowStepper({
  m,
  stage,
  labels = m.steps,
}: {
  m: CatalogMessages;
  stage: ImageStage;
  labels?: CatalogMessages["steps"];
}) {
  return (
    <AdminStepper
      label={m.stepperLabel}
      stateWords={m.stepStates}
      steps={imageFlowSteps(stage).map((step) => ({ ...step, label: labels[step.id] }))}
      data-testid="model-catalog-stepper"
    />
  );
}

const subtitle = (m: CatalogMessages, item: ImageCatalogItem) =>
  [item.id, item.provider, item.source === "code" ? m.sourceCode : m.sourceCatalog].filter(Boolean).join(" · ");

const priceLine = (m: CatalogMessages, prices: readonly { credits: number }[]) => {
  const range = priceRange(prices);
  return range ? m.priceSummary(range.count, range.min, range.max) : m.noPrice;
};

/** The list: models waiting for the operator first, then the settled ones. */
export function ImageCatalogList({
  m,
  items,
  onOpen,
  onAction,
  onHold,
  onInherit,
}: {
  m: CatalogMessages;
  items: readonly ImageCatalogItem[];
  onOpen: (item: ImageCatalogItem) => void;
  onAction: (item: ImageCatalogItem, action: ImageNextAction) => void;
  onHold: (item: ImageCatalogItem) => void;
  onInherit: (item: ImageCatalogItem) => void;
}) {
  const staged = items.map((item) => ({ item, stage: imageStage(item) }));
  const pending = staged.filter((entry) => needsAction(entry.item, entry.stage));
  const settled = staged.filter((entry) => !needsAction(entry.item, entry.stage));
  const servingCount = settled.filter((entry) => entry.stage === "serving").length;
  const heldCount = settled.filter((entry) => entry.stage === "held").length;

  const columns: AdminDataColumn<(typeof settled)[number]>[] = [
    {
      key: "model",
      header: m.model,
      render: ({ item }) => (
        <div className="min-w-0">
          <div className="font-bold text-zinc-100">{item.name}</div>
          <div className="truncate font-mono text-xs text-zinc-500">{subtitle(m, item)}</div>
        </div>
      ),
    },
    {
      key: "state",
      header: m.state,
      render: ({ item, stage }) => (
        <div className="flex flex-col items-start gap-1">
          <ImageStageChip m={m} stage={stage} />
          {item.served?.holdReason ? <span className="text-xs text-zinc-400">{m.holdReasonLine(item.served.holdReason)}</span> : null}
        </div>
      ),
    },
    { key: "price", header: m.columns.credits, render: ({ item }) => <span className="text-xs">{priceLine(m, item.served?.prices ?? [])}</span> },
    {
      key: "checked",
      header: m.verifiedAtLabel,
      render: ({ item }) => <span className="text-xs text-zinc-400">{item.served?.priceVerification.verifiedAt ?? "—"}</span>,
    },
    {
      key: "actions",
      header: m.actions,
      align: "right",
      render: ({ item, stage }) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          <button
            type="button"
            onClick={() => onOpen(item)}
            className="min-h-8 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
          >
            {m.viewPrices}
          </button>
          {stage === "serving" ? (
            <AdminWriteButton size="sm" variant="secondary" onClick={() => onHold(item)}>
              {m.holdAction}
            </AdminWriteButton>
          ) : stage === "blocked" || stage === "needs_budget" ? null : (
            // A refused model offers no switch that would only be refused; its prices view says why.
            <AdminWriteButton size="sm" variant="secondary" onClick={() => onAction(item, "enable")}>
              {m.enable}
            </AdminWriteButton>
          )}
          {item.source === "code" && (item.served?.enabled !== null || item.served?.holdReason) ? (
            <AdminWriteButton size="sm" variant="ghost" onClick={() => onInherit(item)}>
              {m.inheritAction}
            </AdminWriteButton>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {pending.length > 0 ? (
        <section className="flex flex-col gap-3" data-testid="model-catalog-pending">
          <div>
            <h3 className="text-sm font-bold text-zinc-100">
              {m.pendingTitle} <span className="ml-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{pending.length}</span>
            </h3>
            <p className="mt-0.5 text-xs text-zinc-400">{m.pendingNote}</p>
          </div>
          {pending.map(({ item, stage }) => {
            const action = imageNextAction(stage);
            return (
              <div
                key={item.id}
                data-testid="model-catalog-pending-image"
                data-stage={stage}
                className="flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-zinc-950/40 p-4 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-bold text-zinc-100">{item.name}</span>
                    <span className="truncate font-mono text-xs text-zinc-500">{subtitle(m, item)}</span>
                  </div>
                  <ImageFlowStepper m={m} stage={stage} />
                  <p className="text-xs font-bold text-amber-300">{m.stage[stage]}</p>
                  {item.served?.disabledReason === null && stage !== "serving" ? (
                    <div>
                      <ImageStageChip m={m} stage="serving" />
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {/* A model with a new draft may still be serving at its current
                      price; it can always be held from here (review 2026-11-12). */}
                  {item.served?.disabledReason === null ? (
                    <AdminWriteButton variant="secondary" onClick={() => onHold(item)} data-testid="model-catalog-hold">
                      {m.holdAction}
                    </AdminWriteButton>
                  ) : null}
                  {action === "review_prices" ? null : (
                    <button
                      type="button"
                      onClick={() => onOpen(item)}
                      className="min-h-10 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
                    >
                      {m.viewPrices}
                    </button>
                  )}
                  {action === "none" ? null : (
                    <AdminWriteButton onClick={() => (action === "review_prices" ? onOpen(item) : onAction(item, action))}>
                      {m.nextAction[action]}
                    </AdminWriteButton>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ) : null}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-zinc-100">{m.settledTitle}</h3>
            <p className="mt-0.5 text-xs text-zinc-400">{m.settledNote}</p>
          </div>
          <div className="flex gap-1.5">
            <AdminStatusChip tone="ok">{m.countServing(servingCount)}</AdminStatusChip>
            {heldCount > 0 ? <AdminStatusChip tone="warn">{m.countHeld(heldCount)}</AdminStatusChip> : null}
          </div>
        </div>
        <AdminDataTable
          caption={m.settledTitle}
          columns={columns}
          rows={settled}
          rowKey={({ item }) => item.id}
          cardTitle={({ item }) => item.name}
          emptyState={<p className="text-sm text-zinc-400">{m.noImageModels}</p>}
        />
      </section>
    </div>
  );
}

/** Quality × size prices; credits editable when `editable`. */
export function ImagePriceTable({
  m,
  prices,
  floors,
  edits = {},
  editable = false,
  onEdit,
}: {
  m: CatalogMessages;
  prices: readonly ImageOptionPrice[];
  floors: readonly ImageOptionFloor[];
  edits?: Readonly<Record<string, string>>;
  editable?: boolean;
  onEdit?: (key: string, value: string) => void;
}) {
  const rows = orderedPrices(prices);
  const floorOf = new Map(floors.map((floor) => [optionKey(floor), floor.floor]));
  const problems = editable ? creditProblems(prices, edits, floors) : {};
  const view = rows.map((price, index) => {
    const key = optionKey(price);
    const typed = edits[key];
    const edited = typed !== undefined && Number(typed) !== price.credits;
    const credits = typed === undefined ? price.credits : Number(typed);
    const floor = floorOf.get(key) ?? null;
    const problem = problems[key];
    const verdict =
      problem === "not_a_number" ? (
        <span className="font-bold text-red-300">{m.notANumber}</span>
      ) : problem === "below_floor" && floor !== null ? (
        <span className="font-bold text-red-300">{m.belowFloor(floor)}</span>
      ) : floor === null ? (
        <span className="text-zinc-500">{m.floorUnknown}</span>
      ) : credits > floor ? (
        <span className="font-bold text-emerald-300">{m.floorPlus(credits - floor)}</span>
      ) : (
        <span className="text-zinc-400">{m.floorMet}</span>
      );
    const qualityLabel = m.quality[price.quality] ?? price.quality;
    const sizeLabel = m.size[price.size] ?? price.size;
    const input = editable ? (
      <span className="flex items-center gap-2">
        <input
          inputMode="numeric"
          aria-label={m.creditsInputLabel(qualityLabel, sizeLabel)}
          aria-invalid={problem ? true : undefined}
          data-testid={`model-catalog-credits-${key}`}
          value={typed ?? String(price.credits)}
          onChange={(event) => onEdit?.(key, event.target.value.trim())}
          className={`w-20 rounded-lg border bg-zinc-950 px-2 py-1.5 text-right font-mono text-sm font-bold text-zinc-100 outline-none focus:border-blue-500 ${
            problem ? "border-red-500" : edited ? "border-blue-500" : "border-zinc-700"
          }`}
        />
        {edited ? <span className="rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-bold text-blue-300">{m.fromDraft(price.credits)}</span> : null}
      </span>
    ) : (
      <span className="font-mono font-bold text-zinc-100">{price.credits}</span>
    );
    return { key, price, index, qualityLabel, sizeLabel, floor, verdict, input, firstOfQuality: index === 0 || rows[index - 1].quality !== price.quality };
  });

  return (
    <>
      <table className="hidden w-full border-collapse text-sm sm:table" data-testid="model-catalog-price-table">
        <caption className="sr-only">{m.priceTableTitle}</caption>
        <thead>
          <tr className="text-left text-xs text-zinc-500">
            <th scope="col" className="px-2 py-2 font-medium">{m.columns.quality}</th>
            <th scope="col" className="px-2 py-2 font-medium">{m.columns.size}</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">{m.columns.cost}</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">{m.columns.floor}</th>
            <th scope="col" className="px-2 py-2 font-medium">{m.columns.credits}</th>
            <th scope="col" className="px-2 py-2 font-medium">{m.columns.verdict}</th>
          </tr>
        </thead>
        <tbody>
          {view.map((row) => (
            <tr key={row.key} className={`border-t border-zinc-800 ${row.firstOfQuality ? "" : ""}`}>
              <td className="px-2 py-2 font-bold text-zinc-100">{row.firstOfQuality ? row.qualityLabel : ""}</td>
              <td className="px-2 py-2 text-zinc-300">
                {row.sizeLabel} <span className="font-mono text-xs text-zinc-500">{row.price.size.replace("x", "×")}</span>
              </td>
              <td className="px-2 py-2 text-right font-mono text-zinc-300">{formatUsd(row.price.outputCostMicroUsd)}</td>
              <td className="px-2 py-2 text-right font-mono text-zinc-400">{row.floor ?? m.floorUnknown}</td>
              <td className="px-2 py-2">{row.input}</td>
              <td className="whitespace-nowrap px-2 py-2 text-xs">{row.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-col gap-2 sm:hidden">
        {view.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800 p-3">
            <div className="min-w-0">
              <div className="text-sm font-bold text-zinc-100">
                {row.qualityLabel} · {row.sizeLabel}
              </div>
              <div className="text-xs text-zinc-500">
                {formatUsd(row.price.outputCostMicroUsd)} · {m.columns.floor} {row.floor ?? m.floorUnknown}
              </div>
              <div className="mt-1 text-xs">{row.verdict}</div>
            </div>
            {row.input}
          </li>
        ))}
      </ul>
    </>
  );
}

function SourceBox({
  m,
  verification,
  pricingVersion,
  reasons,
  edited,
  fromDraft,
}: {
  m: CatalogMessages;
  verification: { verifiedAt: string | null; sources: readonly string[]; thinkingCapMicroUsd: number | null };
  pricingVersion: string;
  reasons: readonly string[];
  edited: number;
  fromDraft: boolean;
}) {
  const unofficial = reasons.some((reason) => reason.startsWith("unofficial_source")) || verification.sources.length === 0;
  return (
    <AdminTile
      title={m.sourceTitle}
      description={m.sourceNote}
      action={<AdminStatusChip tone={unofficial ? "bad" : "ok"}>{unofficial ? m.unofficialSourceChip : m.officialSource}</AdminStatusChip>}
    >
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-xs font-bold text-zinc-500">{m.sourcesLabel}</dt>
        <dd className="min-w-0">
          {verification.sources.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className="block break-all font-mono text-xs text-blue-300 underline">
              {url.replace(/^https:\/\//, "")}
            </a>
          ))}
        </dd>
        <dt className="text-xs font-bold text-zinc-500">{m.verifiedAtLabel}</dt>
        <dd className="text-zinc-300">{verification.verifiedAt ?? "—"}</dd>
        <dt className="text-xs font-bold text-zinc-500">{m.thinkingCapLabel}</dt>
        <dd className="text-zinc-300">
          {verification.thinkingCapMicroUsd === null ? m.thinkingCapNone : formatUsd(verification.thinkingCapMicroUsd)}
        </dd>
        <dt className="text-xs font-bold text-zinc-500">{m.pricingVersionLabel}</dt>
        <dd className="break-all font-mono text-xs text-zinc-300">{pricingVersion}</dd>
        {fromDraft ? (
          <>
            <dt className="text-xs font-bold text-zinc-500">{m.authorLabel}</dt>
            <dd className="text-zinc-300">{m.authorDraft(edited)}</dd>
          </>
        ) : null}
      </dl>
    </AdminTile>
  );
}

/** One model: where it is in the flow, its prices, and the one thing to do next. */
export function ImageModelDetail({
  m,
  item,
  edits,
  drafting,
  onBack,
  onEdit,
  onResetEdits,
  onApply,
  onAction,
  onHold,
  onRename,
  onMeasure,
}: {
  m: CatalogMessages;
  item: ImageCatalogItem;
  /** Opens the billing measurement for this model; offered where a measurement can answer the refusal. */
  onMeasure?: () => void;
  edits: Readonly<Record<string, string>>;
  /** Elapsed time while a draft request for this model runs. */
  drafting: string | null;
  onBack: () => void;
  onEdit: (key: string, value: string) => void;
  onResetEdits: () => void;
  onApply: () => void;
  onAction: (action: ImageNextAction) => void;
  onHold: () => void;
  /** Resolves true once saved; the field closes then. */
  onRename: (name: string) => Promise<boolean>;
}) {
  const stage = imageStage(item);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const renameValue = renaming?.trim() ?? "";
  const saveRename = async () => {
    if (!renameValue || renameValue === item.name) return setRenaming(null);
    setRenameBusy(true);
    const saved = await onRename(renameValue);
    setRenameBusy(false);
    if (saved) setRenaming(null);
  };
  const draft = item.draft;
  const draftReasons = item.draftReview?.reasons ?? [];
  // Credit floors are re-checked against the typed credits; every other
  // reason the draft has cannot be fixed on this screen.
  const blockingReasons = draftReasons.filter((reason) => !reason.startsWith("credits_below_floor"));
  const problems = draft ? creditProblems(draft.prices, edits, item.draftReview?.floors ?? []) : {};
  const problemCount = Object.keys(problems).length;
  const editedCount = draft ? draft.prices.filter((price) => edits[optionKey(price)] !== undefined && Number(edits[optionKey(price)]) !== price.credits).length : 0;
  const serving = item.served?.disabledReason === null;
  const nextAction = imageNextAction(stage);
  // "No reasoning cost cap" or "no price in the documentation": a measurement can settle either.
  const measureButton = (reasons: readonly string[]) =>
    onMeasure && suggestsMeasurement(item.provider, reasons) ? (
      <AdminWriteButton onClick={onMeasure} data-testid="model-catalog-measure-open">
        {m.measure.action}
      </AdminWriteButton>
    ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="model-catalog-detail" data-stage={stage}>
      <div>
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-bold text-zinc-400 hover:text-zinc-100">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {m.backToList}
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-bold text-zinc-100">{item.name}</h2>
          {renaming === null ? (
            <button
              type="button"
              onClick={() => setRenaming(item.name)}
              data-testid="model-catalog-rename"
              className="text-xs font-bold text-zinc-400 underline hover:text-zinc-100"
            >
              {m.renameAction}
            </button>
          ) : null}
          <ImageStageChip m={m} stage={stage} />
          {serving && stage !== "serving" ? <ImageStageChip m={m} stage="serving" /> : null}
          {serving ? (
            <AdminWriteButton size="sm" variant="secondary" className="ml-auto" onClick={onHold} data-testid="model-catalog-hold">
              {m.holdAction}
            </AdminWriteButton>
          ) : null}
        </div>
        <p className="mt-1 break-all font-mono text-xs text-zinc-500">{subtitle(m, item)}</p>
        {renaming !== null ? (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            data-testid="model-catalog-rename-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveRename();
            }}
          >
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-bold text-zinc-300">
              {m.renameLabel}
              <input
                autoFocus
                maxLength={80}
                value={renaming}
                onChange={(event) => setRenaming(event.target.value)}
                className="min-h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 focus:border-blue-400 focus:outline-none"
              />
              <span className="font-normal text-zinc-500">{m.renameHelp}</span>
            </label>
            <AdminWriteButton size="sm" type="submit" disabled={renameBusy || !renameValue}>
              {renameBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              {m.renameSave}
            </AdminWriteButton>
            <button type="button" onClick={() => setRenaming(null)} className="min-h-8 px-2 text-xs font-bold text-zinc-400 hover:text-zinc-100">
              {m.renameCancel}
            </button>
          </form>
        ) : null}
      </div>
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <ImageFlowStepper m={m} stage={drafting ? "needs_draft" : stage} />
      </div>

      {drafting ? (
        <AdminTile title={m.draftingTitle} description={m.draftingBody} action={<Loader2 className="h-5 w-5 animate-spin text-blue-300" aria-hidden />}>
          <p className="text-sm font-bold text-zinc-200" role="status">
            {m.draftingElapsed(drafting)}
          </p>
          <p className="text-xs text-zinc-400">{m.draftingNote}</p>
        </AdminTile>
      ) : draft ? (
        <>
          <div className="rounded-2xl border border-blue-500/30 bg-blue-500/10 p-4 text-sm">
            <p className="font-bold text-blue-300">{m.draftReadyTitle}</p>
            <p className="mt-1 text-zinc-300">{m.draftReadyBody}</p>
          </div>
          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <AdminTile
              title={m.priceTableTitle}
              description={m.priceTableNote(draft.prices.length)}
              action={
                editedCount > 0 ? (
                  <button type="button" onClick={onResetEdits} className="text-xs font-bold text-zinc-400 underline hover:text-zinc-100">
                    {m.resetEdits}
                  </button>
                ) : undefined
              }
            >
              <ImagePriceTable m={m} prices={draft.prices} floors={item.draftReview?.floors ?? []} edits={edits} editable onEdit={onEdit} />
            </AdminTile>
            <div className="flex min-w-0 flex-col gap-4">
              <SourceBox
                m={m}
                verification={draft.verification}
                pricingVersion={draft.pricingVersion}
                reasons={draftReasons}
                edited={editedCount}
                fromDraft
              />
              <AdminTile title={m.applyTitle}>
                <ul className="flex flex-col gap-1.5 text-sm text-zinc-300">
                  <li>{m.applyEffectVersion}</li>
                  <li>{serving ? m.applyEffectServing : m.applyEffectStillOff}</li>
                  {blockingReasons.length === 0 && problemCount === 0 ? <li className="text-emerald-300">{m.applyJudgeOk}</li> : null}
                </ul>
                {blockingReasons.length > 0 ? (
                  <div className="rounded-xl bg-red-500/10 p-3 text-xs text-red-300" data-testid="model-catalog-draft-reasons">
                    <p className="font-bold">{m.applyJudgeRefused}</p>
                    <ul className="mt-1 list-disc pl-4">
                      {blockingReasons.map((reason) => (
                        <li key={reason}>{reasonText(m, reasonMessage(reason))}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {blockingReasons.length > 0 ? (
                  <>
                    {measureButton(blockingReasons)}
                    <AdminWriteButton variant={onMeasure && suggestsMeasurement(item.provider, blockingReasons) ? "secondary" : undefined} onClick={() => onAction("redraft")}>
                      {m.redraft}
                    </AdminWriteButton>
                    <p className="text-center text-xs text-zinc-400">{m.applyRefusedBlocked}</p>
                  </>
                ) : (
                  <>
                    <AdminWriteButton disabled={problemCount > 0} onClick={onApply} data-testid="model-catalog-apply">
                      {m.applyButton}
                    </AdminWriteButton>
                    <p className={`text-center text-xs ${problemCount > 0 ? "text-red-300" : "text-zinc-500"}`}>
                      {problemCount > 0 ? m.applyBlocked(problemCount) : serving ? null : m.nextEnable}
                    </p>
                  </>
                )}
              </AdminTile>
            </div>
          </div>
        </>
      ) : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <AdminTile title={m.currentPricesTitle} description={item.served ? m.currentPricesNote : undefined}>
            {item.served && item.served.prices.length > 0 ? (
              <ImagePriceTable m={m} prices={item.served.prices} floors={item.served.floors} />
            ) : (
              <p className="text-sm text-zinc-400">{m.noPrice}</p>
            )}
          </AdminTile>
          <div className="flex min-w-0 flex-col gap-4">
            {item.served && item.served.prices.length > 0 ? (
              <SourceBox
                m={m}
                verification={item.served.priceVerification}
                pricingVersion={item.served.pricingVersion}
                reasons={item.served.admissionIfEnabled.reasons ?? []}
                edited={0}
                fromDraft={false}
              />
            ) : null}
            <AdminTile title={m.stageChip[stage]}>
              <p className="text-sm text-zinc-300">{m.stage[stage]}</p>
              {stage === "blocked" && item.served?.admissionIfEnabled.reasons?.length ? (
                <ul className="list-disc pl-4 text-xs text-red-300">
                  {item.served.admissionIfEnabled.reasons.map((reason) => (
                    <li key={reason}>{reasonText(m, reasonMessage(reason))}</li>
                  ))}
                </ul>
              ) : null}
              {stage === "blocked" ? measureButton(item.served?.admissionIfEnabled.reasons ?? []) : null}
              {nextAction === "none" ? null : nextAction === "view" ? (
                <AdminWriteButton variant="secondary" onClick={() => onAction("redraft")}>
                  {m.redraft}
                </AdminWriteButton>
              ) : (
                <AdminWriteButton onClick={() => onAction(nextAction)}>{m.nextAction[nextAction]}</AdminWriteButton>
              )}
            </AdminTile>
          </div>
        </div>
      )}

      <AdminTechInfo summary={m.techSummary}>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(item.raw, null, 2)}</pre>
      </AdminTechInfo>
    </div>
  );
}

export type ImageModelFormValue = {
  provider: string;
  apiModelId: string;
  name: string;
  sizes: string[];
  qualities: string[];
  sources: string;
};

const field =
  "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500";
const help = "mt-1 block text-xs font-normal text-zinc-500";

export function ChoiceChips({
  values,
  selected,
  label,
  onToggle,
}: {
  values: readonly string[];
  selected: readonly string[];
  label: (value: string) => string;
  onToggle: (value: string) => void;
}) {
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {values.map((value) => {
        const on = selected.includes(value);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(value)}
            className={`min-h-9 rounded-xl border px-3 text-xs font-bold ${
              on ? "border-blue-500 bg-blue-500/15 text-zinc-100" : "border-zinc-700 bg-zinc-950 text-zinc-400"
            }`}
          >
            {label(value)}
          </button>
        );
      })}
    </div>
  );
}

/** The add / fix form: no JSON, the profile is built from these answers. */
export function ImageModelForm({
  m,
  value,
  onChange,
  mode,
  providers,
  sizes,
  qualities,
}: {
  m: CatalogMessages;
  value: ImageModelFormValue;
  onChange: (value: ImageModelFormValue) => void;
  mode: "add" | "fix";
  providers: readonly { provider: string; defaultSources: readonly string[]; hosts: readonly string[] }[];
  sizes: readonly string[];
  qualities: readonly string[];
}) {
  const current = providers.find((entry) => entry.provider === value.provider);
  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item]);
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="model-catalog-image-form">
      <div>
        <span className="text-xs font-bold text-zinc-300">{m.providerLabel}</span>
        <ChoiceChips
          values={providers.map((entry) => entry.provider)}
          selected={[value.provider]}
          label={(provider) => provider}
          onToggle={(provider) => onChange({ ...value, provider })}
        />
      </div>
      <label className="text-xs font-bold text-zinc-300">
        {m.apiModelIdLabel}
        <input
          className={`${field} font-mono`}
          value={value.apiModelId}
          onChange={(event) => onChange({ ...value, apiModelId: event.target.value })}
        />
        <span className={help}>{m.apiModelIdHelp}</span>
      </label>
      <label className="text-xs font-bold text-zinc-300">
        {m.nameLabel}
        <input className={field} maxLength={80} value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} />
        <span className={help}>{m.nameHelp}</span>
      </label>
      <div>
        <span className="text-xs font-bold text-zinc-300">{m.sizesLabel}</span>
        <ChoiceChips
          values={sizes}
          selected={value.sizes}
          label={(size) => `${m.size[size] ?? size} ${size.replace("x", "×")}`}
          onToggle={(size) => onChange({ ...value, sizes: toggle(value.sizes, size) })}
        />
      </div>
      <div>
        <span className="text-xs font-bold text-zinc-300">{m.qualitiesLabel}</span>
        <ChoiceChips
          values={qualities}
          selected={value.qualities}
          label={(quality) => m.quality[quality] ?? quality}
          onToggle={(quality) => onChange({ ...value, qualities: toggle(value.qualities, quality) })}
        />
      </div>
      {mode === "add" ? (
        <label className="text-xs font-bold text-zinc-300">
          {m.sourceLabel}
          <textarea
            className={`${field} font-mono`}
            rows={2}
            placeholder={m.sourcePlaceholder}
            value={value.sources}
            onChange={(event) => onChange({ ...value, sources: event.target.value })}
          />
          <span className={help}>
            {current?.defaultSources.length ? current.defaultSources.map((url) => m.sourceDefault(url)).join(" · ") : m.sourceNoDefault}
          </span>
          {current?.hosts.length ? <span className={help}>{m.sourceHosts(current.hosts.join(", "))}</span> : null}
        </label>
      ) : null}
      {mode === "add" ? <p className="text-xs text-zinc-500">{m.addFootnote}</p> : null}
    </div>
  );
}

export type CatalogToastValue = {
  tone: "progress" | "ok" | "refused";
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void } | null;
};

/** The bottom notice: fixed to the viewport so it is seen wherever the button was. */
export function CatalogToast({ m, toast, onClose }: { m: CatalogMessages; toast: CatalogToastValue; onClose: () => void }) {
  const tone =
    toast.tone === "progress"
      ? "border-zinc-600 text-zinc-200"
      : toast.tone === "refused"
        ? "border-amber-500/40 text-amber-300"
        : "border-emerald-500/40 text-emerald-300";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="model-catalog-toast"
      data-tone={toast.tone}
      className={`fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,40rem)] -translate-x-1/2 items-start gap-3 rounded-2xl border bg-zinc-900 px-4 py-3 text-sm shadow-xl ${tone}`}
    >
      {toast.tone === "progress" ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden /> : null}
      <div className="min-w-0 flex-1 break-words">
        <p className="font-bold">{toast.title}</p>
        {toast.body ? <p className="mt-0.5 text-xs text-zinc-400">{toast.body}</p> : null}
      </div>
      {toast.action ? (
        <button
          type="button"
          onClick={toast.action.onClick}
          className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
        >
          {toast.action.label}
        </button>
      ) : null}
      {toast.tone === "progress" ? null : (
        <button type="button" className="shrink-0 text-xs text-zinc-400 underline" onClick={onClose}>
          {m.dismiss}
        </button>
      )}
    </div>
  );
}
