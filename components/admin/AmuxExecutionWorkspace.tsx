"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Copy, RefreshCw, Search, X } from "lucide-react";
import { Bot, Columns3, GitPullRequest, GripVertical, List, MoveRight, Network } from "lucide-react";
import { AmuxExecutionMovePanel, type AmuxBoardMove } from "./AmuxExecutionMovePanel";
import { AmuxExecutionDialog } from "./AmuxExecutionDialog";
import { AmuxCardOwnerReview } from "./AdminAmuxRoutingPanel";
import { AmuxBoardAttentionLane, AMUX_ATTENTION_LANE_ROWS, type AmuxBoardOwnerQueue } from "./AmuxBoardAttentionLane";
import { AmuxBoardPastWork } from "./AmuxBoardPastWork";
import { AmuxCardListPanel } from "./AmuxCardListPanel";
import { AmuxTaskQuestionSection } from "./AmuxWorkerQuestion";
import { AmuxLegacyCardPanel, type AmuxLegacyCardView } from "./AmuxLegacyCardPanel";
import { AmuxSettledCardEscalationPanel } from "./AmuxSettledCardEscalationPanel";
import { isAmuxSettledCardWithOpenEscalation } from "@/lib/amux/settledCardEscalationCore";
import { AmuxCardIdentity, AmuxSourceKeySuffix, amuxCardLabel, amuxDistinctSourceKey } from "./AmuxCardIdentity";
import styles from "./AmuxExecutionWorkspace.module.css";
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent } from "react";

import { AdminChannelIcon, adminChannelName } from "@/components/admin/ui/AdminChannelIcon";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { AdminReadFailed } from "@/components/admin/ui/AdminReadFailed";
import {
  AMUX_BOARD_COLUMNS, AMUX_WORKER_CHANNELS, amuxElapsed,
  type AmuxBoardColumn, type AmuxWorkerChannel,
} from "@/lib/adminAmuxFlow";
import { adminFetch } from "@/lib/adminFetch";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { adminAmuxScreensMessages } from "@/lib/adminMessages/amuxScreens";
import { amuxStatusChip } from "@/lib/adminAmuxBoardView";
import { adminAmuxBoardViewsMessages } from "@/lib/adminMessages/amuxBoardViews";
import type { AmuxExecutionListRow } from "@/lib/amux/adminExecutionCardList";
import { adminAmuxDecisionMakerAttentionMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import type { DmAttention, DmAttentionItem } from "@/lib/amux/decisionMakerAttention";
import { AmuxOutcomeObservationForm } from "./AmuxOutcomeObservationForm";
import { requestArchiveAllActiveCards } from "./amuxExecutionArchiveRequest";
import {
  AMUX_EXECUTION_VISIBLE_LANES,
  amuxVisibleInspectionText,
  amuxVisibleUntrustedText,
  type AmuxExecutionLane,
} from "@/lib/amux/adminExecutionViewCore";
import type { AmuxTaskFeedbackProjection } from "@/lib/amux/v22TaskFeedbackCore";
import {
  amuxIdeaLaneBoardHref, type AmuxIdeaLaneBoardCard, type AmuxIdeaLaneBoardColumn,
} from "@/lib/amux/ideaLaneBoardCore";

type Card = {
  id: string; title: string | null; displayKey: string | null; sourceKey: string | null;
  status: string; priority: string; kind: string;
  cardType: string | null; storyKind: string | null;
  parentFeatureNodeId: string | null; parentStoryCardId: string | null;
  taskRole: string | null; executionGrade: string | null;
  worker: string | null; lane: string | null; sev1: boolean;
  score: number | null; scoreFresh: boolean; dependencyCount: number;
  progress: { done: number; total: number } | null; briefPresent: boolean;
  /** The newest open escalation's reason code; null when none is open. */
  attentionReason: string | null;
  /** A v22 worker question still waiting on the owner; null when none. */
  ownerQuestion: "open" | "answered" | null;
  /** In the archive drawer (the archive lane also holds finished cards that were never archived). */
  archived?: boolean;
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
  /** A legacy WORKBOARD card's recreate and close; null or absent for any other card. */
  legacyCard?: AmuxLegacyCardView | null;
  result: { attemptId: string; state: "available" | "purged";
    createdAt: string; text: string | null; sha256: string | null;
    patch: { state: "available"; baseSha: string; sha256: string } |
      { state: "purged" } | null } | null;
  dependencies: Array<{ id: string; displayKey: string | null; sourceKey: string | null; status: string }>;
  dependents: Array<{ id: string; displayKey: string | null; sourceKey: string | null; status: string }>;
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
const date = (value: string) => formatAestDateTime(value, { seconds: true }) ?? "-";
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

/** How long a request has waited, in the largest whole unit. */
const waitedFor = (fromMs: number, nowMs: number, locale: "en" | "ko") => {
  const minutes = Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
  const [value, unit] = minutes < 60 ? [minutes, "minute"] as const : minutes < 1440 ?
    [Math.floor(minutes / 60), "hour"] as const : [Math.floor(minutes / 1440), "day"] as const;
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(value);
};

/** The side panel over this page, on the Cards tab. */
const dmRequestHref = (requestId: string) =>
  `/admin/amux-execution?tab=cards&dmRequest=${encodeURIComponent(requestId)}`;

function DecisionMakerAttentionCard({ item, nowMs }: { item: DmAttentionItem; nowMs: number }) {
  const d = useAdminMessages(adminAmuxDecisionMakerAttentionMessages);
  const { locale } = useAdminLocale();
  const unknown = item.kind === "delivery_unknown";
  const waited = d.waiting(item.askingWorkerId, item.instance ?? "-", waitedFor(item.createdAtMs, nowMs, locale));
  return <li><Link href={dmRequestHref(item.requestId)} prefetch={false}
    className={"flex min-h-10 min-w-0 items-center gap-2 rounded-xl border bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-100 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 " +
      (unknown ? "border-amber-500/60" : "border-sky-500/50")}
    aria-label={d.open(item.cardId, item.questionRevision)} title={waited}
    data-testid={"amux-dm-attention-" + item.requestId} data-kind={item.kind}>
    <Bot size={14} aria-hidden="true" className={"shrink-0 " + (unknown ? "text-amber-300" : "text-sky-300")} />
    <span className="shrink-0 font-mono text-[11px] font-bold">{amuxVisibleInspectionText(item.cardId)}</span>
    <span className={"shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold " +
      (unknown ? "bg-amber-500/15 text-amber-300" : "bg-sky-500/15 text-sky-300")}>{d.kinds[item.kind]}</span>
    {item.irreversible === true && <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-bold text-red-300">
      {d.irreversible}</span>}
    {item.question !== null && <span className="min-w-0 flex-1 truncate text-zinc-400">{amuxVisibleInspectionText(item.question)}</span>}
  </Link></li>;
}

const PR_URL = "https://github.com/mposition/Tomverse/pull/";

/** The most attention-lane cards the board loads on its own for the column's counts. */
const ATTENTION_AUTOLOAD_MAX = 96;

/** The lanes each board column holds; the lanes themselves are the server's. */
const COLUMN_LANES: Record<AmuxBoardColumn, AmuxExecutionLane[]> = {
  waiting: ["tomverse_backlog", "amux_backlog", "todo"],
  approval: ["attention"],
  running: ["in_progress"],
  review: ["in_review"],
  done: [],
};
/** The dot before a column's name. */
const COLUMN_DOT: Record<AmuxBoardColumn, string> = {
  waiting: "bg-zinc-500", approval: "bg-amber-500", running: "bg-blue-500", review: "bg-cyan-500", done: "bg-emerald-500",
};

/**
 * An idea the idea lane runs without cards (lib/amux/ideaLaneBoardCore.ts):
 * display only, with no move, approval or archive control; it opens the
 * idea's detail on the Ideas tab.
 */
function IdeaLaneCard({ card }: { card: AmuxIdeaLaneBoardCard }) {
  const m = useAdminMessages(adminAmuxExecutionMessages);
  const attention = card.column === "attention";
  return <li className={styles.card + " " + styles.laneCard + (attention ? " " + styles.attention : "")}
    data-testid={"amux-lane-idea-" + card.requestId} data-lane-state={card.state}>
    <div className={styles.identity}>
      <span className={styles.laneChip}><GitPullRequest size={12} aria-hidden="true" />{m.ideaLane.badge}</span>
      {card.prNumber !== null && <a href={PR_URL + card.prNumber} target="_blank" rel="noopener noreferrer"
        className={styles.cardId + " " + styles.lanePr}>#{card.prNumber}</a>}
    </div>
    {attention && <span className={styles.reasonChip}>{m.ideaLane.state[card.state]}</span>}
    <Link href={amuxIdeaLaneBoardHref(card.requestId)} prefetch={false}
      className={styles.cardTitle + " " + styles.laneCardLink}>
      {amuxVisibleInspectionText(card.title ?? card.requestId.slice(0, 8))}</Link>
    <p className={styles.cardMeta}>{[attention ? null : m.ideaLane.state[card.state],
      card.attempts > 0 ? m.ideaLane.attempts(card.attempts) : null].filter(Boolean).join(" · ")}</p>
  </li>;
}

export function AmuxExecutionWorkspace({ initialTaskId = null, canMoveCards = false,
  canReviewCards = false, decisionMaker, laneIdeas, workerChannels, cardList, ownerQueue }: {
  initialTaskId?: string | null; canMoveCards?: boolean;
  /** The "Waiting on me" queue's count and groups, read by the page; null: not read. */
  ownerQueue?: AmuxBoardOwnerQueue | null;
  /**
   * Each registered worker's channel, from the registry the page read. Absent
   * or a worker not in it: no channel badge, never one guessed from a name.
   */
  workerChannels?: Record<string, AmuxWorkerChannel> | null;
  /** Whether a card waiting on the owner opens on its owner review. */
  canReviewCards?: boolean;
  /**
   * Decision Maker requests waiting on a person, read by the page
   * (lib/amux/decisionMakerAttention.ts). Absent: not offered here; null: the
   * read failed, which the lane says instead of showing none.
   */
  decisionMaker?: DmAttention | null;
  /**
   * Idea lane work read by the page (lib/amux/ideaLaneBoardRead.ts), shown
   * beside the cards and never counted, paged or archived with them. Absent:
   * not offered; null: the read failed.
   */
  laneIdeas?: AmuxIdeaLaneBoardCard[] | null;
  /**
   * The List view's rows, read by the page (lib/amux/adminExecutionCardList.ts).
   * Absent: the view is not offered; null: the read failed, which the view says.
   */
  cardList?: { rows: AmuxExecutionListRow[]; total: number; limit: number } | null;
}) {
  const m = useAdminMessages(adminAmuxExecutionMessages);
  const d = useAdminMessages(adminAmuxDecisionMakerAttentionMessages);
  const screens = useAdminMessages(adminAmuxScreensMessages).board;
  const views = useAdminMessages(adminAmuxBoardViewsMessages);
  const { locale } = useAdminLocale();
  // The clock the card ages are counted against: read when the board was read, not on every render.
  const [nowMs, setNowMs] = useState<number | null>(null);
  const dmTotal = decisionMaker?.total ?? 0;
  const [view, setView] = useState<"board" | "list" | "hierarchy">("board");
  // A lane the board pages on its own (the attention lane's rest, the past-work list) stops after a failed read instead of retrying in a loop.
  const [autoStopped, setAutoStopped] = useState<Partial<Record<AmuxExecutionLane, true>>>({});
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
        setBoard(result); setBoardPages({}); setArchive([]); setAutoStopped({}); setNowMs(Date.now());
      }
    } catch (reason) { if (generation === boardGeneration.current) showError(reason); }
    finally { if (generation === boardGeneration.current) setBoardLoading(false); }
  }, [showError]);
  useEffect(() => {
    queueMicrotask(() => { void refreshBoard(); });
    return () => { boardGeneration.current += 1; };
  }, [refreshBoard]);
  const activeCardCount = board ? AMUX_EXECUTION_VISIBLE_LANES.reduce(
    (total, lane) => total + board.counts[lane], 0) : 0;
  const archiveAll = async () => {
    if (!window.confirm(m.archiveAllConfirm(activeCardCount))) return;
    setBoardLoading(true); setError(null);
    try {
      await requestArchiveAllActiveCards();
    } catch (reason) { showError(reason); setBoardLoading(false); return; }
    await refreshBoard();
  };
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
  /** true: a page was added; false: the read failed; null: nothing was read (busy, or the board was reloaded meanwhile). */
  const loadBoardPage = async (lane: AmuxExecutionLane): Promise<boolean | null> => {
    if (boardBusy || boardLoading) return null;
    const generation = boardGeneration.current;
    const next = lane === "archive" && boardPages.archive === undefined ? 0 :
      (boardPages[lane] ?? 0) + 1;
    setBoardBusy(lane); setError(null);
    try {
      const result = await getJson<{ cards: Card[]; counts: BoardSnapshot["counts"] }>(
        `/api/admin/amux/execution-view?view=board&lane=${lane}&page=${next}`);
      if (generation !== boardGeneration.current) return null;
      setBoardPages((current) => ({ ...current, [lane]: next }));
      if (lane === "archive") setArchive((current) => [...current, ...result.cards]);
      else setBoard((current) => current ? { ...current, counts: result.counts,
        lanes: current.lanes.map((column) => column.lane === lane ?
          { ...column, cards: [...column.cards, ...result.cards] } : column) } : current);
      return true;
    } catch (reason) {
      if (generation !== boardGeneration.current) return null;
      showError(reason);
      return false;
    }
    finally { if (generation === boardGeneration.current) setBoardBusy(null); }
  };
  // The four counts in the "waiting on you" column and the past-work list read whole lanes, so the rest of the
  // attention lane (up to ATTENTION_AUTOLOAD_MAX cards) and the first page of the archive load after the snapshot.
  const loadPageRef = useRef(loadBoardPage);
  useEffect(() => { loadPageRef.current = loadBoardPage; });
  useEffect(() => {
    if (!board || boardLoading || boardBusy) return;
    const attentionLoaded = board.lanes.find((item) => item.lane === "attention")?.cards.length ?? 0;
    const lane: AmuxExecutionLane | null = !autoStopped.attention && attentionLoaded < board.counts.attention &&
      ((boardPages.attention ?? 0) + 1) * board.pageSize < ATTENTION_AUTOLOAD_MAX ? "attention" :
      !autoStopped.archive && boardPages.archive === undefined && board.counts.archive > 0 ? "archive" : null;
    if (lane === null) return;
    void loadPageRef.current(lane).then((result) => {
      if (result === false) setAutoStopped((current) => ({ ...current, [lane]: true }));
    });
  }, [board, boardLoading, boardBusy, boardPages, autoStopped]);
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
  const openCard = useCallback(async (id: string, updateHistory = true,
    preferOverview = false) => {
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
        // A worker question is answered on the overview, where it is shown.
        // A legacy WORKBOARD card has no review decision; it opens on its recreate and close.
        // A done or todo card left with an escalation has no decision either; it opens on its close.
        if (canReviewCards && result.escalations.length > 0 && !preferOverview && !result.legacyCard &&
            !isAmuxSettledCardWithOpenEscalation({ status: result.status, escalationId: result.escalations[0]?.id ?? null }))
          setDetailTab("ownerReview");
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
    (!query.trim() || [card.title, card.displayKey, card.id, card.sourceKey, card.worker].some((value) =>
      value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))) &&
    (!workerFilter || (workerFilter === "__unassigned" ? !card.worker : card.worker === workerFilter)) &&
    (!priorityFilter || card.priority === priorityFilter));
  // A lane idea has no worker or priority, so those filters leave it out.
  const laneCardsFor = (column: AmuxIdeaLaneBoardColumn | AmuxExecutionLane) => workerFilter || priorityFilter ? [] :
    (laneIdeas ?? []).filter((card) => card.column === column && (!query.trim() ||
      [card.title, card.requestId].some((value) =>
        value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))));
  const laneDone = laneCardsFor("done");
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
    return <ul className={depth > 0 ? "ml-4 border-l pl-3 border-zinc-700" : ""}>
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
            {item.type === "card" && <span className="font-mono text-xs" data-testid="amux-tree-card-label">
              {amuxVisibleInspectionText(amuxCardLabel(item))}
              <AmuxSourceKeySuffix id={item.id} displayKey={item.displayKey} sourceKey={item.sourceKey} m={m} /></span>}
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
          {feedbackByParent[keyOf(child)] && <p className="ml-8 text-xs text-zinc-300">
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

  const elapsedText = (iso: string) => {
    const elapsed = nowMs === null ? null : amuxElapsed(Date.parse(iso), nowMs);
    return elapsed === null ? null :
      new Intl.NumberFormat(locale, { style: "unit", unit: elapsed.unit, unitDisplay: "narrow" }).format(elapsed.value);
  };
  const dropProps = (lane: AmuxExecutionLane) => ({
    onDragOver: (event: ReactDragEvent) => { if (lane === "amux_backlog" && dragCard.current) event.preventDefault(); },
    onDrop: (event: ReactDragEvent) => {
      event.preventDefault(); const id = dragCard.current; dragCard.current = null;
      if (lane === "amux_backlog" && id) openMove(id);
    },
  });
  /** A card of a lane other than "waiting on you": its number, title and one line (worker, priority, time since it changed). */
  const renderCard = (card: Card, lane: AmuxExecutionLane) => {
    const channel = card.worker ? workerChannels?.[card.worker] ?? null : null;
    const since = elapsedText(card.updatedAt);
    return <li key={card.id}
      className={styles.card}
      data-testid={"amux-board-card-" + card.id}
      draggable={canMoveCards && lane === "tomverse_backlog" && card.cardType === "task"}
      onDragStart={(event) => { if (pointerDrag.current) { event.preventDefault(); return; }
        dragCard.current = card.id;
        event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", card.id); }}
      onDragEnd={() => { dragCard.current = null; }}>
      <div className={styles.identity}>
        <button type="button" className={styles.cardId}
          onClick={(event) => { returnFocusRef.current = event.currentTarget; void openCard(card.id); }}>
          {amuxVisibleInspectionText(amuxCardLabel(card))}</button>
        {channel && <AdminChannelIcon channel={channel} size={18} label={adminChannelName(channel)} />}
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
      <button type="button" className={styles.cardTitle}
        onClick={(event) => { returnFocusRef.current = event.currentTarget; void openCard(card.id); }}>
        {amuxVisibleInspectionText(card.title ?? m.protectedTitle)}
      </button>
      {/* docs/policy/amux-card-display-key.md S5: the number leads, the Task ID beside it. */}
      {card.displayKey && <p className={styles.cardMeta}>
        {m.taskId}: {amuxVisibleInspectionText(card.id)}</p>}
      {!card.displayKey && amuxDistinctSourceKey(card.id, card.sourceKey) && <p className={styles.cardMeta}>
        {m.sourceKey}: {amuxVisibleInspectionText(card.sourceKey ?? "")}</p>}
      <p className={styles.cardWorker}>
        {card.worker ? <AdminPixelAvatar team="amux" tile={22} unit={1.1} body={false} /> : null}
        <span className={styles.workerName}>{card.worker ?? m.noWorker}</span>
        <span>{card.priority.toUpperCase()}</span>
        {since && <span className={styles.elapsed} title={screens.sinceChange}>{since}</span>}
      </p>
    </li>;
  };
  /** The "waiting on you" column: counts by reason, the first cards as one line each, and the way to the tab that handles them. */
  const openFromLane = (taskId: string, preferOverview: boolean, opener: HTMLElement) => {
    returnFocusRef.current = opener; void openCard(taskId, true, preferOverview);
  };
  /** What fills a lane: the Decision Maker requests above its cards, then the cards, then idea-lane display cards. */
  const laneBody = (snapshot: BoardSnapshot, lane: AmuxExecutionLane) => {
    const cards = snapshot.lanes.find((item) => item.lane === lane)?.cards ?? [];
    const matches = filtered(cards);
    const laneCards = laneCardsFor(lane);
    const attention = lane === "attention";
    const attentionTotal = Math.max(snapshot.counts.attention, ownerQueue?.total ?? 0) + dmTotal;
    return <>
      {attention && attentionTotal > 0 && <AmuxBoardAttentionLane cards={matches} countedCards={cards}
        cardTotal={snapshot.counts.attention} decisionMakerTotal={dmTotal} canReviewCards={canReviewCards}
        workerChannels={workerChannels} onOpen={openFromLane} ownerQueue={ownerQueue}
        decisionMakerRows={decisionMaker ? decisionMaker.items.slice(0, AMUX_ATTENTION_LANE_ROWS).map((item) =>
          <DecisionMakerAttentionCard key={item.requestId} item={item} nowMs={decisionMaker.dbNowMs} />) : []}
        decisionMakerNote={<>
          {decisionMaker?.items.some((item) => item.question === null) && <p className={styles.dmMore}>{d.bodiesHidden}</p>}
        </>} />}
      {attention && decisionMaker === null && <p role="alert" className={styles.dmMore}>{d.unavailable}</p>}
      {!attention && <ol className={styles.cards}>{matches.map((card) => renderCard(card, lane))}</ol>}
      {laneCards.length > 0 && <>
        <h4 className={styles.groupHeading + " " + styles.groupHeadingLane}>
          <GitPullRequest size={14} aria-hidden="true" />{m.ideaLane.group(laneCards.length)}</h4>
        <ol className={styles.cards} data-testid={"amux-lane-ideas-" + lane}>
          {laneCards.map((card) => <IdeaLaneCard key={card.requestId} card={card} />)}</ol>
      </>}
      {(attention ? attentionTotal === 0 : matches.length === 0) && laneCards.length === 0 &&
        <p className={styles.empty}>{cards.length === 0 ? m.empty : m.noMatches}</p>}
      {(query || workerFilter || priorityFilter) && <p className={styles.hint}>{m.matchCount(matches.length, cards.length)}</p>}
      {!attention && cards.length < snapshot.counts[lane] && <button type="button"
        disabled={boardBusy !== null || boardLoading} className={styles.button}
        onClick={() => void loadBoardPage(lane)}>
        {m.loadMore(cards.length, snapshot.counts[lane])}
      </button>}
    </>;
  };

  const selectedBody = cardBody(selected?.body ?? null);
  return <section className={styles.workspace}
    data-testid="amux-execution-workspace">
    {pointerTask && <div ref={dragGhostRef} className={styles.dragGhost} aria-hidden="true" data-testid="amux-pointer-drag">
      {amuxVisibleInspectionText(amuxCardLabel(uniqueCards.find((card) => card.id === pointerTask) ?? { id: pointerTask }))} · {m.moveToQueue}
    </div>}
    <div className={styles.header}>
      <div><h2>{m.boardTitle}</h2><p>{m.boardSubtitle}</p>
        <ul className={styles.channels} aria-label={screens.channels}>
          {AMUX_WORKER_CHANNELS.map((channel) => <li key={channel} className={styles.channel}>
            <AdminChannelIcon channel={channel} size={16} />{adminChannelName(channel)}</li>)}
        </ul></div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-2xl border border-zinc-800 bg-zinc-900 p-1" role="group"
          aria-label={views.views.label} data-testid="amux-view-switch">
          {([["board", views.views.board, Columns3, () => setView("board")],
            ...(cardList === undefined ? [] : [["list", views.views.list, List, () => setView("list")] as const]),
            ["hierarchy", views.views.hierarchy, Network, openHierarchy]] as const).map(([id, label, Icon, go]) =>
            <button key={id} type="button" aria-pressed={view === id} onClick={go} data-testid={"amux-view-" + id}
              className={"inline-flex min-h-9 items-center gap-1.5 rounded-xl px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 " +
                (view === id ? "bg-zinc-100 font-bold text-zinc-900" : "font-medium text-zinc-400 hover:text-white")}>
              <Icon className="h-4 w-4" aria-hidden="true" />{label}</button>)}
        </div>
        <button type="button" className={styles.button} disabled={boardLoading}
          onClick={() => void refreshBoard()}><RefreshCw size={14} aria-hidden="true" />{m.refresh}</button>
        {canMoveCards && board && activeCardCount > 0 && <button type="button"
          className={styles.button} disabled={boardLoading} data-testid="amux-archive-all"
          onClick={() => void archiveAll()}>{m.archiveAll}</button>}
      </div>
    </div>
    <p className="text-xs text-zinc-500">{m.globalAttention} <Link
      href="/admin/amux-recovery?tab=safety" className="underline">{m.haltsLink}</Link></p>
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
    {activation && <details data-testid="amux-v22-activation-diagnostic"
      className="rounded border p-3 text-sm border-zinc-700">
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
    {laneIdeas === null && <p role="status" className={styles.hint}>{m.ideaLane.unavailable}</p>}
    {error && <p role="alert" className="rounded border border-red-500 p-2 text-sm">
      {error === "reauth" ? <Link className="underline"
        href={adminRecentAuthenticationHref("/admin/amux-execution?tab=cards")}>{m.reauth}</Link> :
        m.unavailable}
    </p>}
    {view === "board" && <>
      {!board ? <p role="status" className={styles.empty}>{boardLoading ? m.loading : m.unavailable}</p> :
        <div ref={boardRef} className={styles.board} aria-label={m.board} data-testid="amux-board-lanes">
          {AMUX_BOARD_COLUMNS.map((column) => {
            const lanes = COLUMN_LANES[column];
            const total = column === "done" ? laneDone.length : lanes.reduce(
              (sum, lane) => sum + board.counts[lane] + (lane === "attention" ? dmTotal : 0), 0);
            const title = screens.columns[column];
            const heading = <h3 className={styles.columnHeading}>
              <span className={styles.columnTitle}>
                <span aria-hidden="true" className={"h-2 w-2 rounded-full " + COLUMN_DOT[column]} />{title}</span>
              <span className={styles.count}>{total}</span>
            </h3>;
            if (column === "done") {
              return <section key={column} aria-label={title} className={styles.column} data-amux-column={column}>
                {heading}
                <p className={styles.columnHint}>{screens.doneHint}</p>
                <ol className={styles.cards + " " + styles.laneDone} data-testid="amux-lane-ideas-done">
                  {laneDone.map((card) => <IdeaLaneCard key={card.requestId} card={card} />)}</ol>
                {laneDone.length === 0 && <p className={styles.empty}>{m.empty}</p>}
              </section>;
            }
            if (lanes.length === 1) {
              const lane = lanes[0];
              const attention = lane === "attention";
              return <section key={column} aria-label={title} data-amux-lane={lane} data-amux-column={column}
                tabIndex={attention ? -1 : undefined}
                className={styles.column + (attention ? " " + styles.attentionColumn : "")} {...dropProps(lane)}>
                {heading}
                <p className={styles.columnHint}>{m.laneHint[lane]}</p>
                {laneBody(board, lane)}
              </section>;
            }
            return <div key={column} className={styles.column} data-amux-column={column}>
              {heading}
              {lanes.map((lane) => <section key={lane} aria-label={m.lane[lane]} data-amux-lane={lane}
                className={styles.subLane} {...dropProps(lane)}>
                <h4 className={styles.subHeading}><span>{m.lane[lane]}</span>
                  <span className={styles.count}>{board.counts[lane]}</span></h4>
                <p className={styles.columnHint}>{m.laneHint[lane]}</p>
                {laneBody(board, lane)}
              </section>)}
            </div>;
          })}
        </div>}
      <AmuxBoardPastWork cards={archive.map((card) => ({ id: card.id, title: card.title, displayKey: card.displayKey,
          status: card.status, archived: card.archived === true, worker: card.worker, updatedAt: card.updatedAt }))}
        total={board ? board.counts.archive : null}
        loading={boardBusy === "archive" || boardLoading || (board !== null && archive.length === 0 &&
          boardPages.archive === undefined && board.counts.archive > 0 && !autoStopped.archive)}
        failed={Boolean(autoStopped.archive) && archive.length === 0} workerChannels={workerChannels}
        protectedTitle={m.protectedTitle}
        onOpen={(taskId, opener) => { returnFocusRef.current = opener; void openCard(taskId); }}
        onLoadMore={() => void loadBoardPage("archive")}
        onRetry={() => setAutoStopped((current) => { const next = { ...current }; delete next.archive; return next; })} />
      <p className="rounded-2xl border border-zinc-800 bg-zinc-900 px-5 py-3 text-sm text-zinc-400" data-testid="amux-moved-note">
        <strong className="mr-2 text-zinc-100">{views.moved.title}</strong>{views.moved.body}</p>
    </>}
    {view === "list" && cardList !== undefined && (cardList === null ?
      <AdminReadFailed title={views.list.unavailableTitle} detail={views.list.unavailableDetail} /> :
      <AmuxCardListPanel rows={cardList.rows} total={cardList.total} limit={cardList.limit} nowMs={nowMs}
        workerChannels={workerChannels}
        onOpen={(taskId, opener) => { returnFocusRef.current = opener; void openCard(taskId); }} />)}
    {view === "hierarchy" && <section className="rounded-lg border p-4 border-zinc-700">
      <h3 className="font-semibold">{m.hierarchy}</h3>
      <p className="text-xs text-zinc-500">{m.hierarchyHelp}</p>
      {renderTree({ kind: "root" }, 0)}
      <div className="mt-3 border-t pt-3 border-zinc-700">
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
          <AmuxCardIdentity id={selected.id} displayKey={selected.displayKey} sourceKey={selected.sourceKey} revision={selected.revision}
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
      {selected.legacyCard && <AmuxLegacyCardPanel key={selected.id + ":" + selected.revision}
        taskId={selected.id} revision={selected.revision} view={selected.legacyCard} canAct={canReviewCards}
        // The board moves the card to the archive; the panel keeps its answer and the idea link.
        onChanged={() => void refreshBoard()} />}
      {ownerEscalation && isAmuxSettledCardWithOpenEscalation({ status: selected.status,
        escalationId: ownerEscalation.id }) && <AmuxSettledCardEscalationPanel
        key={selected.id + ":" + ownerEscalation.id} taskId={selected.id} escalationId={ownerEscalation.id}
        canAct={canReviewCards} onChanged={() => {
          void refreshBoard();
          if (new URL(window.location.href).searchParams.get("taskId") === selected.id)
            void openCard(selected.id, false, true);
        }} />}
      {selected.ownerQuestion && <AmuxTaskQuestionSection key={selected.id + ":" + selected.revision}
        taskId={selected.id} canAnswer={canReviewCards} onAnswered={() => {
          void refreshBoard();
          if (new URL(window.location.href).searchParams.get("taskId") === selected.id)
            void openCard(selected.id, false, true);
        }} />}
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
              {amuxVisibleInspectionText(amuxCardLabel(item))}</button>
            <AmuxSourceKeySuffix id={item.id} displayKey={item.displayKey} sourceKey={item.sourceKey} m={m} /> · {item.status}</li>)}</ul></div>
        <div><h4 className="font-semibold">{m.dependents}</h4>
          <ul className="text-sm">{selected.dependents.map((item) => <li key={item.id}>
            <button type="button" className="underline" onClick={() => void openCard(item.id)}>
              {amuxVisibleInspectionText(amuxCardLabel(item))}</button>
            <AmuxSourceKeySuffix id={item.id} displayKey={item.displayKey} sourceKey={item.sourceKey} m={m} /> · {item.status}</li>)}</ul></div>
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
          className="rounded border p-2 border-zinc-700">
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
          <li key={run.id} className="rounded border p-2 border-zinc-700">
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
        <Link href={`/admin/amux-execution?tab=review&focusEscalation=${encodeURIComponent(selected.escalations[0].id)}`}
          className="text-sm underline">
          {m.openReview}</Link>
      </section>}
            </div>
          </div>
          <aside className={styles.properties} aria-label={m.cardProperties}>
            <h4>{m.cardProperties}</h4><dl>
              {[[m.cardStatus,views.status[amuxStatusChip(selected.status).group]],[m.priorityFilter,selected.priority.toUpperCase()],
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
