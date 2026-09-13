import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { AdminMessageShape } from "@/lib/adminLocale";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminWorkQueueMessages } from "@/lib/adminMessages/workQueue";
import {
  WORK_QUEUE_SOURCE_LIMIT,
  workQueueAgeHours,
  type AdminWorkQueue,
  type WorkQueueSeverity,
} from "@/lib/adminWorkQueue";

type QueueMessages = AdminMessageShape<
  (typeof adminWorkQueueMessages)["en"]["queue"]
>;

const severityClass = (severity: WorkQueueSeverity) =>
  severity === "critical"
    ? "border-red-500/30 bg-red-500/10 text-red-100"
    : severity === "high"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
      : "border-zinc-800 bg-zinc-900/70 text-zinc-200";

const ageLabel = (hours: number | null, m: QueueMessages["age"]) => {
  if (hours === null) return m.noStartTime;
  if (hours < 1) return m.underAnHour;
  if (hours < 48) return m.hours(hours);
  return m.days(Math.floor(hours / 24));
};

/** A category the queue does not know is shown as it arrives. */
const categoryLabel = (category: string, m: QueueMessages) =>
  (m.categories as Readonly<Record<string, string>>)[category] ?? category;

export async function AdminWorkQueuePanel({
  queue,
  now,
}: {
  queue: AdminWorkQueue;
  now: Date;
}) {
  const { queue: m } = await getAdminMessages(adminWorkQueueMessages);
  const categoryList = (categories: readonly string[]) =>
    categories.map((category) => categoryLabel(category, m)).join(", ");

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-black text-white">{m.title}</h2>
        <p className="text-sm text-zinc-400">{m.itemCount(queue.items.length)}</p>
      </div>
      <p className="mt-1 text-sm leading-6 text-zinc-400">{m.description}</p>

      {queue.failedCategories.length > 0 ? (
        <p className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100">
          {m.failed(categoryList(queue.failedCategories))}
        </p>
      ) : null}
      {queue.truncatedCategories.length > 0 ? (
        <p className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
          {m.truncated(
            WORK_QUEUE_SOURCE_LIMIT,
            categoryList(queue.truncatedCategories)
          )}
        </p>
      ) : null}

      <div className="mt-5 grid gap-2">
        {queue.items.length === 0 ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            {m.empty}
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
                    {categoryLabel(item.category, m)}
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wide opacity-80">
                    {m.severity[item.severity]}
                  </span>
                  <span className="text-xs opacity-80">
                    {ageLabel(workQueueAgeHours(item.openedAt, now), m.age)}
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
