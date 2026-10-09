"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { adminFetch } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { AmuxOutcomeObservationForm } from "./AmuxOutcomeObservationForm";
import {
  AMUX_EXECUTION_VISIBLE_LANES,
  amuxVisibleInspectionText,
  amuxVisibleUntrustedText,
  type AmuxExecutionLane,
} from "@/lib/amux/adminExecutionViewCore";
import type { AmuxTaskFeedbackProjection } from "@/lib/amux/v22TaskFeedbackCore";

type Card = {
  id: string; title: string | null; sourceKey: string | null;
  status: string; priority: string; kind: string;
  cardType: string | null; storyKind: string | null;
  parentFeatureNodeId: string | null; parentStoryCardId: string | null;
  taskRole: string | null; executionGrade: string | null;
  worker: string | null; lane: string | null; sev1: boolean;
  score: number | null; scoreFresh: boolean; dependencyCount: number;
  progress: { done: number; total: number } | null; briefPresent: boolean;
  updatedAt: string;
};
type BoardSnapshot = { pageSize: number;
  counts: Record<AmuxExecutionLane, number>;
  lanes: Array<{ lane: AmuxExecutionLane; cards: Card[] }> };
type ActivationSnapshot = { asOf: string; activationAuthorized: false;
  stages: Array<{ id: string; status: "closed" | "unverified" |
    "owner_evidence_required"; gates: Array<{ id: string;
      codeLatch: boolean | null; environmentEnabled: boolean | null }> }> };
type HierarchyItem = ({ type: "node"; id: string; title: string | null;
  level: string; parentId: string | null; state: string;
  assessment: unknown; progress: { done: number; total: number } } |
  { type: "card" } & Card);
type HierarchyPage = { page: number; pageSize: number; total: number;
  items: HierarchyItem[] };
type FeedbackRollup = { complete: boolean; reason: string | null;
  rollup: { taskCount: number; doneCount: number; attemptCount: number;
    executionMs: number | null; cycleMs: number | null;
    estimatedCostMicrousd: string | null;
    approvedCeilingMicrousd: string | null;
    settledCostMicrousd: string | null; incompleteUsageCount: number;
    checkFindings: number | null; independentReviewFindings: number | null;
    subjectiveOutcomeMissingCount: number } | null };
type Detail = Card & { revision: number; body: string | null;
  brief: string | null;
  feedback: AmuxTaskFeedbackProjection | null;
  outcomeWriteEnabled: boolean;
  result: { attemptId: string; state: "available" | "purged";
    createdAt: string; text: string | null; sha256: string | null;
    patch: { state: "available"; baseSha: string; sha256: string } |
      { state: "purged" } | null } | null;
  dependencies: Array<{ id: string; sourceKey: string | null; status: string }>;
  dependents: Array<{ id: string; sourceKey: string | null; status: string }>;
  attempts: Array<{ id: string; worker: string; attemptNumber: number | null;
    startedAt: string; endedAt: string | null; outcome: string | null;
    toStatus: string | null; reason: string | null;
    reservedCostMicrousd: string; settledCostMicrousd: string | null;
    costConfirmed: boolean }>;
  escalations: Array<{ id: string; reason: string; status: string;
    createdAt: string }>;
  score: { scoreTotal: number; components: unknown; activeFresh: boolean;
    evidenceAsOf: string; activeStaleAt: string;
    baselineStaleAt: string } | null;
  usage: Array<{ id: string; attemptId: string | null; provider: string;
    actualModelId: string | null; selectedModelId: string; status: string;
    completeness: string; inputTokens: string | null;
    outputTokens: string | null; projectedApiCostMicrousd: string | null;
    actualApiCostMicrousd: string | null; startedAt: string }>;
  reviews: Array<{ escalationId: string; taskRevision: number;
    outcome: string; reviewPrNumber: number | null;
    reviewBaseSha: string | null; reviewHeadSha: string | null;
    reviewDiffDigest: string | null; currentRevision: boolean;
    issuedAt: string }>;
  publications: Array<{ id: string; baseSha: string; status: string;
    outcome: string | null; startedAt: string; bindings: Array<{
      id: string; prNumber: number; headSha: string;
      verifiedHeadSha: string; state: string;
      supersededAt: string | null; createdAt: string }> }> };
type Parent = { kind: "root" } | { kind: "unassigned" } |
  { kind: "node" | "story"; id: string };
const keyOf = (parent: Parent) => parent.kind === "root" || parent.kind === "unassigned" ?
  parent.kind :
  `${parent.kind}:${parent.id}`;
const date = (value: string) => new Date(value).toLocaleString();
const USD = (micro: string | null) => micro === null ? null :
  (Number(micro) / 1_000_000).toFixed(4);
const assessmentValue = (value: unknown) => value && typeof value === "object" &&
  !Array.isArray(value) && "value" in value && typeof value.value === "number" ?
  value.value : null;
function cardBody(raw: string | null): { problem: string; scopeIn: string[];
  scopeOut: string[]; completionCriteria: string[] } | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const body = value as Record<string, unknown>;
    if (typeof body.problem !== "string" ||
        !["scopeIn", "scopeOut", "completionCriteria"].every((key) =>
          Array.isArray(body[key]) && (body[key] as unknown[]).every((item) =>
            typeof item === "string"))) return null;
    return { problem: body.problem,
      scopeIn: body.scopeIn as string[], scopeOut: body.scopeOut as string[],
      completionCriteria: body.completionCriteria as string[] };
  } catch { return null; }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await adminFetch(url, { cache: "no-store" });
  if (response.status === 428) throw new Error("reauth");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export function AmuxExecutionWorkspace() {
  const m = useAdminMessages(adminAmuxExecutionMessages);
  const [view, setView] = useState<"board" | "hierarchy">("board");
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [activation, setActivation] = useState<ActivationSnapshot | null>(null);
  const [boardPages, setBoardPages] = useState<Partial<Record<AmuxExecutionLane, number>>>({});
  const [boardBusy, setBoardBusy] = useState<AmuxExecutionLane | null>(null);
  const [archive, setArchive] = useState<Card[]>([]);
  const [tree, setTree] = useState<Record<string, HierarchyPage>>({});
  const [feedbackByParent, setFeedbackByParent] = useState<Record<string, FeedbackRollup>>({});
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ root: true });
  const [treeBusy, setTreeBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const showError = useCallback((reason: unknown) =>
    setError(reason instanceof Error && reason.message === "reauth" ?
      "reauth" : "unavailable"), []);

  useEffect(() => {
    let cancelled = false;
    void getJson<BoardSnapshot>("/api/admin/amux/execution-view?view=board_snapshot")
      .then((result) => { if (!cancelled) setBoard(result); })
      .catch((reason) => { if (!cancelled) showError(reason); });
    return () => { cancelled = true; };
  }, [showError]);
  useEffect(() => {
    let cancelled = false;
    void getJson<ActivationSnapshot>("/api/admin/amux/execution-view?view=activation")
      .then((result) => { if (!cancelled) setActivation(result); })
      .catch((reason) => { if (!cancelled) showError(reason); });
    return () => { cancelled = true; };
  }, [showError]);

  const loadHierarchy = useCallback(async (parent: Parent, page = 0) => {
    const key = keyOf(parent);
    setTreeBusy(key); setError(null);
    const params = new URLSearchParams({ view: "hierarchy", parentKind: parent.kind,
      page: String(page) });
    if (parent.kind === "node" || parent.kind === "story")
      params.set("parentId", parent.id);
    try {
      const result = await getJson<HierarchyPage>(
        `/api/admin/amux/execution-view?${params}`);
      setTree((current) => ({ ...current, [key]: page === 0 ? result : {
        ...result, items: [...(current[key]?.items ?? []), ...result.items],
      } }));
    } catch (reason) { showError(reason); }
    finally { setTreeBusy(null); }
  }, [showError]);

  const openHierarchy = () => {
    setView("hierarchy");
    if (!tree.root) void loadHierarchy({ kind: "root" });
  };
  const loadFeedback = async (parent: { kind: "node" | "story"; id: string }) => {
    const key = keyOf(parent);
    setFeedbackBusy(key); setError(null);
    try {
      const params = new URLSearchParams({ view: "feedback",
        parentKind: parent.kind, parentId: parent.id });
      const result = await getJson<FeedbackRollup>(
        `/api/admin/amux/execution-view?${params}`);
      setFeedbackByParent((current) => ({ ...current, [key]: result }));
    } catch (reason) { showError(reason); }
    finally { setFeedbackBusy(null); }
  };
  const toggle = (parent: Parent) => {
    const key = keyOf(parent);
    const next = !expanded[key];
    setExpanded((current) => ({ ...current, [key]: next }));
    if (next && !tree[key]) void loadHierarchy(parent);
  };
  const loadBoardPage = async (lane: AmuxExecutionLane) => {
    if (boardBusy) return;
    const next = lane === "archive" && boardPages.archive === undefined ? 0 :
      (boardPages[lane] ?? 0) + 1;
    setBoardBusy(lane); setError(null);
    try {
      const result = await getJson<{ cards: Card[]; counts: BoardSnapshot["counts"] }>(
        `/api/admin/amux/execution-view?view=board&lane=${lane}&page=${next}`);
      setBoardPages((current) => ({ ...current, [lane]: next }));
      if (lane === "archive") setArchive((current) => [...current, ...result.cards]);
      else setBoard((current) => current ? { ...current, counts: result.counts,
        lanes: current.lanes.map((column) => column.lane === lane ?
          { ...column, cards: [...column.cards, ...result.cards] } : column) } : current);
    } catch (reason) { showError(reason); }
    finally { setBoardBusy(null); }
  };
  const openCard = async (id: string) => {
    const request = ++detailRequest.current;
    setDetailBusy(true); setSelected(null); setError(null);
    try {
      const result = await getJson<Detail>(
        `/api/admin/amux/execution-view?view=detail&taskId=${encodeURIComponent(id)}`);
      if (request === detailRequest.current) setSelected(result);
    } catch (reason) { if (request === detailRequest.current) showError(reason); }
    finally { if (request === detailRequest.current) setDetailBusy(false); }
  };

  const renderTree = (parent: Parent, depth: number): React.ReactNode => {
    const key = keyOf(parent);
    const page = tree[key];
    if (!expanded[key]) return null;
    return <ul className={depth > 0 ? "ml-4 border-l border-zinc-300 pl-3 dark:border-zinc-700" : ""}>
      {page?.items.map((item) => {
        const child: Parent = item.type === "node" ? { kind: "node", id: item.id } :
          { kind: "story", id: item.id };
        const canExpand = item.type === "node" || item.cardType === "story";
        return <li key={item.id} className="py-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {canExpand ? <button type="button" aria-expanded={Boolean(expanded[keyOf(child)])}
              aria-label={m.expand(amuxVisibleInspectionText(item.title ?? item.id))}
              onClick={() => toggle(child)} className="rounded border px-2 py-0.5">
              {expanded[keyOf(child)] ? "−" : "+"}
            </button> : <span className="w-7" aria-hidden="true" />}
            <span className="text-xs uppercase text-zinc-500">{item.type === "node" ?
              item.level : item.storyKind === "bug" ? "Bug" : item.cardType ?? "Task"}</span>
            {item.type === "card" ? <button type="button" className="text-left underline"
              onClick={() => void openCard(item.id)}>{amuxVisibleInspectionText(item.title ?? m.protectedTitle)}</button> :
              <span>{amuxVisibleInspectionText(item.title ?? m.protectedTitle)}</span>}
            {item.type === "card" && <span className="text-xs text-zinc-500">
              {item.status} · {item.taskRole ?? m.noRole} · {item.executionGrade ?? m.noGrade}
              {item.worker ? ` · ${item.worker}` : ""}
              {item.sev1 ? " · SEV1" : ""}
              {item.score !== null ? ` · ${m.score} ${item.score}${item.scoreFresh ? "" : ` (${m.stale})`}` : ""}
              {item.dependencyCount > 0 ? ` · ${m.dependencyCount(item.dependencyCount)}` : ""}
            </span>}
            {item.progress && item.progress.total > 0 && <span className="text-xs text-zinc-500">
              {m.progress(item.progress.done, item.progress.total)}
            </span>}
            {item.type === "node" && item.assessment !== null &&
              <span className="text-xs text-zinc-500">{m.assessed}
                {assessmentValue(item.assessment) !== null ?
                  ` · ${m.strategicValue} ${assessmentValue(item.assessment)}` : ""}
              </span>}
            {canExpand && <button type="button" className="text-xs underline"
              disabled={feedbackBusy !== null}
              onClick={() => void loadFeedback(child)}>{m.feedback}</button>}
          </div>
          {feedbackByParent[keyOf(child)] && <p className="ml-8 text-xs text-zinc-600 dark:text-zinc-300">
            {feedbackByParent[keyOf(child)].rollup ? (() => {
              const summary = feedbackByParent[keyOf(child)].rollup!;
              return `${m.progress(summary.doneCount, summary.taskCount)} · ${m.attempts} ${summary.attemptCount} · ` +
                `${m.approvedCeiling} ${summary.approvedCeilingMicrousd === null ? m.unknown : `$${USD(summary.approvedCeilingMicrousd)}`} · ` +
                `${m.internalCost} ${summary.settledCostMicrousd === null ? m.unknown : `$${USD(summary.settledCostMicrousd)}`} · ` +
                `${m.incompleteUsage} ${summary.incompleteUsageCount} · ` +
                `${m.checkFindings} ${summary.checkFindings ?? m.unknown} · ` +
                `${m.reviewFindings} ${summary.independentReviewFindings ?? m.unknown}`;
            })() : m.feedbackTooLarge}
          </p>}
          {canExpand && renderTree(child, depth + 1)}
        </li>;
      })}
      {treeBusy === key && <li className="text-sm">{m.loading}</li>}
      {page && page.items.length < page.total && <li className="py-2 text-sm">
        <button type="button" className="underline" disabled={treeBusy !== null}
          onClick={() => void loadHierarchy(parent, page.page + 1)}>
          {m.loadMore(page.items.length, page.total)}
        </button>
      </li>}
    </ul>;
  };

  const selectedBody = cardBody(selected?.body ?? null);
  return <section className="mx-auto w-full max-w-[1600px] space-y-5 p-4"
    data-testid="amux-execution-workspace">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{m.title}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">{m.description}</p></div>
      <div className="flex gap-2" role="group" aria-label={m.viewLabel}>
        <button type="button" aria-pressed={view === "board"}
          className="rounded border px-3 py-1 aria-pressed:bg-zinc-200 dark:aria-pressed:bg-zinc-700"
          onClick={() => setView("board")}>{m.board}</button>
        <button type="button" aria-pressed={view === "hierarchy"}
          className="rounded border px-3 py-1 aria-pressed:bg-zinc-200 dark:aria-pressed:bg-zinc-700"
          onClick={openHierarchy}>{m.hierarchy}</button>
      </div>
    </div>
    <p className="text-xs text-zinc-500">{m.globalAttention} <Link
      href="/admin/amux-execution?tab=halts" className="underline">{m.haltsLink}</Link></p>
    {activation && <details data-testid="amux-v22-activation-diagnostic"
      className="rounded border border-zinc-300 p-3 text-sm dark:border-zinc-700">
      <summary className="cursor-pointer font-semibold">{m.activationReadout}</summary>
      <p className="text-xs text-zinc-500">{m.activationCaveat}</p>
      <ul className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {activation.stages.map((stage) => <li key={stage.id} className="rounded border p-2">
          <strong>{stage.id}</strong> · {m.activationStatus[stage.status]}
          <ul className="text-xs text-zinc-500">{stage.gates.map((gate) =>
            <li key={gate.id}>{gate.id}: {gate.codeLatch === false ? m.codeClosed :
              gate.environmentEnabled === false ? m.environmentClosed : m.unknown}</li>)}</ul>
        </li>)}
      </ul>
    </details>}
    {error && <p role="alert" className="rounded border border-red-500 p-2 text-sm">
      {error === "reauth" ? <Link className="underline"
        href={adminRecentAuthenticationHref("/admin/amux-execution?tab=cards")}>{m.reauth}</Link> :
        m.unavailable}
    </p>}
    {view === "board" && <>
      {!board ? <p className="text-sm">{m.loading}</p> :
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {AMUX_EXECUTION_VISIBLE_LANES.map((lane) => {
            const column = board.lanes.find((item) => item.lane === lane);
            const cards = column?.cards ?? [];
            return <section key={lane} aria-label={m.lane[lane]}
              className="min-w-0 rounded-lg border border-zinc-300 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-900">
              <h3 className="mb-2 flex justify-between gap-1 text-sm font-semibold">
                <span>{m.lane[lane]}</span><span>{board.counts[lane]}</span>
              </h3>
              <ol className="space-y-2">{cards.map((card) =>
                <li key={card.id} className="rounded border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950">
                  <button type="button" className="w-full text-left font-medium underline"
                    onClick={() => void openCard(card.id)}>
                    {amuxVisibleInspectionText(card.title ?? m.protectedTitle)}
                  </button>
                  <p className="break-all font-mono text-xs text-zinc-500">{card.sourceKey ?? card.id}</p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-300">
                    {card.status} · {card.taskRole ?? card.cardType ?? card.kind}
                    {card.worker ? ` · ${card.worker}` : ""}
                    {card.sev1 ? " · SEV1" : ""}
                    {card.score !== null ? ` · ${m.score} ${card.score}${card.scoreFresh ? "" : ` (${m.stale})`}` : ""}
                  </p>
                </li>)}</ol>
              {cards.length === 0 && <p className="text-xs text-zinc-500">{m.empty}</p>}
              {cards.length < board.counts[lane] && <button type="button"
                disabled={boardBusy !== null} className="mt-2 text-xs underline"
                onClick={() => void loadBoardPage(lane)}>
                {m.loadMore(cards.length, board.counts[lane])}
              </button>}
            </section>;
          })}
        </div>}
      <details className="rounded border border-zinc-300 p-3 dark:border-zinc-700">
        <summary className="cursor-pointer text-sm font-semibold">{m.archive}
          {board ? ` (${board.counts.archive})` : ""}</summary>
        <ul className="mt-3 space-y-2 text-sm">{archive.map((card) => <li key={card.id}>
          <button type="button" className="underline" onClick={() => void openCard(card.id)}>
            {amuxVisibleInspectionText(card.title ?? m.protectedTitle)}</button> · {card.status}
        </li>)}</ul>
        {board && archive.length < board.counts.archive && <button type="button"
          disabled={boardBusy !== null} className="mt-2 text-sm underline"
          onClick={() => void loadBoardPage("archive")}>
          {m.loadMore(archive.length, board.counts.archive)}
        </button>}
      </details>
    </>}
    {view === "hierarchy" && <section className="rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h3 className="font-semibold">{m.hierarchy}</h3>
      <p className="text-xs text-zinc-500">{m.hierarchyHelp}</p>
      {renderTree({ kind: "root" }, 0)}
      <div className="mt-3 border-t border-zinc-300 pt-3 dark:border-zinc-700">
        <button type="button" aria-expanded={Boolean(expanded.unassigned)}
          className="text-sm font-semibold underline"
          onClick={() => toggle({ kind: "unassigned" })}>
          {m.unassignedHierarchy}</button>
        {renderTree({ kind: "unassigned" }, 1)}
      </div>
    </section>}
    {detailBusy && <p role="status" className="text-sm">{m.loadingDetail}</p>}
    {selected && <section id="amux-execution-detail" aria-label={m.detail}
      className="space-y-4 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700"
      data-testid="amux-execution-detail">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h3 className="text-lg font-semibold">{amuxVisibleInspectionText(selected.title ?? m.protectedTitle)}</h3>
          <p className="font-mono text-xs">{selected.sourceKey ?? selected.id} · r{selected.revision}</p>
          <p className="text-sm">{selected.status} · {selected.taskRole ?? m.noRole} ·
            {selected.executionGrade ?? m.noGrade} · {selected.worker ?? m.noWorker}</p></div>
        <button type="button" className="rounded border px-2 py-1 text-sm"
          onClick={() => { detailRequest.current += 1; setSelected(null); }}>{m.close}</button>
      </div>
      <p className="text-xs text-zinc-500">{m.readOnly}</p>
      {selected.feedback && <section aria-label={m.feedback}>
        <h4 className="font-semibold">{m.feedback}</h4>
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline">{m.estimatedCost}: </dt><dd className="inline">
            {selected.feedback.expected.estimatedCostMicrousd === null ? m.unknown :
              `$${USD(selected.feedback.expected.estimatedCostMicrousd)}`}</dd></div>
          <div><dt className="inline">{m.approvedCeiling}: </dt><dd className="inline">
            {selected.feedback.expected.approvedCeilingMicrousd === null ? m.unknown :
              `$${USD(selected.feedback.expected.approvedCeilingMicrousd)}`}</dd></div>
          <div><dt className="inline">{m.estimateRevision}: </dt><dd className="inline">
            {selected.feedback.observed.estimateRevision ?
              `${selected.feedback.observed.estimateRevision.revisedEffortPoints} · ` +
              `$${USD(selected.feedback.observed.estimateRevision.revisedCostMicrousd!)}` +
              ` · ${selected.feedback.observed.estimateRevision.reasonCode}` : m.unknown}</dd></div>
          <div><dt className="inline">{m.internalCost}: </dt><dd className="inline">
            {selected.feedback.observed.settledCostMicrousd === null ? m.unknown :
              `$${USD(selected.feedback.observed.settledCostMicrousd)}`}</dd></div>
          <div><dt className="inline">{m.attempts}: </dt><dd className="inline">
            {selected.feedback.observed.attemptCount}</dd></div>
          <div><dt className="inline">{m.executionTime}: </dt><dd className="inline">
            {selected.feedback.observed.executionMs === null ? m.unknown :
              m.minutes(selected.feedback.observed.executionMs)}</dd></div>
          <div><dt className="inline">{m.decisionTime}: </dt><dd className="inline">
            {selected.feedback.observed.cycleMs === null ? m.unknown :
              m.minutes(selected.feedback.observed.cycleMs)}</dd></div>
          <div><dt className="inline">{m.projected}: </dt><dd className="inline">
            {selected.feedback.observed.projectedApiCostMicrousd === null ? m.unknown :
              `$${USD(selected.feedback.observed.projectedApiCostMicrousd)}`}</dd></div>
          <div><dt className="inline">{m.usage}: </dt><dd className="inline">
            {selected.feedback.observed.usage ? m.tokens(
              selected.feedback.observed.usage.inputTokens,
              selected.feedback.observed.usage.outputTokens) : m.unknown}</dd></div>
        </dl>
        <p className="text-xs text-zinc-500">{m.feedbackCaveat}</p>
        <p className="text-xs text-zinc-500">{m.revisionCaveat}</p>
        {selected.feedback.ownerDecisions.length > 0 && <p className="text-sm">
          {m.ownerDecision}: {selected.feedback.ownerDecisions.map((decision) =>
            `${decision.outcome} (${date(decision.decidedAt)})`).join(" · ")}
        </p>}
        <p className="text-sm">{m.postDeployRegression}: {selected.feedback.observed.postDeployRegression?.outcome ?? m.unknown}</p>
        <p className="text-sm">{m.userOutcome}: {selected.feedback.observed.userOutcome?.outcome ?? m.unknown}</p>
        <p className="text-sm">{m.checkFindings}: {selected.feedback.observed.checks?.findingCount ?? m.unknown}</p>
        <p className="text-sm">{m.reviewFindings}: {selected.feedback.observed.independentReview?.findingCount ?? m.unknown}</p>
        {selected.outcomeWriteEnabled && <AmuxOutcomeObservationForm
          key={selected.id} taskId={selected.id} revision={selected.revision}
          writeEnabled={selected.outcomeWriteEnabled}
          onSaved={() => void openCard(selected.id)} />}
      </section>}
      {selected.body ? <div><h4 className="font-semibold">{m.criteria}</h4>
        {selectedBody ? <div className="space-y-2 text-sm">
          <p>{amuxVisibleInspectionText(selectedBody.problem)}</p>
          <p className="font-medium">{m.scopeIn}</p>
          <ul className="list-disc pl-5">{selectedBody.scopeIn.map((item, index) =>
            <li key={index}>{amuxVisibleInspectionText(item)}</li>)}</ul>
          <p className="font-medium">{m.scopeOut}</p>
          <ul className="list-disc pl-5">{selectedBody.scopeOut.map((item, index) =>
            <li key={index}>{amuxVisibleInspectionText(item)}</li>)}</ul>
          <p className="font-medium">{m.completionCriteria}</p>
          <ol className="list-decimal pl-5">{selectedBody.completionCriteria.map((item, index) =>
            <li key={index}>{amuxVisibleInspectionText(item)}</li>)}</ol>
        </div> : <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">
          {amuxVisibleInspectionText(selected.body)}</pre>}
      </div> : <p className="text-sm">{m.bodyUnavailable}</p>}
      {selected.brief && <div><h4 className="font-semibold">{m.brief}</h4>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{amuxVisibleInspectionText(selected.brief)}</pre></div>}
      <section><h4 className="font-semibold">{m.result}</h4>
        {selected.result?.state === "available" && selected.result.text ?
          <div className="space-y-1 text-sm">
            <p>{date(selected.result.createdAt)} · {selected.result.attemptId}</p>
            {selected.result.sha256 && <p className="break-all font-mono text-xs">
              SHA-256: {selected.result.sha256}</p>}
            <p className="text-xs text-zinc-500">{m.resultEncoding}</p>
            <pre dir="ltr" className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border p-2">
              {amuxVisibleUntrustedText(selected.result.text)}</pre>
            {selected.result.patch?.state === "available" && <p className="break-all font-mono text-xs">
              {m.patchEvidence}: {selected.result.patch.baseSha} · {selected.result.patch.sha256}
            </p>}
          </div> : <p className="text-sm">{m.resultUnavailable}</p>}
      </section>
      <div className="grid gap-3 md:grid-cols-2">
        <div><h4 className="font-semibold">{m.dependencies}</h4>
          <ul className="text-sm">{selected.dependencies.map((item) => <li key={item.id}>
            <button type="button" className="underline" onClick={() => void openCard(item.id)}>
              {item.sourceKey ?? item.id}</button> · {item.status}</li>)}</ul></div>
        <div><h4 className="font-semibold">{m.dependents}</h4>
          <ul className="text-sm">{selected.dependents.map((item) => <li key={item.id}>
            <button type="button" className="underline" onClick={() => void openCard(item.id)}>
              {item.sourceKey ?? item.id}</button> · {item.status}</li>)}</ul></div>
      </div>
      {selected.score && <div className="text-sm">
        <p>{m.score}: {selected.score.scoreTotal} ·
          {m.evidenceAsOf} {date(selected.score.evidenceAsOf)} ·
          {selected.score.activeFresh ? m.current : m.stale}</p>
        <details><summary className="cursor-pointer underline">{m.scoreBreakdown}</summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
            {amuxVisibleInspectionText(JSON.stringify(selected.score.components, null, 2))}</pre>
        </details>
      </div>}
      <section><h4 className="font-semibold">{m.attempts}</h4>
        <ol className="space-y-2 text-sm">{selected.attempts.map((item) => <li key={item.id}
          className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
          <span>{date(item.startedAt)} · {item.worker} · {item.outcome ?? m.running} →
            {item.toStatus ?? m.unknown}</span>
          <p>{m.internalCost}: {item.costConfirmed && item.settledCostMicrousd !== null ?
            `$${USD(item.settledCostMicrousd)}` : m.unconfirmed}</p>
          {item.reason && <p>{item.reason}</p>}
        </li>)}</ol></section>
      <section><h4 className="font-semibold">{m.usage}</h4>
        <ul className="space-y-1 text-sm">{selected.usage.map((item) => <li key={item.id}>
          {date(item.startedAt)} · {item.provider}/{item.actualModelId ?? item.selectedModelId} ·
          {item.status} · {m.tokens(item.inputTokens, item.outputTokens)} ·
          {item.projectedApiCostMicrousd !== null ?
            `${m.projected} $${USD(item.projectedApiCostMicrousd)}` : m.unknown}
        </li>)}</ul></section>
      <section><h4 className="font-semibold">{m.reviewEvidence}</h4>
        <ul className="space-y-2 text-sm">{selected.reviews.map((item, index) => <li key={`${item.escalationId}-${index}`}>
          {item.reviewPrNumber && item.reviewPrNumber > 0 ? <Link
            href={`https://github.com/mposition/Tomverse/pull/${item.reviewPrNumber}`}
            target="_blank" rel="noopener noreferrer" className="underline">
            PR #{item.reviewPrNumber}</Link> : m.noPr} ·
          {item.currentRevision ? m.currentRevision : m.staleRevision} ·
          {item.reviewBaseSha ?? m.unknown} → {item.reviewHeadSha ?? m.unknown}
        </li>)}</ul></section>
      <section><h4 className="font-semibold">{m.publications}</h4>
        <ul className="space-y-2 text-sm">{selected.publications.map((run) =>
          <li key={run.id} className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
            <p>{date(run.startedAt)} · {run.status} · {run.outcome ?? m.unknown}</p>
            <p className="break-all font-mono text-xs">base {run.baseSha}</p>
            {run.bindings.map((binding) => <p key={binding.id}>
              <Link href={`https://github.com/mposition/Tomverse/pull/${binding.prNumber}`}
                target="_blank" rel="noopener noreferrer" className="underline">
                PR #{binding.prNumber}</Link> · {binding.state} ·
              {binding.supersededAt ? m.superseded : m.currentBinding}
              <span className="block break-all font-mono text-xs">head {binding.headSha}</span>
            </p>)}
          </li>)}</ul>
        <p className="text-xs text-zinc-500">{m.deploymentNotProven}</p>
      </section>
      {selected.escalations.length > 0 && <section><h4 className="font-semibold">{m.attention}</h4>
        <ul className="text-sm">{selected.escalations.map((item) => <li key={item.id}>
          {item.reason} · {item.status} · {date(item.createdAt)}</li>)}</ul>
        <Link href={`/admin/amux-execution?tab=assignment&focusEscalation=${encodeURIComponent(selected.escalations[0].id)}`}
          className="text-sm underline">
          {m.openReview}</Link>
      </section>}
    </section>}
  </section>;
}
