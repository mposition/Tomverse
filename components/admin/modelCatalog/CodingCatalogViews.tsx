"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import {
  type CatalogMessages,
  ChoiceChips,
  ImageFlowStepper,
  reasonText,
  STAGE_TONE,
} from "@/components/admin/modelCatalog/ImageCatalogViews";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import {
  CODING_PLANS,
  type CodingCatalogItem,
  codingEdit,
  codingEditProblems,
  type CodingEditValue,
  codingNeedsAction,
  codingNextAction,
  type CodingProfileView,
  codingServing,
  type CodingStage,
  codingStage,
  type ImageNextAction,
  reasonMessage,
} from "@/lib/adminModelCatalogFlow";

// The coding catalogue's screens, laid out like the image ones
// (ImageCatalogViews): a list with one next step per waiting model, a detail
// view with the draft as a field table, and the add form. No JSON to type;
// the stored row stays readable under the technical details.

export function CodingStageChip({ m, stage }: { m: CatalogMessages; stage: CodingStage }) {
  return <AdminStatusChip tone={STAGE_TONE[stage]}>{m.codingFlow.stageChip[stage]}</AdminStatusChip>;
}

const subtitle = (item: CodingCatalogItem) => [item.id, item.provider].filter(Boolean).join(" · ");

/** The list: models waiting for the operator first, then serving and held ones. */
export function CodingCatalogList({
  m,
  items,
  onOpen,
  onAction,
  onHold,
}: {
  m: CatalogMessages;
  items: readonly CodingCatalogItem[];
  onOpen: (item: CodingCatalogItem) => void;
  onAction: (item: CodingCatalogItem, action: ImageNextAction) => void;
  onHold: (item: CodingCatalogItem) => void;
}) {
  const c = m.codingFlow;
  const staged = items.map((item) => ({ item, stage: codingStage(item) }));
  const pending = staged.filter((entry) => codingNeedsAction(entry.stage));
  const settled = staged.filter((entry) => !codingNeedsAction(entry.stage));
  const servingCount = settled.filter((entry) => entry.stage === "serving").length;
  const heldCount = settled.length - servingCount;

  const columns: AdminDataColumn<(typeof settled)[number]>[] = [
    {
      key: "model",
      header: m.model,
      render: ({ item }) => (
        <div className="min-w-0">
          <div className="font-bold text-zinc-100">{item.name}</div>
          <div className="truncate font-mono text-xs text-zinc-500">{subtitle(item)}</div>
        </div>
      ),
    },
    {
      key: "state",
      header: m.state,
      render: ({ item, stage }) => (
        <div className="flex flex-col items-start gap-1">
          <CodingStageChip m={m} stage={stage} />
          {item.holdReason ? <span className="text-xs text-zinc-400">{m.holdReasonLine(item.holdReason)}</span> : null}
        </div>
      ),
    },
    {
      key: "weight",
      header: c.fields.creditWeight,
      render: ({ item }) => <span className="font-mono text-xs">{item.profile?.pricing.creditWeight ?? "—"}</span>,
    },
    {
      key: "checked",
      header: m.verifiedAtLabel,
      render: ({ item }) => <span className="text-xs text-zinc-400">{item.profile?.pricing.verifiedAt ?? "—"}</span>,
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
            {c.viewProfile}
          </button>
          {stage === "serving" ? (
            <AdminWriteButton size="sm" variant="secondary" onClick={() => onHold(item)}>
              {m.holdAction}
            </AdminWriteButton>
          ) : item.admission?.admitted ? (
            <AdminWriteButton size="sm" variant="secondary" onClick={() => onAction(item, "enable")}>
              {m.enable}
            </AdminWriteButton>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {pending.length > 0 ? (
        <section className="flex flex-col gap-3" data-testid="model-catalog-coding-pending-list">
          <div>
            <h3 className="text-sm font-bold text-zinc-100">
              {m.pendingTitle} <span className="ml-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{pending.length}</span>
            </h3>
            <p className="mt-0.5 text-xs text-zinc-400">{m.pendingNote}</p>
          </div>
          {pending.map(({ item, stage }) => {
            const action = codingNextAction(stage);
            const serving = codingServing(item);
            return (
              <div
                key={item.id}
                data-testid="model-catalog-pending-coding"
                data-stage={stage}
                className="flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-zinc-950/40 p-4 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-bold text-zinc-100">{item.name}</span>
                    <span className="truncate font-mono text-xs text-zinc-500">{subtitle(item)}</span>
                  </div>
                  <ImageFlowStepper m={m} stage={stage} labels={c.steps} />
                  <p className="text-xs font-bold text-amber-300">{c.stage[stage]}</p>
                  {serving ? (
                    <div>
                      <CodingStageChip m={m} stage="serving" />
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {/* A serving model with a new draft can still be held from here. */}
                  {serving ? (
                    <AdminWriteButton variant="secondary" onClick={() => onHold(item)} data-testid="model-catalog-coding-hold">
                      {m.holdAction}
                    </AdminWriteButton>
                  ) : null}
                  {action === "review_prices" ? null : (
                    <button
                      type="button"
                      onClick={() => onOpen(item)}
                      className="min-h-10 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
                    >
                      {c.viewProfile}
                    </button>
                  )}
                  <AdminWriteButton onClick={() => (action === "review_prices" ? onOpen(item) : onAction(item, action))}>
                    {c.nextAction[action]}
                  </AdminWriteButton>
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
          emptyState={<p className="text-sm text-zinc-400">{c.noModels}</p>}
        />
      </section>
    </div>
  );
}

const inputClass = (problem: boolean, edited: boolean) =>
  `rounded-lg border bg-zinc-950 px-2 py-1.5 text-sm font-bold text-zinc-100 outline-none focus:border-blue-500 ${
    problem ? "border-red-500" : edited ? "border-blue-500" : "border-zinc-700"
  }`;

/** One profile as rows: the operator's three fields first (editable when `editable`), then what the docs say. */
export function CodingProfileTable({
  m,
  profile,
  floor,
  edits = {},
  editable = false,
  onEdit,
}: {
  m: CatalogMessages;
  profile: CodingProfileView;
  floor: number | null;
  edits?: Readonly<CodingEditValue>;
  editable?: boolean;
  onEdit?: (field: keyof CodingEditValue, value: string) => void;
}) {
  const c = m.codingFlow;
  const problems = editable ? codingEditProblems(profile, edits, floor) : {};
  const name = edits.name ?? profile.name;
  const plan = edits.minimumPlan ?? profile.minimumPlan;
  const weightText = edits.creditWeight ?? String(profile.pricing.creditWeight);
  const weight = Number(weightText);
  const weightVerdict =
    problems.creditWeight === "not_a_number" ? (
      <span className="font-bold text-red-300">{m.notANumber}</span>
    ) : problems.creditWeight === "below_floor" && floor !== null ? (
      <span className="font-bold text-red-300">{m.belowFloor(floor)}</span>
    ) : floor === null ? (
      <span className="text-zinc-500">{c.weightFloorUnknown}</span>
    ) : weight > floor ? (
      <span className="font-bold text-emerald-300">{m.floorPlus(weight - floor)}</span>
    ) : (
      <span className="text-zinc-400">{m.floorMet}</span>
    );

  const yours: { key: string; label: string; value: ReactNode; note?: ReactNode }[] = [
    {
      key: "name",
      label: c.fields.name,
      value: editable ? (
        <input
          aria-label={c.fields.name}
          aria-invalid={problems.name ? true : undefined}
          data-testid="model-catalog-coding-name"
          maxLength={80}
          value={name}
          onChange={(event) => onEdit?.("name", event.target.value)}
          className={`w-full max-w-xs ${inputClass(Boolean(problems.name), name !== profile.name)}`}
        />
      ) : (
        <span className="font-bold text-zinc-100">{profile.name}</span>
      ),
      note: problems.name ? <span className="font-bold text-red-300">{c.nameInvalid}</span> : null,
    },
    {
      key: "plan",
      label: c.fields.minimumPlan,
      value: editable ? (
        <ChoiceChips values={CODING_PLANS} selected={[plan]} label={(value) => c.plan[value] ?? value} onToggle={(value) => onEdit?.("minimumPlan", value)} />
      ) : (
        <span className="font-bold text-zinc-100">{c.plan[profile.minimumPlan] ?? profile.minimumPlan}</span>
      ),
    },
    {
      key: "weight",
      label: c.fields.creditWeight,
      value: editable ? (
        <span className="flex flex-wrap items-center gap-2">
          <input
            inputMode="numeric"
            aria-label={c.weightInputLabel}
            aria-invalid={problems.creditWeight ? true : undefined}
            data-testid="model-catalog-coding-weight"
            value={weightText}
            onChange={(event) => onEdit?.("creditWeight", event.target.value.trim())}
            className={`w-24 text-right font-mono ${inputClass(Boolean(problems.creditWeight), weight !== profile.pricing.creditWeight)}`}
          />
          {weight !== profile.pricing.creditWeight ? (
            <span className="rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-bold text-blue-300">{m.fromDraft(profile.pricing.creditWeight)}</span>
          ) : null}
        </span>
      ) : (
        <span className="font-mono font-bold text-zinc-100">{profile.pricing.creditWeight}</span>
      ),
      note: (
        <span className="flex flex-wrap gap-x-2 text-xs">
          <span className="text-zinc-400">{floor === null ? c.weightFloorUnknown : c.weightFloor(floor)}</span>
          {weightVerdict}
        </span>
      ),
    },
  ];
  const caps = profile.capabilities;
  const docs: { key: string; label: string; value: ReactNode }[] = [
    { key: "input", label: c.fields.inputPrice, value: `$${profile.pricing.inputUsdPerMTok}` },
    { key: "output", label: c.fields.outputPrice, value: `$${profile.pricing.outputUsdPerMTok}` },
    { key: "tools", label: c.fields.toolCalling, value: c.toolCalling[caps.toolCalling] ?? caps.toolCalling },
    { key: "structured", label: c.fields.structuredOutput, value: c.structuredOutput[caps.structuredOutput] ?? caps.structuredOutput },
    { key: "image", label: c.fields.imageInput, value: caps.imageInput ? c.yes : c.no },
    { key: "context", label: c.fields.maxContext, value: caps.maxContextTokens.toLocaleString("en-US") },
    { key: "maxOutput", label: c.fields.maxOutput, value: caps.maxOutputTokens.toLocaleString("en-US") },
    { key: "region", label: c.fields.region, value: profile.processingRegion },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="model-catalog-coding-profile">
      <section>
        <h4 className="text-xs font-bold text-blue-300">{c.yours}</h4>
        <dl className="mt-1 divide-y divide-zinc-800">
          {yours.map((row) => (
            <div key={row.key} className="grid gap-1 py-2 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:gap-3">
              <dt className="text-xs font-bold text-zinc-400">{row.label}</dt>
              <dd className="flex min-w-0 flex-col gap-1">
                {row.value}
                {row.note}
              </dd>
            </div>
          ))}
        </dl>
        {editable ? <p className="mt-1 text-xs text-zinc-500">{c.weightHelp}</p> : null}
      </section>
      <section>
        <h4 className="text-xs font-bold text-zinc-500">{c.fromDocs}</h4>
        <dl className="mt-1 divide-y divide-zinc-800">
          {docs.map((row) => (
            <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
              <dt className="text-xs font-bold text-zinc-400">{row.label}</dt>
              <dd className="text-right font-mono text-sm text-zinc-200 sm:text-left">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

const linkList = (urls: readonly string[]) =>
  urls.map((url) => (
    <a key={url} href={url} target="_blank" rel="noreferrer" className="block break-all font-mono text-xs text-blue-300 underline">
      {url.replace(/^https:\/\//, "")}
    </a>
  ));

/** Where the prices, terms and retention answers came from, and when they were checked. */
function CodingEvidenceBox({
  m,
  profile,
  reasons,
  edited,
  fromDraft,
}: {
  m: CatalogMessages;
  profile: CodingProfileView;
  reasons: readonly string[];
  edited: number;
  fromDraft: boolean;
}) {
  const c = m.codingFlow;
  const unofficial = reasons.some((reason) => /unofficial/.test(reason));
  return (
    <AdminTile
      title={c.evidenceTitle}
      description={c.evidenceNote}
      action={<AdminStatusChip tone={unofficial ? "bad" : "ok"}>{unofficial ? m.unofficialSourceChip : m.officialSource}</AdminStatusChip>}
    >
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm" data-testid="model-catalog-coding-evidence">
        <dt className="text-xs font-bold text-zinc-500">{c.priceSources}</dt>
        <dd className="min-w-0">
          {linkList(profile.pricing.sources)}
          <span className="text-xs text-zinc-400">{c.checkedOn(profile.pricing.verifiedAt)}</span>
        </dd>
        <dt className="text-xs font-bold text-zinc-500">{c.termsLabel}</dt>
        <dd className="min-w-0">
          {linkList([profile.terms.url])}
          <span className={`block text-xs font-bold ${profile.terms.allowsResaleAndCodingAgent ? "text-emerald-300" : "text-red-300"}`}>
            {profile.terms.allowsResaleAndCodingAgent ? c.termsAllows : c.termsDenies}
          </span>
          <span className="text-xs text-zinc-400">{c.checkedOn(profile.terms.checkedAt)}</span>
        </dd>
        <dt className="text-xs font-bold text-zinc-500">{c.retentionLabel}</dt>
        <dd className="min-w-0">
          {linkList([profile.retention.url])}
          <span className="text-xs text-zinc-400">{c.checkedOn(profile.retention.checkedAt)}</span>
        </dd>
        {fromDraft ? (
          <>
            <dt className="text-xs font-bold text-zinc-500">{m.authorLabel}</dt>
            <dd className="text-zinc-300">{c.authorDraft(edited)}</dd>
          </>
        ) : null}
      </dl>
    </AdminTile>
  );
}

const ReasonList = ({ m, reasons, testId }: { m: CatalogMessages; reasons: readonly string[]; testId?: string }) => (
  <ul className="list-disc pl-4 text-xs text-red-300" data-testid={testId}>
    {reasons.map((reason) => (
      <li key={reason}>{reasonText(m, reasonMessage(reason))}</li>
    ))}
  </ul>
);

/** One coding model: where it is in the flow, its profile, and the one thing to do next. */
export function CodingModelDetail({
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
}: {
  m: CatalogMessages;
  item: CodingCatalogItem;
  edits: Readonly<CodingEditValue>;
  drafting: string | null;
  onBack: () => void;
  onEdit: (field: keyof CodingEditValue, value: string) => void;
  onResetEdits: () => void;
  onApply: () => void;
  onAction: (action: ImageNextAction) => void;
  onHold: () => void;
}) {
  const c = m.codingFlow;
  const stage = codingStage(item);
  const draft = item.draft;
  const floor = item.draftReview?.floor ?? null;
  // The weight's floor is re-checked against the typed weight; every other
  // reason is about the docs and cannot be fixed on this screen.
  const blockingReasons = (item.draftReview?.reasons ?? []).filter((reason) => !reason.startsWith("credits_below_floor"));
  const problems = draft ? codingEditProblems(draft, edits, floor) : {};
  const problemCount = Object.keys(problems).length;
  const editedCount = draft ? Object.keys(codingEdit(draft, edits)).length : 0;
  const serving = codingServing(item);
  const nextAction = codingNextAction(stage);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="model-catalog-coding-detail" data-stage={stage}>
      <div>
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-bold text-zinc-400 hover:text-zinc-100">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {m.backToList}
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-bold text-zinc-100">{item.name}</h2>
          <CodingStageChip m={m} stage={stage} />
          {serving && stage !== "serving" ? <CodingStageChip m={m} stage="serving" /> : null}
          {serving ? (
            <AdminWriteButton size="sm" variant="secondary" className="ml-auto" onClick={onHold} data-testid="model-catalog-coding-hold">
              {m.holdAction}
            </AdminWriteButton>
          ) : null}
        </div>
        <p className="mt-1 break-all font-mono text-xs text-zinc-500">{subtitle(item)}</p>
      </div>
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <ImageFlowStepper m={m} stage={drafting ? "needs_draft" : stage} labels={c.steps} />
      </div>

      {drafting ? (
        <AdminTile title={c.draftingTitle} description={c.draftingBody} action={<Loader2 className="h-5 w-5 animate-spin text-blue-300" aria-hidden />}>
          <p className="text-sm font-bold text-zinc-200" role="status">
            {m.draftingElapsed(drafting)}
          </p>
          <p className="text-xs text-zinc-400">{m.draftingNote}</p>
        </AdminTile>
      ) : draft ? (
        <>
          <div className="rounded-2xl border border-blue-500/30 bg-blue-500/10 p-4 text-sm">
            <p className="font-bold text-blue-300">{c.draftReadyTitle}</p>
            <p className="mt-1 text-zinc-300">{c.draftReadyBody}</p>
          </div>
          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <AdminTile
              title={c.tableTitle}
              description={c.tableNote}
              action={
                editedCount > 0 ? (
                  <button type="button" onClick={onResetEdits} className="text-xs font-bold text-zinc-400 underline hover:text-zinc-100">
                    {m.resetEdits}
                  </button>
                ) : undefined
              }
            >
              <CodingProfileTable m={m} profile={draft} floor={floor} edits={edits} editable onEdit={onEdit} />
            </AdminTile>
            <div className="flex min-w-0 flex-col gap-4">
              <CodingEvidenceBox m={m} profile={draft} reasons={item.draftReview?.reasons ?? []} edited={editedCount} fromDraft />
              <AdminTile title={m.applyTitle}>
                <ul className="flex flex-col gap-1.5 text-sm text-zinc-300">
                  <li>{c.applyEffectProfile}</li>
                  <li>{serving ? c.applyEffectServing : c.applyEffectStillOff}</li>
                  {blockingReasons.length === 0 && problemCount === 0 ? <li className="text-emerald-300">{c.applyJudgeOk}</li> : null}
                </ul>
                {blockingReasons.length > 0 ? (
                  <div className="rounded-xl bg-red-500/10 p-3" data-testid="model-catalog-coding-draft-reasons">
                    <p className="text-xs font-bold text-red-300">{m.applyJudgeRefused}</p>
                    <ReasonList m={m} reasons={blockingReasons} />
                  </div>
                ) : null}
                {blockingReasons.length > 0 ? (
                  <>
                    <AdminWriteButton onClick={() => onAction("redraft")}>{m.redraft}</AdminWriteButton>
                    <p className="text-center text-xs text-zinc-400">{m.applyRefusedBlocked}</p>
                  </>
                ) : (
                  <>
                    <AdminWriteButton disabled={problemCount > 0} onClick={onApply} data-testid="model-catalog-coding-apply">
                      {c.applyButton}
                    </AdminWriteButton>
                    <p className={`text-center text-xs ${problemCount > 0 ? "text-red-300" : "text-zinc-500"}`}>
                      {problemCount > 0 ? c.applyBlocked : serving ? null : m.nextEnable}
                    </p>
                  </>
                )}
              </AdminTile>
            </div>
          </div>
        </>
      ) : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <AdminTile title={c.currentTitle} description={item.profile ? c.currentNote : undefined}>
            {item.profile ? <CodingProfileTable m={m} profile={item.profile} floor={item.floor} /> : <p className="text-sm text-zinc-400">{c.stage[stage]}</p>}
          </AdminTile>
          <div className="flex min-w-0 flex-col gap-4">
            {item.profile ? (
              <CodingEvidenceBox m={m} profile={item.profile} reasons={item.admission?.reasons ?? []} edited={0} fromDraft={false} />
            ) : null}
            <AdminTile title={c.stageChip[stage]}>
              <p className="text-sm text-zinc-300">{c.stage[stage]}</p>
              {stage === "blocked" && item.admission?.reasons?.length ? <ReasonList m={m} reasons={item.admission.reasons} /> : null}
              {nextAction === "view" ? (
                <AdminWriteButton variant="secondary" onClick={() => onAction("redraft")}>
                  {m.redraft}
                </AdminWriteButton>
              ) : (
                <AdminWriteButton onClick={() => onAction(nextAction)}>{c.nextAction[nextAction]}</AdminWriteButton>
              )}
            </AdminTile>
          </div>
        </div>
      )}

      <AdminTechInfo summary={c.techSummary}>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(item.raw, null, 2)}</pre>
      </AdminTechInfo>
    </div>
  );
}

export type CodingModelFormValue = {
  provider: string;
  apiModelId: string;
  priceUrl: string;
  termsUrl: string;
  retentionUrl: string;
};

const field =
  "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500";
const help = "mt-1 block text-xs font-normal text-zinc-500";

/**
 * The add form: provider, API model id and the three pages a draft reads.
 * The profile itself is the draft's answer, checked in the next step.
 */
export function CodingModelForm({
  m,
  value,
  onChange,
  providers,
}: {
  m: CatalogMessages;
  value: CodingModelFormValue;
  onChange: (value: CodingModelFormValue) => void;
  providers: readonly { provider: string; defaultSources: readonly string[]; hosts: readonly string[] }[];
}) {
  const c = m.codingFlow;
  const current = providers.find((entry) => entry.provider === value.provider);
  const url = (key: "priceUrl" | "termsUrl" | "retentionUrl", label: string, note: string, placeholder?: string) => (
    <label className="text-xs font-bold text-zinc-300">
      {label}
      <input
        type="url"
        className={`${field} font-mono`}
        placeholder={placeholder}
        value={value[key]}
        onChange={(event) => onChange({ ...value, [key]: event.target.value })}
        data-testid={`model-catalog-coding-${key}`}
      />
      <span className={help}>{note}</span>
    </label>
  );
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="model-catalog-coding-form">
      <div>
        <span className="text-xs font-bold text-zinc-300">{m.providerLabel}</span>
        <ChoiceChips
          values={providers.map((entry) => entry.provider)}
          selected={[value.provider]}
          label={(provider) => provider}
          onToggle={(provider) => onChange({ ...value, provider })}
        />
        {current?.hosts.length ? <span className={help}>{c.hosts(current.hosts.join(", "))}</span> : null}
      </div>
      <label className="text-xs font-bold text-zinc-300">
        {m.apiModelIdLabel}
        <input
          className={`${field} font-mono`}
          value={value.apiModelId}
          onChange={(event) => onChange({ ...value, apiModelId: event.target.value })}
          data-testid="model-catalog-coding-apiModelId"
        />
        <span className={help}>{c.apiModelIdHelp}</span>
      </label>
      {url(
        "priceUrl",
        c.priceUrlLabel,
        current?.defaultSources[0] ? c.priceUrlDefault(current.defaultSources[0]) : c.priceUrlNoDefault,
        current?.defaultSources[0]
      )}
      {url("termsUrl", c.termsUrlLabel, c.termsUrlHelp)}
      {url("retentionUrl", c.retentionUrlLabel, c.retentionUrlHelp)}
      <p className="text-xs text-zinc-500">{c.addFootnote}</p>
    </div>
  );
}
