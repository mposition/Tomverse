"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, PackageSearch, RefreshCw } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
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

const PRIORITY_LABELS: Record<ReviewPriority, string> = {
  recommended: "권장 검토",
  review: "패밀리 검토",
  needs_evidence: "근거 확인 필요",
  low: "낮은 우선순위",
  no_action: "조치 비권장",
};

const AVAILABILITY_LABELS: Record<Availability, string> = {
  current: "최신 API 확인",
  stale: "최신 API 미확인",
  unknown: "확인 불가",
};

const PRODUCT_LABELS: Record<ModelProduct, string> = {
  chat: "Chat",
  image_generation: "이미지 생성",
  unsupported: "미지원 제품",
};

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
        dispatchAppToast("선택한 그룹에 적용 가능한 항목이 없습니다.", "error");
        return;
      }
      if (workItemIds.length > MAX_BULK_ITEMS) {
        dispatchAppToast("한 번에 최대 200개 항목까지 처리할 수 있습니다.", "error");
        return;
      }
      if (
        to === "closed_no_action" &&
        !window.confirm(
          `${workItemIds.length}개 항목을 'No action'으로 종료할까요? 이 상태는 되돌릴 수 없습니다.`
        )
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
            data?.message || "The queue refused that transition.",
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
        dispatchAppToast(`${workItemIds.length}개 항목을 업데이트했습니다.`, "success");
      } catch {
        dispatchAppToast("The request did not reach the server.", "error");
      } finally {
        setBusyIds(new Set());
      }
    },
    []
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
      dispatchAppToast("벌크 검토 사유를 먼저 입력해 주세요.", "error");
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
        <h2 className="text-sm font-semibold text-zinc-100">Awaiting review</h2>
        <span className="text-xs text-zinc-500">
          {loading ? "loading" : `${total} items · ${groups.length} families`}
        </span>
        {refreshing && !loading ? (
          <Loader2 className="h-3 w-3 animate-spin text-zinc-500" aria-label="Refreshing" />
        ) : null}
      </header>

      <p className="mb-4 text-xs leading-relaxed text-zinc-500">
        공급자의 최신 모델 API 증거와 Tomverse 제품별 편입 가치를 분리해 보여줍니다.
        이미지 모델은 Studio 후보로, Google 채팅 모델은 Brave 웹검색 경로까지 검토합니다.
        날짜별 버전과 별칭은 한 패밀리로 묶이며, 추천은 자동 결정이 아닙니다.
      </p>

      {failed ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
          <span>큐를 읽지 못했습니다. 현재 목록이 최신이라는 뜻이 아닙니다.</span>
          <button type="button" onClick={() => void load()} className="flex items-center gap-1">
            <RefreshCw className="h-3 w-3" /> 다시 시도
          </button>
        </div>
      ) : null}

      {truncated ? (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          안전 한도인 1,000개까지만 불러왔습니다. 필터 집계는 로드된 항목 기준입니다.
        </p>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-zinc-400">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading the backlog…
        </p>
      ) : rows.length === 0 && !failed ? (
        <p className="text-xs text-zinc-400">
          Nothing is waiting. Discovery runs daily at 10:00 Australia/Brisbane.
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
              placeholder="모델·공급자·분석 검색"
              aria-label="Search model review queue"
              className={`${selectClass} md:col-span-2`}
            />
            <select
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value as ReviewPriority | "all");
                setPage(1);
              }}
              aria-label="Filter by review priority"
              className={selectClass}
            >
              <option value="all">모든 우선순위 ({groups.length})</option>
              {(Object.keys(PRIORITY_LABELS) as ReviewPriority[]).map((value) => (
                <option key={value} value={value}>
                  {PRIORITY_LABELS[value]} ({priorityCounts.get(value) ?? 0})
                </option>
              ))}
            </select>
            <select
              value={product}
              onChange={(event) => {
                setProduct(event.target.value as ModelProduct | "all");
                setPage(1);
              }}
              aria-label="Filter by Tomverse product"
              className={selectClass}
            >
              <option value="all">모든 제품</option>
              {(Object.keys(PRODUCT_LABELS) as ModelProduct[]).map((value) => (
                <option key={value} value={value}>{PRODUCT_LABELS[value]}</option>
              ))}
            </select>
            <select
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                setPage(1);
              }}
              aria-label="Filter by provider"
              className={selectClass}
            >
              <option value="all">모든 공급자</option>
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
              aria-label="Filter by provider availability"
              className={selectClass}
            >
              <option value="all">모든 제공 상태</option>
              {(Object.keys(AVAILABILITY_LABELS) as Availability[]).map((value) => (
                <option key={value} value={value}>{AVAILABILITY_LABELS[value]}</option>
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
              aria-label="Filter by workflow status"
              className={selectClass}
            >
              <option value="all">모든 워크플로 상태</option>
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
              placeholder="벌크 검토 사유 (필수, 선택 항목에 공통 기록)"
              aria-label="Bulk review reason"
              className={`${selectClass} min-w-[18rem] flex-1`}
            />
            <span className="text-xs text-zinc-500">
              {selectedFamilies.size} families selected
            </span>
            {[
              ["awaiting_decision", "Needs decision"],
              ["deferred", "Not yet"],
              ["closed_no_action", "No action"],
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
                      aria-label="Select all families on this page"
                    />
                  </th>
                  <th className="py-2 pr-3 font-medium">Model family</th>
                  <th className="py-2 pr-3 font-medium">Evidence</th>
                  <th className="w-[32rem] py-2 pr-3 font-medium">Tomverse 분석</th>
                  <th className="py-2 pr-3 font-medium">Workflow</th>
                  <th className="py-2 pr-3 font-medium">Waiting</th>
                  <th className="py-2 pr-3 font-medium">Triage</th>
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
                          aria-label={`Select ${group.key}`}
                        />
                      </td>
                      <td className="py-3 pr-3">
                        <span className="break-all font-mono text-[11px] text-zinc-100">
                          {row.apiModel}
                        </span>
                        {group.members.length > 1 ? (
                          <details className="mt-1 text-[11px] text-zinc-500">
                            <summary className="cursor-pointer">
                              +{group.members.length - 1} related IDs
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
                            {PRIORITY_LABELS[group.priority]}
                          </span>
                          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${availabilityClass(row.availability)}`}>
                            {AVAILABILITY_LABELS[row.availability]}
                          </span>
                          <span
                            className={
                              row.product === "image_generation"
                                ? "rounded border border-accent-image-500/30 bg-accent-image-500/10 px-1.5 py-0.5 text-[10px] text-accent-image-200"
                                : "rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300"
                            }
                          >
                            {PRODUCT_LABELS[row.product]}
                          </span>
                          {row.product === "chat" && group.providers.includes("google") ? (
                            <span className="rounded border border-accent-web-search-500/30 bg-accent-web-search-500/10 px-1.5 py-0.5 text-[10px] text-accent-web-search-200">
                              Brave 웹검색 검토
                            </span>
                          ) : null}
                        </div>
                        <span className="text-[11px] text-zinc-400">
                          {group.providers.join(", ") || row.provider}
                        </span>
                        {row.lifecycle ? (
                          <p className="mt-1 text-[10px] text-amber-300">{row.lifecycle}</p>
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
                        {days === null ? "—" : `${days}d`}
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex max-w-[12rem] flex-wrap gap-1">
                          {[
                            ["awaiting_decision", "Needs decision"],
                            ["deferred", "Not yet"],
                            ["closed_no_action", "No action"],
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
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleGroups.length === 0 ? (
              <p className="p-6 text-center text-xs text-zinc-500">
                현재 필터에 맞는 모델 패밀리가 없습니다.
              </p>
            ) : null}
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
            <span>{filtered.length} families · page {currentPage} / {pageCount}</span>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setPage(Math.max(1, currentPage - 1))}
                className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={currentPage >= pageCount}
                onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
                className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
