import { OPEN_WORK_ITEM_STATUSES } from "@/lib/modelLifecycleWorkItemCore";
import { prisma } from "@/lib/prisma";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";

/**
 * One queue for everything waiting on an operator.
 *
 * The Work queue used to be five full management panels stacked on top of each
 * other -- the operations snapshot, approvals, scheduled jobs, the refund table
 * and the feedback inbox -- each with its own filters, its own actions and its
 * own scroll. Nothing ordered them, so an eight-day-old refund sat below a
 * job that ran twenty minutes late, and every one of those panels also exists
 * on its own page. This module produces a single ranked list instead: what is
 * open, how old it is, how bad it is, and where to go to act on it.
 */

export const WORK_QUEUE_SOURCE_LIMIT = 25;

export type WorkQueueSeverity = "critical" | "high" | "normal";

export type WorkQueueItem = {
  id: string;
  category: string;
  severity: WorkQueueSeverity;
  title: string;
  detail: string;
  href: string;
  /** When the item started waiting, or null when the source records no time. */
  openedAt: string | null;
};

export type AdminWorkQueue = {
  items: WorkQueueItem[];
  /**
   * Categories whose source hit `WORK_QUEUE_SOURCE_LIMIT`, so the queue is
   * showing a slice rather than everything. Reported on screen -- a truncated
   * list presented as complete is how a backlog gets missed.
   */
  truncatedCategories: string[];
  /** Sources that failed to load, so an empty queue is never read as "clear". */
  failedCategories: string[];
};

const SEVERITY_RANK: Record<WorkQueueSeverity, number> = {
  critical: 0,
  high: 1,
  normal: 2,
};

export const workQueueAgeHours = (openedAt: string | null, now: Date) =>
  openedAt
    ? Math.max(0, Math.floor((now.getTime() - new Date(openedAt).getTime()) / 3_600_000))
    : null;

export async function loadAdminWorkQueue(now = new Date()): Promise<AdminWorkQueue> {
  const [
    approvals,
    refunds,
    feedback,
    privacyRequests,
    incidents,
    webhooks,
    alerts,
    modelLifecycle,
    jobs,
  ] = await Promise.allSettled([
    prisma.adminActionApproval.findMany({
      where: { status: "pending", expiresAt: { gt: now } },
      orderBy: { createdAt: "asc" },
      take: WORK_QUEUE_SOURCE_LIMIT,
    }),
    prisma.refundRequest.findMany({
      where: { status: "pending" },
      orderBy: { requestedAt: "asc" },
      take: WORK_QUEUE_SOURCE_LIMIT,
      select: { id: true, email: true, plan: true, reason: true, requestedAt: true },
    }),
    prisma.feedback.findMany({
      where: { status: "open" },
      orderBy: { createdAt: "asc" },
      take: WORK_QUEUE_SOURCE_LIMIT,
      select: {
        id: true,
        email: true,
        type: true,
        message: true,
        createdAt: true,
      },
    }),
    prisma.privacyRequest.findMany({
      where: { status: "open" },
      orderBy: { dueAt: "asc" },
      take: WORK_QUEUE_SOURCE_LIMIT,
      select: {
        id: true,
        email: true,
        requestType: true,
        dueAt: true,
        legalHold: true,
        createdAt: true,
      },
    }),
    prisma.adminProviderIncident.findMany({
      where: { status: { not: "resolved" } },
      orderBy: { startsAt: "asc" },
      take: WORK_QUEUE_SOURCE_LIMIT,
      select: {
        id: true,
        provider: true,
        title: true,
        modelId: true,
        startsAt: true,
      },
    }),
    prisma.stripeWebhookEventLog.findMany({
      where: { status: "failed" },
      orderBy: { receivedAt: "asc" },
      take: WORK_QUEUE_SOURCE_LIMIT,
      select: {
        id: true,
        stripeEventId: true,
        eventType: true,
        error: true,
        receivedAt: true,
      },
    }),
    prisma.adminNotificationLog.findMany({
      where: { status: "failed", acknowledgedAt: null },
      orderBy: { createdAt: "asc" },
      take: WORK_QUEUE_SOURCE_LIMIT,
      select: { id: true, title: true, channel: true, createdAt: true },
    }),
    prisma.modelLifecycleWorkItem.findMany({
      where: { status: { in: [...OPEN_WORK_ITEM_STATUSES] } },
      orderBy: { firstSeenAt: "asc" },
      take: WORK_QUEUE_SOURCE_LIMIT,
      select: {
        id: true,
        provider: true,
        apiModel: true,
        action: true,
        status: true,
        severity: true,
        ownerEmail: true,
        firstSeenAt: true,
      },
    }),
    getScheduledJobsDashboard(now),
  ]);

  const items: WorkQueueItem[] = [];
  const truncatedCategories: string[] = [];
  const failedCategories: string[] = [];

  const collect = <T>(
    category: string,
    result: PromiseSettledResult<T[]>,
    map: (row: T) => WorkQueueItem
  ) => {
    if (result.status !== "fulfilled") {
      failedCategories.push(category);
      return;
    }
    if (result.value.length >= WORK_QUEUE_SOURCE_LIMIT) {
      truncatedCategories.push(category);
    }
    items.push(...result.value.map(map));
  };

  collect("Approvals", approvals, (row) => ({
    id: `approval:${row.id}`,
    category: "Approval",
    severity: "critical",
    title: `${row.action} awaiting a second approver`,
    detail: `Requested by ${row.requestedByEmail || "an administrator"} · expires ${row.expiresAt
      .toISOString()
      .replace("T", " ")
      .slice(0, 16)} UTC`,
    href: "/admin/work-queue?tab=approvals",
    openedAt: row.createdAt.toISOString(),
  }));

  collect("Refunds", refunds, (row) => ({
    id: `refund:${row.id}`,
    category: "Refund",
    severity: "high",
    title: `Refund request from ${row.email}`,
    detail: `${row.plan || "no plan"} · ${row.reason || "no reason given"}`,
    href: "/admin/refunds",
    openedAt: row.requestedAt.toISOString(),
  }));

  collect("Incidents", incidents, (row) => ({
    id: `incident:${row.id}`,
    category: "Incident",
    severity: "critical",
    title: row.title,
    detail: `${row.provider}${row.modelId ? ` · ${row.modelId}` : ""} · incident mode is active`,
    href: "/admin/providers?tab=incidents",
    openedAt: row.startsAt.toISOString(),
  }));

  collect("Support", feedback, (row) => ({
    id: `feedback:${row.id}`,
    category: "Feedback",
    severity: "normal",
    title: row.message.slice(0, 120),
    detail: `${row.type} · ${row.email || "no email supplied"}`,
    href: "/admin/support?tab=feedback",
    openedAt: row.createdAt.toISOString(),
  }));

  collect("Privacy requests", privacyRequests, (row) => ({
    id: `privacy:${row.id}`,
    category: "Privacy",
    // A data-rights request is on a statutory clock, so it outranks feedback
    // even when it is younger.
    severity: row.dueAt.getTime() <= now.getTime() ? "critical" : "high",
    title: `${row.requestType} request from ${row.email}`,
    detail: `Due ${row.dueAt.toISOString().slice(0, 10)}${
      row.legalHold ? " · legal hold" : ""
    }`,
    href: "/admin/support?tab=privacy",
    openedAt: row.createdAt.toISOString(),
  }));

  collect("Webhooks", webhooks, (row) => ({
    id: `webhook:${row.id}`,
    category: "Webhook",
    severity: "high",
    title: `Failed ${row.eventType}`,
    detail: `${row.stripeEventId || "no Stripe event id"} · ${
      row.error || "no error recorded"
    }`,
    href: "/admin/automation?tab=webhooks",
    openedAt: row.receivedAt.toISOString(),
  }));

  collect("Model lifecycle", modelLifecycle, (row) => ({
    id: `model-lifecycle:${row.id}`,
    category: "Model",
    // The item carries its own severity; a discovery nobody has looked at is
    // ordinary work, an auto-disabled model with users on it is not.
    severity: (["critical", "high", "normal"] as const).includes(
      row.severity as WorkQueueSeverity
    )
      ? (row.severity as WorkQueueSeverity)
      : "normal",
    title: `${row.action} ${row.apiModel} (${row.provider})`,
    detail: `${row.status.replace(/_/g, " ")} · ${
      row.ownerEmail ? `owner ${row.ownerEmail}` : "no owner"
    }`,
    href: "/admin/models?tab=discovery",
    openedAt: row.firstSeenAt.toISOString(),
  }));

  collect("Alerts", alerts, (row) => ({
    id: `alert:${row.id}`,
    category: "Alert",
    severity: "high",
    title: `Undelivered alert: ${row.title}`,
    detail: `${row.channel} delivery failed and has not been acknowledged`,
    href: "/admin/alerts?tab=deliveries",
    openedAt: row.createdAt.toISOString(),
  }));

  if (jobs.status === "fulfilled") {
    for (const job of jobs.value) {
      if (!job.delayed && job.status !== "stuck" && job.consecutiveFailures === 0) {
        continue;
      }
      items.push({
        id: `job:${job.key}`,
        category: "Scheduled job",
        severity: job.status === "stuck" ? "critical" : "high",
        title: `${job.name} is ${job.status}`,
        detail:
          job.consecutiveFailures > 0
            ? `${job.consecutiveFailures} consecutive failures · ${
                job.lastError || "no error recorded"
              }`
            : `Expected on ${job.schedule}`,
        href: "/admin/automation?tab=jobs",
        openedAt: job.lastRunAt,
      });
    }
  } else {
    failedCategories.push("Scheduled jobs");
  }

  items.sort((left, right) => {
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) return bySeverity;
    const leftAge = left.openedAt ? new Date(left.openedAt).getTime() : Infinity;
    const rightAge = right.openedAt ? new Date(right.openedAt).getTime() : Infinity;
    return leftAge - rightAge;
  });

  return { items, truncatedCategories, failedCategories };
}
