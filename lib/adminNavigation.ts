import type { AdminRole } from "@/lib/adminAuthCore";

/**
 * The Admin Console information architecture.
 *
 * One table, no React, no icons: the sidebar, the command palette, the pinned
 * pages store, the breadcrumb, the per-page tab strips and the legacy redirects
 * all read from here. Keeping it framework-free is what lets a server component
 * (the layout's badge counts) and a client component (the sidebar) agree on the
 * same route table without either importing the other.
 *
 * Icons live in `components/admin/adminNavigationIcons.ts`, keyed by item id,
 * because a `lucide-react` import would make this module unusable from a plain
 * Node test.
 */

export const ADMIN_NAV_GROUPS = [
  "Command Center",
  "Customers",
  "Revenue",
  "AI Platform",
  "Operations",
  "Governance",
] as const;

export type AdminNavGroup = (typeof ADMIN_NAV_GROUPS)[number];

/**
 * Which counter the sidebar renders beside an entry.
 *
 * Only entries an operator is expected to *act* on carry one. A badge on a
 * reference page would be noise, and a badge that never changes teaches an
 * operator to stop reading badges.
 */
export type AdminNavBadgeKey =
  | "abandonedLegalEmail"
  | "workQueue"
  | "support"
  | "refunds"
  | "providers"
  | "automation"
  | "alerts"
  | "modelLifecycle"
  | "emailCampaigns";

export type AdminNavTab = {
  id: string;
  label: string;
  description: string;
};

export type AdminNavItem = {
  id: string;
  label: string;
  href: string;
  description: string;
  group: AdminNavGroup;
  /** Extra search terms the command palette matches on. */
  aliases: readonly string[];
  writeRoles?: readonly AdminRole[];
  badge?: AdminNavBadgeKey;
  tabs?: readonly AdminNavTab[];
};

export const ADMIN_NAVIGATION: readonly AdminNavItem[] = [
  {
    id: "overview",
    label: "Overview",
    href: "/admin/overview",
    description: "Operational snapshot, attention queue, and recent activity",
    group: "Command Center",
    aliases: ["home", "dashboard", "kpi", "status", "health", "snapshot"],
  },
  {
    id: "work-queue",
    label: "Work queue",
    href: "/admin/work-queue",
    description: "Everything waiting on an operator, oldest first",
    group: "Command Center",
    badge: "workQueue",
    aliases: ["queue", "todo", "pending", "backlog", "approvals", "two-person"],
    tabs: [
      {
        id: "queue",
        label: "Queue",
        description: "Open items ranked by priority and age",
      },
      {
        id: "approvals",
        label: "Approvals",
        description: "Two-person approval requests",
      },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    href: "/admin/analytics",
    description: "Product funnel, activation, and import/memory metrics",
    group: "Command Center",
    aliases: [
      "funnel",
      "activation",
      "conversion",
      "ga4",
      "product analytics",
      "memory",
      "import",
      "external import",
      "ai review",
      "cross review",
      "comparison review",
      "reviewer",
    ],
    tabs: [
      {
        id: "product",
        label: "Product analytics",
        description: "Acquisition, activation, and revenue funnel",
      },
      {
        id: "imports",
        label: "Imports & memory",
        description: "External conversation import and memory metrics",
      },
      {
        id: "ai-review",
        label: "AI Review",
        description: "Reliability, adoption, and reviewer-pair evidence",
      },
    ],
  },
  {
    id: "users",
    label: "Users",
    href: "/admin/users",
    description: "Accounts, usage, plans, and account controls",
    group: "Customers",
    writeRoles: ["owner", "support"],
    aliases: ["customers", "accounts", "people", "subscribers", "email"],
  },
  {
    id: "support",
    label: "Support",
    href: "/admin/support",
    description: "Feedback inbox and data-rights request queue",
    group: "Customers",
    writeRoles: ["owner", "support"],
    badge: "support",
    aliases: [
      "feedback",
      "inbox",
      "tickets",
      "cases",
      "privacy",
      "gdpr",
      "data rights",
      "complaints",
    ],
    tabs: [
      {
        id: "feedback",
        label: "Feedback",
        description: "Reports and requests submitted from the product",
      },
      {
        id: "privacy",
        label: "Privacy requests",
        description: "Export and erasure requests",
      },
    ],
  },
  {
    id: "billing",
    label: "Billing",
    href: "/admin/billing",
    description: "Plans, price catalogue, promotions, and promotion risk",
    group: "Revenue",
    writeRoles: ["owner", "billing"],
    aliases: [
      "plans",
      "prices",
      "stripe",
      "subscriptions",
      "catalogue",
      "promotions",
      "coupon",
      "discount",
      "risk",
    ],
    tabs: [
      {
        id: "plans",
        label: "Plans & prices",
        description: "Plan catalogue, Stripe IDs, and lifecycle counters",
      },
      {
        id: "promotions",
        label: "Promotions & risk",
        description: "Promotion codes and their abuse signals",
      },
    ],
  },
  {
    id: "refunds",
    label: "Refunds",
    href: "/admin/refunds",
    description: "Refund review queue and reviewed requests",
    group: "Revenue",
    writeRoles: ["owner", "billing"],
    badge: "refunds",
    aliases: ["cancellations", "chargeback", "dispute", "money back"],
  },
  {
    id: "credit-ledger",
    label: "Credit ledger",
    href: "/admin/credit-ledger",
    description: "Credit grants, settlements, and outstanding debt",
    group: "Revenue",
    writeRoles: ["owner", "billing"],
    aliases: ["credits", "ledger", "grants", "settlement", "debt"],
  },
  {
    id: "providers",
    label: "Providers",
    href: "/admin/providers",
    description: "Availability, spend, incidents, and fallback policy",
    group: "AI Platform",
    writeRoles: ["owner", "ops"],
    badge: "providers",
    aliases: [
      "openai",
      "anthropic",
      "google",
      "perplexity",
      "outage",
      "incident",
      "fallback",
      "usage",
      "cost",
      "spend",
      "balance",
      "budget",
    ],
    tabs: [
      {
        id: "health",
        label: "Health",
        description: "Availability, keys, and per-model metrics",
      },
      {
        id: "usage-cost",
        label: "Usage & cost",
        description: "Provider usage reconciliation and image spend",
      },
      {
        id: "incidents",
        label: "Incidents & fallback",
        description: "Readiness tests, incident mode, and recovery",
      },
    ],
  },
  {
    id: "models",
    label: "Models",
    href: "/admin/models",
    description: "Model registry, availability, and what discovery has found",
    group: "AI Platform",
    writeRoles: ["owner", "ops"],
    badge: "modelLifecycle",
    aliases: [
      "registry",
      "catalogue",
      "catalog",
      "gpt",
      "claude",
      "gemini",
      "discovery",
      "candidates",
      "lifecycle",
      "backlog",
    ],
    tabs: [
      {
        id: "registry",
        label: "Registry",
        description: "Availability, pricing overrides, and API configuration",
      },
      {
        id: "discovery",
        label: "Discovery",
        description: "Models a provider listed that nobody has decided about",
      },
    ],
  },
  {
    id: "routing",
    label: "Routing",
    href: "/admin/routing",
    description: "Shadow Auto Router decisions against what actually ran",
    group: "AI Platform",
    aliases: ["auto", "router", "shadow", "task profile", "candidates"],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    href: "/admin/infrastructure",
    description: "Railway, R2, database, and Prisma operations",
    group: "Operations",
    writeRoles: ["owner", "ops", "billing"],
    aliases: ["railway", "r2", "database", "prisma", "hosting", "storage"],
  },
  {
    id: "automation",
    label: "Automation",
    href: "/admin/automation",
    description: "Scheduled jobs, webhook delivery, and operations reports",
    group: "Operations",
    writeRoles: ["owner", "ops", "billing"],
    badge: "automation",
    aliases: [
      "cron",
      "jobs",
      "scheduler",
      "webhook",
      "stripe events",
      "replay",
      "report",
    ],
    tabs: [
      {
        id: "jobs",
        label: "Scheduled jobs",
        description: "Cron health, history, and stuck runs",
      },
      {
        id: "webhooks",
        label: "Webhooks",
        description: "Billing event delivery and replay",
      },
      {
        id: "reports",
        label: "Reports",
        description: "Operations reports and their distribution",
      },
    ],
  },
  {
    id: "alerts",
    label: "Alerts",
    href: "/admin/alerts",
    description: "Alert thresholds, templates, and the delivery log",
    group: "Operations",
    writeRoles: ["owner", "ops"],
    badge: "alerts",
    aliases: ["notifications", "slack", "discord", "thresholds", "paging"],
    tabs: [
      {
        id: "policy",
        label: "Policy",
        description: "Budget and incident thresholds",
      },
      {
        id: "templates",
        label: "Templates",
        description: "Message templates and delivery tests",
      },
      {
        id: "deliveries",
        label: "Delivery log",
        description: "What was sent, to where, and whether it landed",
      },
    ],
  },
  {
    id: "email-campaigns",
    label: "Email campaigns",
    href: "/admin/email-campaigns",
    description:
      "Campaign drafts, what each one is waiting on, and the waves that are due",
    group: "Operations",
    writeRoles: ["owner", "ops"],
    badge: "emailCampaigns",
    aliases: [
      "campaign",
      "fan-out",
      "fanout",
      "wave",
      "reminder",
      "retirement notice",
      "bulk email",
      "announcement",
      "attestation",
      "approve campaign",
    ],
    tabs: [
      {
        id: "campaigns",
        label: "Campaigns",
        description: "Every campaign, its status, and what still blocks its send",
      },
      {
        id: "schedule",
        label: "Schedule",
        description: "Waves by the time they are due, overdue ones first",
      },
    ],
  },
  {
    id: "email-delivery",
    label: "Email delivery",
    href: "/admin/email-delivery",
    description: "What was sent to whom, what was refused, and which addresses are suppressed",
    group: "Operations",
    writeRoles: ["owner", "ops"],
    badge: "abandonedLegalEmail",
    aliases: [
      "outbox",
      "delivery log",
      "bounce",
      "complaint",
      "suppression",
      "abandoned",
      "dead letter",
      "did not arrive",
      "never received",
      "email history",
    ],
    tabs: [
      {
        id: "deliveries",
        label: "Deliveries",
        description: "Every message and what became of it",
      },
      {
        id: "suppressions",
        label: "Suppressions",
        description: "Addresses we will not mail, and why",
      },
    ],
  },
  {
    id: "platform",
    label: "Platform settings",
    href: "/admin/platform",
    description: "Product defaults and emergency feature controls",
    group: "Operations",
    writeRoles: ["owner", "ops"],
    aliases: [
      "settings",
      "defaults",
      "feature flags",
      "kill switch",
      "guest default",
    ],
  },
  {
    id: "email-policy",
    label: "Email policy",
    href: "/admin/email-policy",
    description: "Jurisdiction profiles for outbound mail, and which version is in force",
    group: "Governance",
    writeRoles: ["owner", "ops"],
    aliases: [
      "email",
      "jurisdiction",
      "unsubscribe",
      "marketing",
      "footer",
      "subject prefix",
      "quiet hours",
      "consent",
      "dmarc",
      "dkim",
      "spf",
      "sending domain",
      "deliverability",
    ],
    tabs: [
      {
        id: "jurisdictions",
        label: "Jurisdictions",
        description: "Profile versions, and which one is in force",
      },
      {
        id: "domains",
        label: "Sending domains",
        description: "Domain verification and DNS record status",
      },
    ],
  },
  {
    id: "audit",
    label: "Audit log",
    href: "/admin/audit",
    description: "Administrator activity, with actor and target",
    group: "Governance",
    aliases: ["log", "history", "activity", "trail", "who changed"],
  },
  {
    id: "retention",
    label: "Retention",
    href: "/admin/retention",
    description: "Retention windows and destructive cleanup",
    group: "Governance",
    writeRoles: ["owner", "ops"],
    aliases: ["cleanup", "purge", "delete", "data lifecycle"],
  },
  {
    id: "admin-access",
    label: "Admin access",
    href: "/admin/admin-access",
    description: "Roles, expiry, operational readiness, and audit integrity",
    group: "Governance",
    writeRoles: ["owner"],
    aliases: [
      "roles",
      "permissions",
      "rbac",
      "administrators",
      "readiness",
      "integrity",
    ],
    tabs: [
      {
        id: "administrators",
        label: "Administrators",
        description: "Configured identities, roles, and expiry",
      },
      {
        id: "readiness",
        label: "Operational readiness",
        description: "Checkpoints an operator must confirm",
      },
      {
        id: "integrity",
        label: "Audit integrity",
        description: "Tamper-evidence for the audit log",
      },
    ],
  },
] as const;

export const ADMIN_NAV_ITEMS_BY_GROUP: ReadonlyArray<{
  label: AdminNavGroup;
  items: readonly AdminNavItem[];
}> = ADMIN_NAV_GROUPS.map((label) => ({
  label,
  items: ADMIN_NAVIGATION.filter((item) => item.group === label),
}));

/** Routes that exist but are deliberately absent from the sidebar. */
export const ADMIN_UNLISTED_PAGES = [
  {
    id: "search",
    label: "Global search",
    href: "/admin/search",
    description:
      "Search customers, refunds, traces, and audit events across the console",
    aliases: ["find", "lookup", "trace", "everything"],
  },
] as const;

export type AdminPageMeta = {
  label: string;
  description: string;
  href: string;
  group: AdminNavGroup | null;
  parentLabel?: string;
  parentHref?: string;
  /** False for a route the navigation table does not describe. */
  isKnown: boolean;
};

const matchesRoute = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

/**
 * The navigation entry a pathname belongs to, or `null` for a route outside the
 * table.
 */
export const findAdminNavItem = (pathname: string): AdminNavItem | null =>
  ADMIN_NAVIGATION.find((item) => matchesRoute(pathname, item.href)) || null;

const ADMIN_DETAIL_ROUTES = [
  {
    pattern: /^\/admin\/users\/[^/]+$/,
    label: "Customer detail",
    description: "Account timeline, billing, credits, and security controls",
    parentLabel: "Users",
    parentHref: "/admin/users",
    group: "Customers" as const,
  },
  {
    pattern: /^\/admin\/email-campaigns\/[^/]+$/,
    label: "Campaign detail",
    description:
      "The copy this campaign sends, who has attested to what, and whether it may go out",
    parentLabel: "Email campaigns",
    parentHref: "/admin/email-campaigns",
    group: "Operations" as const,
  },
  {
    pattern: /^\/admin\/providers\/[^/]+$/,
    label: "Provider detail",
    description: "Usage diagnostics, billing, fallback, and recent errors",
    parentLabel: "Providers",
    parentHref: "/admin/providers",
    group: "AI Platform" as const,
  },
] as const;

/**
 * Title, description and breadcrumb for any admin pathname.
 *
 * A route the table does not know about resolves to a neutral "Admin Console"
 * heading rather than falling through to the first navigation entry. The old
 * behaviour titled `/admin/search` -- and any recent route that had since been
 * renamed -- "Overview", which reads as a wrong page rather than an unknown one.
 */
export const resolveAdminPageMeta = (pathname: string): AdminPageMeta => {
  const detail = ADMIN_DETAIL_ROUTES.find((route) => route.pattern.test(pathname));
  if (detail) {
    return {
      label: detail.label,
      description: detail.description,
      href: pathname,
      group: detail.group,
      parentLabel: detail.parentLabel,
      parentHref: detail.parentHref,
      isKnown: true,
    };
  }

  const unlisted = ADMIN_UNLISTED_PAGES.find((page) =>
    matchesRoute(pathname, page.href)
  );
  if (unlisted) {
    return {
      label: unlisted.label,
      description: unlisted.description,
      href: unlisted.href,
      group: null,
      isKnown: true,
    };
  }

  const item = findAdminNavItem(pathname);
  if (item) {
    return {
      label: item.label,
      description: item.description,
      href: item.href,
      group: item.group,
      isKnown: true,
    };
  }

  return {
    label: "Admin Console",
    description: "This route is not part of the console navigation.",
    href: pathname,
    group: null,
    isKnown: false,
  };
};

/**
 * Retired routes and where they now live.
 *
 * Nothing is deleted: every previously reachable `/admin/*` URL still resolves,
 * so deep links, bookmarks, runbooks and the `href`s already written into audit
 * summaries keep working. Each entry names the tab as well as the page, because
 * landing on a consolidated page's first tab would silently drop the operator
 * somewhere other than where the link pointed.
 */
export const ADMIN_LEGACY_ROUTES: Readonly<Record<string, string>> = {
  "/admin/feedback": "/admin/support?tab=feedback",
  "/admin/promotions": "/admin/billing?tab=promotions",
  "/admin/incidents": "/admin/providers?tab=incidents",
  "/admin/fallback-policies": "/admin/providers?tab=incidents",
  "/admin/usage-cost": "/admin/providers?tab=usage-cost",
  "/admin/jobs": "/admin/automation?tab=jobs",
  "/admin/webhooks": "/admin/automation?tab=webhooks",
  "/admin/approvals": "/admin/work-queue?tab=approvals",
};

/**
 * Where `/admin?tab=<value>` used to land, expressed against the new IA.
 *
 * Kept separate from `ADMIN_LEGACY_ROUTES` because the keys are query values
 * rather than paths, and several of them (`platform`, `audit`) still map to a
 * page that did not move.
 */
export const ADMIN_LEGACY_TAB_ROUTES: Readonly<Record<string, string>> = {
  overview: "/admin/overview",
  "work-queue": "/admin/work-queue",
  search: "/admin/search",
  platform: "/admin/platform",
  users: "/admin/users",
  billing: "/admin/billing",
  refunds: "/admin/refunds",
  providers: "/admin/providers",
  models: "/admin/models",
  analytics: "/admin/analytics",
  infrastructure: "/admin/infrastructure",
  alerts: "/admin/alerts",
  retention: "/admin/retention",
  audit: "/admin/audit",
  support: "/admin/support",
  "credit-ledger": "/admin/credit-ledger",
  "admin-access": "/admin/admin-access",
  automation: "/admin/automation",
  ...ADMIN_LEGACY_ROUTES,
  // The `?tab=` values that named a now-merged workspace.
  feedback: ADMIN_LEGACY_ROUTES["/admin/feedback"],
  promotions: ADMIN_LEGACY_ROUTES["/admin/promotions"],
  incidents: ADMIN_LEGACY_ROUTES["/admin/incidents"],
  "fallback-policies": ADMIN_LEGACY_ROUTES["/admin/fallback-policies"],
  "usage-cost": ADMIN_LEGACY_ROUTES["/admin/usage-cost"],
  jobs: ADMIN_LEGACY_ROUTES["/admin/jobs"],
  webhooks: ADMIN_LEGACY_ROUTES["/admin/webhooks"],
  approvals: ADMIN_LEGACY_ROUTES["/admin/approvals"],
};

type QueryValue = string | string[] | undefined;

/**
 * Merges a legacy request's own query string onto its new destination.
 *
 * `/admin/feedback?status=open` has to arrive at
 * `/admin/support?tab=feedback&status=open`: dropping `status` would turn a
 * working bookmark into a page that opens on the wrong filter, which is the
 * failure a redirect is supposed to prevent.
 *
 * The source's own `tab` is always dropped: on `/admin?tab=refunds` it named
 * the *old* workspace and has already been consumed by the lookup, so copying
 * it forward would land on `/admin/refunds?tab=refunds` -- a query the refunds
 * page does not use and a URL no operator would have typed.
 */
export const adminRedirectTarget = (
  destination: string,
  query: Record<string, QueryValue> = {}
): string => {
  const [path, destinationQuery = ""] = destination.split("?");
  const params = new URLSearchParams(destinationQuery);
  for (const [key, value] of Object.entries(query)) {
    if (key === "tab") continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first !== "string" || first.length === 0) continue;
    params.set(key, first);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
};

/**
 * The tab a page should open on.
 *
 * Unknown and missing values both fall back to the first declared tab, so a
 * hand-edited or stale `?tab=` never renders an empty page.
 */
export const resolveAdminTab = <T extends AdminNavTab>(
  tabs: readonly T[],
  requested: QueryValue
): T => {
  const value = Array.isArray(requested) ? requested[0] : requested;
  return tabs.find((tab) => tab.id === value) || tabs[0];
};

export const adminNavItemTabs = (id: string): readonly AdminNavTab[] => {
  const item = ADMIN_NAVIGATION.find((entry) => entry.id === id);
  if (!item?.tabs) {
    throw new Error(`Admin navigation entry "${id}" declares no tabs.`);
  }
  return item.tabs;
};

export const adminItemIsWritable = (
  role: AdminRole,
  item: Pick<AdminNavItem, "writeRoles">
) => !item.writeRoles || item.writeRoles.includes(role);

/** Every page the command palette can jump to, listed and unlisted alike. */
export const ADMIN_SEARCHABLE_PAGES = [
  ...ADMIN_NAVIGATION.map((item) => ({
    id: item.id,
    label: item.label,
    href: item.href,
    description: item.description,
    group: item.group as AdminNavGroup | null,
    aliases: item.aliases,
  })),
  ...ADMIN_UNLISTED_PAGES.map((page) => ({
    id: page.id,
    label: page.label,
    href: page.href,
    description: page.description,
    group: null as AdminNavGroup | null,
    aliases: page.aliases,
  })),
];

export type AdminSearchablePage = (typeof ADMIN_SEARCHABLE_PAGES)[number];

/**
 * Matches a page on its label, description, group and aliases.
 *
 * Aliases carry the words an operator actually types -- "coupon", "outage",
 * "cron" -- none of which appear in any label. Without them the palette only
 * finds a page when the operator already knows what it is called, which is the
 * case where they least need it.
 */
export const matchAdminPages = (
  query: string,
  pages: readonly AdminSearchablePage[] = ADMIN_SEARCHABLE_PAGES
): AdminSearchablePage[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return pages.filter((page) =>
    [page.label, page.description, page.group || "", ...page.aliases]
      .join(" ")
      .toLowerCase()
      .includes(normalized)
  );
};
