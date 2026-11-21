"use client";

import { ArrowLeft, Check, ExternalLink, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ChoiceChips } from "@/components/admin/modelCatalog/ImageCatalogViews";
import { CodingSourceBadge, CodingStateChip, formatTokens, type CodingMessages } from "@/components/admin/modelCatalog/CodingListViews";
import { AdminProviderMark } from "@/components/admin/ui/AdminProviderMark";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminStepper } from "@/components/admin/ui/AdminStepper";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import type { AdminFlowStepState } from "@/lib/adminAmuxFlow";
import {
  CODING_CHANNEL_ORDER,
  CODING_PLANS,
  CODING_STRUCTURED_OUTPUT_VALUES,
  CODING_TOOL_CALLING_VALUES,
  type CodingCandidateView,
  type CodingCatalogItem,
  type CodingProviderRow,
  type CodingSettingsValue,
  codingRefusals,
  codingServing,
  codingSettingsFrom,
  codingSettingsProblems,
  codingSettingsRequest,
  codingStage,
  effectiveCreditWeight,
} from "@/lib/adminModelCatalogFlow";

// The coding tab's chat-link screens (Figma 02 and 03): the candidates a chat
// model can be linked from, and one link's detail -- what it inherits from
// chat (read-only), its own settings, its provider's conditions, the judge.

const money = (usd: number) => usd.toFixed(2);

const factRow = (label: string, value: React.ReactNode) => (
  <div className="flex items-center justify-between gap-3 py-0.5">
    <dt className="text-xs text-zinc-400">{label}</dt>
    <dd className="font-mono text-xs font-bold text-zinc-100">{value}</dd>
  </div>
);

function TermsLine({ c, provider, terms }: { c: CodingMessages; provider: string; terms: CodingCandidateView["terms"] }) {
  const tone = terms.state === "confirmed" ? "text-emerald-300" : "text-amber-300";
  const text =
    terms.state === "confirmed" && terms.checkedAt
      ? c.candidates.termsConfirmed(provider, terms.checkedAt)
      : terms.state === "expired"
        ? c.candidates.termsExpired(provider)
        : c.candidates.termsMissing(provider);
  return (
    <p className={`flex gap-1.5 text-xs font-bold ${tone}`} data-testid="coding-candidate-terms" data-state={terms.state}>
      <span aria-hidden>●</span>
      {text}
    </p>
  );
}

/** The chat models that can become coding links, each with one add button. */
export function CodingCandidates({
  c,
  candidates,
  excluded,
  adding,
  draftConfigured,
  onAdd,
  onBack,
}: {
  c: CodingMessages;
  candidates: readonly CodingCandidateView[];
  excluded: readonly { id: string; name: string; provider: string; reason: string }[];
  /** The candidate being drafted and how long it has taken, if any. */
  adding: { id: string; elapsed: string } | null;
  draftConfigured: boolean;
  onAdd: (candidate: CodingCandidateView) => void;
  onBack: () => void;
}) {
  const [showExcluded, setShowExcluded] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="coding-candidates">
      <div>
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-bold text-zinc-400 hover:text-zinc-100">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {c.candidates.back}
        </button>
      </div>
      <AdminTile
        title={
          <span className="flex items-center gap-2">
            {c.candidates.title}
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{candidates.length}</span>
          </span>
        }
        description={c.candidates.note}
      >
        {candidates.length === 0 ? <p className="text-sm text-zinc-400">{c.candidates.none}</p> : null}
        <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {candidates.map((candidate) => {
            const busy = adding?.id === candidate.id;
            return (
              <article
                key={candidate.id}
                data-testid="coding-candidate"
                data-model={candidate.id}
                className={`flex min-w-0 flex-col gap-3 rounded-2xl border bg-zinc-950/40 p-4 ${busy ? "border-blue-500" : "border-zinc-800"}`}
              >
                <header className="flex min-w-0 items-start gap-2">
                  <AdminProviderMark provider={candidate.provider} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-zinc-100">{candidate.name}</p>
                    <p className="truncate font-mono text-xs text-zinc-500">
                      {candidate.provider} · {candidate.apiModelId}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] font-bold text-zinc-300">{candidate.usageClass}</span>
                </header>
                <dl className="rounded-xl border border-zinc-800 p-3">
                  {factRow(
                    c.candidates.facts.limits,
                    `${candidate.contextWindowTokens === null ? "—" : formatTokens(candidate.contextWindowTokens)} / ${formatTokens(candidate.maxOutputTokens)}`
                  )}
                  {factRow(c.candidates.facts.price, `${money(candidate.price.inputUsdPerMTok)} / ${money(candidate.price.outputUsdPerMTok)}`)}
                  {factRow(c.candidates.facts.image, candidate.imageInput ? c.candidates.yes : c.candidates.no)}
                  {factRow(c.candidates.facts.weight, `×${candidate.creditWeight}`)}
                </dl>
                <p className="text-xs text-zinc-500">{c.candidates.inheritNote}</p>
                <TermsLine c={c} provider={candidate.provider} terms={candidate.terms} />
                {busy ? (
                  <div className="rounded-xl border border-blue-500/40 bg-blue-500/10 p-3 text-xs" role="status">
                    <p className="flex items-center gap-2 font-bold text-blue-300">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      {c.candidates.addingSteps(adding.elapsed)}
                    </p>
                  </div>
                ) : null}
                <AdminWriteButton
                  className="mt-auto"
                  disabled={!draftConfigured || adding !== null}
                  onClick={() => onAdd(candidate)}
                  data-testid="coding-candidate-add"
                >
                  {busy ? c.candidates.adding : c.candidates.add}
                </AdminWriteButton>
              </article>
            );
          })}
        </div>
        {excluded.length > 0 ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-zinc-800 p-4" data-testid="coding-candidates-excluded">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-bold text-zinc-100">
                {c.candidates.excludedTitle}{" "}
                <span className="ml-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{excluded.length}</span>
              </p>
              <button
                type="button"
                onClick={() => setShowExcluded(!showExcluded)}
                className="ml-auto text-xs font-bold text-zinc-300 underline"
                aria-expanded={showExcluded}
              >
                {showExcluded ? c.candidates.hide : c.candidates.show}
              </button>
            </div>
            <p className="text-xs text-zinc-400">{c.candidates.excludedNote}</p>
            {showExcluded ? (
              <ul className="grid gap-1 text-xs text-zinc-300 sm:grid-cols-2">
                {excluded.map((row) => (
                  <li key={row.id}>
                    <span className="font-bold">{row.name}</span> <span className="font-mono text-zinc-500">{row.id}</span> —{" "}
                    {c.candidates.excludedReason(row.reason)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </AdminTile>
      <p className="text-xs text-zinc-500">{c.candidates.footnote}</p>
    </div>
  );
}

const STEP_STATES: Record<ReturnType<typeof codingStage>, AdminFlowStepState[]> = {
  profile_invalid: ["attention", "todo", "todo", "todo"],
  needs_draft: ["done", "current", "todo", "todo"],
  draft_ready: ["done", "done", "current", "todo"],
  blocked: ["done", "done", "attention", "todo"],
  ready_to_enable: ["done", "done", "done", "current"],
  serving: ["done", "done", "done", "done"],
  held: ["done", "done", "done", "attention"],
};

const inputClass = (problem: boolean, edited: boolean) =>
  `rounded-lg border bg-zinc-950 px-2 py-1.5 text-sm font-bold text-zinc-100 outline-none focus:border-blue-500 ${
    problem ? "border-red-500" : edited ? "border-blue-500" : "border-zinc-700"
  }`;

function InheritedField({ c, label, value }: { c: CodingMessages; label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-bold text-zinc-400">{label}</p>
      <p className="mt-1 flex min-h-10 items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 font-mono text-sm text-zinc-300">
        <span className="min-w-0 truncate">{value}</span>
        <span className="shrink-0 text-[10px] font-bold text-zinc-500">{c.detail.inheritedChip}</span>
      </p>
    </div>
  );
}

function SettingRow({ title, code, children }: { title: string; code: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 border-t border-zinc-800 py-4 first:border-t-0 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <div>
        <p className="text-sm font-bold text-zinc-100">{title}</p>
        <p className="text-xs text-zinc-500">{code}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}

const LlmChip = ({ c, show }: { c: CodingMessages; show: boolean }) =>
  show ? <span className="rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-bold text-blue-300">{c.detail.llmDraft}</span> : null;

/** One chat link: what it inherits, its own settings, its provider's conditions and the judge. */
export function CodingLinkDetail({
  c,
  item,
  provider,
  value,
  busy,
  reasonText,
  toolCallingLabel,
  structuredOutputLabel,
  stepperLabel,
  stepStates,
  onBack,
  onChange,
  onReset,
  onSave,
  onActivate,
  onHold,
  onUnlink,
  onProviders,
}: {
  c: CodingMessages;
  item: CodingCatalogItem;
  provider: CodingProviderRow | null;
  /** The settings form, as edited. */
  value: CodingSettingsValue;
  busy: boolean;
  reasonText: (code: string) => string;
  toolCallingLabel: (value: string) => string;
  structuredOutputLabel: (value: string) => string;
  stepperLabel: string;
  stepStates: Record<AdminFlowStepState, string>;
  onBack: () => void;
  onChange: (value: CodingSettingsValue) => void;
  onReset: () => void;
  onSave: () => void;
  onActivate: () => void;
  onHold: () => void;
  onUnlink: () => void;
  onProviders: () => void;
}) {
  const link = item.link;
  const chat = item.chat;
  const stage = codingStage(item);
  const serving = codingServing(item);
  const stored = link ? codingSettingsFrom(link) : value;
  const problems = codingSettingsProblems(value, { floor: item.floor, chatWeight: chat?.creditWeight ?? null });
  const pending = link ? Object.keys(codingSettingsRequest(link, value)).length : 0;
  const weight = effectiveCreditWeight(value, chat?.creditWeight ?? null);
  const refusals = codingRefusals(item);
  const canActivate = !serving && stage === "ready_to_enable" && pending === 0;
  const steps = (["profile", "draft", "review", "enable"] as const).map((id, index) => ({
    id,
    label: c.detail.steps[id],
    state: STEP_STATES[stage][index],
    note: id === "draft" && link?.evidence ? `${c.detail.stepNotes.draft} ${link.evidence.draftedAt}` : c.detail.stepNotes[id],
  }));
  const terms = provider?.terms ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="coding-link-detail" data-stage={stage}>
      <div>
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-bold text-zinc-400 hover:text-zinc-100">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {c.detail.back}
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-bold text-zinc-100">{item.name}</h2>
          <CodingSourceBadge c={c} source="chat" />
          <CodingStateChip c={c} item={item} />
          <div className="ml-auto flex flex-wrap gap-2">
            <Link
              href="/admin/models?tab=registry"
              className="inline-flex min-h-9 items-center gap-1 rounded-xl border border-zinc-700 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
            >
              {c.detail.openChat}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </Link>
            {serving ? (
              <AdminWriteButton size="sm" variant="secondary" onClick={onHold} data-testid="coding-link-hold">
                {c.detail.hold}
              </AdminWriteButton>
            ) : item.enabled !== true ? (
              <AdminWriteButton size="sm" variant="secondary" onClick={onUnlink} data-testid="coding-link-unlink">
                {c.detail.unlink}
              </AdminWriteButton>
            ) : null}
          </div>
        </div>
        <p className="mt-1 break-all font-mono text-xs text-zinc-500">
          {item.provider} · {item.apiModelId}
        </p>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <AdminStepper
          label={stepperLabel}
          stateWords={stepStates}
          steps={steps.map((step) => ({ id: step.id, label: `${step.label} · ${step.note}`, state: step.state }))}
          data-testid="coding-link-stepper"
        />
      </div>

      {!serving ? (
        <div className="rounded-2xl border border-blue-500/40 bg-blue-500/10 p-4 text-sm">
          <p className="font-bold text-blue-300">{c.detail.reviewTitle}</p>
          <p className="mt-1 text-zinc-300">{c.detail.reviewBody(item.provider)}</p>
        </div>
      ) : null}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <AdminTile
            title={
              <span className="flex items-center gap-2">
                {c.detail.inheritedTitle}
                <span className="rounded-md bg-zinc-800 px-1.5 py-0.5 text-[11px] font-bold text-zinc-300">{c.detail.readOnly}</span>
              </span>
            }
            description={c.detail.inheritedNote}
            action={
              <Link href="/admin/models?tab=registry" className="text-xs font-bold text-blue-300 underline">
                {c.detail.editInChat}
              </Link>
            }
          >
            {chat ? (
              <div className="grid min-w-0 gap-3 sm:grid-cols-3" data-testid="coding-link-inherited">
                <InheritedField c={c} label={c.detail.fields.name} value={chat.name} />
                <InheritedField c={c} label={c.detail.fields.provider} value={chat.provider} />
                <InheritedField c={c} label={c.detail.fields.apiModelId} value={chat.apiModelId} />
                <InheritedField c={c} label={c.detail.fields.input} value={money(chat.price.inputUsdPerMTok)} />
                <InheritedField c={c} label={c.detail.fields.output} value={money(chat.price.outputUsdPerMTok)} />
                <InheritedField c={c} label={c.detail.fields.image} value={chat.imageInput ? c.candidates.yes : c.candidates.no} />
                <InheritedField
                  c={c}
                  label={c.detail.fields.context}
                  value={chat.contextWindowTokens === null ? "—" : chat.contextWindowTokens.toLocaleString("en-US")}
                />
                <InheritedField c={c} label={c.detail.fields.maxOutput} value={chat.maxOutputTokens.toLocaleString("en-US")} />
                <InheritedField c={c} label={c.detail.fields.chatPlan} value={chat.minimumPlan} />
              </div>
            ) : (
              <p className="text-sm text-red-300">{reasonText(item.problem ?? "chat_model_missing")}</p>
            )}
          </AdminTile>

          <AdminTile
            title={c.detail.settingsTitle}
            description={c.detail.settingsNote}
            action={
              pending > 0 ? (
                <button type="button" onClick={onReset} className="text-xs font-bold text-zinc-400 underline hover:text-zinc-100">
                  {c.detail.reset}
                </button>
              ) : undefined
            }
          >
            <div data-testid="coding-link-settings">
              <SettingRow title="Tool calling" code="toolCalling">
                <div className="flex flex-wrap items-center gap-2">
                  <ChoiceChips
                    values={CODING_TOOL_CALLING_VALUES}
                    selected={[value.toolCalling]}
                    label={toolCallingLabel}
                    onToggle={(toolCalling) => onChange({ ...value, toolCalling })}
                  />
                  <LlmChip c={c} show={link?.evidence?.toolCalling === value.toolCalling} />
                </div>
                <p className={`text-xs ${value.toolCalling === "none" ? "font-bold text-red-300" : "text-zinc-500"}`}>{c.detail.toolCallingHelp}</p>
              </SettingRow>
              <SettingRow title={c.list.columns.structuredOutput} code="structuredOutput">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="structuredOutput"
                    value={value.structuredOutput}
                    onChange={(event) => onChange({ ...value, structuredOutput: event.target.value })}
                    className={inputClass(false, value.structuredOutput !== stored.structuredOutput)}
                    data-testid="coding-link-structured"
                  >
                    {CODING_STRUCTURED_OUTPUT_VALUES.map((option) => (
                      <option key={option} value={option}>
                        {`${option} · ${structuredOutputLabel(option)}`}
                      </option>
                    ))}
                  </select>
                  <LlmChip c={c} show={link?.evidence?.structuredOutput === value.structuredOutput} />
                </div>
                <p className={`text-xs ${value.structuredOutput === "none" ? "font-bold text-red-300" : "text-zinc-500"}`}>
                  {c.detail.structuredOutputHelp}
                </p>
              </SettingRow>
              <SettingRow title={c.list.columns.plan} code="minimumPlan">
                <ChoiceChips
                  values={["", ...CODING_PLANS]}
                  selected={[value.minimumPlan]}
                  label={(plan) => (plan === "" ? c.detail.planFollowChat(chat?.minimumPlan ?? "—") : plan)}
                  onToggle={(minimumPlan) => onChange({ ...value, minimumPlan })}
                />
                <p className="text-xs text-zinc-500">{c.detail.planHelp}</p>
              </SettingRow>
              <SettingRow title={c.list.columns.weight} code="creditWeight">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    inputMode="numeric"
                    aria-label={c.list.columns.weight}
                    aria-invalid={problems.creditWeight ? true : undefined}
                    data-testid="coding-link-weight"
                    placeholder={chat ? c.detail.weightPlaceholder(chat.creditWeight) : ""}
                    value={value.creditWeight}
                    onChange={(event) => onChange({ ...value, creditWeight: event.target.value.trim() })}
                    className={`w-28 text-right font-mono ${inputClass(Boolean(problems.creditWeight), value.creditWeight !== stored.creditWeight)}`}
                  />
                  {problems.creditWeight === "not_a_number" ? (
                    <AdminStatusChip tone="bad">{c.detail.weightInvalid}</AdminStatusChip>
                  ) : item.floor !== null ? (
                    problems.creditWeight === "below_floor" ? (
                      <AdminStatusChip tone="bad">{c.detail.weightBelow(item.floor)}</AdminStatusChip>
                    ) : (
                      <AdminStatusChip tone="ok">{c.detail.weightFloorOk(item.floor)}</AdminStatusChip>
                    )
                  ) : null}
                  {weight !== null && value.creditWeight === "" ? <span className="font-mono text-xs text-zinc-400">×{weight}</span> : null}
                </div>
                <p className="text-xs text-zinc-500">{c.detail.weightHelp(chat?.creditWeight ?? null)}</p>
              </SettingRow>
              <SettingRow title={c.detail.channelsTitle} code="channels">
                <div className="flex flex-wrap gap-3">
                  {CODING_CHANNEL_ORDER.map((channel) => (
                    <label key={channel} className="inline-flex items-center gap-2 text-sm font-bold text-zinc-100">
                      <input
                        type="checkbox"
                        checked={value.channels.includes(channel)}
                        onChange={(event) =>
                          onChange({
                            ...value,
                            channels: event.target.checked ? [...value.channels, channel] : value.channels.filter((entry) => entry !== channel),
                          })
                        }
                        data-testid={`coding-link-channel-${channel}`}
                        className="h-4 w-4 accent-blue-600"
                      />
                      {c.channel[channel]}
                    </label>
                  ))}
                </div>
                <p className={`text-xs ${problems.channels ? "font-bold text-red-300" : "text-zinc-500"}`}>
                  {problems.channels ? c.detail.channelsNone : c.detail.channelsHelp}
                </p>
              </SettingRow>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
              <AdminWriteButton
                disabled={busy || pending === 0 || problems.channels !== undefined || problems.creditWeight === "not_a_number"}
                onClick={onSave}
                data-testid="coding-link-save"
              >
                {c.detail.save}
              </AdminWriteButton>
            </div>
          </AdminTile>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <AdminTile
            title={c.detail.termsTitle}
            action={
              provider ? (
                <AdminStatusChip tone={provider.state === "confirmed" ? "ok" : provider.state === "missing" ? "warn" : "bad"}>
                  {c.providers.state[provider.state]}
                </AdminStatusChip>
              ) : undefined
            }
          >
            <div className="flex flex-col gap-3 text-sm" data-testid="coding-link-terms">
              <div className="rounded-xl border border-zinc-800 p-3">
                <p className="flex items-center gap-2 font-bold text-zinc-100">
                  <AdminProviderMark provider={item.provider} size={20} />
                  {c.detail.termsFor(item.provider)}
                </p>
                <p className="mt-1 text-xs text-zinc-400">
                  {terms ? c.detail.termsApplies(terms.checkedAt, provider?.modelCount ?? 0) : c.detail.termsMissing}
                </p>
              </div>
              {terms ? (
                <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2">
                  <dt className="text-xs text-zinc-400">{c.detail.termsLabel}</dt>
                  <dd className="min-w-0">
                    <span className={`block text-xs font-bold ${terms.allowsResaleAndCodingAgent ? "text-emerald-300" : "text-red-300"}`}>
                      {terms.allowsResaleAndCodingAgent ? c.detail.termsAllows : c.detail.termsDenies}
                    </span>
                    <a href={terms.termsUrl} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-blue-300 underline">
                      {terms.termsUrl.replace(/^https:\/\//, "")}
                    </a>
                  </dd>
                  <dt className="text-xs text-zinc-400">{c.detail.retentionLabel}</dt>
                  <dd className="min-w-0">
                    <a href={terms.retentionUrl} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-blue-300 underline">
                      {terms.retentionUrl.replace(/^https:\/\//, "")}
                    </a>
                  </dd>
                  <dt className="text-xs text-zinc-400">{c.detail.regionLabel}</dt>
                  <dd className="text-xs font-bold text-zinc-100">{terms.processingRegion}</dd>
                </dl>
              ) : null}
              <button type="button" onClick={onProviders} className="self-start text-xs font-bold text-blue-300 underline">
                {c.detail.termsRecheck}
              </button>
            </div>
          </AdminTile>

          <AdminTile title={c.detail.sourcesTitle} action={<AdminStatusChip tone="ok">{c.detail.officialSources}</AdminStatusChip>}>
            {link?.evidence ? (
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="text-xs text-zinc-400">{c.detail.sourcesRead}</dt>
                <dd className="min-w-0">
                  {link.evidence.sources.length === 0 ? <span className="text-xs text-zinc-400">{c.detail.sourcesNone}</span> : null}
                  {link.evidence.sources.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" className="block break-all font-mono text-xs text-blue-300 underline">
                      {url.replace(/^https:\/\//, "")}
                    </a>
                  ))}
                </dd>
                <dt className="text-xs text-zinc-400">{c.detail.sourcesAt}</dt>
                <dd className="text-xs text-zinc-100">{link.evidence.draftedAt}</dd>
                {link.evidence.note ? (
                  <>
                    <dt className="text-xs text-zinc-400">{c.detail.llmDraft}</dt>
                    <dd className="text-xs text-zinc-300">{link.evidence.note}</dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <p className="text-xs text-zinc-400">{c.detail.sourcesNone}</p>
            )}
          </AdminTile>

          <AdminTile
            title={c.detail.verdictTitle}
            action={
              <AdminStatusChip tone={serving ? "ok" : refusals.length === 0 ? "ok" : "bad"}>
                {serving ? c.detail.verdictServing : refusals.length === 0 ? c.detail.verdictPass : c.detail.verdictFail}
              </AdminStatusChip>
            }
          >
            <div data-testid="coding-link-verdict" data-admitted={refusals.length === 0 ? "true" : "false"}>
              {refusals.length === 0 && item.profile ? (
                <ul className="flex flex-col gap-1 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-zinc-200">
                  {c.detail
                    .verdictPassItems(toolCallingLabel(item.profile.capabilities.toolCalling), item.profile.pricing.creditWeight, item.floor, item.provider)
                    .map((line) => (
                      <li key={line} className="flex gap-1.5">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden />
                        {line}
                      </li>
                    ))}
                </ul>
              ) : (
                <ul className="flex flex-col gap-1 rounded-xl bg-red-500/10 p-3 text-xs text-red-300" data-testid="coding-link-refusals">
                  {refusals.map((reason) => (
                    <li key={reason} className="flex gap-1.5">
                      <X className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      {reasonText(reason)}
                    </li>
                  ))}
                </ul>
              )}
              {item.warnings.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-1 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-300" data-testid="coding-link-warnings">
                  {item.warnings.map((warning) => (
                    <li key={warning}>
                      {c.detail.warning}: {reasonText(warning)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {!serving ? (
              <>
                <AdminWriteButton disabled={!canActivate || busy} onClick={onActivate} data-testid="coding-link-activate">
                  {c.detail.activate}
                </AdminWriteButton>
                <p className="text-center text-xs text-zinc-500">{pending > 0 ? c.detail.saveFirst : c.detail.activateNext}</p>
              </>
            ) : null}
          </AdminTile>
        </div>
      </div>

      <AdminTechInfo summary="stored · resolved">
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify({ stored: item.link, resolved: item.profile }, null, 2)}</pre>
      </AdminTechInfo>
    </div>
  );
}

/**
 * Where a dedicated row is offered: Code and the coding API (owner decision
 * 2026-11-21). The one setting such a row has on this screen; its profile
 * changes only through a new draft.
 */
export function CodingChannelsTile({
  c,
  item,
  busy,
  onSave,
}: {
  c: CodingMessages;
  item: CodingCatalogItem;
  busy: boolean;
  onSave: (channels: string[]) => void;
}) {
  const [channels, setChannels] = useState<string[]>(item.channels);
  const changed = CODING_CHANNEL_ORDER.filter((channel) => channels.includes(channel)).join(",") !== item.channels.join(",");
  return (
    <AdminTile title={c.detail.channelsTitle}>
      <div className="flex flex-wrap gap-3">
        {CODING_CHANNEL_ORDER.map((channel) => (
          <label key={channel} className="inline-flex items-center gap-2 text-sm font-bold text-zinc-100">
            <input
              type="checkbox"
              checked={channels.includes(channel)}
              onChange={(event) =>
                setChannels(event.target.checked ? [...channels, channel] : channels.filter((entry) => entry !== channel))
              }
              data-testid={`coding-dedicated-channel-${channel}`}
              className="h-4 w-4 accent-blue-600"
            />
            {c.channel[channel]}
          </label>
        ))}
      </div>
      <p className={`text-xs ${channels.length === 0 ? "font-bold text-red-300" : "text-zinc-500"}`}>
        {channels.length === 0 ? c.detail.channelsNone : c.detail.channelsHelp}
      </p>
      <AdminWriteButton
        disabled={busy || !changed || channels.length === 0}
        onClick={() => onSave(CODING_CHANNEL_ORDER.filter((channel) => channels.includes(channel)))}
        data-testid="coding-dedicated-channels-save"
      >
        {c.detail.save}
      </AdminWriteButton>
    </AdminTile>
  );
}
