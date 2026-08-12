import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  WORK_QUEUE_SOURCE_LIMIT,
  workQueueAgeHours,
  type AdminWorkQueue,
  type WorkQueueSeverity,
} from "@/lib/adminWorkQueue";

const severityClass = (severity: WorkQueueSeverity) =>
  severity === "critical"
    ? "border-red-500/30 bg-red-500/10 text-red-100"
    : severity === "high"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
      : "border-zinc-800 bg-zinc-900/70 text-zinc-200";

const ageLabel = (hours: number | null) => {
  if (hours === null) return "no start time";
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours}h open`;
  return `${Math.floor(hours / 24)}d open`;
};

export function AdminWorkQueuePanel({
  queue,
  now,
}: {
  queue: AdminWorkQueue;
  now: Date;
}) {
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-black text-white">Open work, oldest first</h2>
        <p className="text-sm text-zinc-400">
          {queue.items.length} item{queue.items.length === 1 ? "" : "s"}
        </p>
      </div>
      <p className="mt-1 text-sm leading-6 text-zinc-400">
        Approvals, refunds, incidents, support, privacy requests, webhooks, alerts
        and scheduled jobs, ranked by severity and then by age. Each row opens the
        page that owns the action.
      </p>

      {queue.failedCategories.length > 0 ? (
        <p className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
          Could not load {queue.failedCategories.join(", ")}. This queue is
          incomplete — do not read it as clear.
        </p>
      ) : null}
      {queue.truncatedCategories.length > 0 ? (
        <p className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
          Showing the {WORK_QUEUE_SOURCE_LIMIT} oldest of{" "}
          {queue.truncatedCategories.join(", ")}. Open the owning page for the full
          list.
        </p>
      ) : null}

      <div className="mt-5 grid gap-2">
        {queue.items.length === 0 ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            Nothing is waiting on an operator.
          </div>
        ) : (
          queue.items.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              className={`flex items-start gap-3 rounded-2xl border p-4 transition hover:brightness-110 ${severityClass(
                item.severity
              )}`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-current/30 px-2 py-0.5 text-xs font-black uppercase tracking-wide">
                    {item.category}
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wide opacity-80">
                    {item.severity}
                  </span>
                  <span className="text-xs opacity-80">
                    {ageLabel(workQueueAgeHours(item.openedAt, now))}
                  </span>
                </span>
                <span className="mt-1.5 block truncate text-sm font-black text-white">
                  {item.title}
                </span>
                <span className="mt-0.5 block truncate text-xs opacity-80">
                  {item.detail}
                </span>
              </span>
              <ArrowRight className="mt-1 h-4 w-4 shrink-0 opacity-70" aria-hidden />
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
