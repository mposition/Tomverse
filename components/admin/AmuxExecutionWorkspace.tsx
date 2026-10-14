"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight, Copy, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { GripVertical, MoveRight } from "lucide-react";
import { AmuxExecutionMovePanel, type AmuxBoardMove } from "./AmuxExecutionMovePanel";
import { AmuxExecutionDialog } from "./AmuxExecutionDialog";
import { AmuxCardOwnerReview } from "./AdminAmuxRoutingPanel";
import { AmuxCardIdentity, AmuxSourceKeySuffix, amuxDistinctSourceKey } from "./AmuxCardIdentity";
import styles from "./AmuxExecutionWorkspace.module.css";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

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
  /** The newest open escalation's reason code; null when none is open. */
  attentionReason: string | null;
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
type Detail = Omit<Card, "score"> & { revision: number; body: string | null;
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

export function AmuxExecutionWorkspace({ initialTaskId = null, canMoveCards = false,
  canReviewCards = false }: {
  initialTaskId?: string | null; canMoveCards?: boolean;
  /** Whether a card waiting on the owner opens on its owner review. */
  canReviewCards?: boolean;
}) {
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
  const [moveTarget, setMoveTarget] = useState<AmuxBoardMove | null>(null);
  const dragCard = useRef<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const pointerDrag = useRef<{ taskId: string; pointerId: number; x: number; y: number;
    startX: number; startY: number; moved: boolean } | null>(null);
  const [pointerTask, setPointerTask] = useState<string | null>(null);
  const dragGhostRef = useRef<HTMLDivElement>(null);
  const moveRequests = useRef(new Map<string, string>());
  const settledMoveRequests = useRef(new Set<string>());
  const activeMoveTarget = useRef<AmuxBoardMove | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"ownerReview" | "overview" | "execution" | "review" | "activity">("overview");
  const [query, setQuery] = useState("");
  const [workerFilter, setWorkerFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [boardLoading, setBoardLoading] = useState(true);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const boardGeneration = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const showError = useCallback((reason: unknown) =>
    setError(reason instanceof Error && reason.message === "reauth" ?
      "reauth" : "unavailable"), []);

  const refreshBoard = useCallback(async () => {
    const generation = ++boardGeneration.current;
    setBoardLoading(true); setBoardBusy(null); setError(null);
    try {
      const result = await getJson<BoardSnapshot>("/api/admin/amux/execution-view?view=board_snapshot");
      if (generation === boardGeneration.current) {
        setBoard(result); setBoardPages({}); setArchive([]);
      }
    } catch (reason) { if (generation === boardGeneration.current) showError(reason); }
    finally { if (generation === boardGeneration.current) setBoardLoading(false); }
  }, [showError]);
  useEffect(() => {
    queueMicrotask(() => { void refreshBoard(); });
    return () => { boardGeneration.current += 1; };
  }, [refreshBoard]);
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
    if (boardBusy || boardLoading) return;
    const generation = boardGeneration.current;
    const next = lane === "archive" && boardPages.archive === undefined ? 0 :
      (boardPages[lane] ?? 0) + 1;
    setBoardBusy(lane); setError(null);
    try {
      const result = await getJson<{ cards: Card[]; counts: BoardSnapshot["counts"] }>(
        `/api/admin/amux/execution-view?view=board&lane=${lane}&page=${next}`);
      if (generation !== boardGeneration.current) return;
      setBoardPages((current) => ({ ...current, [lane]: next }));
      if (lane === "archive") setArchive((current) => [...current, ...result.cards]);
      else setBoard((current) => current ? { ...current, counts: result.counts,
        lanes: current.lanes.map((column) => column.lane === lane ?
          { ...column, cards: [...column.cards, ...result.cards] } : column) } : current);
    } catch (reason) { if (generation === boardGeneration.current) showError(reason); }
    finally { if (generation === boardGeneration.current) setBoardBusy(null); }
  };
  const closeCard = useCallback((updateHistory = true) => {
    detailRequest.current += 1;
    setDetailOpen(false); setSelected(null); setDetailBusy(false); setDetailError(null);
    if (!updateHistory) return;
    if (window.history.state?.amuxCardOverlay) window.history.back();
    else {
      const url = new URL(window.location.href); url.searchParams.delete("taskId");
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);
  const openCard = useCallback(async (id: string, updateHistory = true) => {
    const request = ++detailRequest.current;
    setDetailOpen(true); setDetailBusy(true); setSelected(null); setDetailError(null);
    setDetailTab("overview"); setCopyNotice("");
    if (updateHistory) {
      const url = new URL(window.location.href);
      const alreadyOpen = url.searchParams.has("taskId");
      if (url.searchParams.get("taskId") !== id) url.searchParams.delete("moveRequest");
      url.searchParams.set("taskId", id);
      if (alreadyOpen) window.history.replaceState(window.history.state, "", url);
      else window.history.pushState({ ...window.history.state, amuxCardOverlay: true }, "", url);
    }
    try {
      const result = await getJson<Detail>(
        `/api/admin/amux/execution-view?view=detail&taskId=${encodeURIComponent(id)}`);
      if (request === detailRequest.current) {
        setSelected(result);
        // A card waiting on the owner opens where the owner acts on it.
        if (canReviewCards && result.escalations.length > 0) setDetailTab("ownerReview");
      }
    } catch (reason) { if (request === detailRequest.current)
      setDetailError(reason instanceof Error && reason.message === "reauth" ? "reauth" : "unavailable"); }
    finally { if (request === detailRequest.current) setDetailBusy(false); }
  }, [canReviewCards]);

  useEffect(() => {
    if (!initialTaskId) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void openCard(initialTaskId, false); });
    return () => { cancelled = true; detailRequest.current += 1; };
  }, [initialTaskId, openCard]);

  useEffect(() => {
    const onPop = () => {
      const url = new URL(window.location.href);
      const id = url.searchParams.get("taskId"); const requestId = url.searchParams.get("moveRequest");
      if (id && /^[A-Za-z0-9_-]{1,80}$/.test(id) && requestId && /^[0-9a-f-]{36}$/i.test(requestId)) {
        const target = { taskId: id, requestId, readOnly: true };
        moveRequests.current.set(id, requestId); closeCard(false);
        activeMoveTarget.current = target; setMoveTarget(target); return;
      }
      activeMoveTarget.current = null;
      setMoveTarget(null);
      if (id && /^[A-Za-z0-9_-]{1,80}$/.test(id)) void openCard(id, false);
      else closeCard(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [openCard, closeCard]);
  const loadedCards = [...(board?.lanes.flatMap((lane) => lane.cards) ?? []), ...archive];
  const uniqueCards = [...new Map(loadedCards.map((card) => [card.id, card])).values()];
  const workers = [...new Set(uniqueCards.flatMap((card) => card.worker ? [card.worker] : []))].sort();
  const filtered = (cards: Card[]) => cards.filter((card) =>
    (!query.trim() || [card.title, card.id, card.sourceKey, card.worker].some((value) =>
      value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))) &&
    (!workerFilter || (workerFilter === "__unassigned" ? !card.worker : card.worker === workerFilter)) &&
    (!priorityFilter || card.priority === priorityFilter));
  const adjacent = selected ? uniqueCards.findIndex((card) => card.id === selected.id) : -1;
  const ownerEscalation = canReviewCards ? selected?.escalations[0] ?? null : null;
  const tabs = ownerEscalation ?
    ["ownerReview", "overview", "execution", "review", "activity"] as const :
    ["overview", "execution", "review", "activity"] as const;
  const copyLink = async () => {
    try { const url = new URL(window.location.href); url.searchParams.delete("moveRequest");
      await navigator.clipboard.writeText(url.href); setCopyNotice(m.copied); }
    catch { setCopyNotice(m.copyFailed); }
  };

  const openMove = (taskId: string) => {
    if (!canMoveCards) return;
    closeCard(false);
    const url = new URL(window.location.href);
    const prior = moveRequests.current.get(taskId) ??
      (url.searchParams.get("taskId") === taskId ? url.searchParams.get("moveRequest") : null);
    const requestId = prior && /^[0-9a-f-]{36}$/i.test(prior) ? prior : crypto.randomUUID();
    url.searchParams.set("taskId", taskId);
    if (prior) url.searchParams.set("moveRequest", requestId);
    else url.searchParams.delete("moveRequest");
    window.history.replaceState(window.history.state, "", url);
    const target = { taskId, requestId, readOnly: Boolean(prior) };
    activeMoveTarget.current = target; setMoveTarget(target);
  };
  useEffect(() => {
    if (!pointerTask) return;
    let frame = 0;
    const tick = () => {
      const drag = pointerDrag.current;
      const boardElement = boardRef.current;
      if (!drag || !boardElement) return;
      if (dragGhostRef.current) {
        dragGhostRef.current.style.left = `${Math.max(120, Math.min(window.innerWidth - 120, drag.x))}px`;
        dragGhostRef.current.style.top = `${Math.max(32, Math.min(window.innerHeight - 32, drag.y))}px`;
      }
      const bounds = boardElement.getBoundingClientRect();
      if (drag.moved && drag.y >= bounds.top && drag.y <= bounds.bottom) {
        if (drag.x > bounds.right - 40) boardElement.scrollLeft += 10;
        else if (drag.x < bounds.left + 40) boardElement.scrollLeft -= 10;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [pointerTask]);
  const startPointerDrag = (event: PointerEvent<HTMLButtonElement>, taskId: string) => {
    if (!canMoveCards || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    returnFocusRef.current = event.currentTarget;
    pointerDrag.current = { taskId, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, moved: false };
    setPointerTask(taskId);
  };
  const updatePointerDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    drag.moved ||= Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6;
  };
  const finishPointerDrag = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerDrag.current = null; setPointerTask(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const destination = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-amux-lane]');
    if (!cancelled && drag.moved && destination?.getAttribute('data-amux-lane') === 'amux_backlog') openMove(drag.taskId);
  };
  const closeMove = () => {
    activeMoveTarget.current = null;
    if (moveTarget && (moveRequests.current.get(moveTarget.taskId) !==
        moveTarget.requestId || settledMoveRequests.current.has(moveTarget.requestId))) {
      const url = new URL(window.location.href);
      if (url.searchParams.get("taskId") === moveTarget.taskId) {
        url.searchParams.delete("taskId"); url.searchParams.delete("moveRequest");
        window.history.replaceState(window.history.state, "", url);
      }
    }
    setMoveTarget(null);
  };
  useEffect(() => {
    const url = new URL(window.location.href);
    const taskId = url.searchParams.get("taskId"); const requestId = url.searchParams.get("moveRequest");
    if (taskId && /^[A-Za-z0-9_-]{1,80}$/.test(taskId) && requestId && /^[0-9a-f-]{36}$/i.test(requestId))
      queueMicrotask(() => { moveRequests.current.set(taskId, requestId);
        const target = { taskId, requestId, readOnly: true };
        activeMoveTarget.current = target; closeCard(false); setMoveTarget(target); });
  }, [closeCard]);

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
              onClick={(event) => { returnFocusRef.current = event.currentTarget; void openCard(item.id); }}>{amuxVisibleInspectionText(item.title ?? m.protectedTitle)}</button> :
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
  return <section className={styles.workspace}
    data-testid="amux-execution-workspace">
    {pointerTask && <div ref={dragGhostRef} className={styles.dragGhost} aria-hidden="true" data-testid="amux-pointer-drag">
      {amuxVisibleInspectionText(pointerTask)} · {m.moveToQueue}
    </div>}
    <div className={styles.header}>
      <div><h2>{m.boardTitle}</h2><p>{m.boardSubtitle}</p></div>
      <div className="flex gap-2" role="group" aria-label={m.viewLabel}>
        <button type="button" aria-pressed={view === "board"}
          className={styles.viewButton} onClick={() => setView("board")}>{m.board}</button>
        <button type="button" aria-pressed={view === "hierarchy"}
          className={styles.viewButton} onClick={openHierarchy}>{m.hierarchy}</button>
        <button type="button" className={styles.button} disabled={boardLoading}
          onClick={() => void refreshBoard()}><RefreshCw size={14} aria-hidden="true" />{m.refresh}</button>
      </div>
    </div>
    {view === "board" && <div className={styles.toolbar}>
      <label className={styles.search}>
        <Search size={16} aria-hidden="true" />
        <input aria-label={m.searchLoaded} placeholder={m.searchLoaded}
          value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)} />
        {query && <button type="button" aria-label={m.clearSearch}
          onClick={(event) => { setQuery(""); event.currentTarget.parentElement?.querySelector("input")?.focus(); }}>
          <X size={14} aria-hidden="true" /></button>}
      </label>
      <div className={styles.filters}>
        <label>{m.workerFilter}<select value={workerFilter}
          onChange={(event) => setWorkerFilter(event.target.value)}>
          <option value="">{m.allWorkers}</option><option value="__unassigned">{m.noWorker}</option>
          {workers.map((worker) => <option key={worker} value={worker}>{worker}</option>)}
        </select></label>
        <label>{m.priorityFilter}<select value={priorityFilter}
          onChange={(event) => setPriorityFilter(event.target.value)}>
          <option value="">{m.allPriorities}</option>
          {["p0","p1","p2","p3"].map((priority) => <option key={priority} value={priority}>{priority.toUpperCase()}</option>)}
        </select></label>
      </div>
    </div>}
    <p className={styles.hint}>{m.searchScope}</p>
    <div className={styles.summary}>
      <span>{m.activeTasks} <strong>{board ? board.counts.in_progress : m.unknown}</strong></span>
      <span>{m.awaitingWorker} <strong>{board ? board.counts.amux_backlog : m.unknown}</strong></span>
      <span>{m.awaitingReview} <strong>{board ? board.counts.in_review : m.unknown}</strong></span>
      <Link href="/admin/amux-settings?tab=safety">{m.haltsLink}</Link>
    </div>
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
      {!board ? <p role="status" className={styles.empty}>{boardLoading ? m.loading : m.unavailable}</p> :
        <div ref={boardRef} className={styles.board} aria-label={m.board} data-testid="amux-board-lanes">
          {AMUX_EXECUTION_VISIBLE_LANES.map((lane) => {
            const column = board.lanes.find((item) => item.lane === lane);
            const cards = column?.cards ?? [];
            const matches = filtered(cards);
            return <section key={lane} aria-label={m.lane[lane]} className={styles.column} data-amux-lane={lane}
              onDragOver={(event) => { if (lane === "amux_backlog" && dragCard.current) event.preventDefault(); }}
              onDrop={(event) => {
                event.preventDefault(); const id = dragCard.current; dragCard.current = null;
                if (lane === "amux_backlog" && id) openMove(id);
              }}>
              <h3 className={styles.columnHeading}>
                <span>{m.lane[lane]}</span><span className={styles.count}>{board.counts[lane]}</span>
              </h3>
              <p className={styles.columnHint}>{m.laneHint[lane]}</p>
              <ol className={styles.cards}>{matches.map((card) =>
                <li key={card.id} className={styles.card + (lane === "attention" ? " " + styles.attention : "")}
                  data-testid={"amux-board-card-" + card.id}
                  draggable={canMoveCards && lane === "tomverse_backlog" && card.cardType === "task"}
                  onDragStart={(event) => { if (pointerDrag.current) { event.preventDefault(); return; }
                    dragCard.current = card.id;
                    event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", card.id); }}
                  onDragEnd={() => { dragCard.current = null; }}>
                  <div className={styles.identity}>
                    <button type="button" className={styles.cardId}
                      onClick={(event) => { returnFocusRef.current = event.currentTarget; void openCard(card.id); }}>
                      {amuxVisibleInspectionText(card.id)}</button>
                    {card.sev1 && <span className={styles.cardWarning}>SEV1</span>}
                    {canMoveCards && lane === "tomverse_backlog" && card.cardType === "task" &&
                      <button type="button" className={styles.iconButton + " " + styles.dragHandle} aria-label={m.dragToQueue}
                        onPointerDown={(event) => startPointerDrag(event, card.id)}
                        onPointerMove={updatePointerDrag} onPointerUp={finishPointerDrag}
                        onPointerCancel={(event) => finishPointerDrag(event, true)}
                        onLostPointerCapture={(event) => {
                          if (pointerDrag.current?.pointerId === event.pointerId) {
                            pointerDrag.current = null; setPointerTask(null);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") { pointerDrag.current = null; setPointerTask(null); }
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault(); returnFocusRef.current = event.currentTarget; openMove(card.id);
                          }
                        }}><GripVertical size={14} aria-hidden="true" /></button>}
                    {canMoveCards && lane === "tomverse_backlog" && card.cardType === "task" &&
                      <button type="button" className={styles.iconButton} aria-label={m.moveToQueue}
                        onClick={(event) => { returnFocusRef.current = event.currentTarget; openMove(card.id); }}>
                        <MoveRight size={14} aria-hidden="true" /></button>}
                  </div>
                  {card.attentionReason && <span className={styles.reasonChip}
                    data-testid={"amux-card-attention-reason-" + card.id}>
                    {m.attentionReason[card.attentionReason] ?? m.attentionReasonFallback}</span>}
                  <button type="button" className={styles.cardTitle}
                    onClick={(event) => { returnFocusRef.current = event.currentTarget; void openCard(card.id); }}>
                    {amuxVisibleInspectionText(card.title ?? m.protectedTitle)}
                  </button>
                  {amuxDistinctSourceKey(card.id, card.sourceKey) && <p className={styles.cardMeta}>
                    {m.sourceKey}: {amuxVisibleInspectionText(card.sourceKey ?? "")}</p>}
                  <p className={styles.cardMeta}>{card.cardType ?? card.kind} · {card.priority.toUpperCase()}
                    {card.taskRole ? " · " + card.taskRole : ""}</p>
                  <p className={styles.cardWorker}><ShieldCheck size={14} aria-hidden="true" />
                    {card.worker ?? m.noWorker}</p>
                  {canReviewCards && card.attentionReason && <button type="button" className={styles.reviewButton}
                    data-testid={"amux-card-open-review-" + card.id}
                    onClick={(event) => { returnFocusRef.current = event.currentTarget; void openCard(card.id); }}>
                    {m.openOwnerReview}<MoveRight size={14} aria-hidden="true" /></button>}
                  <p className={styles.cardState + (!card.briefPresent || !card.scoreFresh ? " " + styles.cardWarning : "")}>
                    {card.dependencyCount > 0 ? m.dependencyCount(card.dependencyCount) :
                      card.score !== null ? m.score + " " + card.score + (card.scoreFresh ? "" : " · " + m.stale) :
                        m.scoreUnavailable}
                  </p>
                </li>)}</ol>
              {matches.length === 0 && <p className={styles.empty}>{cards.length === 0 ? m.empty : m.noMatches}</p>}
              {(query || workerFilter || priorityFilter) && <p className={styles.hint}>{m.matchCount(matches.length, cards.length)}</p>}
              {cards.length < board.counts[lane] && <button type="button"
                disabled={boardBusy !== null || boardLoading} className={styles.button}
                onClick={() => void loadBoardPage(lane)}>
                {m.loadMore(cards.length, board.counts[lane])}
              </button>}
            </section>;
          })}
        </div>}
      <details className={styles.archive}>
        <summary className="cursor-pointer text-sm font-semibold">{m.archive}
          {board ? ` (${board.counts.archive})` : ""}</summary>
        <ul className="mt-3 space-y-2 text-sm">{archive.map((card) => <li key={card.id}>
          <button type="button" className="underline" onClick={(event) => {
            returnFocusRef.current = event.currentTarget; void openCard(card.id);
          }}>
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
    {moveTarget && <AmuxExecutionDialog title={m.moveTitle} closeLabel={m.close}
      onClose={closeMove} returnFocusRef={returnFocusRef}>
      <AmuxExecutionMovePanel key={moveTarget.requestId} move={moveTarget}
        onWriteStarting={() => {
          if (activeMoveTarget.current !== moveTarget || moveTarget.readOnly ||
              settledMoveRequests.current.has(moveTarget.requestId)) return false;
          moveRequests.current.set(moveTarget.taskId, moveTarget.requestId);
          const url = new URL(window.location.href);
          url.searchParams.set("taskId", moveTarget.taskId);
          url.searchParams.set("moveRequest", moveTarget.requestId);
          window.history.replaceState(window.history.state, "", url);
          return true;
        }}
        onKnownRefusal={() => {
          activeMoveTarget.current = null;
          settledMoveRequests.current.add(moveTarget.requestId);
          moveRequests.current.delete(moveTarget.taskId);
          const url = new URL(window.location.href);
          if (url.searchParams.get("moveRequest") === moveTarget.requestId) {
            url.searchParams.delete("moveRequest");
            window.history.replaceState(window.history.state, "", url);
          }
        }}
        onMoved={() => { activeMoveTarget.current = null;
          settledMoveRequests.current.add(moveTarget.requestId); void refreshBoard(); }} />
    </AmuxExecutionDialog>}
    {detailOpen && <AmuxExecutionDialog title={m.detail} closeLabel={m.close}
      onClose={() => closeCard()} returnFocusRef={returnFocusRef}
      actions={<>
        <button type="button" className={styles.iconButton} aria-label={m.previousCard}
          disabled={detailBusy || adjacent <= 0} onClick={() => void openCard(uniqueCards[adjacent - 1].id)}>
          <ChevronLeft size={16} aria-hidden="true" /></button>
        <button type="button" className={styles.iconButton} aria-label={m.nextCard}
          disabled={detailBusy || adjacent < 0 || adjacent >= uniqueCards.length - 1}
          onClick={() => void openCard(uniqueCards[adjacent + 1].id)}><ChevronRight size={16} aria-hidden="true" /></button>
      </>}>
      {detailBusy && <p role="status" className={styles.loading}>{m.loadingDetail}</p>}
      {detailError && <div role="alert" className={styles.notice}>
        {detailError === "reauth" ? <Link href={adminRecentAuthenticationHref(
          "/admin/amux-execution?tab=cards" + (new URL(window.location.href).searchParams.get("taskId") ?
            "&taskId=" + encodeURIComponent(new URL(window.location.href).searchParams.get("taskId")!) : ""))}>{m.reauth}</Link> :
          <><p>{m.unavailable}</p><button type="button" className={styles.button}
            onClick={() => { const id = new URL(window.location.href).searchParams.get("taskId"); if (id) void openCard(id, false); }}>
            {m.refresh}</button></>}
      </div>}
      {selected && <section id="amux-execution-detail" className={styles.detail} data-testid="amux-execution-detail">
        <header className={styles.detailHeader}>
          <AmuxCardIdentity id={selected.id} sourceKey={selected.sourceKey} revision={selected.revision}
            m={m} />
          <h3>{amuxVisibleInspectionText(selected.title ?? m.protectedTitle)}</h3>
          <button type="button" className={styles.button} onClick={() => void copyLink()}>
            <Copy size={14} aria-hidden="true" />{m.copyLink}</button>
          {copyNotice && <p role="status">{copyNotice}</p>}
        </header>
        <div className={styles.detailLayout}>
          <div className={styles.detailMain}>
            <div className={styles.tabs} role="tablist" aria-label={m.detail}>
              {tabs.map((tab, index) => <button key={tab} type="button" className={styles.tab}
                id={"amux-tab-" + tab} role="tab" aria-selected={detailTab === tab}
                aria-controls={"amux-panel-" + tab} tabIndex={detailTab === tab ? 0 : -1}
                onClick={() => setDetailTab(tab)} onKeyDown={(event) => {
                  if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
                    (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                  setDetailTab(tabs[next]);
                  document.getElementById("amux-tab-" + tabs[next])?.focus();
                }}>{m.detailTabs[tab]}</button>)}
            </div>
            {ownerEscalation && <div id="amux-panel-ownerReview" role="tabpanel"
              aria-labelledby="amux-tab-ownerReview" hidden={detailTab !== "ownerReview"} className={styles.panel}>
              {/* Mounted while the card is open, so switching tabs never drops
                  a proposal or a decision whose outcome is still being read. */}
              <AmuxCardOwnerReview key={ownerEscalation.id} taskId={selected.id}
                escalationId={ownerEscalation.id} canInspectCards={canReviewCards}
                onDecisionCommitted={() => {
                  void refreshBoard();
                  // A decision can land after the owner closed this card or
                  // moved to another; reopening it then would show one card
                  // under another's URL. The URL names the card on screen.
                  if (new URL(window.location.href).searchParams.get("taskId") === selected.id)
                    void openCard(selected.id, false);
                }} />
            </div>}
            <div id="amux-panel-overview" role="tabpanel" aria-labelledby="amux-tab-overview" hidden={detailTab !== "overview"} className={styles.panel}>
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
      <div className="grid gap-3 md:grid-cols-2">
        <div><h4 className="font-semibold">{m.dependencies}</h4>
          <ul className="text-sm">{selected.dependencies.map((item) => <li key={item.id}>
            <button type="button" className="underline" onClick={() => void openCard(item.id)}>
              {amuxVisibleInspectionText(item.id)}</button>
            <AmuxSourceKeySuffix id={item.id} sourceKey={item.sourceKey} m={m} /> · {item.status}</li>)}</ul></div>
        <div><h4 className="font-semibold">{m.dependents}</h4>
          <ul className="text-sm">{selected.dependents.map((item) => <li key={item.id}>
            <button type="button" className="underline" onClick={() => void openCard(item.id)}>
              {amuxVisibleInspectionText(item.id)}</button>
            <AmuxSourceKeySuffix id={item.id} sourceKey={item.sourceKey} m={m} /> · {item.status}</li>)}</ul></div>
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
            </div>
            <div id="amux-panel-execution" role="tabpanel" aria-labelledby="amux-tab-execution" hidden={detailTab !== "execution"} className={styles.panel}>
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
      <section><h4 className="font-semibold">{m.attempts}</h4>
        {selected.attempts.length === 0 && <p>{m.noRecords}</p>}
        <ol className="space-y-2 text-sm">{selected.attempts.map((item) => <li key={item.id}
          className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
          <span>{date(item.startedAt)} · {item.worker} · {item.outcome ?? m.running} →
            {item.toStatus ?? m.unknown}</span>
          <p>{m.internalCost}: {item.costConfirmed && item.settledCostMicrousd !== null ?
            `$${USD(item.settledCostMicrousd)}` : m.unconfirmed}</p>
          {item.reason && <p>{item.reason}</p>}
        </li>)}</ol></section>
      <section><h4 className="font-semibold">{m.usage}</h4>
        {selected.usage.length === 0 && <p>{m.noRecords}</p>}
        <ul className="space-y-1 text-sm">{selected.usage.map((item) => <li key={item.id}>
          {date(item.startedAt)} · {item.provider}/{item.actualModelId ?? item.selectedModelId} ·
          {item.status} · {m.tokens(item.inputTokens, item.outputTokens)} ·
          {item.projectedApiCostMicrousd !== null ?
            `${m.projected} $${USD(item.projectedApiCostMicrousd)}` : m.unknown}
        </li>)}</ul></section>
            </div>
            <div id="amux-panel-review" role="tabpanel" aria-labelledby="amux-tab-review" hidden={detailTab !== "review"} className={styles.panel}>
      <section><h4 className="font-semibold">{m.reviewEvidence}</h4>
        {selected.reviews.length === 0 && <p>{m.noRecords}</p>}
        <ul className="space-y-2 text-sm">{selected.reviews.map((item, index) => <li key={`${item.escalationId}-${index}`}>
          {item.reviewPrNumber && item.reviewPrNumber > 0 ? <Link
            href={`https://github.com/mposition/Tomverse/pull/${item.reviewPrNumber}`}
            target="_blank" rel="noopener noreferrer" className="underline">
            PR #{item.reviewPrNumber}</Link> : m.noPr} ·
          {item.currentRevision ? m.currentRevision : m.staleRevision} ·
          {item.reviewBaseSha ?? m.unknown} → {item.reviewHeadSha ?? m.unknown}
        </li>)}</ul></section>
      <section><h4 className="font-semibold">{m.publications}</h4>
        {selected.publications.length === 0 && <p>{m.noRecords}</p>}
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
            </div>
            <div id="amux-panel-activity" role="tabpanel" aria-labelledby="amux-tab-activity" hidden={detailTab !== "activity"} className={styles.panel}>
      {!selected.feedback && selected.escalations.length === 0 && <p>{m.noRecords}</p>}
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
      {selected.escalations.length > 0 && <section><h4 className="font-semibold">{m.attention}</h4>
        <ul className="text-sm">{selected.escalations.map((item) => <li key={item.id}>
          {item.reason} · {item.status} · {date(item.createdAt)}</li>)}</ul>
        <Link href={`/admin/amux-execution?tab=assignment&focusEscalation=${encodeURIComponent(selected.escalations[0].id)}`}
          className="text-sm underline">
          {m.openReview}</Link>
      </section>}
            </div>
          </div>
          <aside className={styles.properties} aria-label={m.cardProperties}>
            <h4>{m.cardProperties}</h4><dl>
              {[[m.cardStatus,selected.status],[m.priorityFilter,selected.priority.toUpperCase()],
                [m.workerFilter,selected.worker ?? m.noWorker],[m.cardRole,selected.taskRole ?? m.noRole],
                [m.cardGrade,selected.executionGrade ?? m.noGrade]].map(([name,value]) =>
                  <div key={name} className={styles.property}><dt>{name}</dt><dd>{value}</dd></div>)}
            </dl><p className={styles.hint}>{m.readOnly}</p>
          </aside>
        </div>
      </section>}
    </AmuxExecutionDialog>}
  </section>;
}
