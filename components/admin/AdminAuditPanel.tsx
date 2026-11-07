"use client";

import { formatAestDateTime } from "@/lib/adminUiCore";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Clipboard, Download, Eye, Loader2, Search, ShieldCheck, X } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";
import { adminAuditMessages } from "@/lib/adminMessages/audit";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminAuditIntegrityCard } from "@/components/admin/AdminAuditIntegrityPanel";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { useModalDialog } from "@/components/useModalDialog";
import { adminFetch } from "@/lib/adminFetch";
import type { AdminTone } from "@/lib/adminUiCore";

export type AdminAuditRow = {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  metadata?: unknown;
};

type Props = {
  rows: AdminAuditRow[];
  /** How many entries the server read, stated so the list is not read as all. */
  rowLimit?: number;
  /**
   * The id `?entry=` asked for, and the row it resolved to.
   *
   * Both, because they are different facts: an id with no row is a stale link
   * and has something to say on screen, while no id at all is the ordinary
   * case and says nothing. Resolved on the server so a directly-opened link
   * works even when the row is older than the window this panel lists.
   */
  requestedEntryId?: string | null;
  requestedEntry?: AdminAuditRow | null;
};

const dateTimeLabel = (value: string) => formatAestDateTime(value) ?? "-";

const isHighRisk = (action: string) =>
  action.includes("delete") || action.includes("refund.approve");

const actionTone = (action: string): AdminTone => {
  if (isHighRisk(action)) return "bad";
  if (action.includes("billing") || action.includes("refund")) return "warn";
  return "info";
};

const actorLabel = (row: AdminAuditRow, unknownAdmin: string) =>
  row.actorEmail || row.actorUserId || unknownAdmin;

/** A round initial, so a list of people reads as people. */
function ActorBadge({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-xs font-bold uppercase text-blue-300"
    >
      {name.trim().charAt(0) || "?"}
    </span>
  );
}

/**
 * The records as a table: who, what, target, when. Pure, so the screen can be
 * rendered without the router the filters need.
 */
export function AdminAuditTable({
  rows,
  loadingDetailId = null,
  onOpenDetail,
  toolbar,
}: {
  rows: readonly AdminAuditRow[];
  loadingDetailId?: string | null;
  onOpenDetail: (row: AdminAuditRow) => void;
  toolbar?: React.ReactNode;
}) {
  const m = useAdminMessages(adminAuditMessages);
  const detailButton = (row: AdminAuditRow) => (
    <button
      type="button"
      onClick={() => onOpenDetail(row)}
      disabled={loadingDetailId === row.id}
      aria-label={`${m.details}: ${row.action}`}
      className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loadingDetailId === row.id ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Eye className="h-3.5 w-3.5" aria-hidden />
      )}
      {m.details}
    </button>
  );
  const columns: AdminDataColumn<AdminAuditRow>[] = [
    {
      key: "actor",
      header: m.columns.actor,
      render: (row) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <ActorBadge name={actorLabel(row, m.unknownAdmin)} />
          <span className="min-w-0 truncate font-bold text-zinc-100">{row.actorEmail || m.unknownAdmin}</span>
        </div>
      ),
    },
    {
      key: "action",
      header: m.columns.action,
      render: (row) => <AdminStatusChip tone={actionTone(row.action)}>{row.action}</AdminStatusChip>,
    },
    {
      key: "summary",
      header: m.detail.summary,
      render: (row) => <span className="text-zinc-300">{row.summary}</span>,
    },
    {
      key: "target",
      header: m.columns.target,
      render: (row) => (
        <div className="min-w-0 text-xs text-zinc-400">
          <div className="font-bold text-zinc-200">{row.targetType}</div>
          <div className="max-w-[12rem] truncate">{row.targetId || "-"}</div>
        </div>
      ),
    },
    {
      key: "time",
      header: m.columns.time,
      render: (row) => <span className="whitespace-nowrap text-xs text-zinc-400">{dateTimeLabel(row.createdAt)}</span>,
    },
    {
      key: "context",
      header: m.columns.context,
      align: "right",
      hideOnCard: true,
      render: detailButton,
    },
  ];
  return (
    <AdminDataTable
      caption={m.table}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      toolbar={toolbar}
      cardTitle={(row) => (
        <span className="flex min-w-0 items-center gap-2">
          <ActorBadge name={actorLabel(row, m.unknownAdmin)} />
          <span className="truncate">{row.actorEmail || m.unknownAdmin}</span>
        </span>
      )}
      cardMeta={(row) => (
        <span className="flex flex-col items-start gap-1">
          <AdminStatusChip tone={actionTone(row.action)}>{row.action}</AdminStatusChip>
          <span className="whitespace-normal text-zinc-300">{row.summary}</span>
          <span>
            {row.targetType}
            {row.targetId ? ` ${row.targetId}` : ""} · {dateTimeLabel(row.createdAt)}
          </span>
        </span>
      )}
      cardAside={detailButton}
      emptyState={<AdminStateBlock kind="empty" title={m.noMatches} />}
    />
  );
}

/** One entry in full. Request details and metadata stay folded away. */
function AuditDetailDialog({ row, onClose }: { row: AdminAuditRow; onClose: () => void }) {
  const { locale } = useAdminLocale();
  const m = useAdminMessages(adminAuditMessages);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalDialog({ open: true, onClose, dialogRef, panelRef: dialogRef, initialFocusRef: closeRef });

  const copy = async () => {
    const text = [
      "Tomverse Admin Audit Event",
      `Time: ${dateTimeLabel(row.createdAt)}`,
      `Actor: ${row.actorEmail || row.actorUserId || "Unknown admin"}`,
      `Action: ${row.action}`,
      `Target: ${row.targetType} ${row.targetId || ""}`.trim(),
      `IP: ${row.ipAddress || "-"}`,
      `User agent: ${row.userAgent || "-"}`,
      "",
      row.summary,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      dispatchAppToast(m.toast.copied, "success");
    } catch {
      dispatchAppToast(m.toast.copyFailed, "error");
    }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      lang={locale}
      data-locale-root
      className="fixed inset-0 z-[150] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-audit-detail-title"
        data-testid="admin-audit-detail"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-t-3xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-zinc-500">{m.detail.title}</p>
            <h2 id="admin-audit-detail-title" className="mt-0.5 break-words text-lg font-bold text-white">
              {row.action}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={m.detail.close}
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-zinc-400 hover:bg-zinc-800"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <dl className="grid gap-3 rounded-2xl bg-zinc-950/60 p-4 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs text-zinc-500">{m.detail.who}</dt>
            <dd className="mt-0.5 break-all font-bold text-zinc-100">{actorLabel(row, m.unknownAdmin)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-zinc-500">{m.detail.when}</dt>
            <dd className="mt-0.5 font-bold text-zinc-100">{dateTimeLabel(row.createdAt)}</dd>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-xs text-zinc-500">{m.detail.target}</dt>
            <dd className="mt-0.5 break-all text-zinc-100">
              <span className="font-bold">{row.targetType}</span>
              {row.targetId ? ` ${row.targetId}` : ""}
            </dd>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-xs text-zinc-500">{m.detail.summary}</dt>
            <dd className="mt-0.5 leading-6 text-zinc-200">{row.summary}</dd>
          </div>
        </dl>
        <AdminTechInfo summary={m.detail.tech}>
          <p className="break-all">id: {row.id}</p>
          <p className="mt-1 break-all">IP: {row.ipAddress || "-"}</p>
          <p className="mt-1 break-all">UA: {row.userAgent || "-"}</p>
          <pre className="mt-3 max-h-80 overflow-auto rounded-xl bg-zinc-950 p-3 leading-5 text-zinc-300">
            {JSON.stringify(row.metadata || {}, null, 2)}
          </pre>
        </AdminTechInfo>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
          >
            <Clipboard className="h-4 w-4" aria-hidden />
            {m.detail.copy}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

const SELECT_CLASS =
  "h-10 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm font-bold text-zinc-100 outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10";

export function AdminAuditPanel({
  rows,
  rowLimit,
  requestedEntryId = null,
  requestedEntry = null,
}: Props) {
  const m = useAdminMessages(adminAuditMessages);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedTarget = searchParams.get("target");
  const [query, setQuery] = useState(() => searchParams.get("q") || "");
  const [targetFilter, setTargetFilter] = useState(() =>
    requestedTarget && rows.some((row) => row.targetType === requestedTarget)
      ? requestedTarget
      : "all"
  );
  const [actorFilter, setActorFilter] = useState("all");
  const [detail, setDetail] = useState<AdminAuditRow | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  const targets = useMemo(
    () => ["all", ...Array.from(new Set(rows.map((row) => row.targetType))).sort()],
    [rows]
  );
  const actors = useMemo(
    () => [
      "all",
      ...Array.from(
        new Set(
          rows
            .map((row) => row.actorEmail || row.actorUserId)
            .filter((value): value is string => Boolean(value))
        )
      ).sort(),
    ],
    [rows]
  );

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (targetFilter !== "all" && row.targetType !== targetFilter) return false;
      if (actorFilter !== "all" && (row.actorEmail || row.actorUserId) !== actorFilter) return false;
      if (!normalizedQuery) return true;
      return [
        // `id` first, because the id is what the integrity checker hands an
        // operator and pasting it in was the obvious thing that did nothing.
        row.id,
        row.actorEmail,
        row.actorUserId,
        row.action,
        row.targetType,
        row.targetId,
        row.summary,
        row.ipAddress,
        row.userAgent,
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedQuery));
    });
  }, [query, rows, targetFilter, actorFilter]);

  const highRiskCount = rows.filter((row) => isHighRisk(row.action)).length;
  const uniqueActors = actors.length - 1;

  const updateLocation = (nextQuery: string, nextTarget: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextQuery.trim()) params.set("q", nextQuery);
    else params.delete("q");
    if (nextTarget === "all") params.delete("target");
    else params.set("target", nextTarget);
    const suffix = params.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
  };

  const loadDetail = async (row: AdminAuditRow) => {
    setLoadingDetailId(row.id);
    try {
      const response = await adminFetch(`/api/admin/audit/${row.id}`);
      const data = (await response.json().catch(() => null)) as {
        audit?: AdminAuditRow;
        error?: string;
      } | null;
      if (!response.ok || !data?.audit) {
        throw new Error(data?.error || m.toast.detailFailed);
      }
      setDetail(data.audit);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : m.toast.detailFailed,
        "error"
      );
    } finally {
      setLoadingDetailId(null);
    }
  };

  const exportCsv = () => {
    const escapeCsv = (value: string | null) =>
      `"${(value || "").replaceAll('"', '""').replaceAll("\n", " ")}"`;
    const csv = [
      ["time", "actor", "action", "targetType", "targetId", "summary", "ipAddress"].join(","),
      ...filteredRows.map((row) =>
        [
          dateTimeLabel(row.createdAt),
          row.actorEmail || row.actorUserId || "",
          row.action,
          row.targetType,
          row.targetId || "",
          row.summary,
          row.ipAddress || "",
        ]
          .map(escapeCsv)
          .join(",")
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tomverse-admin-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminAuditIntegrityCard />

      {/* A row named in the URL, rendered whether or not it is in that
          window. The integrity checker walks oldest-first and stops at the
          first bad row, so the id it hands over is usually older than
          anything listed below -- which is why "entry X is invalid" used to
          be a dead end. */}
      {requestedEntryId && requestedEntry ? (
        <AdminTile
          title={m.requestedEntry}
          className="border-blue-900"
          data-testid="admin-audit-requested-entry"
        >
          <p className="break-all font-mono text-xs text-zinc-400">{requestedEntry.id}</p>
          <p className="text-sm font-bold text-white">{requestedEntry.action}</p>
          <p className="text-xs text-zinc-400">
            {dateTimeLabel(requestedEntry.createdAt)} ·{" "}
            {requestedEntry.actorEmail || requestedEntry.actorUserId || m.unknownAdmin} ·{" "}
            {requestedEntry.targetType}
            {requestedEntry.targetId ? ` ${requestedEntry.targetId}` : ""}
          </p>
          <p className="text-sm leading-6 text-zinc-200">{requestedEntry.summary}</p>
          <div>
            <button
              type="button"
              onClick={() => void loadDetail(requestedEntry)}
              className="min-h-10 cursor-pointer rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
              data-testid="admin-audit-requested-entry-open"
            >
              {m.openFullEntry}
            </button>
          </div>
        </AdminTile>
      ) : null}

      {/* A link that resolves to nothing is a different fact from no link,
          and saying so beats a workspace that silently ignores its own query
          string. */}
      {requestedEntryId && !requestedEntry ? (
        <div data-testid="admin-audit-requested-entry-missing">
          <AdminStateBlock
            kind="error"
            title={
              <>
                {m.missingEntryBefore} <span className="font-mono break-all">{requestedEntryId}</span>
                {m.missingEntryAfter}
              </>
            }
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white">{m.title}</h2>
          <p className="mt-0.5 text-sm text-zinc-400">
            {m.description}
            {rowLimit ? m.rowLimit(rowLimit) : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-900 px-4 text-sm font-bold text-zinc-100 hover:bg-zinc-800"
        >
          <Download className="h-4 w-4" aria-hidden />
          {m.exportCsv}
        </button>
      </div>

      <AdminAuditTable
        rows={filteredRows}
        loadingDetailId={loadingDetailId}
        onOpenDetail={(row) => void loadDetail(row)}
        toolbar={
          <>
            <label className="relative block min-w-[12rem] flex-1">
              <span className="sr-only">{m.searchLabel}</span>
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                aria-hidden
              />
              <input
                value={query}
                onChange={(event) => {
                  const value = event.target.value;
                  setQuery(value);
                  updateLocation(value, targetFilter);
                }}
                placeholder={m.searchPlaceholder}
                className="h-10 w-full rounded-xl border border-zinc-700 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
              />
            </label>
            <select
              aria-label={m.actorFilter}
              value={actorFilter}
              onChange={(event) => setActorFilter(event.target.value)}
              className={SELECT_CLASS}
            >
              {actors.map((actor) => (
                <option key={actor} value={actor}>
                  {actor === "all" ? m.allActors : actor}
                </option>
              ))}
            </select>
            <select
              aria-label={m.targetFilter}
              value={targetFilter}
              onChange={(event) => {
                const value = event.target.value;
                setTargetFilter(value);
                updateLocation(query, value);
              }}
              className={SELECT_CLASS}
            >
              {targets.map((target) => (
                <option key={target} value={target}>
                  {target === "all" ? m.allTargets : target}
                </option>
              ))}
            </select>
            <span className="w-full text-xs text-zinc-500">
              {m.summaryLine(rows.length, uniqueActors, highRiskCount)}
            </span>
          </>
        }
      />

      <p className="flex items-start gap-2 rounded-2xl bg-blue-500/10 p-4 text-sm leading-6 text-blue-200">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {m.footer}
      </p>

      {detail ? <AuditDetailDialog row={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}
