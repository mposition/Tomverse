"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, PackageSearch, RefreshCw } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminModelDiscoveryMessages } from "@/lib/adminMessages/modelDiscovery";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { discardResponseBody } from "@/lib/discardResponseBody";

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
  /** Verifications still owed before rollout, ticked off from this panel. */
  pendingValidations?: string[];
  familyKey: string;
  familySize: number;
  reviewPriority: ReviewPriority;
  reviewKind: string;
  product: ModelProduct;
  analysisKo: string;
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

const priorityClass = (priority: ReviewPriority) => {
  if (priority === "recommended") {
    return "border-blue-500/30 bg-blue-500/10 text-blue-200";
  }
  if (priority === "review") {
    return "border-purple-500/30 bg-purple-500/10 text-purple-200";
  }
  if (priority === "needs_evidence") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  }
  return "border-zinc-700 bg-zinc-800 text-zinc-300";
};

const availabilityClass = (availability: Availability) => {
  if (availability === "current") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  }
  if (availability === "unknown") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  }
  return "border-zinc-700 bg-zinc-800 text-zinc-400";
};

const transitionableIds = (group: ModelFamilyGroup, to: string) => {
  const allowedFrom =
    to === "awaiting_decision"
      ? new Set(["discovered", "deferred"])
      : to === "deferred"
        ? new Set(["discovered", "awaiting_decision"])
        : new Set(["discovered", "awaiting_decision", "deferred"]);
  return group.members
    .filter((member) => allowedFrom.has(member.status))
    .map((member) => member.id);
};

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
 * about a model the registry already has, and a closed item is a decision
 * somebody made: reopening it is a new work item, not a button.
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
  const [bulkNote, setBulkNote] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/admin/model-lifecycle", {
        cache: "no-store",
      });
      if (!response.ok) {
        await discardResponseBody(response);
        throw new Error(String(response.status));
      }
      const data = (await response.json()) as QueueResponse;
      setRows(data.items);
      setTotal(data.total);
      setTruncated(data.truncated);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

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

  const move = useCallback(
    async (workItemIds: string[], to: string, note: string) => {
      if (workItemIds.length === 0) {
        dispatchAppToast(m.toast.noApplicableItems, "error");
        return;
      }
      if (workItemIds.length > MAX_BULK_ITEMS) {
        dispatchAppToast(m.toast.tooManyItems(MAX_BULK_ITEMS), "error");
        return;
      }
      if (
        to === "closed_no_action" &&
        !window.confirm(m.toast.closeConfirm(workItemIds.length))
      ) {
        return;
      }

      setBusyIds(new Set(workItemIds));
      try {
        const response = await fetch("/api/admin/model-lifecycle", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workItemIds, to, note }),
        });
        const data = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        if (!response.ok) {
          dispatchAppToast(
            data?.message || m.toast.transitionRefused,
            "error"
          );
          return;
        }

        const changed = new Set(workItemIds);
        setRows((current) =>
          to === "closed_no_action"
            ? current.filter((row) => !changed.has(row.id))
            : current.map((row) =>
                changed.has(row.id) ? { ...row, status: to } : row
              )
        );
        if (to === "closed_no_action") {
          setTotal((current) => Math.max(0, current - workItemIds.length));
        }
        setSelectedFamilies(new Set());
        dispatchAppToast(m.toast.updated(workItemIds.length), "success");
      } catch {
        dispatchAppToast(m.toast.unreachable, "error");
      } finally {
        setBusyIds(new Set());
      }
    },
    [m]
  );

  /**
   * Marks one validation satisfied on an item that owes it.
   *
   * Here because adoption writes `pricing`, `access` and `staging` onto the
   * item, and the rollout gate refuses while any remain. Without a way to tick
   * them off, filling the list in would have made every adopted model
   * unrolloutable -- the gate turned into a wall.
   */
  const clearValidation = useCallback(
    async (row: ModelWorkItemRow, validation: string) => {
      const note = window.prompt(m.toast.validationPrompt(validation));
      if (!note?.trim()) return;
      setBusyIds(new Set([row.id]));
      try {
        const response = await fetch("/api/admin/model-lifecycle/validations", {
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

  const moveGroup = (group: ModelFamilyGroup, to: string) => {
    void move(
      transitionableIds(group, to),
      to,
      `${group.representative.analysisKo} 관리자 패밀리 검토.`
    );
  };

  const moveSelected = (to: string) => {
    const note = bulkNote.trim();
    if (!note) {
      dispatchAppToast(m.toast.bulkReasonRequired, "error");
      return;
    }
    const ids = Array.from(
      new Set(
        groups
          .filter((group) => selectedFamilies.has(group.key))
          .flatMap((group) => transitionableIds(group, to))
      )
    );
    void move(ids, to, note);
  };

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

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <PackageSearch className="h-4 w-4 text-zinc-400" aria-hidden />
        <h2 className="text-sm font-semibold text-zinc-100">{m.header.title}</h2>
        <span className="text-xs text-zinc-500">
          {loading ? m.header.loading : m.header.counts(total, groups.length)}
        </span>
        {refreshing && !loading ? (
          <Loader2 className="h-3 w-3 animate-spin text-zinc-500" aria-label={m.header.refreshing} />
        ) : null}
      </header>

      <p className="mb-4 text-xs leading-relaxed text-zinc-500">
        {m.header.intro}
      </p>

      {failed ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
          <span>{m.failed}</span>
          <button type="button" onClick={() => void load()} className="flex items-center gap-1">
            <RefreshCw className="h-3 w-3" /> {m.retry}
          </button>
        </div>
      ) : null}

      {truncated ? (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          {m.truncated}
        </p>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-zinc-400">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> {m.loadingBacklog}
        </p>
      ) : rows.length === 0 && !failed ? (
        <p className="text-xs text-zinc-400">
          {m.empty}
        </p>
      ) : (
        <>
          <div className="mb-3 grid gap-2 md:grid-cols-6">
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

          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
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
            <input
              value={bulkNote}
              onChange={(event) => setBulkNote(event.target.value)}
              maxLength={1_000}
              placeholder={m.bulk.reasonPlaceholder}
              aria-label={m.bulk.reasonLabel}
              className={`${selectClass} min-w-[18rem] flex-1`}
            />
            <span className="text-xs text-zinc-500">
              {m.bulk.selected(selectedFamilies.size)}
            </span>
            {[
              ["awaiting_decision", m.transitions.needsDecision],
              ["deferred", m.transitions.notYet],
              ["closed_no_action", m.transitions.noAction],
            ].map(([to, label]) => (
              <button
                key={to}
                type="button"
                disabled={selectedFamilies.size === 0 || busyIds.size > 0}
                onClick={() => moveSelected(to)}
                className="rounded border border-zinc-600 px-2 py-1.5 text-xs text-zinc-200 disabled:opacity-40"
              >
                {label}
              </button>
            ))}
          </div>

          <div className="max-h-[42rem] overflow-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[78rem] text-left text-xs">
              <thead className="sticky top-0 z-10 bg-zinc-950 text-zinc-500">
                <tr>
                  <th className="w-10 px-3 py-2 font-medium">
                    <input
                      type="checkbox"
                      checked={allPageSelected}
                      onChange={togglePage}
                      aria-label={m.table.selectPage}
                    />
                  </th>
                  <th className="py-2 pr-3 font-medium">{m.table.modelFamily}</th>
                  <th className="py-2 pr-3 font-medium">{m.table.evidence}</th>
                  <th className="w-[32rem] py-2 pr-3 font-medium">{m.table.analysis}</th>
                  <th className="py-2 pr-3 font-medium">{m.table.workflow}</th>
                  <th className="py-2 pr-3 font-medium">{m.table.waiting}</th>
                  <th className="py-2 pr-3 font-medium">{m.table.triage}</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {visibleGroups.map((group) => {
                  const row = group.representative;
                  const days = ageDays(row.firstSeenAt);
                  const busy = group.members.some((member) => busyIds.has(member.id));
                  return (
                    <tr key={group.key} className="border-t border-zinc-800/70 align-top">
                      <td className="px-3 py-3">
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
                      </td>
                      <td className="py-3 pr-3">
                        <span className="break-all font-mono text-[11px] text-zinc-100">
                          {row.apiModel}
                        </span>
                        {group.members.length > 1 ? (
                          <details className="mt-1 text-[11px] text-zinc-500">
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
                      </td>
                      <td className="py-3 pr-3">
                        <div className="mb-1 flex flex-wrap gap-1">
                          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${priorityClass(group.priority)}`}>
                            {m.priority[group.priority]}
                          </span>
                          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${availabilityClass(row.availability)}`}>
                            {m.availability[row.availability]}
                          </span>
                          <span
                            className={
                              row.product === "image_generation"
                                ? "rounded border border-accent-image-500/30 bg-accent-image-500/10 px-1.5 py-0.5 text-[10px] text-accent-image-200"
                                : "rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300"
                            }
                          >
                            {m.product[row.product]}
                          </span>
                          {row.product === "chat" && group.providers.includes("google") ? (
                            <span className="rounded border border-accent-web-search-500/30 bg-accent-web-search-500/10 px-1.5 py-0.5 text-[10px] text-accent-web-search-200">
                              {m.table.braveReview}
                            </span>
                          ) : null}
                        </div>
                        <span className="text-[11px] text-zinc-400">
                          {group.providers.join(", ") || row.provider}
                        </span>
                        {row.lifecycle ? (
                          <p className="mt-1 text-[10px] text-amber-300">{row.lifecycle}</p>
                        ) : null}
                        {row.supersededBy ? (
                          <p className="mt-1 text-[10px] text-zinc-500">
                            {m.table.supersededBy(row.supersededBy)}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-3 pr-3 leading-relaxed text-zinc-300">
                        {row.analysisKo}
                      </td>
                      <td className="py-3 pr-3 text-zinc-400">
                        {Array.from(new Set(group.members.map((member) => member.status)))
                          .join(", ")
                          .replace(/_/g, " ")}
                      </td>
                      <td className="py-3 pr-3 text-zinc-400">
                        {days === null ? "—" : m.table.days(days)}
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex max-w-[12rem] flex-wrap gap-1">
                          {[
                            ["awaiting_decision", m.transitions.needsDecision],
                            ["deferred", m.transitions.notYet],
                            ["closed_no_action", m.transitions.noAction],
                          ].map(([to, label]) => (
                            <button
                              key={to}
                              type="button"
                              disabled={busy || transitionableIds(group, to).length === 0}
                              onClick={() => moveGroup(group, to)}
                              className="rounded border border-zinc-600 px-2 py-1 text-[11px] text-zinc-200 disabled:opacity-40"
                            >
                              {label}
                            </button>
                          ))}
                          {group.representative.pendingValidations?.map((validation) => (
                            <button
                              key={validation}
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void clearValidation(group.representative, validation)
                              }
                              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200 disabled:opacity-40"
                              title={m.table.recordValidationTitle}
                            >
                              ✓ {validation}
                            </button>
                          ))}
                          {adoptableMember(group) ? (
                            <a
                              href={`/admin/models?tab=registry&adopt=${encodeURIComponent(
                                adoptableMember(group)!.id
                              )}`}
                              className="rounded border border-blue-500/40 bg-blue-500/10 px-2 py-1 text-[11px] font-bold text-blue-200 hover:bg-blue-500/20"
                            >
                              {m.table.adopt}
                            </a>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleGroups.length === 0 ? (
              <p className="p-6 text-center text-xs text-zinc-500">
                {m.table.noMatches}
              </p>
            ) : null}
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
            <span>{m.pagination.summary(filtered.length, currentPage, pageCount)}</span>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setPage(Math.max(1, currentPage - 1))}
                className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40"
              >
                {m.pagination.previous}
              </button>
              <button
                type="button"
                disabled={currentPage >= pageCount}
                onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
                className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40"
              >
                {m.pagination.next}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
