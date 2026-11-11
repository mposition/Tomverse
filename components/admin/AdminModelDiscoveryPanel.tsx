"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminModelDiscoveryMessages } from "@/lib/adminMessages/modelDiscovery";
import { adminModelsBoardMessages } from "@/lib/adminMessages/modelsBoard";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminReasonDialog } from "@/components/admin/ui/AdminReasonDialog";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { AdminWriteButton } from "@/components/admin/ui/AdminWriteButton";
import type { AdminTone } from "@/lib/adminUiCore";
import { catalogImageDraftHref, isRuntimeImageProvider } from "@/lib/runtimeImageProviders";
import {
  WORK_ITEM_EXCLUSION_REASONS,
  analysisFingerprint,
  type WorkItemExclusionReason,
} from "@/lib/modelLifecycleWorkItemCore";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { discardResponseBody } from "@/lib/discardResponseBody";
import { adminFetch } from "@/lib/adminFetch";

type ReviewPriority =
  | "recommended"
  | "review"
  | "needs_evidence"
  | "low"
  | "no_action";
type Availability = "current" | "stale" | "unknown";
type ModelProduct = "chat" | "image_generation" | "unsupported";

export type ModelWorkItemRow = {
  id: string;
  provider: string;
  apiModel: string;
  action: string;
  status: string;
  severity: string;
  ownerEmail: string | null;
  dueAt: string | null;
  firstSeenAt: string;
  recommendation: string | null;
  observedVia: Array<{ provider: string; apiModel: string }>;
  availability: Availability;
  lifecycle: string | null;
  servedByTomverse: boolean;
  /** The served model that is a later generation of this one's line, if any. */
  supersededBy: string | null;
  /** Adopted, already served, stalled before rollout: "Rollout complete" applies. */
  rolloutFinishable?: boolean;
  /** Verifications still owed before rollout, ticked off from this panel. */
  pendingValidations?: string[];
  familyKey: string;
  familySize: number;
  reviewPriority: ReviewPriority;
  reviewKind: string;
  product: ModelProduct;
  /** One line: what this candidate is to the catalogue Tomverse runs. */
  verdictKo: string;
  /** Supporting facts, each checkable on its own. */
  pointsKo: string[];
  /** What to do next, and what would change the answer. */
  nextStepKo: string;
  /** The three above joined; what a decision records as the analysis shown. */
  analysisKo: string;
  /** Present only in the excluded view: what closed the item, and who. */
  exclusion?: {
    reasonCode: string | null;
    operatorReason: string | null;
    analysisSnapshot: string | null;
    note: string | null;
    actorEmail: string | null;
    excludedAt: string;
  } | null;
};

type QueueView = "open" | "excluded";

type DecisionDialog = {
  decision: "exclude" | "reopen";
  /**
   * One entry per family the operator chose: the row they read (its
   * representative), the members the decision applies to, and a fingerprint
   * of the sentence that row showed.
   */
  families: Array<{
    representativeId: string;
    workItemIds: string[];
    shownAnalysisFingerprint: string;
  }>;
};

type QueueResponse = {
  items: ModelWorkItemRow[];
  total: number;
  truncated: boolean;
};

type ModelFamilyGroup = {
  key: string;
  members: ModelWorkItemRow[];
  representative: ModelWorkItemRow;
  providers: string[];
  priority: ReviewPriority;
  product: ModelProduct;
};

const PAGE_SIZE = 50;
const MAX_BULK_ITEMS = 200;

const PRIORITY_ORDER: Record<ReviewPriority, number> = {
  recommended: 0,
  review: 1,
  needs_evidence: 2,
  low: 3,
  no_action: 4,
};

const PRIORITY_VALUES = Object.keys(PRIORITY_ORDER) as ReviewPriority[];

const AVAILABILITY_VALUES: Availability[] = ["current", "stale", "unknown"];

const PRODUCT_VALUES: ModelProduct[] = ["chat", "image_generation", "unsupported"];

const ageDays = (firstSeenAt: string) => {
  const seen = new Date(firstSeenAt).getTime();
  if (Number.isNaN(seen)) return null;
  return Math.max(0, Math.floor((Date.now() - seen) / 86_400_000));
};

const PRIORITY_TONE: Record<ReviewPriority, AdminTone> = {
  recommended: "info",
  review: "info",
  needs_evidence: "warn",
  low: "idle",
  no_action: "idle",
};

const AVAILABILITY_TONE: Record<Availability, AdminTone> = {
  current: "ok",
  unknown: "warn",
  stale: "idle",
};

/**
 * The members a decision applies to.
 *
 * Exclusion takes the members still undecided -- including any left in the two
 * internal states the panel no longer offers as buttons -- and never an item
 * somebody has already adopted and is walking to rollout. Reopening takes only
 * excluded members.
 */
const EXCLUDABLE_STATUSES = new Set(["discovered", "awaiting_decision", "deferred"]);

const decisionIds = (group: ModelFamilyGroup, decision: DecisionDialog["decision"]) =>
  group.members
    .filter((member) =>
      decision === "exclude"
        ? EXCLUDABLE_STATUSES.has(member.status)
        : member.status === "closed_no_action"
    )
    .map((member) => member.id);

/**
 * The member of a family an adoption would register, or null.
 *
 * The representative rather than the whole group: a family collapses several
 * spellings of one model -- a dated snapshot, a moving alias, a second
 * provider's prefix -- and exactly one of them becomes the identifier requests
 * will carry. `buildGroups` already sorts the stable id to the front for that
 * reason.
 *
 * Only `add` items, and only ones the queue can still move. A retirement is
 * about a model the registry already has, and an excluded item is reopened
 * first -- from the excluded view -- so the reopen is recorded with its reason
 * before anything is adopted.
 */
const adoptableMember = (group: ModelFamilyGroup) => {
  const candidate = group.representative;
  if (candidate.action !== "add") return null;
  // Chat only. Image generation models have their own ledger, and this row's
  // `supportsImage` means image *input*; adopting a generation model here would
  // price and route it as a chat model. The server refuses it as well.
  if (candidate.product !== "chat") return null;
  return ["discovered", "awaiting_decision", "deferred", "approved", "implementation_pending"].includes(
    candidate.status
  )
    ? candidate
    : null;
};

/**
 * The image-generation counterpart of `adoptableMember`: the member to hand to
 * the image catalogue, where its profile, price revision and judge live.
 */
const imageDraftMember = (group: ModelFamilyGroup) => {
  const candidate = group.representative;
  if (candidate.action !== "add" || candidate.product !== "image_generation") return null;
  return ["discovered", "awaiting_decision", "deferred", "approved", "implementation_pending"].includes(
    candidate.status
  )
    ? candidate
    : null;
};

const buildGroups = (rows: readonly ModelWorkItemRow[]): ModelFamilyGroup[] => {
  const byFamily = new Map<string, ModelWorkItemRow[]>();
  for (const row of rows) {
    const family = byFamily.get(row.familyKey);
    if (family) family.push(row);
    else byFamily.set(row.familyKey, [row]);
  }
  return Array.from(byFamily, ([key, members]) => {
    const sorted = [...members].sort(
      (a, b) =>
        PRIORITY_ORDER[a.reviewPriority] - PRIORITY_ORDER[b.reviewPriority] ||
        a.apiModel.localeCompare(b.apiModel)
    );
    const representative = sorted[0];
    return {
      key,
      members: sorted,
      representative,
      providers: Array.from(
        new Set(
          members.flatMap((member) =>
            member.observedVia.map((item) => item.provider)
          )
        )
      ).sort(),
      priority: representative.reviewPriority,
      product: representative.product,
    };
  }).sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      a.representative.firstSeenAt.localeCompare(b.representative.firstSeenAt) ||
      a.key.localeCompare(b.key)
  );
};

const selectClass =
  "rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-zinc-500";

export function AdminModelDiscoveryPanel() {
  const m = useAdminMessages(adminModelDiscoveryMessages);
  const board = useAdminMessages(adminModelsBoardMessages).discovery;
  const [rows, setRows] = useState<ModelWorkItemRow[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [selectedFamilies, setSelectedFamilies] = useState<Set<string>>(
    new Set()
  );
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [priority, setPriority] = useState<ReviewPriority | "all">(
    "recommended"
  );
  const [availability, setAvailability] = useState<Availability | "all">("all");
  const [product, setProduct] = useState<ModelProduct | "all">("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [view, setView] = useState<QueueView>("open");
  const [dialog, setDialog] = useState<DecisionDialog | null>(null);
  const [reasonCode, setReasonCode] = useState<WorkItemExclusionReason | "">("");
  const [operatorReason, setOperatorReason] = useState("");
  // The validation being recorded, and the note that goes with it.
  const [validationDialog, setValidationDialog] = useState<{
    row: ModelWorkItemRow;
    validation: string;
  } | null>(null);
  const [validationNote, setValidationNote] = useState("");
  // Adopted, already-served items being closed as rolled out.
  const [rolloutDialog, setRolloutDialog] = useState<string[] | null>(null);
  const [rolloutNote, setRolloutNote] = useState("");

  // Which load is current. A response from an earlier load -- the other view,
  // or a refresh overtaken by a decision -- is dropped instead of replacing
  // rows the operator is now looking at.
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    const current = () => generation === loadGenerationRef.current;
    setRefreshing(true);
    try {
      const response = await adminFetch(
        view === "excluded"
          ? "/api/admin/model-lifecycle?view=excluded"
          : "/api/admin/model-lifecycle",
        { cache: "no-store" }
      );
      if (!response.ok) {
        await discardResponseBody(response);
        throw new Error(String(response.status));
      }
      const data = (await response.json()) as QueueResponse;
      if (!current()) return;
      setRows(data.items);
      setTotal(data.total);
      setTruncated(data.truncated);
      setFailed(false);
    } catch {
      if (current()) setFailed(true);
    } finally {
      if (current()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [view]);

  useEffect(() => {
    queueMicrotask(() => void load());
    const refresh = () => void load();
    window.addEventListener("admin:refresh", refresh);
    return () => window.removeEventListener("admin:refresh", refresh);
  }, [load]);

  const groups = useMemo(() => buildGroups(rows), [rows]);
  const providers = useMemo(
    () => Array.from(new Set(groups.flatMap((group) => group.providers))).sort(),
    [groups]
  );
  const priorityCounts = useMemo(() => {
    const counts = new Map<ReviewPriority, number>();
    for (const group of groups) {
      counts.set(group.priority, (counts.get(group.priority) ?? 0) + 1);
    }
    return counts;
  }, [groups]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return groups.filter((group) => {
      if (priority !== "all" && group.priority !== priority) return false;
      if (product !== "all" && group.product !== product) return false;
      if (provider !== "all" && !group.providers.includes(provider)) return false;
      if (
        availability !== "all" &&
        !group.members.some((member) => member.availability === availability)
      ) {
        return false;
      }
      if (
        status !== "all" &&
        !group.members.some((member) => member.status === status)
      ) {
        return false;
      }
      if (!term) return true;
      return group.members.some((member) =>
        [
          member.apiModel,
          member.provider,
          member.analysisKo,
          ...member.observedVia.flatMap((item) => [item.provider, item.apiModel]),
        ].some((value) => value.toLowerCase().includes(term))
      );
    });
  }, [availability, groups, priority, product, provider, search, status]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleGroups = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  const openDecision = useCallback(
    (decision: DecisionDialog["decision"], chosen: readonly ModelFamilyGroup[]) => {
      const families = chosen
        .map((group) => ({
          representativeId: group.representative.id,
          workItemIds: decisionIds(group, decision),
          shownAnalysisFingerprint: analysisFingerprint(group.representative.analysisKo),
        }))
        .filter((family) => family.workItemIds.length > 0);
      const workItemIds = families.flatMap((family) => family.workItemIds);
      if (workItemIds.length === 0) {
        dispatchAppToast(m.toast.noApplicableItems, "error");
        return;
      }
      if (workItemIds.length > MAX_BULK_ITEMS) {
        dispatchAppToast(m.toast.tooManyItems(MAX_BULK_ITEMS), "error");
        return;
      }
      setReasonCode("");
      setOperatorReason("");
      // Either decision is checked against the row the operator read, so the
      // representative must be one of the members it covers.
      if (families.some((family) => !family.workItemIds.includes(family.representativeId))) {
        dispatchAppToast(m.toast.representativeNotExcludable, "error");
        return;
      }
      setDialog({ decision, families });
    },
    [m]
  );

  const dialogItemCount = dialog
    ? dialog.families.reduce((sum, family) => sum + family.workItemIds.length, 0)
    : 0;

  const dialogReasonMissing =
    dialog?.decision === "exclude"
      ? !reasonCode || (reasonCode === "other" && !operatorReason.trim())
      : !operatorReason.trim();

  /**
   * Sends the decision in the dialog.
   *
   * The body names the decision and the operator's own reason only. The
   * analysis the row was showing is added by the server, so the record keeps
   * what the queue said apart from what the person said.
   */
  const submitDecision = useCallback(async () => {
    if (!dialog || dialogReasonMissing) return;
    const { decision, families } = dialog;
    const workItemIds = families.flatMap((family) => family.workItemIds);
    setBusyIds(new Set(workItemIds));
    try {
      const response = await adminFetch("/api/admin/model-lifecycle", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          decision === "exclude"
            ? {
                decision,
                reasonCode,
                ...(operatorReason.trim() ? { operatorReason: operatorReason.trim() } : {}),
                families,
              }
            : {
                decision,
                operatorReason: operatorReason.trim(),
                families: families.map(({ representativeId, workItemIds: ids }) => ({
                  representativeId,
                  workItemIds: ids,
                })),
              }
        ),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
      } | null;
      if (!response.ok) {
        if (
          data?.error === "ANALYSIS_CHANGED" ||
          data?.error === "FAMILY_MISMATCH" ||
          data?.error === "QUEUE_TOO_LARGE"
        ) {
          setDialog(null);
          dispatchAppToast(
            data.error === "ANALYSIS_CHANGED"
              ? m.toast.analysisChanged
              : data.error === "FAMILY_MISMATCH"
                ? m.toast.familyChanged
                : m.toast.queueTooLarge,
            "error"
          );
          void load();
          return;
        }
        dispatchAppToast(data?.message || m.toast.transitionRefused, "error");
        return;
      }
      // Any load already in flight read the queue before this decision; its
      // answer would put the decided rows back.
      loadGenerationRef.current += 1;
      setRefreshing(false);
      // Either decision moves the items to the other view.
      const changed = new Set(workItemIds);
      setRows((current) => current.filter((row) => !changed.has(row.id)));
      setTotal((current) => Math.max(0, current - workItemIds.length));
      setSelectedFamilies(new Set());
      setDialog(null);
      dispatchAppToast(
        decision === "exclude"
          ? m.toast.excluded(workItemIds.length)
          : m.toast.reopened(workItemIds.length),
        "success"
      );
    } catch {
      dispatchAppToast(m.toast.unreachable, "error");
    } finally {
      setBusyIds(new Set());
    }
  }, [dialog, dialogReasonMissing, load, m, operatorReason, reasonCode]);

  /**
   * Marks one validation satisfied on an item that owes it.
   *
   * Here because adoption writes `pricing`, `access` and `staging` onto the
   * item, and the rollout gate refuses while any remain. Without a way to tick
   * them off, filling the list in would have made every adopted model
   * unrolloutable -- the gate turned into a wall.
   */
  const clearValidation = useCallback(
    async (row: ModelWorkItemRow, validation: string, note: string) => {
      if (!note.trim()) return;
      setBusyIds(new Set([row.id]));
      try {
        const response = await adminFetch("/api/admin/model-lifecycle/validations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workItemId: row.id,
            completed: [validation],
            note: note.trim(),
          }),
        });
        const data = (await response.json().catch(() => null)) as {
          pendingValidations?: string[];
          error?: string;
        } | null;
        if (!response.ok || !data?.pendingValidations) {
          dispatchAppToast(data?.error || m.toast.validationFailed, "error");
          return;
        }
        const remaining = data.pendingValidations;
        setValidationDialog(null);
        setValidationNote("");
        setRows((current) =>
          current.map((item) =>
            item.id === row.id ? { ...item, pendingValidations: remaining } : item
          )
        );
        dispatchAppToast(
          remaining.length
            ? m.toast.validationRemaining(validation, remaining.length)
            : m.toast.validationNoneRemaining(validation),
          "success"
        );
      } catch {
        dispatchAppToast(m.toast.unreachable, "error");
      } finally {
        setBusyIds(new Set());
      }
    },
    [m]
  );

  const finishRollout = useCallback(
    async (workItemIds: string[], note: string) => {
      if (!note.trim() || workItemIds.length === 0) return;
      setBusyIds(new Set(workItemIds));
      try {
        const response = await adminFetch("/api/admin/model-lifecycle/finish-rollout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workItemIds, note: note.trim() }),
        });
        const data = (await response.json().catch(() => null)) as {
          completed?: number;
          awaitingNotice?: number;
          message?: string;
        } | null;
        if (!response.ok || typeof data?.completed !== "number") {
          dispatchAppToast(data?.message || m.toast.rolloutFailed, "error");
          return;
        }
        setRolloutDialog(null);
        setRolloutNote("");
        setSelectedFamilies(new Set());
        dispatchAppToast(
          m.toast.rolloutFinished(data.completed, data.awaitingNotice ?? 0),
          "success"
        );
        await load();
      } catch {
        dispatchAppToast(m.toast.unreachable, "error");
      } finally {
        setBusyIds(new Set());
      }
    },
    [load, m]
  );

  const rolloutIds = (selected: readonly ModelFamilyGroup[]) =>
    selected.flatMap((group) =>
      group.members.filter((member) => member.rolloutFinishable).map((member) => member.id)
    );
  const selectedRolloutIds =
    view === "open" ? rolloutIds(groups.filter((group) => selectedFamilies.has(group.key))) : [];

  const decideSelected = (decision: DecisionDialog["decision"]) => {
    openDecision(
      decision,
      groups.filter((group) => selectedFamilies.has(group.key))
    );
  };

  const switchView = (next: QueueView) => {
    if (next === view || dialog !== null || busyIds.size > 0) return;
    // Retire any load in flight now, not when the next one starts: that one
    // is only scheduled, and an answer arriving in between is the other view's.
    loadGenerationRef.current += 1;
    setView(next);
    setRows([]);
    setTotal(0);
    setLoading(true);
    setSelectedFamilies(new Set());
    setStatus("all");
    setPage(1);
  };

  const excludeReasonLabel = (code: string | null) =>
    code && (WORK_ITEM_EXCLUSION_REASONS as readonly string[]).includes(code)
      ? m.exclusionReasons[code as WorkItemExclusionReason]
      : m.excluded.noReasonCode;

  const pageFamilyKeys = visibleGroups.map((group) => group.key);
  const allPageSelected =
    pageFamilyKeys.length > 0 &&
    pageFamilyKeys.every((key) => selectedFamilies.has(key));
  const togglePage = () => {
    setSelectedFamilies((current) => {
      const next = new Set(current);
      if (allPageSelected) pageFamilyKeys.forEach((key) => next.delete(key));
      else pageFamilyKeys.forEach((key) => next.add(key));
      return next;
    });
  };

  const columns: AdminDataColumn<ModelFamilyGroup>[] = [
    {
      key: "select",
      header: (
        <input
          type="checkbox"
          checked={allPageSelected}
          onChange={togglePage}
          aria-label={m.table.selectPage}
        />
      ),
      render: (group) => (
        <input
          type="checkbox"
          checked={selectedFamilies.has(group.key)}
          onChange={() =>
            setSelectedFamilies((current) => {
              const next = new Set(current);
              if (next.has(group.key)) next.delete(group.key);
              else next.add(group.key);
              return next;
            })
          }
          aria-label={m.table.selectFamily(group.key)}
        />
      ),
    },
    {
      key: "family",
      header: m.table.modelFamily,
      render: (group) => (
        <div className="min-w-0">
          <span className="break-all font-mono text-xs font-bold text-zinc-100">
            {group.representative.apiModel}
          </span>
          {group.members.length > 1 ? (
            <details className="mt-1 text-xs text-zinc-500">
              <summary className="cursor-pointer">
                {m.table.relatedIds(group.members.length - 1)}
              </summary>
              <ul className="mt-1 space-y-1 pl-3">
                {group.members.map((member) => (
                  <li key={member.id} className="break-all font-mono">
                    {member.apiModel} · {member.status}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ),
    },
    {
      key: "evidence",
      header: m.table.evidence,
      render: (group) => {
        const row = group.representative;
        return (
          <div>
            <div className="mb-1 flex flex-wrap gap-1.5">
              <AdminStatusChip tone={PRIORITY_TONE[group.priority]}>{m.priority[group.priority]}</AdminStatusChip>
              <AdminStatusChip tone={AVAILABILITY_TONE[row.availability]}>
                {m.availability[row.availability]}
              </AdminStatusChip>
              <AdminStatusChip tone="idle">{m.product[row.product]}</AdminStatusChip>
              {row.product === "chat" && group.providers.includes("google") ? (
                <AdminStatusChip tone="info">{m.table.braveReview}</AdminStatusChip>
              ) : null}
            </div>
            <span className="text-xs text-zinc-400">{group.providers.join(", ") || row.provider}</span>
            {row.lifecycle ? <p className="mt-1 text-xs text-amber-300">{row.lifecycle}</p> : null}
            {row.supersededBy ? (
              <p className="mt-1 text-xs text-zinc-500">{m.table.supersededBy(row.supersededBy)}</p>
            ) : null}
          </div>
        );
      },
    },
    {
      key: "analysis",
      header: m.table.analysis,
      render: (group) => {
        const row = group.representative;
        // A verdict, its evidence, then the action. An older row rendered before
        // this shape existed has only the joined paragraph, so it is shown as it
        // is rather than left blank.
        return row.verdictKo ? (
          <div className="max-w-xl space-y-1.5 leading-relaxed">
            <p className="font-bold text-zinc-100">{row.verdictKo}</p>
            {row.pointsKo?.length ? (
              <ul className="space-y-1 text-xs text-zinc-400">
                {row.pointsKo.map((point, index) => (
                  <li key={`${index}-${point.slice(0, 24)}`}>· {point}</li>
                ))}
              </ul>
            ) : null}
            {row.nextStepKo ? (
              <p className="text-xs text-zinc-300">
                <span className="text-zinc-500">{m.table.nextStep} </span>
                {row.nextStepKo}
              </p>
            ) : null}
          </div>
        ) : (
          <span className="max-w-xl leading-relaxed">{row.analysisKo}</span>
        );
      },
    },
    {
      key: "workflow",
      header: m.table.workflow,
      render: (group) => {
        const row = group.representative;
        return view === "excluded" && row.exclusion ? (
          <div className="max-w-[16rem] space-y-1 text-zinc-400">
            <p className="text-zinc-200">{excludeReasonLabel(row.exclusion.reasonCode)}</p>
            {row.exclusion.operatorReason || row.exclusion.note ? (
              <p className="text-xs text-zinc-400">{row.exclusion.operatorReason ?? row.exclusion.note}</p>
            ) : null}
            <p className="text-xs text-zinc-500">
              {m.excluded.by(row.exclusion.actorEmail ?? "—", row.exclusion.excludedAt.slice(0, 10))}
            </p>
            {row.exclusion.analysisSnapshot ? (
              <details className="text-xs text-zinc-500">
                <summary className="cursor-pointer">{m.excluded.analysisAtDecision}</summary>
                <p className="mt-1 leading-relaxed">{row.exclusion.analysisSnapshot}</p>
              </details>
            ) : null}
          </div>
        ) : (
          <span className="text-zinc-400">
            {Array.from(new Set(group.members.map((member) => member.status)))
              .join(", ")
              .replace(/_/g, " ")}
          </span>
        );
      },
    },
    {
      key: "waiting",
      header: m.table.waiting,
      render: (group) => {
        const days = ageDays(group.representative.firstSeenAt);
        return <span className="text-zinc-400">{days === null ? "—" : m.table.days(days)}</span>;
      },
    },
    {
      key: "triage",
      header: m.table.triage,
      render: (group) => {
        const busy = group.members.some((member) => busyIds.has(member.id));
        const adoptable = view === "open" ? adoptableMember(group) : null;
        return (
          <div className="flex max-w-[12rem] flex-wrap gap-1.5">
            {adoptable ? (
              <a
                href={`/admin/models?tab=registry&adopt=${encodeURIComponent(adoptable.id)}`}
                className="inline-flex min-h-8 items-center rounded-xl bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-500"
              >
                {m.table.adopt}
              </a>
            ) : null}
            {view === "open" && imageDraftMember(group) ? (
              isRuntimeImageProvider(imageDraftMember(group)!.provider) ? (
                <a
                  data-testid="model-discovery-image-draft"
                  href={catalogImageDraftHref(imageDraftMember(group)!.provider, imageDraftMember(group)!.apiModel)}
                  className="inline-flex min-h-8 items-center rounded-xl border border-violet-500/40 bg-violet-500/10 px-3 text-xs font-bold text-violet-300 hover:bg-violet-500/20"
                >
                  {m.table.imageDraft}
                </a>
              ) : (
                <span
                  data-testid="model-discovery-image-no-adapter"
                  className="inline-flex min-h-8 items-center rounded-xl border border-dashed border-zinc-700 px-3 text-xs text-zinc-500"
                  title={m.table.noImageAdapterTitle}
                >
                  {m.table.noImageAdapter(imageDraftMember(group)!.provider)}
                </span>
              )
            ) : null}
            {view === "open" && rolloutIds([group]).length > 0 ? (
              <AdminWriteButton
                size="sm"
                variant="primary"
                disabled={busy}
                data-testid="model-discovery-finish-rollout"
                onClick={() => {
                  setRolloutNote("");
                  setRolloutDialog(rolloutIds([group]));
                }}
              >
                {m.table.finishRollout}
              </AdminWriteButton>
            ) : null}
            {view === "open" && decisionIds(group, "exclude").length > 0 ? (
              <AdminWriteButton
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => openDecision("exclude", [group])}
              >
                {m.table.exclude}
              </AdminWriteButton>
            ) : null}
            {view === "excluded" ? (
              <AdminWriteButton
                size="sm"
                variant="secondary"
                disabled={busy || decisionIds(group, "reopen").length === 0}
                onClick={() => openDecision("reopen", [group])}
              >
                {m.table.reopen}
              </AdminWriteButton>
            ) : null}
            {view === "open" &&
              group.representative.pendingValidations?.map((validation) => (
                <AdminWriteButton
                  key={validation}
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setValidationNote("");
                    setValidationDialog({ row: group.representative, validation });
                  }}
                  title={m.table.recordValidationTitle}
                >
                  ✓ {validation}
                </AdminWriteButton>
              ))}
          </div>
        );
      },
    },
  ];

  const filterToolbar = (
    <div className="flex w-full flex-col gap-3">
      <div className="grid gap-2 md:grid-cols-6">
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder={m.filters.searchPlaceholder}
          aria-label={m.filters.searchLabel}
          className={`${selectClass} md:col-span-2`}
        />
        <select
          value={priority}
          onChange={(event) => {
            setPriority(event.target.value as ReviewPriority | "all");
            setPage(1);
          }}
          aria-label={m.filters.priorityLabel}
          className={selectClass}
        >
          <option value="all">{m.filters.allPriorities(groups.length)}</option>
          {PRIORITY_VALUES.map((value) => (
            <option key={value} value={value}>
              {m.priority[value]} ({priorityCounts.get(value) ?? 0})
            </option>
          ))}
        </select>
        <select
          value={product}
          onChange={(event) => {
            setProduct(event.target.value as ModelProduct | "all");
            setPage(1);
          }}
          aria-label={m.filters.productLabel}
          className={selectClass}
        >
          <option value="all">{m.filters.allProducts}</option>
          {PRODUCT_VALUES.map((value) => (
            <option key={value} value={value}>{m.product[value]}</option>
          ))}
        </select>
        <select
          value={provider}
          onChange={(event) => {
            setProvider(event.target.value);
            setPage(1);
          }}
          aria-label={m.filters.providerLabel}
          className={selectClass}
        >
          <option value="all">{m.filters.allProviders}</option>
          {providers.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <select
          value={availability}
          onChange={(event) => {
            setAvailability(event.target.value as Availability | "all");
            setPage(1);
          }}
          aria-label={m.filters.availabilityLabel}
          className={selectClass}
        >
          <option value="all">{m.filters.allAvailability}</option>
          {AVAILABILITY_VALUES.map((value) => (
            <option key={value} value={value}>{m.availability[value]}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {view === "open" ? (
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            aria-label={m.filters.statusLabel}
            className={selectClass}
          >
            <option value="all">{m.filters.allStatuses}</option>
            <option value="discovered">discovered</option>
            <option value="awaiting_decision">awaiting decision</option>
            <option value="deferred">deferred</option>
            <option value="approved">approved</option>
            <option value="implementation_pending">implementation pending</option>
            <option value="validation_pending">validation pending</option>
            <option value="rollout_pending">rollout pending</option>
            <option value="communication_pending">communication pending</option>
          </select>
        ) : null}
        <span className="flex-1 text-xs text-zinc-500">{m.bulk.selected(selectedFamilies.size)}</span>
        {selectedRolloutIds.length > 0 ? (
          <AdminWriteButton
            size="sm"
            variant="primary"
            disabled={busyIds.size > 0}
            onClick={() => {
              setRolloutNote("");
              setRolloutDialog(selectedRolloutIds);
            }}
          >
            {m.bulk.finishRolloutSelected(selectedRolloutIds.length)}
          </AdminWriteButton>
        ) : null}
        <AdminWriteButton
          size="sm"
          variant="secondary"
          disabled={selectedFamilies.size === 0 || busyIds.size > 0}
          onClick={() => decideSelected(view === "open" ? "exclude" : "reopen")}
        >
          {view === "open" ? m.bulk.excludeSelected : m.bulk.reopenSelected}
        </AdminWriteButton>
      </div>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {/*
        Inert while a decision is open or being sent. The decision was made in
        one view about that view's rows; letting focus reach the view switch or
        another row's button would let the answer land on a different list.
      */}
      <div className="flex min-w-0 flex-col gap-5" inert={dialog !== null || busyIds.size > 0 || validationDialog !== null || rolloutDialog !== null}>
        <AdminTile
          title={m.header.title}
          description={m.header.intro}
          action={
            <span className="text-xs text-zinc-500" aria-live="polite">
              {loading
                ? m.header.loading
                : view === "excluded"
                  ? m.header.excludedCounts(total, groups.length)
                  : m.header.counts(total, groups.length)}
              {refreshing && !loading ? ` · ${m.header.refreshing}` : ""}
            </span>
          }
        >
          <div className="flex gap-2" role="group" aria-label={m.views.label}>
            {(["open", "excluded"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => switchView(value)}
                className={`min-h-9 rounded-full border px-4 text-sm font-bold ${
                  view === value
                    ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {value === "open" ? m.views.open : m.views.excluded}
              </button>
            ))}
          </div>
        </AdminTile>

        {failed ? (
          <AdminStateBlock kind="error" title={m.failed} onRetry={() => void load()} />
        ) : null}

        {truncated ? (
          <AdminStateBlock kind="empty" title={board.truncatedTitle} detail={m.truncated} />
        ) : null}

        {loading ? (
          <AdminStateBlock kind="loading" />
        ) : rows.length === 0 && !failed ? (
          <AdminStateBlock
            kind="empty"
            title={board.emptyTitle}
            detail={view === "excluded" ? m.excluded.empty : m.empty}
          />
        ) : rows.length > 0 ? (
          <AdminDataTable
            caption={board.tableCaption}
            columns={columns}
            rows={visibleGroups}
            rowKey={(group) => group.key}
            toolbar={filterToolbar}
            emptyState={<AdminStateBlock kind="empty" title={m.table.noMatches} />}
            footer={
              <div className="flex w-full items-center justify-between gap-3 text-xs text-zinc-500">
                <span>{m.pagination.summary(filtered.length, currentPage, pageCount)}</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setPage(Math.max(1, currentPage - 1))}
                    className="min-h-8 rounded-xl border border-zinc-700 px-3 text-zinc-200 disabled:opacity-40"
                  >
                    {m.pagination.previous}
                  </button>
                  <button
                    type="button"
                    disabled={currentPage >= pageCount}
                    onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
                    className="min-h-8 rounded-xl border border-zinc-700 px-3 text-zinc-200 disabled:opacity-40"
                  >
                    {m.pagination.next}
                  </button>
                </div>
              </div>
            }
          />
        ) : null}
      </div>

      <AdminReasonDialog
        open={dialog !== null}
        title={
          dialog
            ? dialog.decision === "exclude"
              ? m.dialog.excludeTitle(dialog.families.length, dialogItemCount)
              : m.dialog.reopenTitle(dialog.families.length, dialogItemCount)
            : ""
        }
        description={dialog ? (dialog.decision === "exclude" ? m.dialog.excludeNotice : m.dialog.reopenNotice) : undefined}
        confirmLabel={dialog?.decision === "exclude" ? m.dialog.confirmExclude : m.dialog.confirmReopen}
        confirmDisabled={dialogReasonMissing}
        busy={busyIds.size > 0}
        onConfirm={() => void submitDecision()}
        onClose={() => setDialog(null)}
      >
        {dialog?.decision === "exclude" ? (
          <fieldset className="space-y-2 text-sm text-zinc-300">
            <legend className="mb-1 font-bold text-zinc-100">{m.dialog.reasonLegend}</legend>
            {WORK_ITEM_EXCLUSION_REASONS.map((code) => (
              <label key={code} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="model-discovery-exclusion-reason"
                  value={code}
                  checked={reasonCode === code}
                  onChange={() => setReasonCode(code)}
                />
                {m.exclusionReasons[code]}
              </label>
            ))}
          </fieldset>
        ) : null}
        <label className="block text-sm">
          <span className="mb-1 block font-bold text-zinc-100">
            {dialog?.decision === "reopen" || reasonCode === "other"
              ? m.dialog.operatorReasonRequired
              : m.dialog.operatorReasonOptional}
          </span>
          <textarea
            value={operatorReason}
            onChange={(event) => setOperatorReason(event.target.value)}
            maxLength={1_000}
            rows={3}
            className={`${selectClass} w-full`}
          />
        </label>
      </AdminReasonDialog>

      <AdminReasonDialog
        open={validationDialog !== null}
        title={board.validationTitle}
        description={validationDialog ? m.toast.validationPrompt(validationDialog.validation) : undefined}
        confirmLabel={board.validationConfirm}
        confirmDisabled={!validationNote.trim()}
        busy={busyIds.size > 0}
        onConfirm={() =>
          validationDialog && void clearValidation(validationDialog.row, validationDialog.validation, validationNote)
        }
        onClose={() => setValidationDialog(null)}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-bold text-zinc-100">{board.validationNote}</span>
          <textarea
            value={validationNote}
            onChange={(event) => setValidationNote(event.target.value)}
            maxLength={1_000}
            rows={3}
            className={`${selectClass} w-full`}
          />
        </label>
      </AdminReasonDialog>

      <AdminReasonDialog
        open={rolloutDialog !== null}
        title={m.dialog.rolloutTitle}
        description={rolloutDialog ? m.dialog.rolloutDescription(rolloutDialog.length) : undefined}
        confirmLabel={m.dialog.rolloutConfirm}
        confirmDisabled={!rolloutNote.trim()}
        busy={busyIds.size > 0}
        onConfirm={() => rolloutDialog && void finishRollout(rolloutDialog, rolloutNote)}
        onClose={() => setRolloutDialog(null)}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-bold text-zinc-100">{m.dialog.rolloutNote}</span>
          <textarea
            value={rolloutNote}
            onChange={(event) => setRolloutNote(event.target.value)}
            maxLength={1_000}
            rows={3}
            className={`${selectClass} w-full`}
          />
        </label>
      </AdminReasonDialog>
    </div>
  );
}
